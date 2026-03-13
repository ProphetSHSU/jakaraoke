#!/usr/bin/env python3
"""
Jakeraoke Batch Alignment Tool

Processes all songs in a library:
  1. Fuzzy-match each song to an MP3 on the file server
  2. Copy MP3 locally, run demucs + whisper + alignment
  3. Insert {d_time:} markers into the ChordPro file
  4. Clean up intermediates to save disk space
  5. Track status for re-runs and missing MP3s

Usage:
  python batch.py                          # process all, default paths
  python batch.py --dry-run                # preview matches without processing
  python batch.py --song "Closing Time"    # process a single song
  python batch.py --reprocess              # re-process songs that already have markers
"""

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SONG_DIR = "/Users/jawgner/source/Song_Repo/WingPunchDB"
MP3_DIR = "/Volumes/Macintosh HD-1/Users/jake/Music/from youtube and others"
STAGING_DIR = os.path.join(os.path.dirname(__file__), "staging")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
STATUS_FILE = os.path.join(os.path.dirname(__file__), "batch_status.json")
MISSING_FILE = os.path.join(os.path.dirname(__file__), "missing_mp3s.txt")
WHISPER_MODEL = "medium"
OVERRIDES_FILE = os.path.join(os.path.dirname(__file__), "overrides.json")

# ---------------------------------------------------------------------------
# MP3 Fuzzy Matching
# ---------------------------------------------------------------------------

def normalize_for_match(s: str) -> str:
    """Normalize a string for fuzzy matching."""
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def extract_artist_title(song_basename: str) -> tuple:
    """Extract artist and title from 'Artist - Title.txt' format."""
    name = os.path.splitext(song_basename)[0]
    if " - " in name:
        parts = name.split(" - ", 1)
        return normalize_for_match(parts[0]), normalize_for_match(parts[1])
    return "", normalize_for_match(name)


def find_best_mp3(song_basename: str, mp3_files: list) -> tuple:
    """Find the best matching MP3 for a song.

    Requires both artist and title keywords to appear in the MP3 filename.
    Returns (mp3_path, confidence_score) or (None, 0.0).
    """
    artist, title = extract_artist_title(song_basename)
    artist_words = artist.split()
    title_words = title.split()

    # Filter out very short/common words for matching
    skip_words = {"the", "a", "an", "of", "in", "on", "at", "to", "and", "or", "is", "it"}
    artist_keywords = [w for w in artist_words if w not in skip_words and len(w) > 1]
    title_keywords = [w for w in title_words if w not in skip_words and len(w) > 1]

    best_score = 0.0
    best_mp3 = None

    for mp3_path in mp3_files:
        mp3_norm = normalize_for_match(os.path.basename(mp3_path))

        # Count keyword hits
        artist_hits = sum(1 for kw in artist_keywords if kw in mp3_norm) if artist_keywords else 0
        title_hits = sum(1 for kw in title_keywords if kw in mp3_norm) if title_keywords else 0

        # Require at least 1 artist keyword AND 1 title keyword
        if artist_keywords and artist_hits == 0:
            continue
        if title_keywords and title_hits == 0:
            continue

        # Score based on keyword coverage
        artist_ratio = artist_hits / len(artist_keywords) if artist_keywords else 0.5
        title_ratio = title_hits / len(title_keywords) if title_keywords else 0.5

        # Bonus for sequence similarity
        song_norm = normalize_for_match(os.path.splitext(song_basename)[0])
        seq_ratio = SequenceMatcher(None, song_norm, mp3_norm[:60]).ratio()

        score = artist_ratio * 0.35 + title_ratio * 0.45 + seq_ratio * 0.20

        if score > best_score:
            best_score = score
            best_mp3 = mp3_path

    return best_mp3, best_score


# ---------------------------------------------------------------------------
# ChordPro Marker Insertion
# ---------------------------------------------------------------------------

