// setlist_pilot_v1.js (v1.1)
// M4L driver for Setlist Pilot.
// Rendered as a [jsui] canvas — shows status; handles MIDI + LiveAPI.
//
// Messages (inlet 0):
//   note_in <pitch> <vel> <channel>     ; from [notein] → [pack 0 0 0] → [prepend note_in]
//   skip_dividers <0|1>                 ; from [live.toggle] → [prepend ...]
//   skip_empty <0|1>
//   midi_channel <0..16>                ; 0 = omni
//   play_note / stop_note / next_note / prev_note / stopall_note / go_note <N>
//   divider_regex <source>
//   refresh                             ; rebuild scene cache
//
// Load sequence (Max for Live):
//   [live.thisdevice] outlet 1 fires int=1 when LiveAPI is ready → msg_int(1) → _safeInit()

autowatch = 1;
mgraphics.init();
mgraphics.relative_coords = 0;
mgraphics.autofill = 0;

inlets = 1;
outlets = 1;   // reserved, unused today

var BUILD_TAG = "setlist_pilot v1.2.1 (2026-05-08 dividers-visible)";
post("═══ " + BUILD_TAG + " LOADED ═══\n");
post("  build: " + BUILD_TAG + "\n");

// ---------------------------------------------------------------------------
// Core logic (inlined — jsui can't `include()` reliably across all M4L versions)
// ---------------------------------------------------------------------------

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
    var ch = msg.channel | 0;
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
        // Per-pedal channel check disabled: Ableton track-level MIDI From
        // already filters and remaps to track ch=1. Match by pitch alone.
        return a;
    }
    return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

var state = {
    pedals: {
        play:      { note: 4, channel: 3 },
        stop:      { note: 3, channel: 3 },
        nextScene: { note: 6, channel: 3 },
        prevScene: { note: 7, channel: 3 },
        stopAll:   { note: -1, channel: 3 },
        go:        { note: -1, channel: 3 }
    },
    // IMPORTANT: Dividers like '--- Set 2 ---' are SIGNPOSTS for the
    // performer — they indicate breaks / set boundaries. Do NOT default
    // skipDividers=true. Jake uses the next-scene display to know when
    // a break is coming. Keep them visible and navigable.
    opts: { skipDividers: false, skipEmpty: false, dividerRegex: null },
    channelFilter: 3,
    scenes: [],
    currentIdx: -1,
    lastAction: '',
    lastDetail: '',
    ready: false
};

// ---------------------------------------------------------------------------
// LiveAPI — scene cache, dispatch
// ---------------------------------------------------------------------------

function rebuildScenes() {
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
    } catch (e) {
        post('  ERR rebuildScenes: ' + e + '\n');
    }
}

// Lightweight: only reads the currently selected scene index, no scene iteration.
function refreshCurrentIdx() {
    try {
        var view = new LiveAPI('live_set view');
        var sel = view.get('selected_scene');
        if (!sel || sel.length < 2) { state.currentIdx = -1; return; }
        var selId = String(sel[1]);
        // Find by id in cached scenes (using cached ids, no new LiveAPI objects)
        for (var i = 0; i < state.scenes.length; i++) {
            if (String(state.scenes[i].id) === selId) { state.currentIdx = i; return; }
        }
        state.currentIdx = -1;
    } catch (e) { post('  ERR refresh: ' + e + '\n'); }
}

function actPlay() {
    try {
        // Fire the scene by index — the scene object has a .fire() method.
        // 'View' does NOT have fire_selected_scene. The correct API is
        // to call fire() on the scene, or use 'selected_scene' id lookup.
        if (state.currentIdx < 0) { refreshCurrentIdx(); }
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
        // Immediate transport stop (bypasses Global Launch Quantization).
        var s = new LiveAPI('live_set');
        s.set('is_playing', 0);
        s.call('stop_all_clips');
        state.lastAction = 'STOP';
        state.lastDetail = '';
    } catch (e) { post('  ERR actStop: ' + e + '\n'); }
}

