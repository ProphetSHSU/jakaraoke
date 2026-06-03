#!/usr/bin/env python3
"""
generate_setlist_pilot_v2.py
Builds Setlist Pilot v2 — merged device (pedal MIDI + UDP broadcast + UDP commands
+ plugsync~ bar/beat).

Produces: Setlist Pilot v2.amxd
Input JS: setlist_pilot_v2.js (jsui, inlets=2, outlets=1)
"""
import json, os, struct, sys

DEVICE_NAME    = "Setlist Pilot v2"
JS_FILENAME    = "setlist_pilot_v2.js"
AMXD_FILENAME  = "Setlist Pilot v2.amxd"

HERE = os.path.dirname(os.path.abspath(__file__))
PAD_W = 360
PAD_H = 160   # jsui canvas height (also used as patching y-offset reference)
              # Note: Live caps device chain height at ~190px. With chrome (~30px),
              # this leaves no room to add new presentation-visible objects.
              # tempo_maps editing surface lives in the patcher window only —
              # open the device's Max editor (Edit button in the device header).


# ============================================================================
# Phase 6: tempo_maps editor pane — Live UI objects (live.numbox/button/comment)
# ============================================================================
# Layout (190px tall, ~760px wide):
#   x=0..360 : existing jsui (setlist UI)
#   x=370..620 : EDITOR column — match diagnostics + 4 row slots + pagination
#   x=635..755 : GLOBAL column — clear/dump buttons + state mirror
#
# Wiring pattern: each control's outlet feeds a [prepend ui_<msg> [args...]]
# whose output goes to [s ui_to_js]. Receiver [r ui_to_js] connects to jsui
# inlet 0. JS handlers (ui_bar, ui_bpm, ui_del_row, ui_add_row, ui_pg_prev,
# ui_pg_next, ui_clear_map, ui_dump) update state.tempoMaps and refresh UI.
# JS pushes values back to controls via this.patcher.getnamed(varname).message('set', ...)

EDITOR_X = 370    # left edge of editor column
EDITOR_W = 250    # editor column width
GLOBAL_X = 635    # left edge of global column
GLOBAL_W = 120    # global column width


def _live_numbox(obj_id, varname, prect, presrect, range_lo=0, range_hi=999):
    """Create a live.numbox box. parameter_enable=0 keeps it out of Live's
    automation lanes; we manage state in our own dict."""
    return {"box": {
        "id": obj_id,
        "maxclass": "live.numbox",
        "varname": varname,
        "patching_rect": prect,
        "presentation": 1,
        "presentation_rect": presrect,
        "numinlets": 1, "numoutlets": 4,
        "outlettype": ["", "", "", "float"],
        "saved_attribute_attributes": {
            "valueof": {
                "parameter_enable": 0,
                "parameter_longname": varname,
                "parameter_shortname": varname,
                "parameter_type": 0,
                "parameter_mmin": range_lo,
                "parameter_mmax": range_hi,
                "parameter_initial_enable": 1,
                "parameter_initial": [0]
            }
        }
    }}


def _live_button(obj_id, varname, prect, presrect, label):
    """Create a live.text in MOMENTARY button mode.

    `mode: 0` is the critical attribute — without it, live.text defaults
    to TOGGLE behavior, where the second-state text shows an icon-font
    glyph (an "8" rendered in orange) instead of staying as a button.
    `parameter_enable: 0` keeps the control out of Live's automation lanes
    so we own all state in the JS dict."""
    return {"box": {
        "id": obj_id,
        "maxclass": "live.text",
        "varname": varname,
        "text": label,
        "mode": 0,
        "patching_rect": prect,
        "presentation": 1,
        "presentation_rect": presrect,
        "numinlets": 1, "numoutlets": 2,
        "outlettype": ["", ""],
        "saved_attribute_attributes": {
            "valueof": {
                "parameter_enable": 0,
                "parameter_longname": varname,
                "parameter_shortname": varname,
                "parameter_type": 2
            }
        }
    }}


def _comment(obj_id, varname, text, prect, presrect, fontsize=10, justify=0):
    """Create a comment that JS can update via .message('set', new_text).
    justify: 0=left (default), 1=center, 2=right."""
    box = {
        "id": obj_id,
        "maxclass": "comment",
        "varname": varname,
        "text": text,
        "patching_rect": prect,
        "presentation": 1,
        "presentation_rect": presrect,
        "numinlets": 1, "numoutlets": 0,
        "fontsize": fontsize
    }
    if justify:
        box["textjustification"] = justify
    return {"box": box}


