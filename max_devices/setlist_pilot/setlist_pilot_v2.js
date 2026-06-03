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
//
// SCRIPT_VERSION is stamped into every consequential log line so we can always
// confirm at a glance which build is running. Bump it whenever this file changes
// in a way that affects runtime behavior.
var SCRIPT_VERSION = "v2.4.0-reveal-in-finder-2026-06-03";
post('=== SP2 script loaded: ' + (new Date()).toISOString() + ' [' + SCRIPT_VERSION + '] ===\n');
mgraphics.relative_coords = 0;
mgraphics.autofill = 0;

inlets = 2;
outlets = 2;  // 0 = UDP + print; 1 = UDP only (for bulky payloads)

var BUILD_TAG = "setlist_pilot " + SCRIPT_VERSION;
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
    tempoSchedule: [],         // [{bar, bpm}] sorted by bar — sent by server on scene load (set_tempo_schedule)
    tempoFiredIdx: 0,          // next index in tempoSchedule to fire — non-destructive pointer, reset on rewind/replay
    tempoFiredCount: 0,        // telemetry: how many tempo changes fired in current playthrough
    baselineTempo: null,       // captured Ableton tempo for the pre-first-entry zone — restored on scrub-back
    ready: false,
    // Phase 1: device-side song-repo discovery (shadow mode — no behavior change yet)
    repo: {
        path: '/Users/jake/Library/CloudStorage/Dropbox/WingPunchDB',  // overridable via set_song_repo message
        files: [],         // [string] — list of song filenames found in repo (basename only)
        indexed: false,    // true once _buildRepoIndex has run successfully
        scanCount: 0,      // total directory entries seen (incl. filtered out)
        lastError: null,   // last enum/filter error message, if any
        bySlug: {}         // Phase 2: { slug: filename } — built alongside files[]
    },
    // Phase 3: device-side tempo_maps storage. Loaded from [dict tempo_maps]
    // on init. Schema: { <slug>: [{bar, bpm}, ...] } sorted by bar.
    // Server's set_tempo_schedule is honored ONLY if no local map exists for
    // the matched slug. In Phase 4 the server path will retire entirely.
    tempoMaps: {},
    tempoMapsLoaded: false,
    tempoSource: 'none',       // 'local' | 'server' | 'none' — which map populated state.tempoSchedule

    // Phase 6: Editor pane state. The editor always edits the slug of the
    // most recent matched scene. editorPage paginates through entries.
    editorSlug: null,           // slug currently shown in editor UI
    editorPage: 0,              // 0-indexed page (4 entries per page)
    editorMatchInfo: null       // last match info { filename, method, confidence }
};

var EDITOR_ROWS_PER_PAGE = 4;

// File extensions we treat as ChordPro-likely (case-insensitive)
var REPO_TEXT_EXTS = ['txt', 'cho', 'pro', 'crd', 'chord'];

