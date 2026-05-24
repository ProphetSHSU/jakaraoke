# Tempo Handling Architecture

> Last updated: 2026-05-24
> Current SCRIPT_VERSION: `v2.2.1-defer-tempo-set-2026-05-24`
> Source: `max_devices/setlist_pilot/setlist_pilot_v2.js`

## Summary

The Setlist Pilot v2 M4L device drives Ableton master tempo from two sources:

1. **Scene's "initial tempo"** (per-scene `tempo` field, set in Ableton's widened Main track in Session view) — read via LiveAPI on play-start, used as the song's baseline BPM.
2. **`{tempo_map: bar:bpm, ...}`** entries in the song's ChordPro file — sent to the M4L by the server on song-load, fired by the M4L when transport bar reaches each scheduled bar.

The scene tempo is the authoritative "song starts at X" declaration. The tempo_map handles in-song changes (e.g. `27:194, 144:150` for "99 Red Balloons" — accelerate at bar 27, return at 144).

## State

```javascript
state.tempoSchedule  // [{bar, bpm}] sorted by bar — copy from server, never mutated
state.tempoFiredIdx  // pointer; reset on play-start, rewind, scene change
state.baselineTempo  // captured pre-first-entry tempo (scene initial tempo)
```

## Lifecycle

| Event | Handler | Action |
|---|---|---|
| Server sends `set_tempo_schedule` | `list()` UDP cmd path | Copy schedule, reset pointer, clear baseline |
| Scene change (selected) | `sceneCallback` | Clear schedule (server will re-send), reset pointer + baseline |
| Transport `becamePlaying` | `transportCallback` | Reset pointer; read `getSceneInitialTempo(currentIdx)`; if valid, set `state.baselineTempo` and `deferTempoSet(...)` to apply now |
| Bar advances `>= schedule[idx].bar` | `list()` plugsync path | Advance pointer to last-due, `ls.set('tempo', bpm)` (regular handler — no defer needed) |
| Bar moves backwards (rewind/scrub) | `list()` plugsync path | Reset pointer; if rewound into pre-first-entry zone, restore `state.baselineTempo` |

## Critical LiveAPI rule

**Live forbids mutating Live state synchronously from inside notification callbacks.** If you call `ls.set('tempo', X)` from a property observer callback (`transportCallback`, `tempoCallback`, `sceneCallback`, etc.) you'll see:

```
jsliveapi: Changes cannot be triggered by notifications. You will need to defer your response.
```

Use `deferTempoSet(bpm, label)` — wraps the set in a Max `Task` that fires on the next idle tick. Regular message handlers (`list()`, anything not registered as an observer callback) can call `ls.set()` directly.

## Server side

`server/websocket-server.js` extracts `parsed.metadata.tempo_map` from the ChordPro and ships it to the M4L as `{type:'command', action:'set_tempo_schedule', schedule:[...]}`. **It does NOT prepend a `{bar:1, bpm:metadata.tempo}` entry** — `metadata.tempo` is descriptive (header annotation), not the song's start tempo. The scene-tempo-via-LiveAPI path is the authoritative baseline.

## Why this design

**v1 (broken):** `state.tempoSchedule.shift()` destructively consumed the array. After bar 27 fired in run 1, the schedule was `[]` until server restart. Replays got nothing.

**v2.1 (intermediate):** Non-destructive pointer + baseline-capture window (observe master tempo during play-start). Worked, but heuristic — relied on Ableton's clip-tempo automation firing predictably at scene launch.

**v2.2.0:** Replaced capture window with deterministic LiveAPI read of scene tempo. Cleaner, no race conditions.

**v2.2.1 (current):** Added `deferTempoSet()` to silence the LiveAPI-mutation-in-notification warning.

## SCRIPT_VERSION pattern

Every consequential log line stamps the running version. Confirms at a glance which build is executing — silenced ambiguity from the 2026-05-24 deploy-gotcha incident where stale `.js` files in the User Library ran for days while we kept pushing fixes to the repo.

```javascript
var SCRIPT_VERSION = "v2.2.1-defer-tempo-set-2026-05-24";
post('=== SP2 script loaded: ' + (new Date()).toISOString() + ' [' + SCRIPT_VERSION + '] ===\n');
post('  PLAY-START [' + SCRIPT_VERSION + ']: ...');
post('  REWIND [' + SCRIPT_VERSION + ']: ...');
post('  TEMPO [' + SCRIPT_VERSION + '] -> ... (deferred)');
post('  tempo_schedule loaded [' + SCRIPT_VERSION + ']: N change(s)');
```

**Bump SCRIPT_VERSION** whenever the file changes in a way that affects runtime behavior. Format: `vMAJOR.MINOR.PATCH-feature-YYYY-MM-DD[-shortsha]`.

## Deploy

⚠️ **`.js` files load from User Library on gigmac, NOT from the repo.** See `~/.aki/memories/jakaraoke_project.md` → "⚠️ CRITICAL: Max .js Deploy Gotcha" for the full deploy procedure. TL;DR:

```bash
# After commit + push:
ssh gigmac "cd /Users/jake/source/jakaraoke && git pull && \
  cp max_devices/setlist_pilot/setlist_pilot_v2.js \
     '/Users/jake/Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect/setlist_pilot_v2.js'"
# Verify md5 -q matches both paths.
# Then in Max: right-click device → Reload. Confirm SCRIPT_VERSION in load marker.
```
