# AI Handoff — Jakaraoke

> **READ THIS FIRST** if you are an AI assistant picking up this project.
> Updated 2026-05-11. Supersedes all prior versions.

---

## Project at a glance

Jake plays live music (solo + band). He uses Ableton Live in **Session View**
where each scene = one song. Guitar pedals (FCB-1010 → TinyBox → MIDI)
navigate scenes and trigger playback. **Jakaraoke** is a system that displays
lyrics and setlist state on tablets for the whole band.

**Ableton is the single source of truth.** The server is a relay, not an authority.

---

## Essential Docs (read in order)

| Doc | Location | Purpose |
|---|---|---|
| **ECOSYSTEM.md** | `docs/ECOSYSTEM.md` | Full architecture, signal paths, config model, slug matcher |
| **SET_STATE_BROADCASTER_SPEC.md** | `docs/SET_STATE_BROADCASTER_SPEC.md` | M4L device wire protocol (UDP 9899/9900) |
| **SETLIST_PILOT_SPEC.md** | `docs/SETLIST_PILOT_SPEC.md` | Pedal→LiveAPI navigation device (deployed) |

**ECOSYSTEM.md is the authoritative architecture reference.** If anything in
this handoff conflicts with ECOSYSTEM.md, ECOSYSTEM.md wins.

---

## Workspace & Repo Structure

- **Repo:** `/Users/jawgner/source/jakaraoke/` (git, deployed to gigmac)
- **Workspace:** `/Users/jawgner/JakeDocs/AI_Workspaces/Jakaraoke/` (staging, tools, docs)
- **Song libraries:** Dropbox-synced ChordPro `.txt` files (WingPunchDB, SoloSetDB, StartUpDB)
- **Local song copy:** `/Users/jawgner/source/Song_Repo/WingPunchDB/`

```
jakaraoke/
├── server/
│   ├── websocket-server.js      ← main server (Node.js, port 9898)
│   ├── server-additions.js      ← slug matcher, ready-check, command relay
│   ├── udp-bridge.js            ← UDP 9899/9900 integration (Phase 2b)
│   ├── config.local.json        ← per-machine config (library paths, .als path)
│   └── test-server-additions.js ← 31 tests
├── views/
│   ├── lyrics.html              ← Jake/Lisa tablet view
│   ├── navigator.html           ← Nate/Toni setlist navigation
│   └── stage_monitor.html       ← legacy (being superseded)
├── docs/
│   ├── AI_HANDOFF.md            ← this file
│   ├── ECOSYSTEM.md             ← ARCHITECTURE REFERENCE
│   ├── SET_STATE_BROADCASTER_SPEC.md
│   └── SETLIST_PILOT_SPEC.md
└── tools/
    └── validate-setlist.js      ← slug match validation CLI tool
```

---

## User Preferences (critical)

- ⚠️ **DO NOT generate `.als` files** — Jake handles Ableton integration manually
- ⚠️ **M4L deploy target:** `/Users/jake/Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect/`
- Wants to test each change before moving on. Do not batch unrelated changes.
- Prefers terse summaries with a testing checklist after each edit.
- Pressure-test mental models before implementing. Align on semantics first.
- The tablet is mounted to a mic stand — design for **glanceability** (huge text, high contrast, dark BG)
- Song libraries are ChordPro `.txt` files synced via Dropbox
- **Never** add MIDI listeners to the server for navigation
- **Never** maintain a server-side song pointer that diverges from Ableton
- Divider scenes (`--- Set 1 ---`) are first-class navigation targets, render in amber
- Parking lot songs (below `--------` divider) are hidden from UI

---

## Surfaces (5 devices, 2 view types)

| Person | Device | View | Role |
|---|---|---|---|
| Jake | tablet (mic stand) | lyrics.html | Lyrics + chords, auto-scroll |
| Lisa | tablet (mic stand) | lyrics.html | Lyrics, can advance songs |
| Nate | computer (drums) | navigator.html | Setlist nav, ready-check |
| Toni | phone | navigator.html | Setlist nav, ready-check |
| gigmac | hidden rack | — | Ableton + M4L + server |

---

## Architecture Summary

