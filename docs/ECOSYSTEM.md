# Jakaraoke Ecosystem — Full Signal Path

> **Read this first** for any jakaraoke work. This documents the complete system
> architecture, control flows, and design principles.

---

## Core Principle

**Ableton Live is the single source of truth for performance state.**

"State" = which song we're on, whether we're playing, what bar we're at.
Nothing else maintains independent state. The server is a **relay**, not an authority.

### Why This Matters

Any control surface — pedal, tablet button, direct Ableton interaction — results
in Ableton's state changing. The M4L Set State Broadcaster observes that change
and broadcasts it. The *cause* of the change is irrelevant to downstream consumers.

**Anti-pattern (rejected):** Server listens to pedal MIDI directly and maintains
its own pointer. This breaks when ANY other method is used to control Ableton
(mouse click, different pedal, Setlist Pilot, direct scene selection). Never do this.

---

## Control Surfaces (Who Can Change State)

Priority order reflects who typically controls during performance:

| Priority | Person | Method | Signal Path |
|---|---|---|---|
| 1 | Jake | Guitar pedal (FCB-1010 → TinyBox) | MIDI → Setlist Pilot M4L → LiveAPI |
| 2 | Lisa | Lyrics view "next/prev" button | WS → server → UDP:9900 → Set State Broadcaster → LiveAPI |
| 3 | Nate/Toni | Navigator view buttons | WS → server → UDP:9900 → Set State Broadcaster → LiveAPI |
| 4 | Jake (backup) | Direct Ableton interaction | Mouse/keyboard → Ableton directly |

**All four paths converge at step 4 below.**

---

## Signal Flows

### Pedal path (Jake, primary)
```
1. FCB-1010 foot press
2. TinyBox receives, emits MIDI (ch3, notes 3/4/6/7)
3. Setlist Pilot M4L hears MIDI, calls LiveAPI (fire scene, navigate)
4. Ableton scene changes
5. Set State Broadcaster M4L observes change, emits UDP:9899 → server
6. Server receives state, slug-matches scene → ChordPro, broadcasts to WS clients
7. All tablets update
```

### Tablet path (Lisa/Nate/Toni)
```
1. User taps "Next" on lyrics.html or navigator.html
2. WebSocket command → jakaraoke server
3. Server forwards command via UDP:9900 → Set State Broadcaster M4L
4. M4L receives, calls LiveAPI (navigate to next scene)
5. Ableton scene changes
6. Set State Broadcaster observes change, emits UDP:9899 → server
7. Server receives state, slug-matches, broadcasts to WS clients
8. All tablets update (including the one that initiated)
```

### Direct Ableton path (Jake backup / rehearsal)
```
1. Jake clicks scene in Ableton, or uses keyboard shortcut
2. Ableton scene changes
3. Set State Broadcaster M4L observes change, emits UDP:9899 → server
4. Server receives state, slug-matches, broadcasts to WS clients
5. All tablets update
```

### Key Insight

Steps 4→onward are IDENTICAL in all paths. The broadcaster doesn't know or
care WHY the scene changed. It just observes and announces.

---

## M4L Devices on gigmac

| Device | Track | Role |
|---|---|---|
| **Setlist Pilot v1** | Utility (MIDI From: TinyBox) | Pedal → LiveAPI navigation |
| **Set State Broadcaster** | Same track | Observe state → UDP:9899 broadcast + UDP:9900 command receiver |

Both devices share a track. Setlist Pilot translates pedal MIDI to LiveAPI calls.
Set State Broadcaster watches state and bridges to the jakaraoke server.

Note: "Setlist Pilot" and "Set State Broadcaster" may merge into one device later,
but conceptually they are separate concerns (input translation vs. state observation).

---

## Network Topology (all on gigmac / localhost)

