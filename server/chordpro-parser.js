// ============================================================
// ChordPro / LivePrompter Parser
// ============================================================
// Parses ChordPro-format song files (LivePrompter variant) into
// structured JSON for client rendering.
//
// Input:  raw text content of a .txt song file
// Output: { metadata: {...}, sections: [...] }
//
// Highlight markers (>N...< ) are preserved in text for the
// client renderer to handle during display.

// Known metadata tag names (lowercase for matching)
var METADATA_TAGS = {
    'title': 'title',
    't': 'title',
    'artist': 'artist',
    'key': 'key',
    'duration': 'duration',
    'tempo': 'tempo',
    'color': 'color',
    'capo': 'capo',
    'transpose': 'transpose',
    'metronome': 'metronome',
    'book': 'book',
    'energy': 'energy',
    'textsize': 'textsize'
};

// Tags that should be parsed as numbers
var NUMERIC_TAGS = { 'tempo': true, 'capo': true, 'transpose': true, 'metronome': true, 'energy': true, 'textsize': true };

// Section start/end tags to skip (not displayed)
var SECTION_TAGS = [
    'start_of_chorus', 'end_of_chorus', 'soc', 'eoc',
    'start_of_verse', 'end_of_verse', 'sov', 'eov',
    'start_of_bridge', 'end_of_bridge', 'sob', 'eob',
    'start_of_tab', 'end_of_tab', 'sot', 'eot',
    'start_of_highlight', 'end_of_highlight', 'soh', 'eoh',
    'start_of_exclusive', 'end_of_exclusive',
    'start_of_ignore', 'end_of_ignore'
];

// Regex: matches a {tag:value} or {tag} directive
var TAG_RE = /^\{([^:}]+)(?::(.+))?\}\s*$/;

// Regex: matches section labels like "Verse:", "Chorus 1:", "Solo Banjo:", "Pre-Chorus:"
var SECTION_LABEL_RE = /^[A-Z][A-Za-z0-9 /\-]*:$/;

// Regex: matches chords in square brackets
var CHORD_RE = /\[([^\]]+)\]/g;


/**
 * Parse a duration string like "3:17" or "03:38" into seconds.
 */
function parseDuration(str) {
    if (!str) return null;
    str = str.trim();
    var parts = str.split(':');
    if (parts.length === 2) {
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }
    var n = parseInt(str, 10);
    return isNaN(n) ? null : n;
}


/**
 * Parse a single line of lyrics/chords into an array of parts.
 * Each part: { chord: "Am" | null, text: "lyrics here" }
 *
 * Highlight markers (>N...< ) are left in the text for the client
 * renderer to process during display.
 */
function parseLine(line) {
    var parts = [];
    var lastIndex = 0;
    var match;

    CHORD_RE.lastIndex = 0;

    while ((match = CHORD_RE.exec(line)) !== null) {
        // Text before this chord (or between previous chord and this one)
        var textBefore = line.substring(lastIndex, match.index);

        if (parts.length === 0 && textBefore.length > 0) {
            // Leading text before any chord
            parts.push({ chord: null, text: textBefore });
        } else if (parts.length > 0) {
            // Append text to the previous chord's segment
            parts[parts.length - 1].text += textBefore;
        }

        // Start a new segment for this chord
        parts.push({ chord: match[1], text: '' });
        lastIndex = CHORD_RE.lastIndex;
    }

    // Remaining text after the last chord
    var trailing = line.substring(lastIndex);
    if (parts.length > 0) {
        parts[parts.length - 1].text += trailing;
    } else {
        // No chords at all — entire line is text
        parts.push({ chord: null, text: line });
    }

    return parts;
}


/**
 * Determine if a line is purely chords (no meaningful lyrics).
 */
function isChordsOnly(parts) {
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].text.trim().length > 0) return false;
    }
    return parts.some(function(p) { return p.chord !== null; });
}


/**
 * Main parser: takes raw ChordPro text, returns structured object.
 *
 * @param {string} text - Raw song file content
 * @returns {{ metadata: Object, sections: Array }}
 */
function parse(text) {
    var metadata = {};
    var sections = [];

    var lines = text.split('\n');

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '');

        // Empty line → spacer
        if (line.trim() === '') {
            sections.push({ type: 'empty' });
            continue;
        }

        // Check for {tag:value} directives
        var tagMatch = TAG_RE.exec(line.trim());
        if (tagMatch) {
            var tagName = tagMatch[1].trim().toLowerCase();
            var tagValue = tagMatch[2] ? tagMatch[2].trim() : '';

            // Metadata tags
            var metaKey = METADATA_TAGS[tagName];
            if (metaKey) {
                if (NUMERIC_TAGS[metaKey]) {
                    metadata[metaKey] = parseFloat(tagValue) || null;
                } else {
                    metadata[metaKey] = tagValue;
                }
                if (metaKey === 'duration') {
                    metadata.durationSeconds = parseDuration(tagValue);
                }
                continue;
            }

            // Comment tags
            if (tagName === 'comment' || tagName === 'c') {
                sections.push({ type: 'comment', text: tagValue });
                continue;
            }

            // Custom comments (cc0-cc9, customcomment0-9)
            if (/^(customcomment|cc)\d$/.test(tagName)) {
                sections.push({ type: 'comment', text: tagValue, custom: tagName });
                continue;
            }

            // Scroll timing
            if (tagName === 'd_time') {
                var seconds = parseDuration(tagValue);
                sections.push({ type: 'timing', time: tagValue, seconds: seconds });
                continue;
            }

            // Bar markers
            if (tagName === 'bar') {
                sections.push({ type: 'bar', bar: parseInt(tagValue, 10) || 0 });
                continue;
            }

            // Pause
            if (tagName === 'pause') {
                sections.push({ type: 'pause', seconds: tagValue ? parseFloat(tagValue) : null });
                continue;
            }

            // Beats per bar
            if (tagName === 'beats_per_bar' || tagName === 'bpb') {
                sections.push({ type: 'bpb', value: parseInt(tagValue, 10) || 4 });
                continue;
            }

            // Section start/end markers — skip silently
            var isSectionTag = SECTION_TAGS.some(function(t) {
                return tagName === t || tagName.indexOf(t) === 0;
            });
            if (isSectionTag) {
                continue;
            }

            // Unknown tag — preserve for debugging
            sections.push({ type: 'tag', name: tagName, value: tagValue });
            continue;
        }

        // Hidden comment (# at start of line)
        if (line.trim().charAt(0) === '#') {
            continue;
        }

        // Section label (e.g., "Verse 1:", "Chorus:", "Solo Banjo:")
        if (SECTION_LABEL_RE.test(line.trim())) {
            sections.push({ type: 'section', label: line.trim().replace(/:$/, '') });
            continue;
        }

        // Regular line with chords and/or lyrics
        var parts = parseLine(line);

        sections.push({
            type: 'line',
            parts: parts,
            chordsOnly: isChordsOnly(parts)
        });
    }

    return {
        metadata: metadata,
        sections: sections
    };
}


module.exports = {
    parse: parse,
    parseLine: parseLine,
    parseDuration: parseDuration
};
