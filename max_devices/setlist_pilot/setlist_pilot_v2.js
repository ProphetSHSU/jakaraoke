// setlist_pilot_v2.js
// Merged device: Setlist Pilot (pedal MIDI + scene nav) + Set State Broadcaster
// (LiveAPI observers + UDP broadcast + UDP command receive + bar/beat stream).
//
// Inlets:
//   0: all messages — note_in, config, init bang (live.thisdevice), UDP JSON commands
//   1: list(bar, beat) — from plugsync~ → snapshot~ → pack
//
// Outlets:
//   0: UDP JSON strings → [udpsend 127.0.0.1 9899]
//
// UDP contract (see server/udp-bridge.js):
//   OUT types: "scene", "transport", "scenes", "playhead", "tracks"
//   IN commands (JSON on inlet 0): {type:"command", action:"play|stop|next|prev|refresh|goto|toggle_track", ...}
//
// Load sequence:
//   [live.thisdevice] outlet 1 fires int=1 → via [t b] → bang on inlet 0 → _safeInit()

autowatch = 1;
mgraphics.init();

// Load marker — printed on every script (re)load. If you don't see this line
// in the Max console after right-click → Reload, the device didn't actually
// reload the new code (try closing + reopening the device, or restart Ableton).
post('=== SP2 script loaded: ' + (new Date()).toISOString() + ' ===\n');
mgraphics.relative_coords = 0;
mgraphics.autofill = 0;

inlets = 2;
outlets = 2;  // 0 = UDP + print; 1 = UDP only (for bulky payloads)

var BUILD_TAG = "setlist_pilot v2.0.0 (2026-05-10 merged SP+SSB)";
post("═══ " + BUILD_TAG + " LOADED ═══\n");

// ===========================================================================
// Core pure functions (from SP v1)
// ===========================================================================

var DEFAULT_DIVIDER_REGEX = /^-+\s*(?:set\s+\d+|encore|break|intermission)?\s*-+$/i;

function isDividerName(name, re) {
    if (name == null) return false;
    var s = String(name).trim();
    if (s.length === 0) return false;
    return (re || DEFAULT_DIVIDER_REGEX).test(s);
}

function _isSelectable(scene, opts) {
    if (!scene) return false;
    if (opts.skipDividers && isDividerName(scene.name, opts.dividerRegex)) return false;
    if (opts.skipEmpty && scene.isEmpty) return false;
    return true;
}

function chooseNextIndex(scenes, fromIndex, opts) {
    opts = opts || {};
    if (!scenes || scenes.length === 0) return -1;
    var start = (typeof fromIndex === 'number' && fromIndex >= -1) ? fromIndex : -1;
    for (var i = start + 1; i < scenes.length; i++) {
        if (_isSelectable(scenes[i], opts)) return i;
    }
    return -1;
}

function choosePrevIndex(scenes, fromIndex, opts) {
    opts = opts || {};
    if (!scenes || scenes.length === 0) return -1;
    var start = (typeof fromIndex === 'number') ? fromIndex : scenes.length;
    if (start > scenes.length) start = scenes.length;
    for (var i = start - 1; i >= 0; i--) {
        if (_isSelectable(scenes[i], opts)) return i;
    }
    return -1;
}

function routeMidiToAction(msg, pedals) {
    if (!msg) return null;
    if (msg.status !== 'noteon') return null;
    if (!(msg.velocity > 0)) return null;
    var n = msg.note | 0;
    var check = [
        ['play',       pedals.play],
        ['stop',       pedals.stop],
        ['next_scene', pedals.nextScene],
        ['prev_scene', pedals.prevScene],
        ['stop_all',   pedals.stopAll],
        ['go',         pedals.go]
    ];
    for (var i = 0; i < check.length; i++) {
        var a = check[i][0], cfg = check[i][1];
        if (!cfg || cfg.note == null || cfg.note < 0) continue;
        if (cfg.note !== n) continue;
        return a;
    }
    return null;
}

// ===========================================================================
// State
// ===========================================================================