// ===========================================================================
// Phase 2: Slug + scene-to-song matching (shadow mode)
// ===========================================================================
// Verbatim port of slugify() and the filename passes of matchSceneToSong()
// from server/server-additions.js. We deliberately omit the metadata-title
// fallback in this phase — that requires reading file contents and is rarely
// hit when filenames already contain titles. If shadow-mode divergence logs
// reveal we need it, we can add it later.
//
// Pure shadow telemetry: no UDP messages emitted, no behavior change. Logs
// only what the device WOULD have picked, so we can compare against the
// server's pick over time before cutting over in Phase 5.
// ===========================================================================
function slugify(name) {
    if (!name) return '';
    return String(name)
        .toLowerCase()
        .replace(/\.[a-z]+$/i, '')      // strip ANY trailing extension
        .replace(/['\u2019]/g, '')      // strip ASCII + curly apostrophes
        .replace(/[^a-z0-9]+/g, ' ')    // non-alphanumeric → space
        .trim()
        .replace(/\s+/g, ' ');          // collapse whitespace
}

// Match a scene name against the indexed repo. Returns:
//   { filename: string|null, method: string, confidence: 'high'|'none' }
// Methods: 'slug-exact', 'slug-substring', 'slug-substring-shortest', 'none'.
function _matchSceneToSong(sceneName) {
    if (!sceneName || !state.repo.indexed || state.repo.files.length === 0) {
        return { filename: null, method: 'none', confidence: 'none' };
    }
    var sceneSlug = slugify(sceneName);
    if (!sceneSlug) return { filename: null, method: 'none', confidence: 'none' };

    var bySlug = state.repo.bySlug || {};
    // Pass 1: exact slug match (constant-time lookup via index)
    if (bySlug[sceneSlug]) {
        return { filename: bySlug[sceneSlug], method: 'slug-exact', confidence: 'high' };
    }

    // Pass 2: scene slug is a substring of file slug at a word boundary
    var escaped = sceneSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var wordBoundaryRe = new RegExp('(^|\\s)' + escaped + '(\\s|$)');
    var substringMatches = [];
    for (var i = 0; i < state.repo.files.length; i++) {
        var fileSlug = slugify(state.repo.files[i]);
        if (wordBoundaryRe.test(fileSlug)) substringMatches.push(state.repo.files[i]);
    }
    if (substringMatches.length === 1) {
        return { filename: substringMatches[0], method: 'slug-substring', confidence: 'high' };
    }
    if (substringMatches.length > 1) {
        substringMatches.sort(function(a, b) { return slugify(a).length - slugify(b).length; });
        return { filename: substringMatches[0], method: 'slug-substring-shortest', confidence: 'high' };
    }

    return { filename: null, method: 'none', confidence: 'none' };
}

// ===========================================================================
// Phase 3: Local tempo_maps — load from embedded dict, fire from local store
// ===========================================================================
// ---------------------------------------------------------------------------
// EXTERNAL TEMPO-MAP STORAGE [v2.3.0+]
// ---------------------------------------------------------------------------
// Tempo maps live in an EXTERNAL JSON file colocated with the device .amxd:
//
//   /Users/<user>/Music/Ableton/User Library/Presets/MIDI Effects/
//     Max MIDI Effect/setlist_pilot_tempo_maps.json
//
// This decouples user data from the device binary. Updating the .amxd
// (e.g., scp during dev) leaves the user's hundreds of customized tempo
// maps untouched. The embedded [dict tempo_maps @embed 1] is a working
// mirror only — kept around for ONE rev to allow migration of any data
// that was already saved into the .als prior to this change.
//
// Filename is intentionally NOT version-namespaced: `setlist_pilot_tempo_maps.json`.
// A future v3 device can read the same file (and bump schemaVersion in the
// JSON if it needs to evolve schema). This makes v2→v3 ingestion automatic.
//
// File schema (unchanged from embedded dict):
//   { "schemaVersion": 1, "tempoMaps": { "<slug>": [{"bar":N,"bpm":M},...] } }

var TEMPO_MAPS_FILE = null;   // computed once on first load, cached

function _computeTempoMapsPath() {
    // Derive absolute path from this device's location. In M4L, this.patcher.filepath
    // can return either the .amxd file or, surprisingly, the containing folder
    // (depending on how Live wraps the device). We probe and adapt.
    var diag = [];
    var raw = null;
    try {
        raw = this.patcher.filepath || null;
        diag.push('this.patcher.filepath=\'' + (raw || '<empty>') + '\'');
    } catch (e) { diag.push('this.patcher.filepath ERR: ' + e); }
    try {
        var pp = this.patcher.parentpatcher;
        var ppfp = pp ? (pp.filepath || '<empty>') : '<no parent>';
        diag.push('parentpatcher.filepath=\'' + ppfp + '\'');
    } catch (e) { diag.push('parentpatcher.filepath ERR: ' + e); }
    post('  tempo_maps: path probe — ' + diag.join(' | ') + '\n');

    if (!raw) {
        post('  tempo_maps: WARN — no patcher.filepath; file persistence DISABLED\n');
        TEMPO_MAPS_FILE = null;
        return false;
    }

    // Heuristic: if the path ends in a recognized extension, treat as file (strip filename).
    // Otherwise treat as folder (use directly).
    var lower = raw.toLowerCase();
    var isFile = (lower.indexOf('.amxd') === lower.length - 5)
              || (lower.indexOf('.maxpat') === lower.length - 7)
              || (lower.indexOf('.maxhelp') === lower.length - 8);
    var dir;
    if (isFile) {
        var slash = raw.lastIndexOf('/');
        dir = (slash > 0) ? raw.substring(0, slash) : raw;
    } else {
        // Likely already a folder path (M4L wrapper case observed on gigmac).
        // Strip trailing slash if any.
        dir = raw.replace(/\/+$/, '');
    }
    TEMPO_MAPS_FILE = dir + '/setlist_pilot_tempo_maps.json';
    post('  tempo_maps: resolved file path = ' + TEMPO_MAPS_FILE + '\n');
    return true;
}

function _loadTempoMaps() {
    state.tempoMaps = {};
    state.tempoMapsLoaded = false;

    _computeTempoMapsPath();
    var d = new Dict('tempo_maps');

    // Step 0: snapshot embedded contents from the .amxd-loaded dict BEFORE
    // any import_json call (which may clobber the dict contents on a missing-file
    // failure). This snapshot is our migration source if no external file exists.
    var embeddedSnapshot = null;
    try {
        var rawBefore = d.stringify();
        if (rawBefore && rawBefore !== '{}') {
            var parsedBefore = JSON.parse(rawBefore);
            if (parsedBefore && parsedBefore.tempoMaps) {
                // Only consider it real data if at least one slug has entries
                for (var pk in parsedBefore.tempoMaps) {
                    if (parsedBefore.tempoMaps[pk] && parsedBefore.tempoMaps[pk].length) {
                        embeddedSnapshot = parsedBefore.tempoMaps;
                        break;
                    }
                }
            }
        }
    } catch (e) { post('  tempo_maps: snapshot ERR — ' + e + '\n'); }

    // Step 1: try to load from external file. import_json does NOT throw on
    // missing file (just logs `dictwrap: file not found`), so verify success
    // by re-checking the dict contents afterward.
    var fileMaps = null;
    if (TEMPO_MAPS_FILE) {
        try {
            d.import_json(TEMPO_MAPS_FILE);
            var rawAfter = d.stringify();
            if (rawAfter && rawAfter !== '{}') {
                var parsedAfter = JSON.parse(rawAfter);
                if (parsedAfter && parsedAfter.tempoMaps) {
                    fileMaps = parsedAfter.tempoMaps;
                }
            }
        } catch (e) {
            post('  tempo_maps: import_json ERR — ' + e + '\n');
        }
    }

    // Step 2: pick the data source. File wins; embedded is migration fallback.
    var source = null;   // 'file' | 'migrate' | 'fresh'
    var maps = null;
    if (fileMaps) {
        source = 'file';
        maps = fileMaps;
    } else if (embeddedSnapshot) {
        source = 'migrate';
        maps = embeddedSnapshot;
    } else {
        source = 'fresh';
        maps = {};
    }

    // Step 3: hydrate state.tempoMaps from chosen source.
    var slugCount = 0, totalChanges = 0;
    for (var slug in maps) {
        var sched = maps[slug];
        if (sched && sched.length) {
            sched.sort(function(a, b) { return (a.bar | 0) - (b.bar | 0); });
            state.tempoMaps[slug] = sched;
            slugCount++;
            totalChanges += sched.length;
        }
    }

    // Step 4: report + cement migration if needed.
    if (source === 'file') {
        post('  tempo_maps [' + SCRIPT_VERSION + ']: loaded ' + slugCount +
             ' song(s), ' + totalChanges + ' change(s) from ' + TEMPO_MAPS_FILE + '\n');
    } else if (source === 'migrate') {
        post('  tempo_maps [' + SCRIPT_VERSION + ']: MIGRATING ' + slugCount +
             ' song(s), ' + totalChanges + ' change(s) from embedded dict to ' +
             TEMPO_MAPS_FILE + '\n');
        _saveTempoMaps();   // cement to file
    } else if (TEMPO_MAPS_FILE) {
        post('  tempo_maps [' + SCRIPT_VERSION + ']: starting fresh (no file, no embedded data) at ' +
             TEMPO_MAPS_FILE + '\n');
    } else {
        post('  tempo_maps [' + SCRIPT_VERSION + ']: starting fresh (file persistence DISABLED — no patcher path)\n');
    }
    state.tempoMapsLoaded = true;
}

function _saveTempoMaps() {
    // Truth: external file. Mirror: embedded dict (kept for one rev for
    // backward-compat — if the device ever loads on an older build that
    // reads from the embedded dict only, it'll still see current data
    // saved into the .als).
    try {
        var d = new Dict('tempo_maps');
        d.clear();
        d.parse(JSON.stringify({ schemaVersion: 1, tempoMaps: state.tempoMaps }));
        if (!TEMPO_MAPS_FILE) _computeTempoMapsPath();
        if (TEMPO_MAPS_FILE) {
            d.export_json(TEMPO_MAPS_FILE);
        }
    } catch (e) {
        post('  tempo_maps: ERR _saveTempoMaps — ' + e + '\n');
    }
}

// Backward-compat aliases (in case any caller still references the old names).
var _loadTempoMapsFromDict = _loadTempoMaps;
var _saveTempoMapsToDict = _saveTempoMaps;

// Called from broadcastSceneChange after shadow-match. If a local map exists
// for the matched slug, populate state.tempoSchedule. Otherwise leave it alone
// (server's set_tempo_schedule will arrive via udp-bridge if available).
function _applyLocalTempoMap(matchedSlug) {
    if (!matchedSlug || !state.tempoMaps[matchedSlug]) {
        // No local map. tempoSource stays whatever the prior path set it to.
        // (broadcastSceneChange always resets state.tempoSchedule = [] before
        // calling us — so 'none' if no local map is correct.)
        return;
    }
    var sched = state.tempoMaps[matchedSlug];
    state.tempoSchedule = sched.slice();   // copy — non-destructive
    state.tempoFiredIdx = 0;
    state.tempoFiredCount = 0;
    state.baselineTempo = null;
    state.tempoSource = 'local';
    post('  tempo_maps: applied local map for slug=\'' + matchedSlug + '\' (' +
         sched.length + ' change' + (sched.length === 1 ? '' : 's') + ')\n');
}

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
    // Phase 2: shadow-mode device-side match.
    // Phase 3: now also applies a local tempo_map (if present for the matched slug).
    if (name && state.repo.indexed) {
        var m = _matchSceneToSong(name);
        var slug = slugify(name);
        if (m.filename) {
            post("  match[shadow]: scene='" + name + "' slug='" + slug +
                 "' -> '" + m.filename + "' (" + m.method + "/" + m.confidence + ")\n");
        } else {
            post("  match[shadow]: scene='" + name + "' slug='" + slug + "' -> NO MATCH\n");
        }
        // Phase 3: apply local tempo_map keyed by slug (scene-derived, NOT file slug).
        // Local map wins over server's set_tempo_schedule. If no local map, server
        // path remains active for compatibility (retires in Phase 4).
        _applyLocalTempoMap(slug);
        // Phase 6: editor follows the matched scene. Reset to page 0 on scene change.
        state.editorSlug = slug;
        state.editorMatchInfo = m;
        state.editorPage = 0;
        _refreshEditorDiagnostics(name, m, slug);
        _refreshEditorUI();
    }
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
        // Reset transport position to 0 BEFORE firing the scene. Ableton's
        // current_song_time does NOT auto-rewind on scene fire or on stop+play
        // (it keeps incrementing across the whole Live session). Without this,
        // navigating between scenes via the navigator and pressing play causes
        // plugsync to emit bar=N from the prior song, scrolling lyrics to the
        // middle (or end) of the new song.
        // Set in any state — Ableton allows mid-playback teleport. Combined
        // with the immediately-following scene.fire(), the audible result is
        // a clean play-start at bar 1.
        try {
            var ls = new LiveAPI('live_set');
            ls.set('current_song_time', 0);
            post('  actPlay [' + SCRIPT_VERSION + ']: reset current_song_time=0 before fire\n');
        } catch (eReset) {
            post('  WARN actPlay reset song_time failed: ' + eReset + '\n');
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
        // Clear any prior tempo schedule — broadcastSceneChange will repopulate
        // from local tempoMaps (Phase 3) or server's set_tempo_schedule if no local map.
        state.tempoSchedule = [];
        state.tempoFiredIdx = 0;
        state.tempoFiredCount = 0;
        state.baselineTempo = null;
        state.tempoSource = 'none';
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
            // Clear any prior tempo schedule — broadcastSceneChange will repopulate
            // from local tempoMaps (Phase 3) or server's set_tempo_schedule if no local map.
            state.tempoSchedule = [];
            state.tempoFiredIdx = 0;
            state.tempoFiredCount = 0;
            state.baselineTempo = null;
            state.tempoSource = 'none';
            broadcastSceneChange();
            mgraphics.redraw();
        }
    } catch (e) { post('  ERR sceneCb: ' + e + '\n'); }
}