```
┌─────────────────────────────────────────────────────────┐
│  gigmac (192.168.4.119)                                  │
│                                                          │
│  Ableton Live ◄──── LiveAPI ────► M4L devices            │
│       │                              │   ▲               │
│       │ (state changes)              │   │               │
│       ▼                              ▼   │               │
│  Set State Broadcaster         UDP:9899  UDP:9900        │
│                                      │   │               │
│                                      ▼   │               │
│  jakaraoke server (port 9898) ◄──────┘   │               │
│       │         └────────────────────────┘               │
│       │ WebSocket                                        │
│       ▼                                                  │
└───────┼──────────────────────────────────────────────────┘
        │ LAN (Wi-Fi)
        ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Jake tablet │  │ Lisa tablet │  │ Nate/Toni   │
│ lyrics.html │  │ lyrics.html │  │navigator.html│
└─────────────┘  └─────────────┘  └─────────────┘
```

---

## State Messages (M4L → Server, UDP:9899)

| Type | When | Purpose |
|---|---|---|
| `scene` | Selected scene changes | Song navigation — slug-match to ChordPro |
| `transport` | Play/stop/tempo change | Scroll start/stop, tempo for timing |
| `playhead` | Bar number increments (while playing) | Measure-accurate lyrics scroll |
| `scenes` | Device init + scene list changes | Build/validate setlist model |

## Commands (Server → M4L, UDP:9900)

| Action | Effect |
|---|---|
| `play` | Fire selected scene (starts clips) |
| `stop` | Stop all clips + transport |
| `next` | Navigate to next scene |
| `prev` | Navigate to previous scene |

---

## Configuration Model

One `config.local.json` file per machine. Each library entry pairs a song repo
with its Ableton .als file (scene source). Switching `activeLibrary` changes the
entire context — different band = different songs + different scenes.

```json
{
  "libraries": [
    { "name": "WingPunch", "path": "/path/to/WingPunchDB", "als": "/path/to/WingPunch.als" },
    { "name": "SoloSet", "path": "/path/to/SoloSetDB", "als": "/path/to/solo.als" }
  ],
  "activeLibrary": "WingPunch"
}
```

**On startup**, the server:
1. Loads all song filenames from the active library path
2. Parses scene names from the .als file (gzipped XML)
3. Runs the slug matcher against all scenes
4. Stores match results as server state (exposed to clients via WS)
5. Logs warnings for unmatched/ambiguous scenes

**When M4L sends a `scenes` message** (Phase 2b), it overrides the .als-derived
scene list with the live runtime list and re-runs validation.

---

## Startup Validation (slug match health)

The server validates ALL scene-to-song mappings on boot. Results are:
- Logged to console (operator sees issues immediately)
- Sent to Navigator clients (health banner: "51/53 matched" or "⚠️ 2 unmatched")
- Unmatched scenes highlighted in the Navigator scene list

This ensures naming issues are discovered during setup/soundcheck, never mid-gig.

**Slug matcher rules:**
1. Strip leading `*` from scene name (guitar solo marker)
2. Slugify: lowercase, strip punctuation/apostrophes, collapse whitespace
3. Pass 1: exact slug match (scene slug == file slug)
4. Pass 2: word-boundary substring (scene slug appears at word boundary in file slug)
5. Disambiguation: if multiple matches, prefer shortest file slug
6. Pass 3: metadata `{title:}` inside ChordPro file (fallback)
7. No match → reported as unmatched

---

## Server Role (relay + enrichment)

The server does NOT maintain independent navigation state. It:

1. **Receives** state from M4L (UDP:9899)
2. **Enriches** it — slug-matches scene name → loads ChordPro file content
3. **Broadcasts** enriched state to all WS clients
4. **Relays** client commands back to M4L (WS → UDP:9900)
5. **Serves** the HTML views (lyrics, navigator)
6. **Caches** current state for late-joiners (new client connects → gets current song immediately)

### Late-Joiner Sync

When a WebSocket client connects, the server MUST immediately send:
- Current song (scene name + ChordPro content)
- Current transport state (playing/stopped, tempo)
- Current playhead position (if playing)

This ensures a device joining mid-set sees the same state as everyone else.

---

## Scene-to-Song Mapping (Slug Matcher)

Ableton scene names are short nicknames (space-constrained). ChordPro files have
full song titles. The slug matcher bridges this:

1. Slugify both scene name and song filename (lowercase, strip punctuation, collapse whitespace)
2. Try exact match
3. Try substring match (scene slug contained in song slug, or vice versa)
4. Try metadata `{title:}` inside ChordPro file
5. No match → display scene name without lyrics + warning