var state = {
    pedals: {
        play:      { note: 4 },
        stop:      { note: 3 },
        nextScene: { note: 6 },
        prevScene: { note: 7 },
        stopAll:   { note: -1 },
        go:        { note: -1 }
    },
    // IMPORTANT: Dividers ('--- Set 2 ---') are SIGNPOSTS for the performer.
    // Do NOT default skipDividers=true. Keep visible and navigable.
    opts: { skipDividers: false, skipEmpty: false, dividerRegex: null },
    scenes: [],          // [{index, name, isEmpty, id}]
    currentIdx: -1,
    isPlaying: false,
    tempo: 120.0,
    timeSig: [4, 4],
    lastBar: -1,
    lastBeat: -1,
    lastAction: '',
    lastDetail: '',
    udpSendCount: 0,     // telemetry for status display
    tempoSchedule: [],   // [{bar, bpm}] sorted by bar — sent by server on scene load (set_tempo_schedule)
    tempoFiredIdx: 0,    // next index in tempoSchedule to fire — non-destructive pointer, reset on rewind/replay
    tempoFiredCount: 0,  // telemetry: how many tempo changes fired in current playthrough
    ready: false
};

// Tracks we broadcast mute state for (for navigator.html track toggles)
var TRACKED_NAMES = ["Original", "BT"];

// ===========================================================================
// UDP output (outlet 0 → [udpsend 127.0.0.1 9899])
// ===========================================================================

function udpSend(obj) {
    try {
        var json = JSON.stringify(obj);
        outlet(0, json);  // small messages — also logged via [print SP2_UDP_OUT]
        state.udpSendCount++;
    } catch (e) { post('  ERR udpSend: ' + e + '\n'); }
}

// Silent UDP send — bypasses the [print] object (outlet 1). Used for
// bulky payloads where verbose logging would flood the Max window.
function udpSendQuiet(obj) {
    try {
        var json = JSON.stringify(obj);
        outlet(1, json);
        state.udpSendCount++;
    } catch (e) { post('  ERR udpSendQuiet: ' + e + '\n'); }
}

function broadcastSceneChange() {
    var idx = state.currentIdx;
    var name = (idx >= 0 && state.scenes[idx]) ? state.scenes[idx].name : "";
    udpSend({
        type: "scene",
        index: idx,
        name: name,
        count: state.scenes.length
    });
}

var lastBroadcastScenesKey = null;  // change-detect cache

function broadcastScenesList(force) {
    var names = [];
    for (var i = 0; i < state.scenes.length; i++) names.push(state.scenes[i].name);
    // Cheap change detector — skip redundant broadcasts (e.g. reload with
    // unchanged setlist). join() with a separator unlikely to appear in names.
    var key = names.length + '|' + names.join('\x1f');
    if (!force && key === lastBroadcastScenesKey) {
        post('  scenes unchanged (' + names.length + ') — skip broadcast\n');
        return;
    }
    lastBroadcastScenesKey = key;
    post('  scenes broadcast (' + names.length + ' items)\n');
    udpSendQuiet({ type: "scenes", scenes: names });  // big payload → outlet 1
}

function broadcastTransport() {
    udpSend({
        type: "transport",
        state: state.isPlaying ? "playing" : "stopped",
        tempo: state.tempo,
        time_sig: state.timeSig
    });
}

function broadcastTrackMutes() {
    var tracks = {};
    for (var i = 0; i < TRACKED_NAMES.length; i++) {
        var tn = TRACKED_NAMES[i];
        var idx = findTrackByName(tn);
        if (idx >= 0) {
            try {
                var t = new LiveAPI('live_set tracks ' + idx);
                var muted = parseInt(t.get('mute'), 10);
                tracks[tn] = muted ? false : true; // true = active (unmuted)
            } catch (e) { tracks[tn] = null; }
        } else {
            tracks[tn] = null;
        }
    }
    udpSend({ type: "tracks", tracks: tracks });
}

// ===========================================================================
// LiveAPI — scene cache, nav
// ===========================================================================