def count_existing_markers(chordpro_path: str) -> int:
    """Count existing {d_time:} markers in a ChordPro file."""
    with open(chordpro_path) as f:
        content = f.read()
    return len(re.findall(r"\{d_time:", content))


def insert_markers(chordpro_path: str, markers: list) -> tuple:
    """Insert {d_time:} markers into a ChordPro file.

    Removes existing {d_time:} markers and inserts new ones.
    Returns (updated_content, markers_inserted).
    """
    with open(chordpro_path) as f:
        lines = f.readlines()

    # Build a map: line_num → marker time_str
    marker_map = {}
    for m in markers:
        marker_map[m["line_num"]] = m["time_str"]

    # Remove existing {d_time:} lines and insert new ones
    new_lines = []
    for i, line in enumerate(lines):
        line_num = i + 1

        # Skip existing d_time markers
        if re.match(r"^\s*\{d_time:", line):
            continue

        # Insert new marker before this line if needed
        if line_num in marker_map:
            new_lines.append(f"{{d_time: {marker_map[line_num]}}}\n")

        new_lines.append(line)

    return "".join(new_lines), len(markers)


# ---------------------------------------------------------------------------
# Single Song Processing
# ---------------------------------------------------------------------------

def process_song(
    song_path: str,
    mp3_path: str,
    staging_dir: str,
    output_dir: str,
    whisper_model: str = "medium",
) -> dict:
    """Process a single song through the full pipeline.

    Returns a result dict with status, markers, timing info.
    """
    song_name = os.path.splitext(os.path.basename(song_path))[0]
    result = {
        "song": song_name,
        "status": "pending",
        "mp3": os.path.basename(mp3_path),
        "markers_generated": 0,
        "markers_existing": count_existing_markers(song_path),
        "lines_matched": 0,
        "lines_total": 0,
        "avg_delta": None,
        "duration_secs": 0,
        "error": None,
    }

    start_time = time.time()

    try:
        # Stage audio locally (convert m4a to mp3 if needed)
        os.makedirs(staging_dir, exist_ok=True)
        src_ext = os.path.splitext(mp3_path)[1].lower()
        local_mp3_name = os.path.splitext(os.path.basename(mp3_path))[0] + ".mp3"
        local_mp3 = os.path.join(staging_dir, local_mp3_name)
        if not os.path.exists(local_mp3):
            if src_ext == ".m4a":
                print(f"    Converting M4A → MP3...")
                subprocess.run(
                    ["ffmpeg", "-i", mp3_path, "-q:a", "2", "-y", local_mp3],
                    capture_output=True, check=True,
                )
            else:
                print(f"    Copying MP3 to staging...")
                shutil.copy2(mp3_path, local_mp3)

        # Import alignment functions
        from align import (
            isolate_vocals,
            transcribe_vocals,
            extract_lyric_lines,
            align_lyrics_to_words,
            generate_markers,
        )

        # Step 1: Demucs
        song_output = os.path.join(output_dir, song_name)
        os.makedirs(song_output, exist_ok=True)
        vocals_path = isolate_vocals(local_mp3, song_output)

        # Step 2: Whisper
        whisper_words = transcribe_vocals(vocals_path, model_name=whisper_model)

        # Step 3: Parse lyrics
        lyric_lines = extract_lyric_lines(song_path)
        result["lines_total"] = len(lyric_lines)

        # Step 4: Align
        aligned = align_lyrics_to_words(lyric_lines, whisper_words)
        result["lines_matched"] = sum(1 for a in aligned if a["start_time"] is not None)

        # Step 5: Generate markers
        markers = generate_markers(aligned)
        result["markers_generated"] = len(markers)

        # Step 6: Insert markers into ChordPro
        if markers:
            updated_content, count = insert_markers(song_path, markers)
            with open(song_path, "w") as f:
                f.write(updated_content)
            print(f"    ✅ Inserted {count} markers into {os.path.basename(song_path)}")

        # Cleanup intermediates (keep whisper JSON for debugging)
        whisper_json = os.path.join(song_output, "whisper_words.json")
        with open(whisper_json, "w") as f:
            json.dump(whisper_words, f, indent=2)

        # Remove demucs output (large wav files)
        demucs_dir = os.path.join(song_output, "htdemucs")
        if os.path.exists(demucs_dir):
            shutil.rmtree(demucs_dir)

        # Remove staged MP3
        if os.path.exists(local_mp3):
            os.remove(local_mp3)

        result["status"] = "processed"

    except Exception as e:
        result["status"] = "failed"
        result["error"] = str(e)
        print(f"    ❌ Error: {e}")

    result["duration_secs"] = round(time.time() - start_time, 1)
    return result