function setSelectedScene(idx) {
    if (idx < 0 || idx >= state.scenes.length) {
        post('  setSelected: out-of-range idx=' + idx + ' (len=' + state.scenes.length + ')\n');
        return false;
    }
    try {
        var v = new LiveAPI('live_set view');
        var sid = state.scenes[idx].id;
        if (sid == null) {
            var sc = new LiveAPI('live_set scenes ' + idx);
            sid = sc.id;
            state.scenes[idx].id = sid;
        }
        v.set('selected_scene', 'id', sid);
        state.currentIdx = idx;
        post('  setSelected: idx=' + idx + ' id=' + sid + ' state.currentIdx now=' + state.currentIdx + '\n');
        return true;
    } catch (e) { post('  ERR setSelected: ' + e + '\n'); return false; }
}

// Cache is built once at init. Only rebuild if scene count changes.
function ensureScenesCached() {
    try {
        var liveSet = new LiveAPI('live_set');
        var n = liveSet.getcount('scenes');
        if (state.scenes.length === n && n > 0) return; // cache valid
        rebuildScenes();
    } catch (e) { post('  ERR ensureCache: ' + e + '\n'); }
}

// Next/Prev use our OWN targetIdx — we don't read Ableton's selected_scene
// during navigation, because Ableton can reset it (e.g. snap to playing scene).
// We still write to Ableton for visual feedback. On init, we seed from Ableton.

function actNext() {
    ensureScenesCached();
    post('  actNext: from idx=' + state.currentIdx + ' name="' + (state.scenes[state.currentIdx] ? state.scenes[state.currentIdx].name : '?') + '"\n');
    var n = chooseNextIndex(state.scenes, state.currentIdx, state.opts);
    post('  actNext: chose idx=' + n + (n>=0 ? ' name="' + state.scenes[n].name + '"' : ' (end)') + '\n');
    if (n < 0) { state.lastAction = 'NEXT'; state.lastDetail = '(end)'; return; }
    if (setSelectedScene(n)) {
        state.lastAction = 'NEXT';
        state.lastDetail = n + ': ' + (state.scenes[n].name || '');
    }
    post('  actNext: after, state.currentIdx=' + state.currentIdx + '\n');
}

function actPrev() {
    ensureScenesCached();
    post('  actPrev: from idx=' + state.currentIdx + ' name="' + (state.scenes[state.currentIdx] ? state.scenes[state.currentIdx].name : '?') + '"\n');
    var p = choosePrevIndex(state.scenes, state.currentIdx, state.opts);
    post('  actPrev: chose idx=' + p + (p>=0 ? ' name="' + state.scenes[p].name + '"' : ' (start)') + '\n');
    if (p < 0) { state.lastAction = 'PREV'; state.lastDetail = '(start)'; return; }
    if (setSelectedScene(p)) {
        state.lastAction = 'PREV';
        state.lastDetail = p + ': ' + (state.scenes[p].name || '');
    }
    post('  actPrev: after, state.currentIdx=' + state.currentIdx + '\n');
}

function actGo() { actNext(); actPlay(); state.lastAction = 'GO'; }

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

// ---------------------------------------------------------------------------
// Max message handlers
// ---------------------------------------------------------------------------

function _safeInit() {
    if (state.ready) return;
    state.ready = true;
    post('  initializing (LiveAPI ready)\n');
    rebuildScenes();
    refreshCurrentIdx();
    mgraphics.redraw();
}

function msg_int(v) { if (v === 1 || v === 1.0) _safeInit(); }
function msg_float(v) { /* ignore */ }
function list() { /* ignore stray lists */ }
function bang() { _safeInit(); }
function loadbang() { /* wait for live.thisdevice */ }

function note_in(pitch, vel, ch) {
    post('  note_in IN: pitch=' + pitch + ' vel=' + vel + ' ch=' + ch + '\n');
    var msg = {
        status: (vel > 0) ? 'noteon' : 'noteoff',
        note: pitch | 0,
        velocity: vel | 0,
        channel: (ch == null) ? state.channelFilter : (ch | 0)
    };
    // Channel filter disabled: Ableton's track-level MIDI From dropdown
    // already filters by channel and remaps to track ch=1. So if MIDI got
    // here at all, it passed the channel filter at the track level.
    // (state.channelFilter retained for API compatibility but unused.)
    var a = routeMidiToAction(msg, state.pedals);
    post('    routed to: ' + (a || 'null') + '\n');
    if (a) dispatch(a);
}