function rebuildScenes(forceBroadcast) {
    try {
        state.scenes = [];
        var liveSet = new LiveAPI('live_set');
        var n = liveSet.getcount('scenes');
        for (var i = 0; i < n; i++) {
            var sc = new LiveAPI('live_set scenes ' + i);
            var name = String(sc.get('name'));
            if (name && name.charAt(0) === '"') name = name.slice(1, -1);
            var clipSlots = sc.getcount('clip_slots');
            var isEmpty = true;
            for (var j = 0; j < clipSlots; j++) {
                var slot = new LiveAPI('live_set scenes ' + i + ' clip_slots ' + j);
                if (parseInt(slot.get('has_clip'), 10) === 1) { isEmpty = false; break; }
            }
            state.scenes.push({ index: i, name: name, isEmpty: isEmpty, id: sc.id });
        }
        post('  scene_count=' + state.scenes.length + '\n');
        broadcastScenesList(forceBroadcast);
    } catch (e) { post('  ERR rebuildScenes: ' + e + '\n'); }
}

function refreshCurrentIdx() {
    try {
        var view = new LiveAPI('live_set view');
        var sel = view.get('selected_scene');
        if (!sel || sel.length < 2) { state.currentIdx = -1; return; }
        var selId = String(sel[1]);
        for (var i = 0; i < state.scenes.length; i++) {
            if (String(state.scenes[i].id) === selId) { state.currentIdx = i; return; }
        }
        state.currentIdx = -1;
    } catch (e) { post('  ERR refreshCurrentIdx: ' + e + '\n'); }
}

function ensureScenesCached() {
    try {
        var liveSet = new LiveAPI('live_set');
        var n = liveSet.getcount('scenes');
        if (state.scenes.length === n && n > 0) return;
        rebuildScenes();
    } catch (e) { post('  ERR ensureCache: ' + e + '\n'); }
}

function findTrackByName(name) {
    try {
        var ls = new LiveAPI('live_set');
        var count = ls.getcount('tracks');
        for (var i = 0; i < count; i++) {
            var t = new LiveAPI('live_set tracks ' + i);
            var tName = String(t.get('name'));
            if (tName && tName.charAt(0) === '"') tName = tName.slice(1, -1);
            if (tName === name) return i;
        }
    } catch (e) { post('  ERR findTrack: ' + e + '\n'); }
    return -1;
}

// ===========================================================================
// Nav actions (pedal OR UDP-command driven)
// ===========================================================================

function actPlay() {
    try {
        if (state.currentIdx < 0) refreshCurrentIdx();
        if (state.currentIdx < 0) {
            state.lastAction = 'PLAY'; state.lastDetail = '(no scene)'; return;
        }
        var sc = new LiveAPI('live_set scenes ' + state.currentIdx);
        sc.call('fire');
        state.lastAction = 'PLAY';
        state.lastDetail = 'scene ' + state.currentIdx;
    } catch (e) { post('  ERR actPlay: ' + e + '\n'); }
}

function actStop() {
    try {
        var s = new LiveAPI('live_set');
        s.set('is_playing', 0);           // instant (bypasses Global Launch Quant)
        s.call('stop_all_clips');
        state.lastAction = 'STOP';
        state.lastDetail = '';
    } catch (e) { post('  ERR actStop: ' + e + '\n'); }
}

function setSelectedScene(idx) {
    if (idx < 0 || idx >= state.scenes.length) return false;
    try {
        var v = new LiveAPI('live_set view');
        var sid = state.scenes[idx].id;
        if (sid == null) {
            var sc = new LiveAPI('live_set scenes ' + idx);
            sid = sc.id;
            state.scenes[idx].id = sid;
        }
        // Set currentIdx FIRST so the observer callback (fires synchronously
        // from v.set) sees the new value and skips its own broadcast.
        state.currentIdx = idx;
        v.set('selected_scene', 'id', sid);
        // Clear any prior tempo schedule — server will send a new one (or none)
        // when it processes the broadcast and resolves the new scene's song.
        state.tempoSchedule = [];
        state.tempoFiredIdx = 0;
        state.tempoFiredCount = 0;
        // Explicit broadcast — observer saw currentIdx matching, skipped.
        broadcastSceneChange();
        post('  setSelected: idx=' + idx + '\n');
        return true;
    } catch (e) { post('  ERR setSelected: ' + e + '\n'); return false; }
}

