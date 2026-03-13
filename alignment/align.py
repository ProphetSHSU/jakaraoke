#!/usr/bin/env python3
"""
Jakeraoke Lyrics Alignment Tool

Pipeline:
  1. Demucs: isolate vocals from MP3
  2. Whisper: transcribe vocals with word-level timestamps
  3. Match: align transcribed words to ChordPro lyric lines → {d_time:} markers

Usage:
  python align.py <mp3_path> <chordpro_path>
  python align.py <mp3_path> <chordpro_path> --model medium
  python align.py <mp3_path> <chordpro_path> --whisper-json output/whisper_words_medium.json
"""

import argparse
import os
import re
import subprocess
import sys
import json
from pathlib import Path

# ---------------------------------------------------------------------------
# 1. Vocal Isolation (Demucs)
# ---------------------------------------------------------------------------

def isolate_vocals(mp3_path: str, output_dir: str) -> str:
    """Run Demucs to extract vocals. Returns path to vocals wav."""
    print(f"\n{'='*60}")
    print(f"  Step 1: Vocal Isolation (Demucs)")
    print(f"{'='*60}")
    print(f"  Input: {mp3_path}")

    stem_name = Path(mp3_path).stem
    vocals_path = os.path.join(output_dir, "htdemucs", stem_name, "vocals.wav")

    if os.path.exists(vocals_path):
        print(f"  ✅ Vocals already extracted (cached): {vocals_path}")
        return vocals_path

    print(f"  Running demucs (this may take a few minutes)...")
    cmd = [
        sys.executable, "-m", "demucs",
        "--two-stems", "vocals",
        "-o", output_dir,
        mp3_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ❌ Demucs failed:\n{result.stderr}")
        sys.exit(1)

    if not os.path.exists(vocals_path):
        for root, dirs, files in os.walk(output_dir):
            for f in files:
                if "vocal" in f.lower():
                    vocals_path = os.path.join(root, f)
                    break

    print(f"  ✅ Vocals extracted: {vocals_path}")
    return vocals_path


# ---------------------------------------------------------------------------
# 2. Transcription (Whisper)
# ---------------------------------------------------------------------------

def transcribe_vocals(vocals_path: str, model_name: str = "medium") -> list[dict]:
    """Run Whisper on vocals to get word-level timestamps.

    Returns list of: { 'word': str, 'start': float, 'end': float }
    """
    print(f"\n{'='*60}")
    print(f"  Step 2: Transcription (Whisper, model={model_name})")
    print(f"{'='*60}")
    print(f"  Input: {vocals_path}")

    import whisper

    print(f"  Loading model '{model_name}'...")
    model = whisper.load_model(model_name)

    print(f"  Transcribing with word timestamps...")
    result = model.transcribe(
        vocals_path,
        word_timestamps=True,
        language="en",
    )

    words = []
    for segment in result.get("segments", []):
        for w in segment.get("words", []):
            words.append({
                "word": w["word"].strip(),
                "start": round(w["start"], 2),
                "end": round(w["end"], 2),
            })

    print(f"  ✅ Transcribed {len(words)} words")
    if words:
        print(f"  First word at {words[0]['start']}s: \"{words[0]['word']}\"")
        print(f"  Last word at {words[-1]['start']}s: \"{words[-1]['word']}\"")

    return words


def load_whisper_json(json_path: str) -> list[dict]:
    """Load pre-computed whisper words from JSON."""
    print(f"\n{'='*60}")
    print(f"  Step 2: Load Cached Whisper Output")
    print(f"{'='*60}")
    print(f"  Input: {json_path}")

    with open(json_path) as f:
        words = json.load(f)

    print(f"  ✅ Loaded {len(words)} words")
    if words:
        print(f"  First word at {words[0]['start']}s: \"{words[0]['word']}\"")
        print(f"  Last word at {words[-1]['start']}s: \"{words[-1]['word']}\"")

    return words


# ---------------------------------------------------------------------------
# 3. ChordPro Parsing (extract lyric lines)
# ---------------------------------------------------------------------------

def extract_lyric_lines(chordpro_path: str) -> list[dict]:
    """Parse ChordPro file and extract lyric lines with their line numbers.

    Returns list of: {
        'line_num': int,       # 1-based line number in file
        'text': str,           # plain lyrics (chords stripped)
        'raw': str,            # original line from file
        'is_section_start': bool,  # first lyric line after a section label
        'section_name': str,   # name of containing section
    }
    """
    print(f"\n{'='*60}")
    print(f"  Step 3: Parse ChordPro Lyrics")
    print(f"{'='*60}")

    with open(chordpro_path, "r") as f:
        lines = f.readlines()

    chord_re = re.compile(r"\[.*?\]")
    tag_re = re.compile(r"^\{.*\}$")
    section_re = re.compile(r"^([A-Za-z][A-Za-z\s\-]*):\s*$")

    lyric_lines = []
    current_section = ""
    pending_section_start = False

    for i, raw_line in enumerate(lines):
        raw = raw_line.rstrip("\n")
        stripped = raw.strip()

        if not stripped:
            continue

        # Check for section label
        section_match = section_re.match(stripped)
        if section_match:
            current_section = section_match.group(1).strip()
            pending_section_start = True
            continue

        # Skip metadata/directive tags (but note d_time for reference)
        if tag_re.match(stripped):
            continue

        # Skip hidden comments
        if stripped.startswith("#"):
            continue

        # Strip chords to get plain lyrics
        text = chord_re.sub("", stripped).strip()

        # Skip lines that are only chords (no lyrics)
        if not text:
            continue

        lyric_lines.append({
            "line_num": i + 1,
            "text": text,
            "raw": raw,
            "is_section_start": pending_section_start,
            "section_name": current_section,
        })
        pending_section_start = False

    print(f"  ✅ Extracted {len(lyric_lines)} lyric lines")
    for ll in lyric_lines[:5]:
        flag = " [section start]" if ll["is_section_start"] else ""
        print(f"    L{ll['line_num']:3d}: {ll['text'][:55]}{flag}")
    if len(lyric_lines) > 5:
        print(f"    ... ({len(lyric_lines) - 5} more)")

    return lyric_lines


# ---------------------------------------------------------------------------
# 4. Alignment: Word-level sequential matching
# ---------------------------------------------------------------------------

def norm_word(w: str) -> str:
    """Normalize a word for comparison."""
    return re.sub(r"[^a-z0-9]", "", w.lower())


def word_similarity(a: str, b: str) -> float:
    """Score similarity between two normalized words. 0.0 to 1.0."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    # Check if one contains the other (handles "beginnings" vs "beginning")
    if a in b or b in a:
        return 0.85
    # Simple edit distance ratio for short words
    if abs(len(a) - len(b)) <= 2:
        # Count matching characters in order (LCS-like)
        matches = 0
        j = 0
        for ch in a:
            while j < len(b):
                if b[j] == ch:
                    matches += 1
                    j += 1
                    break
                j += 1
        ratio = (2.0 * matches) / (len(a) + len(b))
        if ratio > 0.6:
            return ratio
    return 0.0


def score_alignment(lyric_words: list[str], whisper_words: list[dict],
                    start_idx: int) -> tuple[float, int]:
    """Score how well lyric_words match whisper_words starting at start_idx.

    Uses a flexible matching that allows whisper to skip/insert words.
    Returns (score: 0.0-1.0, words_consumed: int).
    """
    if start_idx >= len(whisper_words):
        return 0.0, 0

    n_lyric = len(lyric_words)
    if n_lyric == 0:
        return 0.0, 0

    # How many whisper words to consider (allow some slack for insertions)
    window = min(n_lyric + 5, len(whisper_words) - start_idx)
    if window <= 0:
        return 0.0, 0

    # Greedy forward matching: walk through lyric words, try to find each
    # in the whisper window in order
    w_pos = 0  # position within the whisper window
    total_score = 0.0
    matched = 0
    last_matched_pos = 0

    for lw in lyric_words:
        best_sim = 0.0
        best_offset = -1

        # Look ahead up to 3 positions for a match
        for offset in range(min(3, window - w_pos)):
            w_idx = start_idx + w_pos + offset
            if w_idx >= len(whisper_words):
                break
            ww = norm_word(whisper_words[w_idx]["word"])
            sim = word_similarity(lw, ww)
            if sim > best_sim:
                best_sim = sim
                best_offset = offset

        if best_sim > 0.5:
            total_score += best_sim
            matched += 1
            w_pos += best_offset + 1
            last_matched_pos = w_pos
        # else: skip this lyric word (whisper might have missed it)

    if n_lyric == 0:
        return 0.0, 0

    # Score combines match rate and match quality
    match_rate = matched / n_lyric
    avg_quality = total_score / n_lyric

    score = match_rate * 0.6 + avg_quality * 0.4
    return score, last_matched_pos


def align_lyrics_to_words(
    lyric_lines: list[dict],
    whisper_words: list[dict],
) -> list[dict]:
    """Match each lyric line to its timestamp using word-level sequential alignment.

    Strategy: For each lyric line, scan strictly forward through whisper words,
    scoring each possible start position. Pick the best. Enforce monotonically
    increasing timestamps — never go backwards.

    Returns list of: { 'line_num': int, 'text': str, 'start_time': float,
                       'confidence': float, 'section_name': str,
                       'is_section_start': bool }
    """
    print(f"\n{'='*60}")
    print(f"  Step 4: Align Lyrics to Timestamps")
    print(f"{'='*60}")

    if not whisper_words:
        print("  ❌ No whisper words to align")
        return []

    results = []
    search_from = 0       # whisper word index — strictly forward
    last_match_time = 0.0  # enforce monotonic timestamps

    for ll in lyric_lines:
        lyric_words = [norm_word(w) for w in ll["text"].split() if norm_word(w)]
        if not lyric_words:
            results.append({
                "line_num": ll["line_num"],
                "text": ll["text"],
                "start_time": None,
                "confidence": 0.0,
                "section_name": ll["section_name"],
                "is_section_start": ll["is_section_start"],
            })
            continue

        # --- Adaptive time-based search window ---
        # Try tight window first (keeps repeated lines local), then expand
        # if nothing found (handles instrumental gaps like bridge/solo).
        scan_start = search_from  # strictly forward — no backtracking

        best_score = 0.0
        best_idx = -1
        best_consumed = 0

        # Progressive search: 12s → 25s → 45s
        for max_ahead in (12.0, 25.0, 45.0):
            if best_score >= 0.3:
                break  # already found a good match in tighter window

            scan_end = len(whisper_words)
            if scan_start < len(whisper_words):
                start_time_ref = whisper_words[scan_start]["start"]
                for idx in range(scan_start, len(whisper_words)):
                    if whisper_words[idx]["start"] > start_time_ref + max_ahead:
                        scan_end = idx
                        break

            for idx in range(scan_start, scan_end):
                score, consumed = score_alignment(lyric_words, whisper_words, idx)
                if score > best_score:
                    best_score = score
                    best_idx = idx
                    best_consumed = consumed

        # Detect repeated lyric lines — require higher confidence for lines
        # that appear multiple times (prevents them from eating future words)
        is_repeated = sum(
            1 for other in lyric_lines
            if norm_word(other["text"]) == norm_word(ll["text"])
        ) > 1
        min_score = 0.5 if is_repeated else 0.3

        # Accept match if score meets threshold AND timestamp is forward
        if (best_score >= min_score and best_idx >= 0
                and whisper_words[best_idx]["start"] >= last_match_time - 0.5):
            start_time = whisper_words[best_idx]["start"]
            results.append({
                "line_num": ll["line_num"],
                "text": ll["text"],
                "start_time": start_time,
                "confidence": round(best_score, 3),
                "section_name": ll["section_name"],
                "is_section_start": ll["is_section_start"],
            })
            # Advance search_from past ALL consumed whisper words
            search_from = best_idx + max(1, best_consumed)
            last_match_time = start_time
        else:
            results.append({
                "line_num": ll["line_num"],
                "text": ll["text"],
                "start_time": None,
                "confidence": round(best_score, 3),
                "section_name": ll["section_name"],
                "is_section_start": ll["is_section_start"],
            })

    matched = sum(1 for r in results if r["start_time"] is not None)
    high_conf = sum(1 for r in results if r["confidence"] >= 0.7)
    print(f"  ✅ Matched {matched}/{len(results)} lyric lines")
    print(f"     High confidence (≥0.7): {high_conf}")
    print(f"     Low confidence (<0.7):  {matched - high_conf}")
    print(f"     Unmatched:              {len(results) - matched}")

    # Show alignment details
    print(f"\n  {'Time':>6s}  {'Conf':>5s}  {'Section':<12s}  Lyrics")
    print(f"  {'-'*6}  {'-'*5}  {'-'*12}  {'-'*40}")
    for r in results:
        if r["start_time"] is not None:
            m, s = divmod(int(r["start_time"]), 60)
            time_str = f"{m}:{s:02d}"
            flag = "★" if r["is_section_start"] else " "
        else:
            time_str = "  ???"
            flag = " "
        conf_str = f"{r['confidence']:.2f}"
        sect = r["section_name"][:12] if r["section_name"] else ""
        print(f"  {time_str:>6s}  {conf_str:>5s}  {sect:<12s} {flag}{r['text'][:45]}")

    return results


# ---------------------------------------------------------------------------
# 5. Generate d_time markers
# ---------------------------------------------------------------------------

def fmt_time(secs: float) -> str:
    """Format seconds as M:SS."""
    m = int(secs // 60)
    s = int(secs % 60)
    return f"{m}:{s:02d}"


def generate_markers(aligned: list[dict]) -> list[dict]:
    """Generate {d_time:} markers for section starts and key positions.

    Strategy:
    - Every section-start lyric line gets a marker
    - First lyric line of the song gets a marker
    - Lines after large time gaps (>8s) get a marker

    Returns list of: { 'line_num': int, 'time_str': str, 'time_secs': float,
                       'text': str, 'reason': str }
    """
    print(f"\n{'='*60}")
    print(f"  Step 5: Generate d_time Markers")
    print(f"{'='*60}")

    markers = []
    prev_time = None
    is_first = True

    for a in aligned:
        if a["start_time"] is None:
            continue

        reasons = []

        # First lyric line
        if is_first:
            reasons.append("first")
            is_first = False

        # Section start
        if a["is_section_start"]:
            reasons.append("section")

        # Large time gap from previous matched line
        if prev_time is not None and (a["start_time"] - prev_time) > 8.0:
            reasons.append("gap")

        if reasons:
            markers.append({
                "line_num": a["line_num"],
                "time_str": fmt_time(a["start_time"]),
                "time_secs": a["start_time"],
                "text": a["text"],
                "confidence": a["confidence"],
                "reason": "+".join(reasons),
            })

        prev_time = a["start_time"]

    print(f"  ✅ Generated {len(markers)} markers:")
    for m in markers:
        conf = f"({m['confidence']:.2f})" if m["confidence"] < 0.7 else ""
        print(f"    {{d_time: {m['time_str']}}}  [{m['reason']:<12s}]  "
              f"{m['text'][:40]} {conf}")

    return markers


# ---------------------------------------------------------------------------
# 6. Compare with existing markers
# ---------------------------------------------------------------------------

def compare_with_existing(chordpro_path: str, generated: list[dict]):
    """Compare generated markers with existing {d_time:} markers in the file."""
    print(f"\n{'='*60}")
    print(f"  Step 6: Compare with Existing Markers")
    print(f"{'='*60}")

    with open(chordpro_path, "r") as f:
        content = f.read()

    existing = []
    for m in re.finditer(r"\{d_time:\s*(\d+):(\d+)\}", content):
        mins, secs = int(m.group(1)), int(m.group(2))
        total = mins * 60 + secs
        existing.append({
            "time_str": f"{mins}:{secs:02d}",
            "time_secs": total,
        })

    if not existing:
        print("  No existing markers to compare against.")
        return

    print(f"\n  {'Existing':>10s}  {'Generated':>10s}  {'Δ (sec)':>8s}  Context")
    print(f"  {'-'*10}  {'-'*10}  {'-'*8}  {'-'*35}")

    total_delta = 0
    matched_count = 0

    for ex in existing:
        # Find closest generated marker within 20 seconds
        best_delta = float("inf")
        best_gen = None
        for g in generated:
            delta = abs(g["time_secs"] - ex["time_secs"])
            if delta < best_delta:
                best_delta = delta
                best_gen = g

        if best_gen and best_delta < 20:
            delta_val = best_gen["time_secs"] - ex["time_secs"]
            delta_str = f"{delta_val:+.1f}"
            total_delta += abs(delta_val)
            matched_count += 1
            print(f"  {ex['time_str']:>10s}  {best_gen['time_str']:>10s}  "
                  f"{delta_str:>8s}  {best_gen['text'][:35]}")
        else:
            print(f"  {ex['time_str']:>10s}  {'???':>10s}  {'N/A':>8s}  "
                  f"(no generated marker nearby)")

    if matched_count > 0:
        avg = total_delta / matched_count
        print(f"\n  Average |Δ|: {avg:.1f}s across {matched_count} matched markers")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Jakeraoke Lyrics Alignment Tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full pipeline (demucs + whisper + align):
  python align.py song.mp3 song.txt

  # Skip demucs (use raw MP3):
  python align.py song.mp3 song.txt --skip-demucs

  # Use cached whisper output (skip demucs + whisper):
  python align.py song.mp3 song.txt --whisper-json output/whisper_words_medium.json
        """,
    )
    parser.add_argument("mp3_path", help="Path to MP3 file")
    parser.add_argument("chordpro_path", help="Path to ChordPro song file")
    parser.add_argument("--skip-demucs", action="store_true",
                        help="Skip vocal isolation (use raw MP3 for whisper)")
    parser.add_argument("--model", default="medium",
                        help="Whisper model size: tiny/base/small/medium/large (default: medium)")
    parser.add_argument("--whisper-json", default=None,
                        help="Path to cached whisper words JSON (skips demucs + whisper)")
    parser.add_argument("--output-dir", default=None,
                        help="Output directory for intermediate files")
    args = parser.parse_args()

    # Validate inputs
    if not os.path.exists(args.mp3_path):
        print(f"❌ MP3 not found: {args.mp3_path}")
        sys.exit(1)
    if not os.path.exists(args.chordpro_path):
        print(f"❌ ChordPro file not found: {args.chordpro_path}")
        sys.exit(1)

    output_dir = args.output_dir or os.path.join(os.path.dirname(__file__), "output")
    os.makedirs(output_dir, exist_ok=True)

    # Steps 1+2: Get whisper words (from cache or fresh run)
    if args.whisper_json:
        if not os.path.exists(args.whisper_json):
            print(f"❌ Whisper JSON not found: {args.whisper_json}")
            sys.exit(1)
        whisper_words = load_whisper_json(args.whisper_json)
    else:
        # Step 1: Vocal isolation
        if args.skip_demucs:
            audio_path = args.mp3_path
            print(f"\n  Skipping Demucs — using raw MP3 for transcription")
        else:
            audio_path = isolate_vocals(args.mp3_path, output_dir)

        # Step 2: Transcription
        whisper_words = transcribe_vocals(audio_path, model_name=args.model)

        # Save whisper output
        model_suffix = f"_{args.model}" if args.model != "medium" else "_medium"
        whisper_json = os.path.join(output_dir, f"whisper_words{model_suffix}.json")
        with open(whisper_json, "w") as f:
            json.dump(whisper_words, f, indent=2)
        print(f"  Saved whisper words to: {whisper_json}")

    # Step 3: Parse ChordPro
    lyric_lines = extract_lyric_lines(args.chordpro_path)

    # Step 4: Align
    aligned = align_lyrics_to_words(lyric_lines, whisper_words)

    # Save alignment
    align_json = os.path.join(output_dir, "alignment.json")
    with open(align_json, "w") as f:
        json.dump(aligned, f, indent=2)
    print(f"\n  Saved alignment to: {align_json}")

    # Step 5: Generate markers
    markers = generate_markers(aligned)

    # Save markers
    markers_json = os.path.join(output_dir, "markers.json")
    with open(markers_json, "w") as f:
        json.dump(markers, f, indent=2)

    # Step 6: Compare with existing
    compare_with_existing(args.chordpro_path, markers)

    print(f"\n{'='*60}")
    print(f"  Done! Output files in: {output_dir}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