```
FCB-1010 → TinyBox → Setlist Pilot v2 M4L ──→ Ableton LiveAPI (source of truth)
                       │  (merged SP + SSB)          │
                       │  LiveAPI observers          │
                       ▼                             │
                    UDP:9899 (state) ◄───────────────┘
                       │                        ▲ UDP:9900 (commands)
                       ▼                        │
                    jakaraoke server (port 9898)
                       │ WebSocket (LAN Wi-Fi)
    ┌──────────────────┼───────────────────┐
lyrics.html        navigator.html       (future views)
```

As of 2026-05-11, **Setlist Pilot v2** is a single merged M4L device (jsui) that
replaces the v1 pair (Setlist Pilot + Set State Broadcaster). Same UDP contract,
single source of pointer truth (`state.currentIdx`), one track instead of two.

All control paths (pedal, tablet buttons, direct Ableton, server UDP commands)
converge at Ableton, then flow through v2's observers to all clients identically.
See `SETLIST_PILOT_SPEC.md` → "v2 MERGE" section for rationale + smoke-test results.

See **ECOSYSTEM.md** for detailed signal flows, config model, and design decisions.

---

## Configuration

`config.local.json` (per-machine, not committed):

```json
{
  "libraries": [
    { "name": "WingPunch", "path": "/path/to/WingPunchDB", "als": "/path/to/practice.als" }
  ],
  "activeLibrary": "WingPunch"
}
```

Switching `activeLibrary` changes song repo + scene list together (different band = different config).

---

## Implementation Status (2026-05-11)

| Component | Status |
|---|---|
| **Setlist Pilot v2** (merged SP + SSB) | ✅ Deployed on gigmac, fully smoke-tested |
| Setlist Pilot v1 (standalone) | ⚪ Superseded by v2; retained on original track for rollback |
| Set State Broadcaster v1 (standalone) | ⚪ Superseded by v2; retained on original track for rollback |
| Server (core WS + ChordPro) | ✅ Running on gigmac |
| Server additions (slug matcher, ready-check, command relay) | ✅ Deployed |
| Server UDP bridge | ✅ Deployed |
| Navigator view | ✅ Deployed on gigmac |
| Lyrics view | ✅ Deployed on gigmac |
| Late-joiner sync | ✅ Deployed |
| Navigator health banner | ⏭ Pending |
| Measure-accurate scroll | ⏭ Pending (v2 now broadcasts playhead bar/beat) |

---

## Deploy to gigmac

```bash
# From workspace:
scp -r staging/server/* gigmac:~/source/jakaraoke/server/
scp -r staging/views/* gigmac:~/source/jakaraoke/views/

# On gigmac:
cd ~/source/jakaraoke && ./stop.sh && ./start.sh
```

M4L devices: scp to `/Users/jake/Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect/`
Then close + reopen Ableton (RAM cache flush required).

---

## Gigmac Reference

- **Host:** SSH alias `gigmac` (IP updated occasionally in `~/.ssh/config`; 10.49.5.129 as of 2026-05-11)
- **Node:** `/usr/local/bin/node`
- **Ableton .als:** `~/Music/Ableton/Startup/NewBand_Practice Project/NewBand_Practice_12.3.als`
- **CloudStorage:** NOT accessible via SSH (macOS sandbox). Jake runs server from Terminal.
- **Log capture**: `ssh gigmac pbpaste` — pulls whatever is on gigmac's macOS clipboard. Jake copies Max console text (cmd-C) → we fetch. Replaces the email-to-self loop.
- **UDP command injection** (smoke testing without running the server): send OSC address `/j` + type `,s` + JSON arg to 127.0.0.1:9900. See `SETLIST_PILOT_SPEC.md` → v2 section for a Python one-liner.

---

## For Future AIs — Hard Rules

1. Read **ECOSYSTEM.md** before making any changes
2. Ableton is the source of truth. The server is a relay.
3. The M4L Set State Broadcaster is the ONLY bridge between Ableton and the network
4. Never add MIDI listeners to the server for navigation
5. Never maintain a server-side pointer that can diverge from Ableton
6. Test with ALL control paths — if any path breaks the others, the design is wrong
7. Scene names are short/imprecise — the slug matcher handles the mapping
8. Performance never depends on jakaraoke working (graceful degradation)