function actNext() {
    ensureScenesCached();
    refreshCurrentIdx();
    var n = chooseNextIndex(state.scenes, state.currentIdx, state.opts);
    if (n < 0) { state.lastAction = 'NEXT'; state.lastDetail = '(end)'; mgraphics.redraw(); return; }
    if (setSelectedScene(n)) {
        state.lastAction = 'NEXT';
        state.lastDetail = n + ': ' + (state.scenes[n].name || '');
    }
    mgraphics.redraw();
}

function actPrev() {
    ensureScenesCached();
    refreshCurrentIdx();
    var p = choosePrevIndex(state.scenes, state.currentIdx, state.opts);
    if (p < 0) { state.lastAction = 'PREV'; state.lastDetail = '(start)'; mgraphics.redraw(); return; }
    if (setSelectedScene(p)) {
        state.lastAction = 'PREV';
        state.lastDetail = p + ': ' + (state.scenes[p].name || '');
    }
    mgraphics.redraw();
}

function actGo() { actNext(); actPlay(); state.lastAction = 'GO'; mgraphics.redraw(); }

function actToggleTrack(name) {
    var idx = findTrackByName(name);
    if (idx < 0) { post('  toggle_track: track "' + name + '" not found\n'); return; }
    try {
        var t = new LiveAPI('live_set tracks ' + idx);
        var muted = parseInt(t.get('mute'), 10);
        t.set('mute', muted ? 0 : 1);
        post('  toggle_track: ' + name + ' -> ' + (muted ? 'active' : 'muted') + '\n');
        broadcastTrackMutes();
    } catch (e) { post('  ERR toggleTrack: ' + e + '\n'); }
}

function dispatch(action) {
    post('  action: ' + action + '\n');
    switch (action) {
        case 'play':       actPlay();   break;
        case 'stop':       actStop();   break;
        case 'next_scene': actNext();   break;
        case 'prev_scene': actPrev();   break;
        case 'stop_all':   actStop(); state.lastAction = 'STOP-ALL'; break;
        case 'go':         actGo();     break;
    }
    mgraphics.redraw();
}

// ===========================================================================
// LiveAPI observers — catch EXTERNAL scene/transport changes (user clicks,
// Ableton auto-snap). Own navigation paths broadcast explicitly.
// ===========================================================================

var sceneObserver = null;
var transportObserver = null;
var tempoObserver = null;

// Scene-list (count/add/remove) + per-scene name observers. When scenes are
// renamed, added, deleted, or reordered in Ableton, scheduleFullRebuild()
// debounces the cache refresh and re-broadcasts to clients. Prevents stale
// setlists in lyrics/navigator after the user reorgs scenes mid-session.
var sceneListObserver = null;
var sceneNameObservers = [];  // parallel array matching state.scenes length
var rebuildTask = null;       // Max Task for debouncing
var observersReady = false;   // gate to ignore first-call fires during init

function sceneCallback(args) {
    // Fires on ANY selected_scene change. Check if it differs from our local
    // idx (which own-driven paths already updated) — broadcast only if external.
    try {
        var prev = state.currentIdx;
        refreshCurrentIdx();
        if (state.currentIdx !== prev) {
            // Clear any prior tempo schedule — server will send a new one
            // (or none) for the song matching this scene.
            state.tempoSchedule = [];
            state.tempoFiredIdx = 0;
            state.tempoFiredCount = 0;
            broadcastSceneChange();
            mgraphics.redraw();
        }
    } catch (e) { post('  ERR sceneCb: ' + e + '\n'); }
}