Scene names come from Ableton's LOM at runtime (`live_set.scenes[N].name`).
Actual examples from the WingPunch practice set (88 scenes):

```
--- Set 1 ---          ← divider (render in amber, first-class nav target)
Walk Like An Egyptian
*Beat It               ← asterisk = guitar solo marker (strip before matching)
Sally When The         ← short nickname for "Sally When the Wine Runs Out"
Havent Found/Stand By Me  ← slash = medley
--- Set 2 ---
Genie in a Botte      ← typo (slug matcher must be fuzzy)
Jenny 8675309          ← numbers in name
--- BTL ---            ← "Below The Line" divider
--------               ← PARKING LOT divider (songs below are inactive/historical)
Cake By The Ocean      ← parking lot song (not played, kept for future)
```

**Pre-processing before slug match:**
1. Strip leading `*` (guitar solo marker — ignore entirely)
2. Detect dividers: contains `---` or is all hyphens
3. Detect parking lot: everything after the `--------` divider is inactive
4. Medley scenes (slash in name) map to a single ChordPro file — no splitting

**Navigator display rules:**
- Show all scenes from first scene through the parking lot divider (exclusive)
- Dividers render in amber as section headers (not selectable songs)
- Parking lot songs are hidden entirely
- Asterisks stripped from display

---

## Transport & Scroll

- **Play** → triggers lyrics auto-scroll (using tempo + time signature for speed)
- **Stop** → freezes scroll position (does NOT reset to top — user may scrub in Ableton)
- **Playhead bar:N** → anchors scroll to `{bar:N}` tag in ChordPro content
  - This enables mid-song scrubbing: Ableton jumps to bar 40, lyrics jump to matching line
  - Songs need `{bar:N}` tags in their ChordPro files for measure-accurate scroll

---

## What The Server Does NOT Do

- ❌ Maintain its own song pointer independent of Ableton
- ❌ Listen to pedal MIDI directly (that's Setlist Pilot's job)
- ❌ Decide navigation logic (next/prev skip logic lives in M4L, not server)
- ❌ Own the setlist order (Ableton's scene list IS the setlist)

---

## Failure Modes & Degradation

| Failure | Impact | Mitigation |
|---|---|---|
| M4L device not loaded | Tablets show nothing | Jake navigates Ableton directly; no tablet sync |
| Server down | Tablets disconnected | Performance continues (Ableton + pedal work fine) |
| WiFi drops | Individual tablet loses sync | Auto-reconnect + late-joiner sync on reconnect |
| Pedal fails | Jake uses tablet or direct Ableton | All paths work independently |

The system is designed so that **the performance never depends on jakaraoke working**.
Ableton + pedal is the minimum viable path. Jakaraoke is a convenience layer.

---

## Implementation Status

| Component | Status | Location |
|---|---|---|
| Setlist Pilot M4L v1 | ✅ Deployed | gigmac Ableton User Library |
| Set State Broadcaster M4L | ⏭ Next to build | Spec: `docs/SET_STATE_BROADCASTER_SPEC.md` |
| Server UDP bridge | 🔨 Staged | `staging/server/udp-bridge.js` |
| Server slug matcher | ✅ Built (31 tests) | `staging/server/server-additions.js` |
| Navigator view | ✅ Deployed | gigmac `views/navigator.html` |
| Lyrics view | ✅ Deployed | gigmac `views/lyrics.html` |
| Late-joiner sync | ⏭ Pending | Trivial addition to WS connect handler |

---

## For Future AIs

1. **Never** add MIDI listeners to the server for navigation. The server doesn't touch MIDI.
2. **Never** maintain a server-side song pointer that can diverge from Ableton.
3. The M4L device is the ONLY bridge between Ableton and the network.
4. Test with ALL control paths (pedal, tablet, direct) — if any path breaks the others, the design is wrong.
5. Scene names are short and imprecise — the slug matcher must be fuzzy.
6. Divider scenes (`--- Set 1 ---`) are first-class navigation targets. Render them, don't skip them.
