# AI Handoff — Jakaraoke

> **READ THIS FIRST** if you are an AI assistant picking up this project.
> Updated 2026-05-09. Supersedes all prior versions.

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
FCB-1010 → TinyBox → Setlist Pilot M4L → Ableton LiveAPI
                                              │ (single source of truth)
                    Set State Broadcaster M4L ─┘
                         │ UDP:9899 (state)        ▲ UDP:9900 (commands)
                         ▼                         │
                    jakaraoke server (port 9898) ───┘
                         │ WebSocket (LAN Wi-Fi)
    ┌────────────────────┼────────────────────┐
lyrics.html        navigator.html        (any future view)
```

All control paths (pedal, tablet buttons, direct Ableton) converge at Ableton,
then flow through the Set State Broadcaster to all clients identically.

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

## Implementation Status (2026-05-09)

| Component | Status |
|---|---|
| Setlist Pilot M4L v1 | ✅ Deployed on gigmac |
| Set State Broadcaster M4L | ⏭ **Next to build** |
| Server (core WS + ChordPro) | ✅ Running on gigmac |
| Server additions (slug matcher, ready-check, command relay) | 🔨 Staged |
| Server UDP bridge | 🔨 Staged |
| Startup validation (slug health) | 🔨 Staged |
| Navigator view | ✅ Deployed on gigmac |
| Lyrics view | ✅ Deployed on gigmac |
| Late-joiner sync | ⏭ Pending |
| Navigator health banner | ⏭ Pending |

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

- **Host:** `jake@192.168.4.119` (SSH alias `gigmac`)
- **Node:** `/usr/local/bin/node`
- **Ableton .als:** `~/Music/Ableton/Startup/NewBand_Practice Project/NewBand_Practice_12.3.als`
- **CloudStorage:** NOT accessible via SSH (macOS sandbox). Jake runs server from Terminal.

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