function transportCallback(args) {
    try {
        var ls = new LiveAPI('live_set');
        var playing = parseInt(ls.get('is_playing'), 10) === 1;
        if (playing !== state.isPlaying) {
            var becamePlaying = playing && !state.isPlaying;
            state.isPlaying = playing;
            // PRIMARY tempo-replay fix: reset the schedule pointer on every play-start.
            // Ableton's transport bar does NOT rewind on Stop+Play (it keeps incrementing
            // even though the clip restarts at clip-bar 1), so the bar<prevBar rewind
            // detector in list() never fires between runs. Resetting here covers all
            // common cases: scene-relaunch, transport stop/start, clip relaunch.
            if (becamePlaying) {
                state.tempoFiredIdx = 0;
                state.tempoFiredCount = 0;
                post('  PLAY-START: re-armed tempo (idx=0, schedule.length=' + state.tempoSchedule.length + ', lastBar=' + state.lastBar + ')\n');
            }
            broadcastTransport();
            mgraphics.redraw();
        }
    } catch (e) { post('  ERR transportCb: ' + e + '\n'); }
}

function tempoCallback(args) {
    try {
        var ls = new LiveAPI('live_set');
        var t = parseFloat(ls.get('tempo'));
        if (t !== state.tempo) {
            state.tempo = t;
            broadcastTransport();
            mgraphics.redraw();
        }
    } catch (e) { post('  ERR tempoCb: ' + e + '\n'); }
}

function setupObservers() {
    try {
        sceneObserver = new LiveAPI(sceneCallback, 'live_set view');
        sceneObserver.property = 'selected_scene';
        post('  observer: selected_scene ✓\n');

        transportObserver = new LiveAPI(transportCallback, 'live_set');
        transportObserver.property = 'is_playing';
        post('  observer: is_playing ✓\n');

        tempoObserver = new LiveAPI(tempoCallback, 'live_set');
        tempoObserver.property = 'tempo';
        post('  observer: tempo ✓\n');

        sceneListObserver = new LiveAPI(sceneListChangedCallback, 'live_set');
        sceneListObserver.property = 'scenes';
        post('  observer: scenes (count/list) ✓\n');
    } catch (e) { post('  ERR setupObservers: ' + e + '\n'); }
}

// -------- Scene-list & rename observers (auto-detect setlist reorgs) --------

function scheduleFullRebuild() {
    if (!observersReady) return;  // ignore first-call fires during init
    if (!rebuildTask) rebuildTask = new Task(_doFullRebuild);
    rebuildTask.cancel();
    rebuildTask.schedule(400);  // ms — coalesces bursts (e.g. typing a rename)
}

function _doFullRebuild() {
    try {
        post('  scene change detected — rebuilding cache\n');
        teardownSceneNameObservers();
        rebuildScenes(true);  // force broadcast since something changed
        setupSceneNameObservers();
        refreshCurrentIdx();  // selection may have shifted after reorder
        broadcastSceneChange();
        mgraphics.redraw();
    } catch (e) { post('  ERR fullRebuild: ' + e + '\n'); }
}

function teardownSceneNameObservers() {
    for (var i = 0; i < sceneNameObservers.length; i++) {
        try { sceneNameObservers[i].property = ''; } catch (_) {}
    }
    sceneNameObservers = [];
}

function setupSceneNameObservers() {
    teardownSceneNameObservers();
    // Close the gate: each new observer fires once on .property= with its
    // current value. Without this guard, rebuild→setup→88 fires→another
    // rebuild = infinite loop that tanks Max performance.
    observersReady = false;
    for (var i = 0; i < state.scenes.length; i++) {
        try {
            var obs = new LiveAPI(sceneNameChangedCallback, 'live_set scenes ' + i);
            obs.property = 'name';
            sceneNameObservers.push(obs);
        } catch (e) { post('  ERR setupNameObs[' + i + ']: ' + e + '\n'); }
    }
    observersReady = true;
}

function sceneNameChangedCallback(args) {
    // Fires on rename OR reorder (index→scene mapping changes).
    scheduleFullRebuild();
}