def _prepend(obj_id, prect, prefix):
    """[prepend <prefix>] — wraps an arg list with a function name + index."""
    return {"box": {
        "id": obj_id,
        "maxclass": "newobj",
        "text": "prepend " + prefix,
        "patching_rect": prect,
        "numinlets": 2, "numoutlets": 1,
        "outlettype": [""]
    }}


def build_editor_boxes(B, DY):
    """Build editor + global column boxes. Patcher coords sit below the
    existing main patching area; presentation coords define on-device layout."""
    # Patching-area Y for hidden helper objects (prepends, send/receive)
    P_Y = B + 10 + DY*5 + 50  # below the dict object
    PX = 5                     # restart x for hidden helpers
    boxes = []

    # ---- Hidden plumbing: a single [r ui_to_js] for all control messages ----
    boxes.append({"box": {
        "id": "obj-r-ui-to-js",
        "maxclass": "newobj",
        "text": "r ui_to_js",
        "patching_rect": [PX, P_Y, 80, 22],
        "numinlets": 0, "numoutlets": 1, "outlettype": [""]
    }})
    # The corresponding patchline ([r ui_to_js] -> jsui inlet 0) is added in build_editor_lines.

    # ---- 4 editor rows: bar (live.numbox), bpm (live.numbox), delete (live.text button) ----
    # Tightened to fit under Live's ~160px usable presentation area.
    ROW_Y_BASE = 56    # presentation y for row 0
    ROW_DY = 20        # vertical spacing between rows
    BAR_X = EDITOR_X + 5
    BAR_W = 70
    BPM_X = EDITOR_X + 80
    BPM_W = 70
    DEL_X = EDITOR_X + 155
    DEL_W = 24
    for i in range(4):
        py = ROW_Y_BASE + i * ROW_DY
        # Patching coords (these objects' editing-area positions don't matter much)
        bar_prect = [PX + 100, P_Y + (i*4)*22, 60, 19]
        bpm_prect = [PX + 170, P_Y + (i*4)*22, 60, 19]
        del_prect = [PX + 240, P_Y + (i*4)*22, 30, 19]
        boxes.append(_live_numbox("obj-bar-row-%d" % i, "bar_row_%d" % i,
                                   bar_prect, [BAR_X, py, BAR_W, 17]))
        boxes.append(_live_numbox("obj-bpm-row-%d" % i, "bpm_row_%d" % i,
                                   bpm_prect, [BPM_X, py, BPM_W, 17]))
        boxes.append(_live_button("obj-del-row-%d" % i, "del_row_%d" % i,
                                   del_prect, [DEL_X, py, DEL_W, 17], "X"))
        # Per-row prepend boxes (route the outlet value into ui_to_js)
        boxes.append(_prepend("obj-prep-bar-%d" % i,
                              [PX + 100, P_Y + (i*4 + 1)*22, 100, 22], "ui_bar %d" % i))
        boxes.append(_prepend("obj-prep-bpm-%d" % i,
                              [PX + 170, P_Y + (i*4 + 1)*22, 100, 22], "ui_bpm %d" % i))
        boxes.append(_prepend("obj-prep-del-%d" % i,
                              [PX + 240, P_Y + (i*4 + 1)*22, 100, 22], "ui_del_row %d" % i))

    # ---- Diagnostic labels (top of editor column) ----
    boxes.append(_comment("obj-lbl-scene",  "lbl_scene",  "Scene: (none)",
                          [EDITOR_X, B + 10, EDITOR_W, 14],
                          [EDITOR_X, 1, EDITOR_W, 12], fontsize=10))
    boxes.append(_comment("obj-lbl-match",  "lbl_match",  "-> (no match)",
                          [EDITOR_X, B + 26, EDITOR_W, 14],
                          [EDITOR_X, 14, EDITOR_W, 12], fontsize=10))
    boxes.append(_comment("obj-lbl-method", "lbl_method", "Match: -",
                          [EDITOR_X, B + 42, EDITOR_W, 14],
                          [EDITOR_X, 27, EDITOR_W, 12], fontsize=10))
    # Column headers (static) — one per column, positioned over its numbox
    boxes.append(_comment("obj-lbl-hdr-bar", "lbl_hdr_bar", "Bar",
                          [EDITOR_X, B + 58, 70, 14],
                          [BAR_X, 41, BAR_W, 12], fontsize=10))
    boxes.append(_comment("obj-lbl-hdr-bpm", "lbl_hdr_bpm", "BPM",
                          [EDITOR_X + 80, B + 58, 70, 14],
                          [BPM_X, 41, BPM_W, 12], fontsize=10))

    # ---- Bottom row: add-row + pagination ----
    BTM_Y = 138    # tightened to fit under Live's ~160px usable presentation
    boxes.append(_live_button("obj-btn-add-row", "btn_add_row",
                              [EDITOR_X, B + 100, 100, 17],
                              [EDITOR_X + 5, BTM_Y, 90, 17], "+ Add row"))
    # Pagination: tight grouping with center-justified label
    # prev[100..124] [page 130..170 centered] next[174..198]
    boxes.append(_live_button("obj-btn-pg-prev", "btn_pg_prev",
                              [EDITOR_X + 110, B + 100, 30, 17],
                              [EDITOR_X + 100, BTM_Y, 24, 17], "<"))
    boxes.append(_comment("obj-lbl-page", "lbl_page", "1/1",
                          [EDITOR_X + 145, B + 100, 40, 14],
                          [EDITOR_X + 130, BTM_Y + 2, 40, 12], fontsize=10, justify=1))
    boxes.append(_live_button("obj-btn-pg-next", "btn_pg_next",
                              [EDITOR_X + 180, B + 100, 30, 17],
                              [EDITOR_X + 174, BTM_Y, 24, 17], ">"))

    # Prepend wiring for bottom row + global controls
    HX = PX + 350   # patching X for these prepends (off to the right)
    boxes.append(_prepend("obj-prep-add-row", [HX, P_Y + 0,  120, 22], "ui_add_row"))
    boxes.append(_prepend("obj-prep-pg-prev", [HX, P_Y + 25, 120, 22], "ui_pg_prev"))
    boxes.append(_prepend("obj-prep-pg-next", [HX, P_Y + 50, 120, 22], "ui_pg_next"))
    boxes.append(_prepend("obj-prep-clear",   [HX, P_Y + 75, 120, 22], "ui_clear_map"))
    boxes.append(_prepend("obj-prep-dump",    [HX, P_Y + 100,120, 22], "ui_dump"))

    # ---- GLOBAL column ----
    boxes.append(_live_button("obj-btn-clear-map", "btn_clear_map",
                              [GLOBAL_X, B + 10, 100, 17],
                              [GLOBAL_X, 1, GLOBAL_W, 17], "Clear map"))
    boxes.append(_live_button("obj-btn-dump", "btn_dump",
                              [GLOBAL_X, B + 30, 100, 17],
                              [GLOBAL_X, 21, GLOBAL_W, 17], "Dump all"))
    boxes.append(_comment("obj-lbl-schema", "lbl_schema", "Schema: v1",
                          [GLOBAL_X, B + 50, 100, 12],
                          [GLOBAL_X, 44, GLOBAL_W, 12], fontsize=10))
    boxes.append(_comment("obj-lbl-count", "lbl_count", "Maps: 0",
                          [GLOBAL_X, B + 64, 100, 12],
                          [GLOBAL_X, 58, GLOBAL_W, 12], fontsize=10))
    boxes.append(_comment("obj-lbl-source", "lbl_source", "Source: none",
                          [GLOBAL_X, B + 78, 100, 12],
                          [GLOBAL_X, 72, GLOBAL_W, 12], fontsize=10))

    # ---- Single [s ui_to_js] aggregator (all prepends feed into this send) ----
    boxes.append({"box": {
        "id": "obj-s-ui-to-js",
        "maxclass": "newobj",
        "text": "s ui_to_js",
        "patching_rect": [PX + 480, P_Y, 80, 22],
        "numinlets": 1, "numoutlets": 0
    }})
    return boxes


