# Set State Broadcaster + Command Receiver — M4L Device Spec

> **Purpose:** Make Ableton the single source of truth for all jakaraoke clients.
> Replaces the dual-pointer problem (Setlist Pilot ↔ jakaraoke server) with a
> unidirectional state push from Ableton → server, and a command path back.

---

## Overview

One M4L MIDI Effect device on any track (Master or dedicated utility track).
Two roles in one device:

1. **Broadcaster** — observes Live state via LiveAPI + plugsync~, pushes JSON over UDP to jakaraoke server
2. **Receiver** — listens for commands from jakaraoke server via UDP, executes LiveAPI calls

```
┌─────────────────────────────────────────────────────────────┐
│  Ableton Live (gigmac)                                      │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Set State Broadcaster (M4L device)                 │    │
│  │                                                     │    │
│  │  LiveAPI observers ──┐                              │    │
│  │  [plugsync~] ────────┼──▶ [js] ──▶ [udpsend 9899]  │    │
│  │                      │                              │    │
│  │  [udpreceive 9900] ──┼──▶ [js] ──▶ LiveAPI calls   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
         │ UDP :9899                    ▲ UDP :9900
         ▼                              │
┌─────────────────────────────────────────────────────────────┐
│  jakaraoke server (same machine, localhost)                  │
│                                                             │
│  UDP listener :9899 ──▶ update state ──▶ broadcast to WS    │
│  WS command received ──▶ UDP send :9900 ──▶ M4L executes    │
└─────────────────────────────────────────────────────────────┘
```

---

## Port Assignments

| Port | Direction | Protocol | Purpose |
|---|---|---|---|
| 9898 | clients ↔ server | WebSocket (TCP) | Existing jakaraoke WS |
| 9899 | M4L → server | UDP | State broadcast (scene, transport, bar) |
| 9900 | server → M4L | UDP | Commands (play, stop, next, prev) |

All on localhost (127.0.0.1). No firewall concerns.

---

## Wire Protocol: M4L → Server (port 9899)

All messages are JSON strings terminated by newline (`\n`).
One message per UDP packet. Max size ~500 bytes (well under UDP MTU).

### Message types

#### 1. `scene` — scene selection changed

Sent when: `live_set.view.selected_scene` observer fires.

```json
{
  "type": "scene",
  "index": 3,
  "name": "Wagon Wheel",
  "count": 44
}
```

- `index`: 0-based scene index in Ableton
- `name`: scene name string (what we slug-match to ChordPro files)
- `count`: total number of scenes (for "3 of 44" display)

#### 2. `transport` — play state changed

Sent when: `live_set.is_playing` observer fires, or `live_set.tempo` changes.

```json
{
  "type": "transport",
  "state": "playing",
  "tempo": 128.0,
  "time_sig": [4, 4]
}
```

- `state`: `"playing"` | `"stopped"` (Ableton has no "paused" — stop is stop)
- `tempo`: BPM float
- `time_sig`: [numerator, denominator]

#### 3. `playhead` — bar changed

Sent when: `[plugsync~]` detects bar number increment (once per bar while playing).

```json
{
  "type": "playhead",
  "bar": 43,
  "beat": 2
}
```