function sceneListChangedCallback(args) {
    // Fires on add/remove (and some reorders).
    scheduleFullRebuild();
}

// ===========================================================================
// UDP command receiver (JSON strings arriving at inlet 0)
// ===========================================================================

function handleCommand(cmdStr) {
    try {
        var cmd = JSON.parse(cmdStr);
        if (cmd.type !== 'command') return;
        post('  cmd from server: ' + cmd.action + '\n');
        switch (cmd.action) {
            case 'play':    dispatch('play');       break;
            case 'stop':    dispatch('stop');       break;
            case 'next':    dispatch('next_scene'); break;
            case 'prev':    dispatch('prev_scene'); break;
            case 'refresh':
                post('  refresh requested — re-broadcasting full state\n');
                rebuildScenes(true);  // force scenes broadcast even if unchanged
                broadcastSceneChange();
                broadcastTransport();
                broadcastTrackMutes();
                break;
            case 'goto':
                if (typeof cmd.index === 'number') setSelectedScene(cmd.index);
                break;
            case 'toggle_track':
                if (cmd.track) actToggleTrack(cmd.track);
                break;
            case 'set_tempo_schedule':
                if (cmd.schedule && cmd.schedule.length) {
                    state.tempoSchedule = cmd.schedule.slice();  // copy — non-destructive: scanned via tempoFiredIdx
                    state.tempoFiredIdx = 0;
                    state.tempoFiredCount = 0;
                    post('  tempo_schedule loaded: ' + state.tempoSchedule.length + ' change(s)\n');
                } else {
                    state.tempoSchedule = [];
                    state.tempoFiredIdx = 0;
                    state.tempoFiredCount = 0;
                    post('  tempo_schedule cleared\n');
                }
                break;
            default:
                post('  unknown action: ' + cmd.action + '\n');
        }
    } catch (e) {
        post('  ERR handleCommand: ' + e + ' | raw: ' + String(cmdStr).substring(0, 80) + '\n');
    }
}

// ===========================================================================
// Plugsync bar/beat (inlet 1)
// ===========================================================================

function list() {
    if (inlet === 1 && arguments.length >= 2) {
        var bar = Math.floor(arguments[0]);
        var beat = Math.floor(arguments[1]);
        if (bar !== state.lastBar) {
            var prevBar = state.lastBar;
            state.lastBar = bar;
            state.lastBeat = beat;
            if (state.isPlaying) {
                udpSendQuiet({ type: 'playhead', bar: bar, beat: beat });  // bar-by-bar — silenced to reduce console noise
            }
            // Rewind/replay detection: if bar moved backwards (clip relaunch,
            // manual rewind, scene fire from start), re-arm the tempo schedule
            // from the beginning so subsequent playthroughs fire the same changes.
            // prevBar=-1 (initial) is not a rewind — only treat real backwards moves.
            if (prevBar >= 0 && bar < prevBar) {
                state.tempoFiredIdx = 0;
                state.tempoFiredCount = 0;
                post('  REWIND: prevBar=' + prevBar + ' -> bar=' + bar + ' — re-armed tempo\n');
            }
            // Tempo schedule: advance the pointer past every entry whose bar is
            // <= current bar; fire only the most recent overdue change.
            // If multiple changes are overdue (e.g. user navigated mid-song),
            // we collapse them into the latest target — safer than blasting
            // through every intermediate BPM.
            // NON-DESTRUCTIVE: tempoSchedule itself is preserved so replays work.
            if (state.tempoFiredIdx < state.tempoSchedule.length
                && bar >= state.tempoSchedule[state.tempoFiredIdx].bar) {
                var lastDue = null;
                while (state.tempoFiredIdx < state.tempoSchedule.length
                       && bar >= state.tempoSchedule[state.tempoFiredIdx].bar) {
                    lastDue = state.tempoSchedule[state.tempoFiredIdx];
                    state.tempoFiredIdx++;
                }
                if (lastDue) {
                    try {
                        var ls = new LiveAPI('live_set');
                        ls.set('tempo', lastDue.bpm);
                        state.tempoFiredCount++;
                        post('  TEMPO @ bar ' + bar + ' -> ' + lastDue.bpm + ' BPM (target was bar ' + lastDue.bar + ')\n');
                    } catch (e) { post('  ERR set tempo: ' + e + '\n'); }
                }
            }
        }
    }
}