# ---------------------------------------------------------------------------
# Batch Processing
# ---------------------------------------------------------------------------

def load_status() -> dict:
    """Load batch status from disk."""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE) as f:
            return json.load(f)
    return {"songs": {}, "last_run": None}


def save_status(status: dict):
    """Save batch status to disk."""
    status["last_run"] = datetime.now().isoformat()
    with open(STATUS_FILE, "w") as f:
        json.dump(status, f, indent=2)


def main():
    parser = argparse.ArgumentParser(description="Jakeraoke Batch Alignment")
    parser.add_argument("--dry-run", action="store_true",
                        help="Preview MP3 matches without processing")
    parser.add_argument("--song", default=None,
                        help="Process a single song (partial name match)")
    parser.add_argument("--reprocess", action="store_true",
                        help="Re-process songs that already have markers")
    parser.add_argument("--model", default=WHISPER_MODEL,
                        help=f"Whisper model (default: {WHISPER_MODEL})")
    parser.add_argument("--match-threshold", type=float, default=0.70,
                        help="Minimum MP3 match score (default: 0.70)")
    args = parser.parse_args()

    # Check SMB mount
    if not os.path.isdir(MP3_DIR):
        print(f"❌ MP3 directory not accessible: {MP3_DIR}")
        print(f"   Make sure the SMB share is mounted.")
        sys.exit(1)

    # Gather songs
    song_files = sorted(glob.glob(os.path.join(SONG_DIR, "*.txt")))
    song_files = [s for s in song_files if "Setlists" not in s]

    if args.song:
        song_files = [s for s in song_files
                      if args.song.lower() in os.path.basename(s).lower()]
        if not song_files:
            print(f"❌ No song matching '{args.song}'")
            sys.exit(1)

    # Gather audio files (MP3 + M4A)
    mp3_files = sorted(
        glob.glob(os.path.join(MP3_DIR, "*.mp3")) +
        glob.glob(os.path.join(MP3_DIR, "*.m4a"))
    )
    print(f"📚 {len(song_files)} songs, 🎵 {len(mp3_files)} audio files available\n")

    # Load previous status
    status = load_status()

    # Match and process
    found = []
    missing = []
    skipped = []

    for song_path in song_files:
        song_name = os.path.splitext(os.path.basename(song_path))[0]
        existing_markers = count_existing_markers(song_path)

        # Check if already processed (unless --reprocess)
        prev = status["songs"].get(song_name, {})
        if prev.get("status") == "processed" and not args.reprocess:
            skipped.append(song_name)
            continue

        # Skip songs with existing markers unless --reprocess
        if existing_markers > 0 and not args.reprocess:
            skipped.append(song_name)
            status["songs"][song_name] = {
                "status": "skipped_has_markers",
                "markers_existing": existing_markers,
            }
            continue

        # Check for manual override first
        overrides = {}
        if os.path.exists(OVERRIDES_FILE):
            with open(OVERRIDES_FILE) as f:
                overrides = json.load(f)

        if song_name in overrides:
            override_path = os.path.join(MP3_DIR, overrides[song_name])
            if os.path.exists(override_path):
                found.append((song_path, override_path, 1.0))
                continue
            else:
                print(f"  ⚠️  Override file not found: {overrides[song_name]}")

        # Find matching MP3
        best_mp3, score = find_best_mp3(os.path.basename(song_path), mp3_files)

        if best_mp3 and score >= args.match_threshold:
            found.append((song_path, best_mp3, score))
        else:
            missing.append((song_name, best_mp3, score))
            status["songs"][song_name] = {"status": "missing_mp3", "best_match": os.path.basename(best_mp3) if best_mp3 else None, "score": round(score, 2)}

    # Print summary
    print(f"{'='*60}")
    print(f"  Batch Plan")
    print(f"{'='*60}")
    print(f"  To process:  {len(found)}")
    print(f"  Missing MP3: {len(missing)}")
    print(f"  Skipped:     {len(skipped)}")
    print()

    if found:
        print(f"  Will process:")
        for song_path, mp3_path, score in found:
            song_name = os.path.splitext(os.path.basename(song_path))[0]
            mp3_name = os.path.basename(mp3_path)
            print(f"    ✅ {score:.2f}  {song_name}")
            print(f"           → {mp3_name[:70]}")
        print()

    if missing:
        print(f"  Missing MP3s:")
        for song_name, best_mp3, score in missing:
            best = os.path.basename(best_mp3)[:50] if best_mp3 else "none"
            print(f"    ❌ {song_name}  (best: {best}, score={score:.2f})")
        print()

    if skipped:
        print(f"  Skipped (already processed or has markers):")
        for s in skipped:
            print(f"    ⏭️  {s}")
        print()

    # Write missing list
    with open(MISSING_FILE, "w") as f:
        f.write(f"# Missing MP3s — {datetime.now().strftime('%Y-%m-%d %H:%M')}\n")
        f.write(f"# Place MP3s in: {MP3_DIR}\n")
        f.write(f"# Then re-run: python batch.py\n\n")
        for song_name, _, _ in missing:
            f.write(f"{song_name}\n")
    print(f"  📝 Missing list saved to: {MISSING_FILE}")

    if args.dry_run:
        print(f"\n  🏁 Dry run complete. Use without --dry-run to process.")
        save_status(status)
        return

    if not found:
        print(f"\n  Nothing to process.")
        save_status(status)
        return

    # Process each song
    print(f"\n{'='*60}")
    print(f"  Processing {len(found)} songs")
    print(f"{'='*60}\n")

    for i, (song_path, mp3_path, score) in enumerate(found):
        song_name = os.path.splitext(os.path.basename(song_path))[0]
        print(f"\n{'─'*60}")
        print(f"  [{i+1}/{len(found)}] {song_name}")
        print(f"  MP3: {os.path.basename(mp3_path)[:65]}")
        print(f"{'─'*60}")

        result = process_song(
            song_path=song_path,
            mp3_path=mp3_path,
            staging_dir=STAGING_DIR,
            output_dir=OUTPUT_DIR,
            whisper_model=args.model,
        )

        status["songs"][song_name] = result
        save_status(status)  # save after each song

        print(f"\n  Status: {result['status']}")
        print(f"  Matched: {result['lines_matched']}/{result['lines_total']} lines")
        print(f"  Markers: {result['markers_generated']} generated "
              f"(was {result['markers_existing']})")
        print(f"  Time: {result['duration_secs']}s")

    # Final summary
    print(f"\n{'='*60}")
    print(f"  Batch Complete!")
    print(f"{'='*60}")

    processed = sum(1 for s in status["songs"].values() if s.get("status") == "processed")
    failed = sum(1 for s in status["songs"].values() if s.get("status") == "failed")
    print(f"  Processed: {processed}")
    print(f"  Failed:    {failed}")
    print(f"  Missing:   {len(missing)}")
    print(f"  Status:    {STATUS_FILE}")
    print(f"  Missing:   {MISSING_FILE}")


if __name__ == "__main__":
    main()