- `bar`: 1-based bar number (matches Ableton's transport display)
- `beat`: 1-based beat within the bar (1–N where N = time sig numerator)

**Frequency:** ~1 message per 1-2 seconds while playing. Silent when stopped.

#### 4. `scenes` — full scene list (sent on device init + scene list change)

Sent when: device loads, or `live_set.scenes` list length changes.

```json
{
  "type": "scenes",
  "scenes": ["Wagon Wheel", "--- Set 1 ---", "Call Me Al", "Hotel California", ...]
}
```

This allows the server to build its setlist model directly from Ableton's scene list,
eliminating the need for separate setlist.txt files (stretch goal — initially the server
can use this for validation/warning only).

---

## Wire Protocol: Server → M4L (port 9900)

Commands from clients, relayed by the server. Same JSON-per-packet format.

#### 1. `command` — transport/nav action

```json
{
  "type": "command",
  "action": "play"
}
```

Valid actions:
- `play` → `live_set.view.selected_scene.fire()` (fires selected scene)
- `stop` → `live_set.stop_all_clips()` + `live_set.is_playing = 0` (instant stop)
- `next` → increment `selected_scene_index`, skip dividers per config
- `prev` → decrement `selected_scene_index`, skip dividers per config

Note: `next`/`prev` reuse the same own-pointer logic from Setlist Pilot v1.2.1.
The Command Receiver can literally import the navigation logic.

---

## M4L Patcher Structure

```
[live.thisdevice] → bang → [js set_state_broadcaster.js]
                                    │
[plugsync~ @bar 1] ─────────────────┤ (inlet 1: bar/beat from plugsync~)
                                    │
[live.observer selected_scene] ─────┤ (inlet 2: scene change notification)
[live.observer is_playing] ─────────┤ (inlet 3: transport change)
[live.observer tempo] ──────────────┤ (inlet 4: tempo change)
                                    │
                              [outlet 0] → [udpsend 127.0.0.1 9899]
                                    
[udpreceive 9900] → [fromsymbol] → [js] inlet 5 (commands from server)
```

### Why `[plugsync~]` for bar numbers

`[plugsync~]` is a signal-rate object that outputs bar/beat/tick position
directly from Ableton's internal transport. It:
- Accounts for all time signature changes in the arrangement
- Gives us the exact bar number Ableton shows in its transport display
- Updates every sample (we only need to emit on bar-change → cheap polling at bang rate)

In the JS, we poll `plugsync~` output via `[snapshot~]` every 100ms and emit
a `playhead` message only when bar number changes.

### Alternative: `[transport]` object

Max's `[transport]` object can also output bars:beats:ticks. Either works.
`[plugsync~]` is preferred because it explicitly follows Live's transport
(not Max's internal transport which can diverge in M4L context).

---

## Server-Side Integration (in websocket-server.js)

Add a UDP listener on port 9899:

```javascript
var dgram = require('dgram');
var udpServer = dgram.createSocket('udp4');

udpServer.on('message', function(msg) {
  try {
    var data = JSON.parse(msg.toString());
    handleAbletonState(data);
  } catch(e) { console.error('UDP parse error:', e); }
});

udpServer.bind(9899, '127.0.0.1');
```

`handleAbletonState(data)` processes each message type:

- `scene` → slug-match scene name → load ChordPro → broadcast song to WS clients
- `transport` → update server transport state → broadcast to WS clients  
- `playhead` → broadcast `{type:"playhead", bar, beat}` to WS clients
- `scenes` → rebuild internal setlist model from Ableton's scene list

For command relay (server → M4L), add UDP send:

```javascript
var udpClient = dgram.createSocket('udp4');

function sendToAbleton(command) {
  var msg = Buffer.from(JSON.stringify(command) + '\n');
  udpClient.send(msg, 9900, '127.0.0.1');
}
```

Update the `handleCommand()` function in `server-additions.js` to call `sendToAbleton()`
instead of (or in addition to) executing locally.

---

## Migration Path (phased)

### Phase A: Broadcaster only (read path)

1. Deploy M4L device on gigmac
2. Server listens on UDP 9899, receives scene/transport/playhead
3. Server uses scene name to slug-match and load songs (replaces MIDI-driven pointer)
4. Existing MIDI path (IAC → JZZ) remains active as fallback
5. If both paths agree → confidence. If they diverge → log warning.

### Phase B: Command receiver (write path)

1. Server forwards client commands via UDP 9900 → M4L
2. M4L executes LiveAPI calls (same as Setlist Pilot)
3. Navigator/Lyrics views can now control Ableton directly
4. Setlist Pilot device remains for pedal control (separate track, same LiveAPI calls)

### Phase C: MIDI retirement

1. Remove JZZ MIDI listener from server (no more IAC dependency)
2. jakaraoke server becomes pure WebSocket + UDP relay (simpler, more portable)
3. TinyBox → Setlist Pilot is the only MIDI path remaining

---

## Open Questions (to resolve during implementation)

1. **plugsync~ bar output format:** Need to verify: does it output 1-based bar numbers
   or 0-based? And does it handle the "song start at bar 1" case correctly for Live's
   Session View (which has a different concept of "song position" than Arrangement)?
   
   **Hypothesis:** In Session View, `plugsync~` reports position relative to when
   the scene was launched. So bar 1 = start of currently playing clip. This is exactly
   what we want for lyrics scrolling.

2. **Scene observer granularity:** Does `live_set.view.selected_scene` fire when
   the user clicks a scene AND when Setlist Pilot changes it via LiveAPI? (Should be yes —
   observers fire on any change regardless of source.)

3. **Same-machine UDP latency:** Expected <1ms on localhost. Verify no packet loss
   under load (44 scenes × observer spam during bulk operations).

4. **Device placement:** Master track or dedicated utility track? Master is simpler
   (always loaded), but utility track keeps it organized with Setlist Pilot.
   Recommendation: same track as Setlist Pilot (shared context, one MIDI From = TinyBox).

---

## Generator: `generate_set_state_broadcaster.py`

Follows the established pattern from Lights/Setlist Pilot:
- Python script builds `.amxd` + `.js` sidecar
- Uses `write_amxd()` from the ampf template (jsui pattern not needed — no UI face)
- Patcher objects: `live.thisdevice`, `plugsync~`, `snapshot~`, `live.observer` ×3,
  `udpsend`, `udpreceive`, `fromsymbol`, `js`

Estimated size: ~200 lines Python generator, ~150 lines JS.

---

## Testing Strategy

1. **Offline (no Ableton):** Unit-test the slug matcher against song repo (already done: 31 tests passing)
2. **Server UDP listener:** Start server, send mock UDP packets via `echo '{"type":"scene",...}' | nc -u 127.0.0.1 9899`
3. **M4L in Ableton:** Load device, observe console prints. Verify scene/transport/bar messages emit.
4. **End-to-end:** Press pedal → Ableton scene changes → M4L emits → server receives → clients update.
   Measure total latency (target: <100ms from pedal press to client display update).