// ===========================================================================
// Max message handlers (inlet 0)
// ===========================================================================

function _safeInit() {
    if (state.ready) return;
    state.ready = true;
    post('  initializing (LiveAPI ready)\n');
    rebuildScenes();
    refreshCurrentIdx();
    setupObservers();
    setupSceneNameObservers();
    observersReady = true;  // open the gate — subsequent fires trigger rebuild

    // Seed transport state
    try {
        var ls = new LiveAPI('live_set');
        state.isPlaying = parseInt(ls.get('is_playing'), 10) === 1;
        state.tempo = parseFloat(ls.get('tempo'));
        var sig = ls.get('signature_numerator');
        var den = ls.get('signature_denominator');
        state.timeSig = [parseInt(sig, 10) || 4, parseInt(den, 10) || 4];
    } catch (e) { post('  ERR init transport: ' + e + '\n'); }

    // Initial broadcasts
    broadcastSceneChange();
    broadcastTransport();
    broadcastTrackMutes();
    mgraphics.redraw();
    post('  ready — broadcasting on UDP:9899\n');
}

function msg_int(v)   { if (v === 1 || v === 1.0) _safeInit(); }
function msg_float(v) { /* ignore */ }
function bang()       { _safeInit(); }
function loadbang()   { /* wait for live.thisdevice */ }

function note_in(pitch, vel, ch) {
    var msg = {
        status: (vel > 0) ? 'noteon' : 'noteoff',
        note:  pitch | 0,
        velocity: vel | 0,
        channel: (ch | 0)
    };
    // Track-level MIDI From already filtered; match by pitch alone.
    var a = routeMidiToAction(msg, state.pedals);
    if (a) dispatch(a);
}

// Catch-all for inlet 0 — handles UDP JSON commands (arrive as symbol starting with '{')
function anything() {
    if (inlet !== 0) return;
    var args = [];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    var msg = String(messagename);
    // If message looks like JSON, parse it as a command
    if (msg.charAt(0) === '{') {
        var full = msg + (args.length ? ' ' + args.join(' ') : '');
        handleCommand(full);
        return;
    }
    // Otherwise: unrecognized — log it
    post('  anything: msg=' + msg + ' args=[' + args.join(',') + ']\n');
}

// --- Config messages (from patcher toggles/numboxes) ---
function skip_dividers(v) { state.opts.skipDividers = !!v; mgraphics.redraw(); }
function skip_empty(v)    { state.opts.skipEmpty   = !!v; mgraphics.redraw(); }
function play_note(v)     { state.pedals.play.note = v | 0; }
function stop_note(v)     { state.pedals.stop.note = v | 0; }
function next_note(v)     { state.pedals.nextScene.note = v | 0; }
function prev_note(v)     { state.pedals.prevScene.note = v | 0; }
function stopall_note(v)  { state.pedals.stopAll.note = (v | 0) || -1; }
function go_note(v)       { state.pedals.go.note = (v | 0) || -1; }
function divider_regex(src) {
    src = String(src || '').trim();
    if (src === '') { state.opts.dividerRegex = null; return; }
    try { state.opts.dividerRegex = new RegExp(src, 'i'); } catch (e) { post('  bad regex\n'); }
}
function refresh() {
    rebuildScenes();
    refreshCurrentIdx();
    broadcastSceneChange();
    broadcastTransport();
    broadcastTrackMutes();
    mgraphics.redraw();
}

// ===========================================================================
// Paint — prev/now/next + status
// ===========================================================================

function _sceneLabel(idx) {
    if (idx < 0 || idx >= state.scenes.length) return null;
    var name = String(state.scenes[idx].name || '').substring(0, 36);
    return idx + ': ' + name;
}