// Read the selected scene's initial tempo via LiveAPI.
// In Ableton, widening the Main track in Session view exposes a per-scene
// 'Tempo' field. Setting it makes scene-launch establish that BPM as the song's
// starting tempo. We read this same value as the authoritative baseline — no
// guesswork, no observation window, deterministic.
//
// Returns the scene's tempo as a float, or -1 if the scene has no tempo set
// (the scene won't change BPM on launch). Returns NaN on LiveAPI error.
function getSceneInitialTempo(sceneIdx) {
    if (sceneIdx == null || sceneIdx < 0) return NaN;
    try {
        var sc = new LiveAPI('live_set scenes ' + sceneIdx);
        var t = parseFloat(sc.get('tempo'));
        return t;
    } catch (e) {
        post('  ERR getSceneInitialTempo: ' + e + '\n');
        return NaN;
    }
}

// Set Live master tempo from inside a notification callback (transportCallback,
// sceneCallback, etc). Live's API forbids mutating its state synchronously from
// observer callbacks (warns: "Changes cannot be triggered by notifications. You
// will need to defer your response."), so we schedule the set via a Max Task
// to run on the next idle tick. Use this everywhere ls.set('tempo', X) is
// called outside of regular message handlers (list/anything).
function deferTempoSet(bpm, label) {
    var t = new Task(function() {
        try {
            var lsd = new LiveAPI('live_set');
            lsd.set('tempo', bpm);
            post('  TEMPO [' + SCRIPT_VERSION + '] -> ' + bpm + ' BPM ' + label + ' (deferred)\n');
        } catch (e) {
            post('  ERR deferTempoSet: ' + e + '\n');
        }
    }, this);
    t.schedule(0);
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
                // Read the selected scene's initial tempo (set in Ableton via the
                // widened Main track in Session view). If valid, use it as the
                // authoritative baseline AND apply it to master tempo right now —
                // this gives us the same effect as Ableton's clip-tempo automation
                // would, but deterministically, on every play-start.
                var sceneTempo = getSceneInitialTempo(state.currentIdx);
                if (sceneTempo > 0 && state.tempoSchedule.length > 0) {
                    state.baselineTempo = sceneTempo;
                    deferTempoSet(sceneTempo, '(scene ' + state.currentIdx + ' initial tempo)');
                } else if (state.tempoSchedule.length > 0) {
                    // Scene has no tempo set — fall back to current master tempo as best-guess baseline.
                    state.baselineTempo = state.tempo;
                    post('  PLAY-START [' + SCRIPT_VERSION + ']: scene ' + state.currentIdx + ' has no initial tempo (sceneTempo=' + sceneTempo + '); using current master tempo ' + state.tempo + ' as baseline\n');
                }
                var pdump = '';
                for (var pi = 0; pi < state.tempoSchedule.length; pi++) {
                    if (pi) pdump += ', ';
                    pdump += '{' + state.tempoSchedule[pi].bar + ':' + state.tempoSchedule[pi].bpm + '}';
                }
                post('  PLAY-START [' + SCRIPT_VERSION + ']: re-armed tempo (idx=0, schedule=[' + pdump + '], src=' + state.tempoSource + ', lastBar=' + state.lastBar + ', sceneTempo=' + sceneTempo + ', baseline=' + state.baselineTempo + ')\n');
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
                // Phase 3: local tempo_map wins over server. If a local map was applied
                // by _applyLocalTempoMap during the most recent scene change, ignore the
                // server's payload entirely — they're racing for state.tempoSchedule.
                if (state.tempoSource === 'local') {
                    post('  tempo_schedule from server IGNORED — local map active for this scene\n');
                    break;
                }
                if (cmd.schedule && cmd.schedule.length) {
                    state.tempoSchedule = cmd.schedule.slice();  // copy — non-destructive: scanned via tempoFiredIdx
                    state.tempoFiredIdx = 0;
                    state.tempoFiredCount = 0;
                    state.baselineTempo = null;
                    state.tempoSource = 'server';
                    post('  tempo_schedule loaded [' + SCRIPT_VERSION + ']: ' + state.tempoSchedule.length + ' change(s)\n');
                } else {
                    state.tempoSchedule = [];
                    state.tempoFiredIdx = 0;
                    state.tempoFiredCount = 0;
                    state.baselineTempo = null;
                    state.tempoSource = 'none';
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
                post('  REWIND [' + SCRIPT_VERSION + ']: prevBar=' + prevBar + ' -> bar=' + bar + ' — re-armed tempo\n');
                // If we rewound INTO the pre-first-entry zone and we have a
                // captured baseline, restore it. Without this, the tempo would
                // remain stuck at whatever the last fired schedule entry set it
                // to — wrong for bars before the first programmed change.
                if (state.baselineTempo !== null
                    && state.tempoSchedule.length > 0
                    && bar < state.tempoSchedule[0].bar) {
                    try {
                        var lsBl = new LiveAPI('live_set');
                        lsBl.set('tempo', state.baselineTempo);
                        post('  TEMPO @ bar ' + bar + ' -> ' + state.baselineTempo + ' BPM (baseline restore — pre-first-entry zone)\n');
                    } catch (e) { post('  ERR baseline restore: ' + e + '\n'); }
                }
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

// ===========================================================================
// Phase 1: Song-repo discovery (shadow mode)
// ===========================================================================
// Enumerates the configured song-repo directory via Max's Folder object,
// filters to text-likely extensions, and stores the resulting filename list
// in state.repo. No matching/slug logic yet — that lands in Phase 2.
//
// Trigger: called once from _safeInit() at device load.
// Override: send `set_song_repo <path>` to the device to re-scan a different
//           directory at runtime (testing / multi-band swap).
// ===========================================================================
function _buildRepoIndex() {
    var p = state.repo.path;
    state.repo.files = [];
    state.repo.bySlug = {};
    state.repo.indexed = false;
    state.repo.scanCount = 0;
    state.repo.lastError = null;

    if (!p) {
        state.repo.lastError = 'no repo path configured';
        post('  repo: NO PATH configured — set_song_repo <path> to enable\n');
        return;
    }

    try {
        var f = new Folder(p);
        f.typelist = [];   // no filter; we filter by extension in JS
        var files = [];
        var scan = 0;
        while (!f.end) {
            var name = f.filename;
            if (name) {
                scan++;
                var dot = name.lastIndexOf('.');
                if (dot > 0) {
                    var ext = name.substring(dot + 1).toLowerCase();
                    for (var i = 0; i < REPO_TEXT_EXTS.length; i++) {
                        if (ext === REPO_TEXT_EXTS[i]) { files.push(name); break; }
                    }
                }
            }
            f.next();
        }
        f.close();
        files.sort();
        // Phase 2: build slug → filename index. Last-write wins on duplicates
        // (rare — would require two files differing only in punctuation/case).
        var bySlug = {};
        var dupes = 0;
        for (var k = 0; k < files.length; k++) {
            var slug = slugify(files[k]);
            if (slug) {
                if (bySlug[slug]) dupes++;
                bySlug[slug] = files[k];
            }
        }
        state.repo.files = files;
        state.repo.bySlug = bySlug;
        state.repo.scanCount = scan;
        state.repo.indexed = true;
        post('  repo: ' + p + '\n');
        post('  repo: indexed ' + files.length + ' songs (' + scan + ' entries scanned, ' +
             (scan - files.length) + ' filtered out by extension' +
             (dupes ? ', ' + dupes + ' slug collision' + (dupes === 1 ? '' : 's') : '') + ')\n');
        if (files.length > 0) {
            var sample = files.slice(0, 3).join(', ');
            post('  repo: sample files: ' + sample + '\n');
        }
    } catch (e) {
        state.repo.lastError = String(e);
        post('  repo: ERROR enumerating ' + p + ' — ' + e + '\n');
    }
}

function _safeInit() {
    if (state.ready) return;
    state.ready = true;
    post('  initializing (LiveAPI ready)\n');
    _buildRepoIndex();              // Phase 1: discover song repo
    _loadTempoMaps();              // Phase 3+: load tempo_maps from external file (with embedded-dict migration)
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

    // Phase 6: initial editor refresh — populates labels/numboxes even if no
    // scene matched yet. (broadcastSceneChange handles the post-match refresh.)
    _refreshEditorDiagnostics(null, null, null);
    _refreshEditorUI();

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

// Phase 1: runtime repo-path override + manual rescan trigger.
// Usage from a [message] box: `set_song_repo /path/to/repo`
function set_song_repo(p) {
    var newPath = String(p || '').trim();
    if (!newPath) { post('  set_song_repo: empty path — ignored\n'); return; }
    state.repo.path = newPath;
    post('  set_song_repo: path -> ' + newPath + ', re-indexing...\n');
    _buildRepoIndex();
}

// Phase 3: tempo_maps message handlers.
// All operate on state.tempoMaps and persist via _saveTempoMaps() (writes to external JSON file).
// Save the .als after editing to durably commit changes.

function tempo_map_set(slug, bar, bpm) {
    slug = String(slug || '').trim().toLowerCase();
    bar = bar | 0;
    bpm = parseFloat(bpm);
    if (!slug || bar < 0 || !(bpm > 0)) {
        post('  tempo_map_set: usage: tempo_map_set <slug> <bar> <bpm>  (got slug=\'' +
             slug + '\' bar=' + bar + ' bpm=' + bpm + ')\n');
        return;
    }
    var sched = state.tempoMaps[slug] || [];
    // Replace existing entry at same bar, otherwise append + sort
    var replaced = false;
    for (var i = 0; i < sched.length; i++) {
        if ((sched[i].bar | 0) === bar) {
            sched[i] = { bar: bar, bpm: bpm };
            replaced = true;
            break;
        }
    }
    if (!replaced) {
        sched.push({ bar: bar, bpm: bpm });
        sched.sort(function(a, b) { return (a.bar | 0) - (b.bar | 0); });
    }
    state.tempoMaps[slug] = sched;
    _saveTempoMaps();
    post('  tempo_map_set: \'' + slug + '\' bar=' + bar + ' bpm=' + bpm +
         (replaced ? ' (replaced)' : '') + ', schedule.length=' + sched.length + '\n');
}

function tempo_map_clear(slug) {
    slug = String(slug || '').trim().toLowerCase();
    if (!slug) { post('  tempo_map_clear: usage: tempo_map_clear <slug>\n'); return; }
    if (state.tempoMaps[slug]) {
        delete state.tempoMaps[slug];
        _saveTempoMaps();
        post('  tempo_map_clear: removed \'' + slug + '\'\n');
    } else {
        post('  tempo_map_clear: \'' + slug + '\' not found\n');
    }
}

function tempo_map_clear_all() {
    var n = 0;
    for (var k in state.tempoMaps) n++;
    state.tempoMaps = {};
    _saveTempoMaps();
    post('  tempo_map_clear_all: removed ' + n + ' map' + (n === 1 ? '' : 's') + '\n');
}

function tempo_map_dump() {
    var n = 0;
    for (var k in state.tempoMaps) n++;
    post('  tempo_map_dump: ' + n + ' song map' + (n === 1 ? '' : 's') + ':\n');
    for (var slug in state.tempoMaps) {
        var sched = state.tempoMaps[slug];
        var parts = [];
        for (var i = 0; i < sched.length; i++) parts.push(sched[i].bar + ':' + sched[i].bpm);
        post('    \'' + slug + '\' -> [' + parts.join(', ') + ']\n');
    }
}

// ===========================================================================
// Phase 6: Editor pane — Live UI handlers + refresh
// ===========================================================================
// Each control (live.numbox, live.text-button) sends [prepend ui_<name> [args]]
// → [s ui_to_js] → [r ui_to_js] → jsui inlet 0 → handler function below.
// Handlers mutate state.tempoMaps[state.editorSlug], save dict, refresh UI.
// JS pushes values back to controls via this.patcher.getnamed(name).message('set', val)
// — 'set' suppresses the outlet so we don't loop.

// Helper: safely get a named patcher object. Returns null if not found
// (e.g. during early init before patcher fully resolves).
function _ed(name) {
    try {
        var p = this.patcher;
        if (!p) return null;
        return p.getnamed(name);
    } catch (e) { return null; }
}

// Push a value or text into a named control, suppressing its outlet.
function _edSet(name, value) {
    try {
        var obj = this.patcher.getnamed(name);
        if (obj) obj.message('set', value);
    } catch (e) {}
}

// Refresh the diagnostics labels (top of editor column).
function _refreshEditorDiagnostics(sceneName, matchInfo, slug) {
    if (!state.ready) return;
    var sceneText = sceneName ? ('Scene: ' + sceneName) : 'Scene: (none)';
    var matchText, methodText;
    if (matchInfo && matchInfo.filename) {
        matchText  = '-> ' + matchInfo.filename;
        methodText = 'Match: ' + matchInfo.method + ' / ' + matchInfo.confidence;
    } else {
        matchText  = '-> (no match)';
        methodText = 'Match: -';
    }
    _edSet('lbl_scene', sceneText);
    _edSet('lbl_match', matchText);
    _edSet('lbl_method', methodText);
}

// Refresh the row numboxes + page label + global state mirror.
function _refreshEditorUI() {
    if (!state.ready) return;
    var slug = state.editorSlug;
    var entries = (slug && state.tempoMaps[slug]) ? state.tempoMaps[slug] : [];
    var totalPages = Math.max(1, Math.ceil(entries.length / EDITOR_ROWS_PER_PAGE));
    if (state.editorPage >= totalPages) state.editorPage = totalPages - 1;
    if (state.editorPage < 0) state.editorPage = 0;
    var pageStart = state.editorPage * EDITOR_ROWS_PER_PAGE;
    for (var i = 0; i < EDITOR_ROWS_PER_PAGE; i++) {
        var entry = entries[pageStart + i];
        var bar = entry ? (entry.bar | 0) : 0;
        var bpm = entry ? Number(entry.bpm) : 0;
        _edSet('bar_row_' + i, bar);
        _edSet('bpm_row_' + i, bpm);
    }
    _edSet('lbl_page', (state.editorPage + 1) + '/' + totalPages);
    var mapCount = 0;
    for (var k in state.tempoMaps) mapCount++;
    _edSet('lbl_count', 'Maps: ' + mapCount);
    _edSet('lbl_source', 'Source: ' + state.tempoSource);
}

// Convert a row index (0..3) on the current page to an entry index in the slug's array.
function _entryIdxForRow(rowIdx) {
    return state.editorPage * EDITOR_ROWS_PER_PAGE + (rowIdx | 0);
}

// If the user is editing the currently-fired slug, re-apply the schedule
// so changes take effect mid-song without waiting for next scene change.
function _maybeReapplyForActiveSlug(slug) {
    // Currently 'editorSlug' is always the most-recent matched scene's slug,
    // so this fires for every edit. If that ever decouples, gate here.
    if (slug && state.tempoMaps[slug]) {
        state.tempoSchedule = state.tempoMaps[slug].slice().sort(function(a,b){ return a.bar - b.bar; });
        state.tempoFiredIdx = 0;
        state.tempoFiredCount = 0;
        state.baselineTempo = null;
        state.tempoSource = 'local';
        var dump = '';
        for (var i = 0; i < state.tempoSchedule.length; i++) {
            if (i) dump += ', ';
            dump += '{' + state.tempoSchedule[i].bar + ':' + state.tempoSchedule[i].bpm + '}';
        }
        post('  REAPPLY [' + slug + ']: schedule=[' + dump + '] source=local firedIdx=0\n');
    } else {
        post('  REAPPLY [' + slug + ']: no map — schedule unchanged (source=' + state.tempoSource + ')\n');
    }
}

// ---- Per-row UI handlers ----

function ui_bar(rowIdx, value) {
    var slug = state.editorSlug;
    if (!slug) { post('  ui_bar: no editorSlug — ignoring (no scene matched yet)\n'); return; }
    var entryIdx = _entryIdxForRow(rowIdx);
    var entries = state.tempoMaps[slug] || [];
    while (entries.length <= entryIdx) entries.push({bar: 0, bpm: 0});
    entries[entryIdx].bar = parseInt(value) | 0;
    state.tempoMaps[slug] = entries;
    _saveTempoMaps();
    _maybeReapplyForActiveSlug(slug);
    _refreshEditorUI();
}

function ui_bpm(rowIdx, value) {
    var slug = state.editorSlug;
    if (!slug) { post('  ui_bpm: no editorSlug — ignoring\n'); return; }
    var entryIdx = _entryIdxForRow(rowIdx);
    var entries = state.tempoMaps[slug] || [];
    while (entries.length <= entryIdx) entries.push({bar: 0, bpm: 0});
    entries[entryIdx].bpm = Number(value);
    state.tempoMaps[slug] = entries;
    _saveTempoMaps();
    _maybeReapplyForActiveSlug(slug);
    _refreshEditorUI();
}

function ui_del_row(rowIdx) {
    var slug = state.editorSlug;
    if (!slug) { post('  ui_del_row: no editorSlug — ignoring\n'); return; }
    var entryIdx = _entryIdxForRow(rowIdx);
    var entries = state.tempoMaps[slug];
    if (!entries || entryIdx >= entries.length) {
        post('  ui_del_row: row=' + rowIdx + ' (entry=' + entryIdx + ') is empty — nothing to delete\n');
        return;
    }
    entries.splice(entryIdx, 1);
    if (entries.length === 0) {
        delete state.tempoMaps[slug];
    } else {
        state.tempoMaps[slug] = entries;
    }
    _saveTempoMaps();
    _maybeReapplyForActiveSlug(slug);
    _refreshEditorUI();
    post('  ui_del_row: removed entry ' + entryIdx + ' for slug=\'' + slug + '\'\n');
}

// ---- Bottom-row UI handlers ----

function ui_add_row() {
    var slug = state.editorSlug;
    if (!slug) { post('  ui_add_row: no editorSlug — fire a scene first\n'); return; }
    var entries = state.tempoMaps[slug] || [];
    entries.push({bar: 0, bpm: 0});
    state.tempoMaps[slug] = entries;
    _saveTempoMaps();
    // Jump to page containing the new entry
    state.editorPage = Math.floor((entries.length - 1) / EDITOR_ROWS_PER_PAGE);
    _refreshEditorUI();
    post('  ui_add_row: appended empty entry to slug=\'' + slug + '\' (now ' + entries.length + ' entries)\n');
}

function ui_pg_prev() {
    if (state.editorPage > 0) {
        state.editorPage--;
        _refreshEditorUI();
    }
}

function ui_pg_next() {
    var slug = state.editorSlug;
    var entries = (slug && state.tempoMaps[slug]) ? state.tempoMaps[slug] : [];
    var totalPages = Math.max(1, Math.ceil(entries.length / EDITOR_ROWS_PER_PAGE));
    if (state.editorPage < totalPages - 1) {
        state.editorPage++;
        _refreshEditorUI();
    }
}

// ---- Global column handlers ----

function ui_clear_map() {
    var slug = state.editorSlug;
    if (!slug) { post('  ui_clear_map: no editorSlug — nothing to clear\n'); return; }
    if (state.tempoMaps[slug]) {
        delete state.tempoMaps[slug];
        _saveTempoMaps();
        _maybeReapplyForActiveSlug(slug);  // will leave tempoSource='none' since map gone
        // Note: maybeReapply would set source='local' — but since map is gone, fix up:
        state.tempoSchedule = [];
        state.tempoFiredIdx = 0;
        state.tempoFiredCount = 0;
        state.baselineTempo = null;
        state.tempoSource = 'none';
        post('  ui_clear_map: cleared slug=\'' + slug + '\'\n');
    } else {
        post('  ui_clear_map: slug=\'' + slug + '\' was already empty\n');
    }
    state.editorPage = 0;
    _refreshEditorUI();
}

function ui_reveal_file() {
    // Open the device folder in Finder so the user can see / edit / back up
    // the tempo_maps JSON alongside the .amxd and .js files. macOS handles
    // file:// URLs via NSWorkspace; spaces must be percent-encoded.
    if (!TEMPO_MAPS_FILE) _computeTempoMapsPath();
    if (!TEMPO_MAPS_FILE) {
        post('  ui_reveal_file: no path resolved — cannot reveal\n');
        return;
    }
    var slash = TEMPO_MAPS_FILE.lastIndexOf('/');
    var dir = (slash > 0) ? TEMPO_MAPS_FILE.substring(0, slash) : TEMPO_MAPS_FILE;
    // Trailing slash hints to NSWorkspace that this is a directory (open in Finder)
    var url = 'file://' + dir.replace(/ /g, '%20') + '/';
    try {
        messnamed('max', 'launchbrowser', url);
        post('  ui_reveal_file: opened ' + url + '\n');
    } catch (e) {
        post('  ui_reveal_file: ERR — ' + e + '\n');
    }
}

// Phase 1: dump current repo state for diagnostics.
// Usage from a [message] box: `repo_status`
function repo_status() {
    post('  repo_status: path=' + state.repo.path + '\n');
    var slugCount = 0;
    for (var k in state.repo.bySlug) slugCount++;
    post('  repo_status: indexed=' + state.repo.indexed + ', files=' + state.repo.files.length +
         ', slugs=' + slugCount + ', scanned=' + state.repo.scanCount +
         ', error=' + (state.repo.lastError || '(none)') + '\n');
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