// Catch-all — any message the jsui receives that doesn't match a named function
function anything() {
    var args = [];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    post('  anything: msg=' + messagename + ' args=[' + args.join(',') + ']\n');
}

function skip_dividers(v) { state.opts.skipDividers = !!v; mgraphics.redraw(); }
function skip_empty(v)    { state.opts.skipEmpty   = !!v; mgraphics.redraw(); }
function midi_channel(v)  { state.channelFilter = v | 0; mgraphics.redraw(); }
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
function refresh() { rebuildScenes(); refreshCurrentIdx(); mgraphics.redraw(); }

// ---------------------------------------------------------------------------
// Paint — minimal canvas showing status
// ---------------------------------------------------------------------------

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

        // --- Header row (top) ---
        select_font_face('Arial Bold');
        set_font_size(13);
        set_source_rgba(0.9, 0.9, 1.0, 1);
        move_to(10, 18);
        text_path('SETLIST PILOT');
        fill();

        // Status + last action on same line as header, right-aligned feel
        select_font_face('Arial');
        set_font_size(10);
        set_source_rgba(0.6, 0.7, 0.8, 1);
        move_to(130, 18);
        var rightStr = state.ready ? (state.scenes.length + ' scenes') : 'loading…';
        if (state.lastAction) rightStr += '  ·  ' + state.lastAction;
        text_path(rightStr);
        fill();

        // --- Prev / Current / Next stack ---
        // Dividers like '--- Set 2 ---' are SIGNPOSTS — rendered in amber so
        // Jake can glance at 'next' and know a break is coming.
        if (state.ready && state.currentIdx >= 0 && state.currentIdx < state.scenes.length) {
            var prevIdx = choosePrevIndex(state.scenes, state.currentIdx, state.opts);
            var nextIdx = chooseNextIndex(state.scenes, state.currentIdx, state.opts);
            var prevLabel = _sceneLabel(prevIdx);
            var nextLabel = _sceneLabel(nextIdx);
            var currLabel = _sceneLabel(state.currentIdx) || '';

            var prevIsDiv = (prevIdx >= 0) && isDividerName(state.scenes[prevIdx].name, state.opts.dividerRegex);
            var currIsDiv = isDividerName(state.scenes[state.currentIdx].name, state.opts.dividerRegex);
            var nextIsDiv = (nextIdx >= 0) && isDividerName(state.scenes[nextIdx].name, state.opts.dividerRegex);

            // Prev (dim; amber if divider)
            if (prevIsDiv) set_source_rgba(0.90, 0.65, 0.20, 1);
            else           set_source_rgba(0.45, 0.50, 0.60, 1);
            select_font_face('Arial');
            set_font_size(11);
            move_to(10, 44);
            text_path('◀ ' + (prevLabel || '(start)'));
            fill();

            // Current (bright green normally; bright amber if divider — dominant)
            if (currIsDiv) set_source_rgba(1.00, 0.70, 0.15, 1);
            else           set_source_rgba(0.30, 1.00, 0.45, 1);
            select_font_face('Arial Bold');
            set_font_size(15);
            move_to(10, 75);
            text_path('▶ ' + currLabel);
            fill();

            // Next (dim; amber if divider — easy to spot upcoming break)
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

        // --- Footer: pedal map ---
        set_source_rgba(0.35, 0.42, 0.50, 1);
        select_font_face('Arial');
        set_font_size(9);
        move_to(10, h - 8);
        text_path('play=' + state.pedals.play.note +
                  ' stop=' + state.pedals.stop.note +
                  ' next=' + state.pedals.nextScene.note +
                  ' prev=' + state.pedals.prevScene.note +
                  ' · ' + BUILD_TAG);
        fill();
    }
}
