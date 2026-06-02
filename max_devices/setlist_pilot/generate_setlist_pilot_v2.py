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
        # [dict tempo_maps @embed 1] — Max dict that embeds its contents
        # in the saved patcher (.amxd) and therefore in the .als. JS reads
        # and writes via `var d = new Dict('tempo_maps')`. Schema:
        #   { "schemaVersion": 1, "tempoMaps": { "<slug>": [{"bar":N,"bpm":M},...] } }
        # Initial state: empty dict ({}). Phase 3 message handlers in
        # setlist_pilot_v2.js (tempo_map_set/clear/dump) populate it at
        # runtime; saving the .als persists everything.
        {"box": {
            "id": "obj-dict-tempomaps", "maxclass": "newobj",
            "text": "dict tempo_maps @embed 1",
            "patching_rect": [240, B + 10 + DY*5 + 15, 220, 22],
            "numinlets": 1, "numoutlets": 4, "outlettype": ["dictionary", "", "", ""]
        }},

        # Phase 3 tempo_maps editing surface (until Phase 6 UI lands).
        # Each [message] box sends its text into js inlet 0 → handler.
        # Patcher-window only (NOT presentation): Live caps device height
        # at ~190px and the jsui already takes 160. Open the device's Max
        # editor (Edit button in device header) to see/click these boxes.
        {"box": {
            "id": "obj-comment-tempomaps", "maxclass": "comment",
            "text": "tempo_maps editing (Cmd-click msg text to edit, then click box to send):",
            "patching_rect": [240, B + 10 + DY*6 + 15, 420, 18],
            "numinlets": 1, "numoutlets": 0, "fontsize": 11
        }},
        {"box": {
            "id": "obj-msg-tempomap-set", "maxclass": "message",
            "text": "tempo_map_set 99-red-balloons 27 194",
            "patching_rect": [240, B + 10 + DY*7 + 15, 320, 22],
            "numinlets": 2, "numoutlets": 1, "outlettype": [""]
        }},
        {"box": {
            "id": "obj-msg-tempomap-clear", "maxclass": "message",
            "text": "tempo_map_clear 99-red-balloons",
            "patching_rect": [240, B + 10 + DY*8 + 15, 320, 22],
            "numinlets": 2, "numoutlets": 1, "outlettype": [""]
        }},
        {"box": {
            "id": "obj-msg-tempomap-dump", "maxclass": "message",
            "text": "tempo_map_dump",
            "patching_rect": [240, B + 10 + DY*9 + 15, 150, 22],
            "numinlets": 2, "numoutlets": 1, "outlettype": [""]
        }},
        {"box": {
            "id": "obj-msg-tempomap-clear-all", "maxclass": "message",
            "text": "tempo_map_clear_all",
            "patching_rect": [400, B + 10 + DY*9 + 15, 160, 22],
            "numinlets": 2, "numoutlets": 1, "outlettype": [""]
        }},

    ]

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

        # --- Phase 3 tempo_maps editing message boxes → jsui inlet 0 ---
        {"patchline": {"source": ["obj-msg-tempomap-set", 0], "destination": ["obj-jsui", 0]}},
        {"patchline": {"source": ["obj-msg-tempomap-clear", 0], "destination": ["obj-jsui", 0]}},
        {"patchline": {"source": ["obj-msg-tempomap-dump", 0], "destination": ["obj-jsui", 0]}},
        {"patchline": {"source": ["obj-msg-tempomap-clear-all", 0], "destination": ["obj-jsui", 0]}},

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