def build_editor_lines():
    """Wiring: control outlets -> prepends -> [s ui_to_js], and [r ui_to_js] -> jsui inlet 0."""
    lines = []
    # Receive aggregator → jsui inlet 0
    lines.append({"patchline": {"source": ["obj-r-ui-to-js", 0], "destination": ["obj-jsui", 0]}})

    # Per-row controls
    for i in range(4):
        lines.append({"patchline": {"source": ["obj-bar-row-%d" % i, 0], "destination": ["obj-prep-bar-%d" % i, 0]}})
        lines.append({"patchline": {"source": ["obj-bpm-row-%d" % i, 0], "destination": ["obj-prep-bpm-%d" % i, 0]}})
        lines.append({"patchline": {"source": ["obj-del-row-%d" % i, 0], "destination": ["obj-prep-del-%d" % i, 0]}})
        lines.append({"patchline": {"source": ["obj-prep-bar-%d" % i, 0], "destination": ["obj-s-ui-to-js", 0]}})
        lines.append({"patchline": {"source": ["obj-prep-bpm-%d" % i, 0], "destination": ["obj-s-ui-to-js", 0]}})
        lines.append({"patchline": {"source": ["obj-prep-del-%d" % i, 0], "destination": ["obj-s-ui-to-js", 0]}})

    # Bottom row + global controls → their prepends → send
    pairs = [
        ("obj-btn-add-row",  "obj-prep-add-row"),
        ("obj-btn-pg-prev",  "obj-prep-pg-prev"),
        ("obj-btn-pg-next",  "obj-prep-pg-next"),
        ("obj-btn-clear-map","obj-prep-clear"),
        ("obj-btn-dump",     "obj-prep-dump"),
    ]
    for src, prep in pairs:
        lines.append({"patchline": {"source": [src, 0], "destination": [prep, 0]}})
        lines.append({"patchline": {"source": [prep, 0], "destination": ["obj-s-ui-to-js", 0]}})
    return lines


