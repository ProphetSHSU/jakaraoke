# Setlist Pilot — M4L Device Spec (v1)

> Written 2026-05-06 during Phase 2a planning.
> Status: **DRAFT** — awaiting Jake sign-off before generator code is written.
> Read `AI_HANDOFF.md` first for the overall evolution plan.

---

## The tl;dr

A Max-for-Live **MIDI Effect** device that lives on a dedicated "Pedals"
MIDI track. It consumes incoming pedal MIDI and controls Ableton's
transport + scene selection **directly via LiveAPI**, eliminating the
gymnastics currently performed in TinyBox to simulate "play the currently
selected scene."

- **Input**: MIDI notes (configurable pitches) from FCB-1010 → TinyBox → IAC Bus
- **Output**: Direct LiveAPI calls (`scene.fire()`, `start_playing`, etc.)
- **UI**: Small status panel showing current scene + state, plus configurable pedal mapping
- **Does NOT replace** expression pedal → fader mapping (that stays native)

---

## Why it exists

Ableton's MIDI Map cannot dereference "the currently selected scene" — the
Launch buttons it exposes are per-scene, so there's no mappable widget for
"fire whatever is highlighted right now." This forces the current TinyBox
approach: simulate the intent by walking the selection and firing the next
scene, which is brittle at set boundaries and requires clever state
tracking upstream of Ableton.

LiveAPI has a direct primitive for this:
```js
new LiveAPI("live_set view selected_scene").call("fire");
```

This one line replaces the entire TinyBox orchestration logic for navigation.
The Setlist Pilot device wraps that primitive — plus Stop / Next / Prev —
into a single, well-behaved MIDI effect.

---

## Design principles

1. **Configurable, not hardcoded.** Pedal note numbers are `live.numbox`
   parameters on the device face. Jake should not need to regenerate the
   device if a pedal assignment changes.
2. **Headless but visible.** The device has a small status readout so Jake
   can glance at it during setup and see what LiveAPI thinks is happening.
   Once the setup is right, he can hide the track or ignore it.
3. **Pure functions where possible.** Navigation logic (skip-empty,
   skip-divider, bounds clamping) lives in pure JS functions that can be
   unit-tested in Node without Live running.
4. **Fail-safe.** All LiveAPI calls are wrapped. If a scene is empty or a
   boundary is hit, log and no-op — never throw or leave Live in a bad state.
5. **No .als changes required.** Jake drops the device on a track he creates
   manually, same pattern as the Lights devices.

---

## Device overview

### Placement
- Track type: **MIDI track** (regular, not return)
- Track input: whatever IAC bus receives your pedal MIDI (same bus TinyBox outputs to today, or a new dedicated one — see Open Questions)
- Track MIDI-From: set to receive from that bus
- Monitor: **In**
- Track output: usually **No Output** (the device itself does not need to pass MIDI through — it translates every matched input to a LiveAPI call and *eats* the event)

### File names
- `Setlist Pilot v1.amxd`
- `setlist_pilot_v1.js`

### Deploy target (same as Lights)
```
/Users/jake/Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect/
```

---

## Pedal input contract

### Event types
The device listens for **Note On** messages. Which pitch triggers which
action is **user-configurable** via four `live.numbox` parameters on the
device face. Defaults:

| Parameter | Default pitch | Action |
|---|---|---|
| `play_note`  | 60 (C3)  | Fire currently-selected scene |
| `stop_note`  | 61 (C#3) | Global stop |
| `next_note`  | 62 (D3)  | Advance selection (skip dividers / empties) |
| `prev_note`  | 63 (D#3) | Retreat selection (skip dividers / empties) |

Additional configurable parameters:

| Parameter | Default | Meaning |
|---|---|---|
| `midi_channel`   | 0 (omni) | 0 = any channel; 1-16 = specific |
| `skip_empty`     | 1 (on)   | Next/Prev skips scenes with no clips |
| `skip_dividers`  | 1 (on)   | Next/Prev skips scenes whose name matches divider regex |
| `divider_regex`  | `^-+$` or `^-+\s*(Set\s+\d+)?\s*-+$` | What names count as dividers (see Open Questions) |

### Velocity handling
- Velocity > 0 → fires action on the **NoteOn edge**
- Velocity == 0 / NoteOff → ignored (standard Max convention)
- If Jake's pedals send hold/release as note on/off, we only act on the "on" edge. No retrigger, no hold-to-repeat. Tap to act.

### Why Notes and not CCs?
- FCB-1010 stomp switches emit Note messages via TinyBox (confirmed convention).
- Notes are a cleaner mental model for "discrete event" (as opposed to continuous CCs which are better for expression pedals).
- If future pedals emit CCs instead, trivial to add — spec'd as an extension point.

### Expression pedals (out of scope for v1)
Expression pedals (CC messages) pass straight through to Ableton. Native
MIDI map handles CC-to-fader mapping. Setlist Pilot does **not** intercept
or transform expression pedal CCs in v1.

---

## Device UI

Canvas: approximately **420 × 180 px** (roughly similar footprint to a
Palette Controller row). Vertical stack of three regions:

```
┌────────────────────────────────────────────────────────────┐
│ SETLIST PILOT v1                              [●] Live API │  ← header row (status LED)
├────────────────────────────────────────────────────────────┤
│ Pedal notes:   Play [60]  Stop [61]  Next [62]  Prev [63]  │  ← config row (4 live.numbox)
│ Ch [0=omni]  ☐ Skip empty  ☐ Skip dividers                 │  ← toggles row
├────────────────────────────────────────────────────────────┤
│ NOW:  "Wagon Wheel"     (scene 3 of 18)                    │  ← status readout (updates live)
│ STATE: ▶ playing  1:45                                     │
│ LAST: fire → scene 3 OK                                    │  ← last action result
└────────────────────────────────────────────────────────────┘
```

**Status LED** (top-right): green when LiveAPI calls are succeeding,
red if a recent call failed (e.g., no live_set accessible — unusual, but
happens during session switching).

**NOW readout**: driven by `live.observer` on `selected_scene` so it
updates when Jake moves the selection with the mouse, not just via pedals.

**LAST readout**: brief flash of the last action (`fire OK`, `next → 4`,
`prev blocked — at start`, etc.). Visible for ~2 seconds, then fades to
"ready". Helps debug pedal MIDI routing during setup.

---

## LiveAPI surface (exact paths we depend on)

### Read
- `live_set` — root
  - `.is_playing` → boolean
- `live_set view`
  - `.selected_scene` → id pointer
  - `.selected_scene_index` → integer (Live 10+; settable)
- `live_set scenes <i>` (iterated for name + emptiness check)
  - `.name` → string
  - `.is_empty` → boolean (Live 11+; fallback: walk clip_slots and check `.has_clip`)

### Call
- `live_set`
  - `.call("start_playing")`
  - `.call("stop_playing")`
  - `.call("continue_playing")` — not used in v1, reserved
  - `.call("stop_all_clips")` — reserved for double-tap stop (v1.1?)
- `live_set view selected_scene`
  - `.call("fire")` — THE key primitive

### Write
- `live_set view`
  - `.set("selected_scene_index", N)`

### Observers (for UI readout)
- `live.observer live_set is_playing` → update STATE display
- `live.observer live_set view selected_scene_index` → update NOW display
- `live.observer live_set tempo` → update header tempo (optional)

---

## Behavior tree

### PLAY pedal
```
1. Read selected_scene_index.
2. Get scene at that index.
3. scene.call("fire").
4. Update LAST display: "fire → scene <N>: <name>"
```

**Rationale**: `fire()` on a scene is idempotent and state-agnostic. It
works from stopped, playing, or paused states. It works from the top of
the set (no "previous scene" gymnastics needed). It even handles the
"empty scene" case gracefully (Ableton silently does nothing). One primitive,
zero branches.

### STOP pedal
```
1. live_set.call("stop_playing").
2. Update LAST display: "stop OK"
```

**Future v1.1**: detect double-tap within 500ms → also call
`stop_all_clips()` for a harder reset. Not in v1 to keep semantics simple.

### NEXT pedal
```
1. Read selected_scene_index (= i).
2. Read total scene count (N).
3. target = i + 1
4. Loop while target < N:
     if skip_empty AND scene[target].is_empty: target++; continue
     if skip_dividers AND scene[target].name matches divider_regex: target++; continue
     break  // found a valid target
5. If target >= N:
     LAST display: "next blocked — at end"
     no state change
   Else:
     live_set.view.set("selected_scene_index", target)
     LAST display: "next → scene <target>: <name>"
```

**Rationale**: Selection move only — no auto-fire. Jake hits Next to stage,
hits Play to go. This matches his current mental model with TinyBox and
avoids surprise fires.

**Future option**: add a fifth pedal "Go" = Next + fire. Trivial extension.

### PREV pedal
Symmetric to NEXT (step from `i - 1` downward to 0). Same skip rules.
Same "blocked — at start" message at the boundary.

---

## Pure functions (testable in Node without Live)

These are extracted from the behavior tree so we can unit-test them with
mock scene data:

```js
// Given a list of scene descriptors, find the next valid index.
// Returns -1 if no valid index found (at boundary).
function chooseNextIndex(currentIdx, scenes, opts) {
  const { skipEmpty = true, skipDividers = true, dividerRe = /^-+$/ } = opts;
  for (let i = currentIdx + 1; i < scenes.length; i++) {
    if (skipEmpty && scenes[i].isEmpty) continue;
    if (skipDividers && dividerRe.test(scenes[i].name)) continue;
    return i;
  }
  return -1;  // blocked
}

function choosePrevIndex(currentIdx, scenes, opts) {
  const { skipEmpty = true, skipDividers = true, dividerRe = /^-+$/ } = opts;
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (skipEmpty && scenes[i].isEmpty) continue;
    if (skipDividers && dividerRe.test(scenes[i].name)) continue;
    return i;
  }
  return -1;
}

function isDividerName(name, re) {
  return re.test(name);
}

function routeMidiToAction(note, velocity, channel, config) {
  // Returns one of: 'play' | 'stop' | 'next' | 'prev' | null
  if (velocity === 0) return null;
  if (config.midiChannel !== 0 && channel !== config.midiChannel) return null;
  if (note === config.playNote)  return 'play';
  if (note === config.stopNote)  return 'stop';
  if (note === config.nextNote)  return 'next';
  if (note === config.prevNote)  return 'prev';
  return null;
}
```

**Test plan**: Write `test_setlist_pilot.js` that imports these (or a
copy of them) and runs scenarios:
- Empty setlist → all nav returns -1
- 3 songs, no dividers → next/prev hit each in order, boundaries blocked
- Songs + divider in middle → next skips divider when flag on, lands on it when flag off
- Songs + empty scene → same coverage for skip_empty
- Note dispatch: correct action chosen for each note, ignored for wrong channel
- MIDI channel filter: omni passes all, specific channel only passes matches

---

## Edge cases

| Case | Behavior |
|---|---|
| Live session has 0 scenes | All nav no-ops, "blocked" message |
| Selection is -1 (nothing selected) | Treat as index -1; NEXT goes to 0, PREV blocks |
| PLAY on empty scene | Ableton no-ops. LAST displays "fire → empty scene (no-op)" |
| PLAY on scene named `---` | Fires (empty scene = silent). User can opt in `skip_dividers` on PLAY too — TBD |
| Scene count changes mid-gig (unlikely) | Observer picks it up; next NEXT re-reads count |
| Live 10 (no `is_empty`) | Fallback: `scene.clip_slots[*].has_clip` scan |
| MIDI arrives before device init | `live.thisdevice` gates init; early notes buffered or dropped (TBD) |
| Multiple pedals within one MIDI frame | Each acted on in order; last-action-wins for display |
| Track not armed / wrong MIDI route | Notes never reach device. Setup responsibility. Status LED helps diagnose. |

---

## Internal state (live JS memory)

```js
var config = {
  playNote: 60, stopNote: 61, nextNote: 62, prevNote: 63,
  midiChannel: 0,
  skipEmpty: true,
  skipDividers: true,
  dividerRegex: /^-+\s*(Set\s+\d+)?\s*-+$/,
};

var snapshot = {
  selectedSceneIndex: -1,
  selectedSceneName: '',
  isPlaying: false,
  sceneCount: 0,
};

var lastAction = { kind: '', detail: '', at: 0 };
```

State is **ephemeral** — reset on device reload. LiveAPI is always the
source of truth; we only cache for UI readout.

---

## Deploy + smoke-test runbook (for when gigmac is available)

### Build
```bash
cd /Users/jawgner/source/jakaraoke/max_devices/setlist_pilot
python3 generate_setlist_pilot.py
# outputs: Setlist Pilot v1.amxd, setlist_pilot_v1.js
```

### JS syntax check
```bash
node --check setlist_pilot_v1.js
# ReferenceError for LiveAPI/outlet is expected (Max globals).
# Only fail on SyntaxError.
```

### Pure function tests
```bash
node test_setlist_pilot.js
# Should print: "All tests passed (N assertions)"
```

### Deploy to gigmac
```bash
scp "Setlist Pilot v1.amxd" setlist_pilot_v1.js \
  "jake@192.168.4.205:Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect/"
```

### Smoke test (on gigmac, with Ableton + Live set)
1. Close + reopen Ableton (flush RAM cache, per Lights lesson #4)
2. Create a new MIDI track called "Pedals"
3. Set MIDI-From to the IAC bus your pedals emit on, Monitor = In
4. Drag "Setlist Pilot v1" onto that track
5. Look at the device: status LED should be green, NOW should show current scene
6. **Test without pedals first**: use a MIDI controller or Ableton's computer keyboard MIDI to send note 60 → should fire selected scene
7. **Test with pedals**: tap each pedal, watch LAST display and scene selection
8. **Test boundaries**: select first scene, hit Prev → "blocked — at start"
9. **Test dividers**: if setlist has divider scenes, Next should skip them
10. **Verify**: the existing TinyBox-driven behavior can be bypassed or retained side-by-side until confidence is high

### Rollback
Remove the device from the track. TinyBox + existing PC-based nav still works as before. No .als damage.

---

## Open questions (need Jake input before we write code)

1. **Pedal note numbers** — what does your FCB+TinyBox currently emit for each stomp pedal? Need the 4 notes for Play/Stop/Next/Prev. (If you don't remember offhand, we'll make them configurable with sensible defaults and you set them on the device face.)

2. **MIDI input bus** — is there a dedicated IAC bus for pedals already, or should we create a new one? (Keeping pedals on a distinct bus from beat/transport MIDI is cleaner for routing but not required.)

3. **Divider convention in Ableton scenes** — today jakaraoke uses `---` or `--- Set N ---` in setlist `.txt` files. In Ableton's Session View, do you name divider scenes the same way (e.g., a scene literally named `---`), or do you use empty scenes, or do you use Ableton's built-in Stop Clip marker? This determines the `divider_regex` default.

4. **"Go" pedal (5th)** — do you want Next+Fire as a single pedal, or keep the two-step (Next stages, Play fires)? Adding in v1.1 is trivial if we defer.

5. **Double-tap Stop** — do you want single-tap = `stop_playing`, double-tap = `stop_all_clips` (harder reset)? Or keep it simple in v1 with single-tap stop only?

6. **Expression pedals** — confirm v1 leaves them on native MIDI map (not intercepted by Setlist Pilot). We discussed this but want to lock it in.

7. **Track output** — should the device eat the note (no output) or pass it through? If TinyBox still routes those same notes elsewhere (e.g., to trigger scene launch as a backup), pass-through lets both paths coexist during rollout. Eating is cleaner once confidence is high.

---

## What happens next (sequenced)

Once Jake signs off on this spec:

1. **Write pure-function module** (`setlist_pilot_core.js` or an exportable section) + Node test harness. Verify offline.
2. **Build Python generator** (`generate_setlist_pilot.py`) — template structure mirrors Lights generators but much simpler (no UI grid, just a header + config row + status row).
3. **Generate v1** — produce `.amxd` + `.js`.
4. **Commit** — in `jakaraoke` repo under `max_devices/setlist_pilot/`.
5. **Deploy + smoke-test** when gigmac is available (per runbook above).
6. **Iterate** based on gig-day feedback — new behaviors land in v1.x, breaking changes go to v2.

---

## Files to touch / create

- `/Users/jawgner/source/jakaraoke/max_devices/setlist_pilot/generate_setlist_pilot.py` (new)
- `/Users/jawgner/source/jakaraoke/max_devices/setlist_pilot/setlist_pilot_core.js` (new, pure-function module)
- `/Users/jawgner/source/jakaraoke/max_devices/setlist_pilot/test_setlist_pilot.js` (new, Node test harness)
- `/Users/jawgner/source/jakaraoke/max_devices/setlist_pilot/setlist_pilot_v1.js` (generated output, gitignored)
- `/Users/jawgner/source/jakaraoke/max_devices/setlist_pilot/Setlist Pilot v1.amxd` (generated output, gitignored)
- `/Users/jawgner/source/jakaraoke/.gitignore` — add `*.amxd` and generated `*_v*.js`


---

## RESOLVED (2026-05-06 — all 7 open questions closed)

1. **Pedal note numbers** — Jake confirmed from `TinyBox_Code.txt`. All on **MIDI channel 3**:
   - `note 3` → Stop
   - `note 4` → Play
   - `note 5` → Record (reserved, unused in v1)
   - `note 6` → NextScene
   - `note 7` → PreviousScene **(currently emits `7,7,6` kludge — TinyBox reprogram required to emit raw `7`)**
   - `note 8` → TapTempo (reserved, unused in v1)
   - `CC 1` / `CC 2` → expression pedals (native MIDI map, **not** intercepted — see #6)

2. **MIDI input bus** — No new IAC bus. Pedals arrive via **TinyBox Port 1**. The Setlist Pilot track's `MIDI From` is set to `TinyBox Port 1, Ch. 3`.
   **PRE-FLIGHT AUDIT** (April 25 gig-fail mitigation): verify every palette track's `MIDI From` is set to its *specific* IAC bus (not `All Ins`) before re-enabling the Track flag on the Setlist Pilot track for TinyBox. Jake's "remote control M4L device track" topology is believed to already enforce this; re-confirm at gigmac.

3. **Divider convention** — **`--- Set 1 ---`** style. Default regex:
   ```
   /^-+\s*(?:set\s+\d+|encore|break|intermission)?\s*-+$/i
   ```
   Matches: `---`, `--- Set 1 ---`, `----Encore----`, `---Break---`. User-overridable via `divider_regex` message.

4. **"Go" pedal** — Reserved configurable slot (`go_note`), defaults to `-1` (disabled). User opts in by setting a note number and reprogramming the pedal. When fired: `next_scene` + `fire_selected_scene` atomically.

5. **Double-tap Stop** — Not in v1. Kept simple: single tap = `stop_all_clips`. `stop_all` reserved slot (`stopall_note`) also defaults to `-1` (disabled).

6. **Expression pedals** — Confirmed: remain on native MIDI map, **not** intercepted by Setlist Pilot. CC1/CC2 continue to route to their existing destinations.

7. **Track output** — **Absorb** (no passthrough). `[notein]` feeds the `js` object only; there is no `[noteout]` in the patcher. This eliminates accidental double-triggers when the Track flag is enabled.


## Implementation status (2026-05-06)

✅ **SHIPPED** to `jakaraoke/max_devices/setlist_pilot/`:

| File | Role |
|---|---|
| `setlist_pilot_core.js` | Pure functions (141 lines). No Max/Live globals at module scope. |
| `test_setlist_pilot.js` | Node test harness — **74/74 passing**. |
| `setlist_pilot_v1.js` | M4L driver — wires LiveAPI ↔ core via `include('setlist_pilot_core.js')`. |
| `generate_setlist_pilot.py` | Builds `.amxd` ampf container. |
| `Setlist Pilot v1.amxd` | Generated bundle (23 KB). Valid ampf header. |

**Patcher layout** (presentation mode, 480×280 px):
- `notein → pack 0 0 0 → prepend note_in → [js]`
- Toggles: `skip_dividers` (default ON), `skip_empty` (default OFF)
- Numbox: `midi_channel` (default 3, 0=omni)
- Numboxes: `play_note` (4), `stop_note` (3), `next_note` (6), `prev_note` (7), `stopall_note` (-1), `go_note` (-1)
- `live.thisdevice` kicks initial `bang` → JS rebuilds scene cache & reads current selection

**Test coverage** (offline, Node):
- `isDividerName` default + custom regex (incl. whitespace, null/undefined, edge cases)
- `chooseNextIndex` / `choosePrevIndex` across: empty setlist, no-dividers, skipDividers on/off, skipEmpty on/off, both-on, boundary clamps at start/end
- `routeMidiToAction` across: default pedals ch 3, channel filter, omni (ch 0), velocity-0 reject, NoteOff reject, CC reject, reserved `stop_all`/`go` remap, disabled slots (-1), bad input (null/undefined/empty)


## Pre-deploy checklist (when gigmac is available)

Before re-enabling Track flag on Setlist Pilot track:

- [ ] **TinyBox reprogram** — emit raw note `7` for PreviousScene (eliminate `7,7,6` kludge). Verify on MIDI monitor.
- [ ] **Pre-flight audit** — walk every palette track in the lighting set, confirm `MIDI From` = specific IAC bus (not `All Ins`). Document in runbook.
- [ ] **Install** — drop `Setlist Pilot v1.amxd` + `setlist_pilot_v1.js` + `setlist_pilot_core.js` into `~/Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect/setlist_pilot/`. All three JS files colocated (the `.amxd` references `setlist_pilot_v1.js` by filename; it uses `include('setlist_pilot_core.js')`).
- [ ] **Restart Ableton** — RAM cache flush pattern from v4 lighting device.
- [ ] **Smoke test** — drag device onto a new MIDI track with `MIDI From = TinyBox Port 1, Ch. 3`, Track flag ON. Test each pedal:
  - Stop (3) → all clips stop
  - Play (4) → selected scene fires
  - Next (6) → selection advances, skipping dividers
  - Prev (7) → selection retreats, skipping dividers
- [ ] **Gig rehearsal** — full setlist walk with real scenes.


---

# POST-IMPLEMENTATION (2026-05-08) — v1.2.1 shipped, verified on gigmac

The spec above was the **plan**. What shipped differs in several ways — captured here, not in the spec, to preserve the planning → reality delta.

## v1.2.1 is live

Jake'"'"'s verdict: **"its awesome - thank you"**.

All four pedals verified end-to-end on gigmac:

| TinyBox button | Note | Behavior |
|---|---|---|
| Button 1 | 3 | Stop — instant (no launch-quant delay) |
| Button 2 | 4 | Play — fires selected scene |
| Button 3 | 7 | Back — steps backward, multi-press safe |
| Button 4 | 6 | Next — steps forward |

## Delta from spec — what we learned

### 1. Own-pointer architecture (NOT spec'"'"'d)

**Spec said:** Read `selected_scene_index` from LiveAPI, then set it to `idx±1`.

**Reality:** Ableton auto-re-selects the playing or prior scene on certain state changes, even with Follow off. Reading back from LiveAPI after a nav call returned the wrong index.

**Fix:** Device maintains its own `state.currentIdx` as source of truth. Writes LiveAPI but does not read it back.

### 2. Channel filter must be OFF at device level (NOT spec'"'"'d)

**Spec said:** `routeMidiToAction` filters by `midi_channel` numbox (default 3).

**Reality:** Ableton'"'"'s track-level `MIDI From: TinyBox Port 1, Ch. 3` filter normalizes inbound MIDI to **ch 1** before the device sees it. The device'"'"'s own ch-3 filter rejected all events.

**Fix:** Device ignores channel entirely. Track-level routing does the filtering.

### 3. Instant Stop requires `is_playing=0` (NOT spec'"'"'d)

**Spec said:** Stop = `live_set.call("stop_all_clips")`.

**Reality:** `stop_all_clips` respects Global Launch Quantization — if Ableton is set to quantize launches to 1-bar or larger, stop is delayed up to that amount. Unacceptable for a pedal.

**Fix:** Call `stop_all_clips()` AND explicitly set `live_set.is_playing = 0`. The property set is instant.

### 4. Scene-ID caching (NOT spec'"'"'d)

**Reality:** Building fresh `new LiveAPI("live_set scenes N")` per button press created 176 wrappers for a 44-scene setlist across prev/current/next + fire calls — caused Ableton crashes.

**Fix:** On `live.thisdevice` bang, iterate `scenes` once and cache `id` values. Rebuild cache only when `scenes` list notification fires.

### 5. Dividers are SIGNPOSTS, never skipped (CRITICAL UX REVERSAL)

**Spec said:** `skip_dividers` default ON (true). Matches existing jakaraoke behavior.

**Reality:** Divider scenes (`--- Set 1 ---`) are **visual orientation anchors** during a gig. When the band crosses into a new set, Jake WANTS to see the boundary arrive and pass. Skipping them erases context.

**Fix:** `skipDividers` default is now **false**. Dividers render in amber in the prev/current/next UI as highlighted signposts. This is a **locked user preference** — recorded in `~/.aki/memories/jakaraoke_project.md`.

### 6. jsui UI (NOT spec'"'"'d)

**Spec said:** Patcher has toggles + numboxes only, no custom UI.

**Reality:** A plain `[js]` status numbox doesn'"'"'t tell Jake *what song is selected* — just an index. The prev/current/next stack (◀ prev / ▶ CURRENT / ▶▶ next) is the difference between "is this pedal doing anything?" and "I can see what'"'"'s about to happen."

**Fix:** Switched to `[jsui]` pattern. Renders 3-line stack inside the device face. Dividers amber.

### 7. Physical button swap

**Spec said nothing about** TinyBox physical button ↔ firmware preset mapping.

**Reality:** Jake'"'"'s TinyBox had button 3 emitting NextScene (note 6) and button 4 emitting PreviousScene (note 7). Cognitive mismatch during play.

**Fix:** Reassigned in TinyBox patchdmp: button 3 = PreviousScene (note 7), button 4 = NextScene (note 6). Matches firmware preset names and physical layout left→right = back→next.

### 8. TinyBox firmware cleanup

**Spec assumed:** A one-line TinyBox reprogram to emit raw note 7 (eliminate `7,7,6` kludge).

**Reality:** The `PreviousScene` preset had a multi-note sequence commented out in firmware source but still **active** in runtime. Caused "press once, scene moves back then snaps forward."

**Fix:** Jake resent a clean patchdmp. Preset now emits raw note 7.

## Files shipped (in `jakaraoke/max_devices/setlist_pilot/`)

| File | Role |
|---|---|
| `setlist_pilot_v1.js` | jsui-based, 16.9 KB. Core functions inlined. |
| `generate_setlist_pilot_v1_1.py` | AMXD builder — jsui pattern. |
| `Setlist Pilot v1.amxd` | Generated bundle, 5.9 KB. |

**Removed:**
- `setlist_pilot_core.js` — inlined into `setlist_pilot_v1.js` (jsui pattern needs self-contained JS).
- Old `generate_setlist_pilot.py` — plain-js pattern, superseded.
- Old `setlist_pilot_v1.js` (9 KB, plain `[js]`) — superseded.

**Left for consideration:**
- `test_setlist_pilot.js` (Node harness, 74 tests) — currently targets old pure-function API. Either (a) port to target inlined functions in v1.js, or (b) retire in favor of live-on-gigmac smoke tests. TBD.

## Deploy runbook (v1.2.1)

```bash
cd ~/source/jakaraoke/max_devices/setlist_pilot/
scp "Setlist Pilot v1.amxd" setlist_pilot_v1.js \
  "jake@192.168.4.119:Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect/"
```

On gigmac: restart Ableton (RAM cache flush), then on your Setlist Pilot track:
- `MIDI From: TinyBox Port 1, Ch. 3` (unchanged)
- Track monitor: In or Auto
- Device: Setlist Pilot v1 (re-drag from browser if pre-existing instance is stale)

## Smoke-test checklist (post-deploy)

- [ ] Button 1 → all clips stop instantly (no launch-quant delay)
- [ ] Button 2 → selected scene fires
- [ ] Button 3 → prev/current/next display shifts one step backward, selected scene name is now the one above previous current
- [ ] Button 4 → same but forward
- [ ] Divider scene arrives → renders amber in current row; does not skip
- [ ] Multiple-button sequences (e.g., Next×3 → Play) land on intended scene
- [ ] No Ableton freeze or audio glitch on any button press

## Parked work (explicit reminder list)

1. **MIDI noise cleanup** — TinyBox Port 2 emits CC32 + ghost Ch 13 notes alongside each pedal press. Harmless today. Clean up when revisiting firmware.
2. **client.html prev/current/next overlay** — design session needed. Goal: blend with lyric scroll without eating lyric space.
3. **Setlist Pilot ↔ jakaraoke pointer sync** — both tools derive pointer from same TinyBox MIDI. If Ableton scene list diverges from jakaraoke setlist.txt mid-session, they drift. Phase 2b Set State Broadcaster makes Ableton single source of truth.

---

# v2 MERGE (2026-05-11) — SP + SSB collapsed into one device

v2 is the canonical device going forward. v1 SP + v1 SSB on separate tracks is superseded but still loadable as a rollback.

## Why merge

Running v1 SP (pedal MIDI + LiveAPI nav) on one track and v1 SSB (observers + UDP bridge) on another created a double-source-of-truth problem: SP updated its `state.currentIdx`, and SSB independently observed `selected_scene` and inferred the same pointer. Most of the time they agreed, but on rapid pedal presses the two pointers could diverge for a beat until Ableton's scene selection propagated. Merging both into a single jsui inside one `.amxd` gives us **one `state.currentIdx`** authoritative for both nav and broadcast.

## What v2 does (single device)

- **Pedal MIDI → LiveAPI nav** (inherited from v1 SP)
- **LiveAPI observers** (`selected_scene`, `is_playing`, `tempo`) — broadcast UDP state on change (inherited from v1 SSB)
- **UDP command receive** on port 9900 (`route /j` → `anything()` in jsui) — server drives `play`/`stop`/`next`/`prev`/`goto`/`refresh`/`toggle_track`
- **Playhead bar/beat stream** via `plugsync~` (see bug fix below)
- **Track mute toggle** for "Original" / "BT" tracks (navigator.html binding)
- **jsui canvas** shows prev/now/next scenes + amber divider markers, transport glyph (▶/■), current BPM

## UDP contract (unchanged from v1 SSB)

- **OUT (udpsend → 127.0.0.1:9899)**: JSON payloads with type in `{scene, transport, scenes, playhead, tracks}`
- **IN (udpreceive 9900 → route /j → jsui inlet 0)**: OSC address `/j`, single string arg = JSON command `{type:"command", action:"..."}`

## Device architecture

- **1 jsui**, inlets=2, outlets=1
- **Inlet 0** = all non-bar-beat messages: notein (via pack/prepend `note_in`), `live.thisdevice` bang (init), UDP JSON commands (via `route /j`), config messages
- **Inlet 1** = plugsync~ bar/beat list
- **Outlet 0** = UDP JSON strings → `udpsend 127.0.0.1 9899`

## Bugs found + fixed during v2 smoke test

### 1. Observer race double-broadcast

**Symptom**: every nav action (pedal or UDP cmd) produced TWO identical `scene` UDP payloads.

**Root cause**: `setSelectedScene()` called `v.set('selected_scene', 'id', sid)` BEFORE updating `state.currentIdx`. `v.set` fires the LiveAPI observer **synchronously**. The observer's no-change guard compared incoming scene idx against `state.currentIdx` (still holding the old value), saw a mismatch, and broadcast. Then the calling code updated `state.currentIdx` and called `broadcastSceneChange()` explicitly → second broadcast.

**Fix**: assign `state.currentIdx = idx` FIRST, then `v.set(...)`. The observer now sees `state.currentIdx` already matches, skips. Only the explicit broadcast fires.

### 2. plugsync~ wrong outlets + wrong signal handling

**Symptom**: playhead bar/beat stream never fired. All samples showed `0. 0.` even during playback.

**Root cause 1 — outlet mapping**: v1 SSB (and inherited v2 v1) connected `plugsync~` outlets 2 and 3 to `snapshot~`. Per Max8 docs, those are actually **beat (int, 1-idx) and beat-fraction (float 0..1)**. The bar outlet is **outlet 1**. Note plugsync~ has **9 outlets**, not 5, and they're a mix of int and float (NOT all signals).

**Root cause 2 — snapshot~ misuse**: `snapshot~` expects signal-rate input and samples it into float messages. plugsync~ outlets 1, 2, 3, etc. are **message outlets** (int/float), not signals. Wiring them into snapshot~'s signal inlet silently gave us `0.0` in perpetuity.

**Fix**:
- Drop `snapshot~` entirely
- Drop redundant `metro 200` + `loadmess 1` (snapshot~ was self-sampling, metro double-banged)
- Wire `plugsync~` outlet 1 (bar) → `change` → `pack i i` inlet 0
- Wire `plugsync~` outlet 2 (beat) → `change` → `pack i i` inlet 1
- `change` filters plugsync~'s continuous stream to transitions only
- `pack` emits list to jsui inlet 1 → `list()` callback dedups by bar change → UDP `playhead`

### 3. Tempo/transport observer did not trigger canvas redraw

**Symptom**: Ableton BPM changed (e.g., scene-baked tempo) — v2 correctly broadcast new tempo via UDP, but the device's own canvas readout kept showing the old BPM.

**Root cause**: `tempoCallback` and `transportCallback` updated `state` and called `broadcastTransport()`, but never called `mgraphics.redraw()`. Canvas only repainted on the next natural trigger (scene change, mouse event).

**Fix**: Append `mgraphics.redraw()` to both observer callbacks. One-line fix each.

## Smoke test results (2026-05-11)

| Subsystem | Result |
|---|---|
| Pedal MIDI (notes 3/4/6/7) → action dispatch | ✅ |
| Scene nav (prev/next/goto) — exactly 1 UDP broadcast per action | ✅ |
| UDP command receive (play/stop/next/prev) | ✅ |
| UDP command receive (toggle_track "Original"/"BT") | ✅ |
| Transport observer (is_playing) → UDP + redraw | ✅ |
| Tempo observer → UDP + redraw | ✅ |
| Scene-list broadcast on init | ✅ |
| Track state broadcast on init + on toggle | ✅ |
| Playhead bar/beat stream — 1 UDP per bar change | ✅ |

## Files shipped

In `jakaraoke/max_devices/setlist_pilot/`:
- `Setlist Pilot v2.amxd` (10,135 bytes) — production build
- `setlist_pilot_v2.js` (23,238 bytes) — production build
- `generate_setlist_pilot_v2.py` — regenerator (run to rebuild .amxd from JS+layout)

v1 files retained alongside for rollback reference:
- `Setlist Pilot v1.amxd`, `setlist_pilot_v1.js`, `generate_setlist_pilot_v1_1.py`, `test_setlist_pilot.js`

## Operational workflow tools adopted during v2

- **Log transfer via clipboard** — Jake copies Max console text on gigmac (cmd-C), says "log in clipboard"; we run `ssh gigmac pbpaste` to fetch. No files, no email loop.
- **UDP command injection for smoke tests** — tiny Python one-liner constructs OSC packet (address `/j`, type `,s`, JSON arg) and sendto 127.0.0.1:9900. Lets us test `toggle_track`, `refresh`, etc. without running the full jakaraoke server:
  ```python
  import socket
  addr = b"/j\x00\x00"
  tags = b",s\x00\x00"
  s = b'{"type":"command","action":"toggle_track","track":"Original"}'
  pad = (-len(s) - 1) % 4
  msg = addr + tags + s + b"\x00" * (pad + 1)
  socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(msg, ("127.0.0.1", 9900))
  ```

## Rollback

If v2 regresses during a gig:
1. Remove v2 device from its track in Ableton
2. Re-enable the v1 SP + v1 SSB devices on their original tracks (LEDs → on)
3. No server-side change required — UDP contract identical

## v2 cleanup backlog (low priority)

1. Remove v1 SP + v1 SSB from the original track after N gigs of v2 soak-test
2. `SETLIST_PILOT_SPEC.md` planning sections (Pre-Implementation / Open Questions / Implementation Status) could be moved to an `archive/` subdir — they're historical context, not current truth