function paint() {
    with (mgraphics) {
        var w = box.rect[2] - box.rect[0];
        var h = box.rect[3] - box.rect[1];

        // Background
        set_source_rgba(0.08, 0.10, 0.12, 1);
        rectangle(0, 0, w, h);
        fill();

        // Header
        select_font_face('Arial Bold');
        set_font_size(13);
        set_source_rgba(0.9, 0.9, 1.0, 1);
        move_to(10, 18);
        text_path('SETLIST PILOT v2');
        fill();

        select_font_face('Arial');
        set_font_size(10);
        set_source_rgba(0.6, 0.7, 0.8, 1);
        move_to(150, 18);
        var rightStr = state.ready ? (state.scenes.length + ' scenes') : 'loading…';
        if (state.lastAction) rightStr += '  ·  ' + state.lastAction;
        text_path(rightStr);
        fill();

        // Transport + UDP telemetry (right side)
        set_source_rgba(0.45, 0.60, 0.80, 1);
        select_font_face('Arial');
        set_font_size(10);
        move_to(w - 110, 18);
        var transportStr = (state.isPlaying ? '▶ ' : '■ ') + Math.round(state.tempo) + ' BPM';
        text_path(transportStr);
        fill();

        // Prev / Current / Next stack (dividers amber)
        if (state.ready && state.currentIdx >= 0 && state.currentIdx < state.scenes.length) {
            var prevIdx = choosePrevIndex(state.scenes, state.currentIdx, state.opts);
            var nextIdx = chooseNextIndex(state.scenes, state.currentIdx, state.opts);
            var prevLabel = _sceneLabel(prevIdx);
            var nextLabel = _sceneLabel(nextIdx);
            var currLabel = _sceneLabel(state.currentIdx) || '';

            var prevIsDiv = (prevIdx >= 0) && isDividerName(state.scenes[prevIdx].name, state.opts.dividerRegex);
            var currIsDiv = isDividerName(state.scenes[state.currentIdx].name, state.opts.dividerRegex);
            var nextIsDiv = (nextIdx >= 0) && isDividerName(state.scenes[nextIdx].name, state.opts.dividerRegex);

            if (prevIsDiv) set_source_rgba(0.90, 0.65, 0.20, 1);
            else           set_source_rgba(0.45, 0.50, 0.60, 1);
            select_font_face('Arial');
            set_font_size(11);
            move_to(10, 44);
            text_path('◀ ' + (prevLabel || '(start)'));
            fill();

            if (currIsDiv) set_source_rgba(1.00, 0.70, 0.15, 1);
            else           set_source_rgba(0.30, 1.00, 0.45, 1);
            select_font_face('Arial Bold');
            set_font_size(15);
            move_to(10, 75);
            text_path('▶ ' + currLabel);
            fill();

            if (nextIsDiv) set_source_rgba(0.90, 0.65, 0.20, 1);
            else           set_source_rgba(0.45, 0.50, 0.60, 1);
            select_font_face('Arial');
            set_font_size(11);
            move_to(10, 99);
            text_path('▶▶ ' + (nextLabel || '(end)'));
            fill();
        } else if (state.ready) {
            set_source_rgba(0.7, 0.7, 0.75, 1);
            select_font_face('Arial');
            set_font_size(11);
            move_to(10, 75);
            text_path('(no scene selected)');
            fill();
        }

        // Footer: pedal map + UDP counter + build tag
        set_source_rgba(0.35, 0.42, 0.50, 1);
        select_font_face('Arial');
        set_font_size(9);
        move_to(10, h - 20);
        text_path('play=' + state.pedals.play.note +
                  ' stop=' + state.pedals.stop.note +
                  ' next=' + state.pedals.nextScene.note +
                  ' prev=' + state.pedals.prevScene.note +
                  '  ·  udp_out=' + state.udpSendCount +
                  '  ·  bar=' + state.lastBar);
        fill();
        move_to(10, h - 8);
        text_path(BUILD_TAG);
        fill();
    }
}