def build_patcher(js_filename: str, w: int, h: int) -> dict:
    B = h + 10   # y-offset for patching area (below presentation canvas)
    DY = 30
    boxes = [
        # ================== PRESENTATION: jsui canvas ==================
        {"box": {
            "id": "obj-jsui",
            "maxclass": "jsui",
            "patching_rect": [5, 5, w, h],
            "presentation": 1,
            "presentation_rect": [0, 0, w, h],
            "numinlets": 2,
            "numoutlets": 2,
            "outlettype": ["", ""],
            "filename": js_filename
        }},

        # ================== MIDI IN (inlet 0) ==================
        {"box": {
            "id": "obj-notein", "maxclass": "newobj", "text": "notein",
            "patching_rect": [5, B + 10, 60, 22],
            "numinlets": 1, "numoutlets": 3, "outlettype": ["int", "int", "int"]
        }},
        {"box": {
            "id": "obj-pack-notein", "maxclass": "newobj", "text": "pack 0 0 0",
            "patching_rect": [5, B + 10 + DY, 90, 22],
            "numinlets": 3, "numoutlets": 1, "outlettype": [""]
        }},
        {"box": {
            "id": "obj-prepend-notein", "maxclass": "newobj", "text": "prepend note_in",
            "patching_rect": [5, B + 10 + DY*2, 130, 22],
            "numinlets": 1, "numoutlets": 1, "outlettype": [""]
        }},

        # ================== live.thisdevice → init bang (inlet 0) ==================
        {"box": {
            "id": "obj-livethisdev", "maxclass": "newobj", "text": "live.thisdevice",
            "patching_rect": [160, B + 10, 100, 22],
            "numinlets": 1, "numoutlets": 3, "outlettype": ["", "", ""]
        }},
        {"box": {
            "id": "obj-trigger-init", "maxclass": "newobj", "text": "t b",
            "patching_rect": [160, B + 10 + DY, 40, 22],
            "numinlets": 1, "numoutlets": 1, "outlettype": ["bang"]
        }},

        # ================== UDP OUT (outlet 0) ==================
        {"box": {
            "id": "obj-udpsend", "maxclass": "newobj", "text": "udpsend 127.0.0.1 9899",
            "patching_rect": [5, B + 10 + DY*4, 180, 22],
            "numinlets": 1, "numoutlets": 0
        }},
        {"box": {
            "id": "obj-print-udpout", "maxclass": "newobj", "text": "print SP2_UDP_OUT",
            "patching_rect": [200, B + 10 + DY*4, 140, 22],
            "numinlets": 1, "numoutlets": 0
        }},

        # ================== UDP IN (commands → inlet 0) ==================
        {"box": {
            "id": "obj-udpreceive", "maxclass": "newobj", "text": "udpreceive 9900",
            "patching_rect": [290, B + 10, 130, 22],
            "numinlets": 1, "numoutlets": 1, "outlettype": [""]
        }},
        {"box": {
            "id": "obj-route-j", "maxclass": "newobj", "text": "route /j",
            "patching_rect": [290, B + 10 + DY, 80, 22],
            "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""]
        }},
        {"box": {
            "id": "obj-print-cmdin", "maxclass": "newobj", "text": "print SP2_CMD_IN",
            "patching_rect": [400, B + 10 + DY, 140, 22],
            "numinlets": 1, "numoutlets": 0
        }},

        # ================== plugsync~ bar/beat (→ inlet 1) ==================
        # plugsync~ outlets (per Max8 docs):
        #   0=int running, 1=int bar (1-idx), 2=int beat (1-idx),
        #   3=float beat-fraction, 4=?, 5=float samples/beat, 6=float beatsPPQ,
        #   7=?, 8=int flags
        # We want outlets 1 (bar) and 2 (beat). They're ints, not signals —
        # so NO snapshot~ needed. But plugsync~ streams continuously, so we
        # use [change] to filter down to transitions only.
        {"box": {
            "id": "obj-plugsync", "maxclass": "newobj", "text": "plugsync~",
            "patching_rect": [5, B + 10 + DY*5 + 15, 80, 22],
            "numinlets": 1, "numoutlets": 9,
            "outlettype": ["int", "int", "int", "float", "", "float", "float", "int", "int"]
        }},
        {"box": {
            "id": "obj-change-bar", "maxclass": "newobj", "text": "change",
            "patching_rect": [90, B + 10 + DY*5 + 15, 60, 22],
            "numinlets": 1, "numoutlets": 1, "outlettype": ["int"]
        }},
        {"box": {
            "id": "obj-change-beat", "maxclass": "newobj", "text": "change",
            "patching_rect": [160, B + 10 + DY*5 + 15, 60, 22],
            "numinlets": 1, "numoutlets": 1, "outlettype": ["int"]
        }},
        {"box": {
            "id": "obj-pack-bb", "maxclass": "newobj", "text": "pack i i",
            "patching_rect": [90, B + 10 + DY*6 + 15, 80, 22],
            "numinlets": 2, "numoutlets": 1, "outlettype": [""]
        }},

        # ================== TEMPO MAPS STORAGE ==================
        # [dict tempo_maps @embed 1] — Max dict that mirrors the canonical
        # tempo-map data which now LIVES IN AN EXTERNAL JSON FILE colocated
        # with this .amxd:
        #   <amxd_dir>/setlist_pilot_tempo_maps.json
        #
        # The external file is the source of truth (since v2.3.0). The
        # embedded dict is kept (and `@embed 1` retained) for ONE rev so
        # devices saved into a .als under v2.2.x still get their data
        # migrated to the file on first load under v2.3.0+. After everyone
        # is on v2.3.0+, this can be flipped to `@embed 0`.
        #
        # Schema (unchanged): { "schemaVersion": 1, "tempoMaps": { "<slug>": [{"bar":N,"bpm":M},...] } }
        # See setlist_pilot_v2.js: _loadTempoMaps() / _saveTempoMaps().
        {"box": {
            "id": "obj-dict-tempomaps", "maxclass": "newobj",
            "text": "dict tempo_maps @embed 1",
            "patching_rect": [240, B + 10 + DY*5 + 15, 220, 22],
            "numinlets": 1, "numoutlets": 4, "outlettype": ["dictionary", "", "", ""]
        }},

    ]
    boxes += build_editor_boxes(B, DY)

    lines = [
        # --- MIDI path: notein → pack → prepend → jsui inlet 0 ---
        {"patchline": {"source": ["obj-notein", 0], "destination": ["obj-pack-notein", 0]}},
        {"patchline": {"source": ["obj-notein", 1], "destination": ["obj-pack-notein", 1]}},
        {"patchline": {"source": ["obj-notein", 2], "destination": ["obj-pack-notein", 2]}},
        {"patchline": {"source": ["obj-pack-notein", 0], "destination": ["obj-prepend-notein", 0]}},
        {"patchline": {"source": ["obj-prepend-notein", 0], "destination": ["obj-jsui", 0]}},

        # --- live.thisdevice → t b → jsui inlet 0 (bang = init) ---
        {"patchline": {"source": ["obj-livethisdev", 1], "destination": ["obj-trigger-init", 0]}},
        {"patchline": {"source": ["obj-trigger-init", 0], "destination": ["obj-jsui", 0]}},

        # --- UDP IN: udpreceive → route /j → jsui inlet 0 ---
        {"patchline": {"source": ["obj-udpreceive", 0], "destination": ["obj-route-j", 0]}},
        {"patchline": {"source": ["obj-route-j", 0], "destination": ["obj-jsui", 0]}},
        {"patchline": {"source": ["obj-route-j", 0], "destination": ["obj-print-cmdin", 0]}},

        # --- UDP OUT: jsui outlet 0 → udpsend + print (small msgs: logged) ---
        {"patchline": {"source": ["obj-jsui", 0], "destination": ["obj-udpsend", 0]}},
        {"patchline": {"source": ["obj-jsui", 0], "destination": ["obj-print-udpout", 0]}},

        # --- UDP OUT quiet: jsui outlet 1 → udpsend ONLY (big msgs: no log) ---
        {"patchline": {"source": ["obj-jsui", 1], "destination": ["obj-udpsend", 0]}},

        # --- plugsync~ outlets 1 (bar int), 2 (beat int) → change → pack → jsui inlet 1 ---
        {"patchline": {"source": ["obj-plugsync", 1], "destination": ["obj-change-bar", 0]}},
        {"patchline": {"source": ["obj-plugsync", 2], "destination": ["obj-change-beat", 0]}},
        {"patchline": {"source": ["obj-change-bar", 0], "destination": ["obj-pack-bb", 0]}},
        {"patchline": {"source": ["obj-change-beat", 0], "destination": ["obj-pack-bb", 1]}},
        {"patchline": {"source": ["obj-pack-bb", 0], "destination": ["obj-jsui", 1]}},
    ]
    lines += build_editor_lines()

    patcher = {
        "fileversion": 1,
        "appversion": {"major": 8, "minor": 6, "revision": 4,
                       "architecture": "x64", "modernui": 1},
        "classnamespace": "box",
        "rect": [100, 100, w + 20, h + 280],
        "bglocked": 0,
        "openinpresentation": 1,
        "default_fontsize": 12.0,
        "default_fontface": 0,
        "default_fontname": "Arial",
        "gridonopen": 1,
        "gridsize": [15, 15],
        "gridsnaponopen": 1,
        "objectsnaponopen": 1,
        "statusbarvisible": 2,
        "toolbarvisible": 1,
        "lefttoolbarpinned": 0, "toptoolbarpinned": 0,
        "righttoolbarpinned": 0, "bottomtoolbarpinned": 0,
        "toolbars_unpinned_last_save": 0,
        "eventsource": None, "description": "", "digest": "",
        "tags": "", "style": "", "subpatcher_template": "",
        "assistshowspatchername": 0,
        "boxes": boxes,
        "lines": lines,
        "dependency_cache": [],
        "autosave": 0
    }
    return {"patcher": patcher}


