#!/usr/bin/env python3
"""
generate_setlist_pilot_v1_1.py
Builds Setlist Pilot v1.1 as a jsui-based M4L device, mirroring the proven
v4/5/6 lighting controller pattern (jsui.filename for JS resolution).

Produces: Setlist Pilot v1.amxd  (overwrites v1)
Input JS:  setlist_pilot_v1.js   (jsui-compatible)
"""
import json, os, struct, sys

DEVICE_NAME = "Setlist Pilot v1"
JS_FILENAME = "setlist_pilot_v1.js"
AMXD_FILENAME = "Setlist Pilot v1.amxd"

HERE = os.path.dirname(os.path.abspath(__file__))
PAD_W = 340
PAD_H = 160


def build_patcher(js_filename: str, w: int, h: int) -> dict:
    B = h + 10  # y-offset for non-presentation (patching) objects
    boxes = [
        # --- jsui: the brain + canvas ---
        {"box": {
            "id": "obj-jsui",
            "maxclass": "jsui",
            "patching_rect": [5, 5, w, h],
            "presentation": 1,
            "presentation_rect": [0, 0, w, h],
            "numinlets": 1,
            "numoutlets": 1,
            "outlettype": [""],
            "filename": js_filename
        }},
        # --- MIDI input chain ---
        {"box": {
            "id": "obj-notein",
            "maxclass": "newobj", "text": "notein",
            "patching_rect": [5, B + 10, 60, 22],
            "numinlets": 1, "numoutlets": 3,
            "outlettype": ["int", "int", "int"]
        }},
        {"box": {
            "id": "obj-pack-notein",
            "maxclass": "newobj", "text": "pack 0 0 0",
            "patching_rect": [5, B + 40, 90, 22],
            "numinlets": 3, "numoutlets": 1, "outlettype": [""]
        }},
        {"box": {
            "id": "obj-prepend-notein",
            "maxclass": "newobj", "text": "prepend note_in",
            "patching_rect": [5, B + 70, 130, 22],
            "numinlets": 1, "numoutlets": 1, "outlettype": [""]
        }},
        # --- Diagnostic [print] objects (log MIDI flow to Max Console) ---
        {"box": {
            "id": "obj-print-notein-raw",
            "maxclass": "newobj", "text": "print SP_RAW_NOTEIN",
            "patching_rect": [140, B + 10, 140, 22],
            "numinlets": 1, "numoutlets": 0
        }},
        {"box": {
            "id": "obj-print-pack-out",
            "maxclass": "newobj", "text": "print SP_PACK_OUT",
            "patching_rect": [140, B + 40, 140, 22],
            "numinlets": 1, "numoutlets": 0
        }},
        {"box": {
            "id": "obj-print-prepend-out",
            "maxclass": "newobj", "text": "print SP_PREPEND_OUT",
            "patching_rect": [140, B + 70, 160, 22],
            "numinlets": 1, "numoutlets": 0
        }},
        # --- live.thisdevice → msg_int(1) when LiveAPI ready ---
        {"box": {
            "id": "obj-livethisdev",
            "maxclass": "newobj", "text": "live.thisdevice",
            "patching_rect": [310, B + 10, 100, 22],
            "numinlets": 1, "numoutlets": 3, "outlettype": ["", "", ""]
        }},
    ]

    lines = [
        # MIDI path
        {"patchline": {"source": ["obj-notein", 0], "destination": ["obj-pack-notein", 0]}},
        {"patchline": {"source": ["obj-notein", 1], "destination": ["obj-pack-notein", 1]}},
        {"patchline": {"source": ["obj-notein", 2], "destination": ["obj-pack-notein", 2]}},
        {"patchline": {"source": ["obj-pack-notein", 0], "destination": ["obj-prepend-notein", 0]}},
        {"patchline": {"source": ["obj-prepend-notein", 0], "destination": ["obj-jsui", 0]}},
        # Diagnostic branches (tap each stage, print in parallel)
        {"patchline": {"source": ["obj-notein", 0], "destination": ["obj-print-notein-raw", 0]}},
        {"patchline": {"source": ["obj-pack-notein", 0], "destination": ["obj-print-pack-out", 0]}},
        {"patchline": {"source": ["obj-prepend-notein", 0], "destination": ["obj-print-prepend-out", 0]}},
        # LiveAPI-ready kickoff
        {"patchline": {"source": ["obj-livethisdev", 1], "destination": ["obj-jsui", 0]}},
    ]

    patcher = {
        "fileversion": 1,
        "appversion": {"major": 8, "minor": 6, "revision": 4,
                       "architecture": "x64", "modernui": 1},
        "classnamespace": "box",
        "rect": [100, 100, w + 20, h + 240],
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