def write_amxd(patch_dict: dict, path: str) -> None:
    j = json.dumps(patch_dict, indent=2).encode("utf-8")
    if not j.endswith(b"\n"):
        j += b"\n"
    payload = j + b"\x00"
    h = bytearray(32)
    h[0x00:0x04] = b"ampf"
    struct.pack_into("<I", h, 0x04, 4)
    h[0x08:0x0c] = b"mmmm"
    h[0x0c:0x10] = b"meta"
    struct.pack_into("<I", h, 0x10, 4)
    struct.pack_into("<I", h, 0x14, 0)
    h[0x18:0x1c] = b"ptch"
    struct.pack_into("<I", h, 0x1c, len(payload))
    with open(path, "wb") as f:
        f.write(bytes(h) + payload)


def main() -> int:
    js_path = os.path.join(HERE, JS_FILENAME)
    amxd_path = os.path.join(HERE, AMXD_FILENAME)

    if not os.path.exists(js_path):
        print(f"ERR: missing {js_path}", file=sys.stderr)
        return 1

    patch = build_patcher(JS_FILENAME, PAD_W, PAD_H)
    write_amxd(patch, amxd_path)
    print(f"Built: {DEVICE_NAME}")
    print(f"  JS:   {js_path}  ({os.path.getsize(js_path):,} bytes)")
    print(f"  AMXD: {amxd_path}  ({os.path.getsize(amxd_path):,} bytes)")
    print(f"\nDeploy to gigmac:")
    print(f"  scp '{amxd_path}' '{js_path}' \\")
    print(f"    'gigmac:Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect/'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
