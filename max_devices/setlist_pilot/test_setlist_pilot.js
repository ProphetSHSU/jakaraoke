// test_setlist_pilot.js
// Node test harness for setlist_pilot_core.js — runs offline.
// Usage:  node test_setlist_pilot.js

'use strict';

var core = require('./setlist_pilot_core.js');

var passed = 0;
var failed = 0;
var failures = [];

function eq(actual, expected, label) {
    var aStr = JSON.stringify(actual);
    var eStr = JSON.stringify(expected);
    if (aStr === eStr) {
        passed++;
    } else {
        failed++;
        failures.push(label + '\n    expected: ' + eStr + '\n    actual:   ' + aStr);
    }
}

function group(name, fn) {
    console.log('\n== ' + name + ' ==');
    var before = failed;
    fn();
    console.log('  ' + (failed === before ? 'OK' : 'FAIL (' + (failed - before) + ')'));
}

// ---------------------------------------------------------------------------
// isDividerName
// ---------------------------------------------------------------------------
group('isDividerName — default regex', function () {
    eq(core.isDividerName('---'), true, 'bare triple-dash');
    eq(core.isDividerName('-----'), true, 'many dashes');
    eq(core.isDividerName('--- Set 1 ---'), true, 'Set 1 divider');
    eq(core.isDividerName('--- Set 2 ---'), true, 'Set 2 divider');
    eq(core.isDividerName('--- Encore ---'), true, 'Encore divider');
    eq(core.isDividerName('---Encore---'), true, 'no spaces');
    eq(core.isDividerName('--- Break ---'), true, 'Break divider');
    eq(core.isDividerName('--- Intermission ---'), true, 'Intermission');
    eq(core.isDividerName('  --- Set 1 ---  '), true, 'whitespace trim');
    eq(core.isDividerName('Come Sail Away'), false, 'normal song');
    eq(core.isDividerName(''), false, 'empty string');
    eq(core.isDividerName(null), false, 'null');
    eq(core.isDividerName(undefined), false, 'undefined');
    eq(core.isDividerName('-'), false, 'single dash line — NOT a divider (needs dashes both ends)');
    eq(core.isDividerName('--'), true, 'two dashes — matches (one + one)');
});

group('isDividerName — custom regex', function () {
    var custom = /^\[break\]$/i;
    eq(core.isDividerName('[break]', custom), true, 'custom match');
    eq(core.isDividerName('[BREAK]', custom), true, 'case insensitive');
    eq(core.isDividerName('---', custom), false, 'default no longer matches under custom');
    eq(core.isDividerName('[break]', '^\\[break\\]$'), true, 'string-source regex');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function s(index, name, isEmpty) {
    return { index: index, name: name, isEmpty: !!isEmpty };
}

var empty = [];

var noDividers = [
    s(0, 'Song A'),
    s(1, 'Song B'),
    s(2, 'Song C')
];

var withDividers = [
    s(0, '--- Set 1 ---'),
    s(1, 'Song A'),
    s(2, 'Song B'),
    s(3, '--- Set 2 ---'),
    s(4, 'Song C'),
    s(5, 'Song D'),
    s(6, '--- Encore ---'),
    s(7, 'Song E')
];

var mixedEmpty = [
    s(0, 'Song A', false),
    s(1, '(empty)', true),
    s(2, 'Song B', false),
    s(3, '--- Set 2 ---', false),
    s(4, '(empty)', true),
    s(5, 'Song C', false)
];

// ---------------------------------------------------------------------------
// chooseNextIndex
// ---------------------------------------------------------------------------
group('chooseNextIndex — empty setlist', function () {
    eq(core.chooseNextIndex(empty, -1, {}), -1, 'empty → -1');
    eq(core.chooseNextIndex(null, -1, {}), -1, 'null → -1');
});

group('chooseNextIndex — no dividers, skipDividers off', function () {
    eq(core.chooseNextIndex(noDividers, -1, {}), 0, 'start → 0');
    eq(core.chooseNextIndex(noDividers, 0, {}), 1, '0 → 1');
    eq(core.chooseNextIndex(noDividers, 1, {}), 2, '1 → 2');
    eq(core.chooseNextIndex(noDividers, 2, {}), -1, '2 → end clamps -1');
});

group('chooseNextIndex — skipDividers on', function () {
    var opts = { skipDividers: true };
    eq(core.chooseNextIndex(withDividers, -1, opts), 1, 'start skips Set 1 → 1');
    eq(core.chooseNextIndex(withDividers, 1, opts), 2, '1 → 2');
    eq(core.chooseNextIndex(withDividers, 2, opts), 4, '2 skips Set 2 → 4');
    eq(core.chooseNextIndex(withDividers, 5, opts), 7, '5 skips Encore → 7');
    eq(core.chooseNextIndex(withDividers, 7, opts), -1, 'last → -1');
});

group('chooseNextIndex — skipDividers off (dividers selectable)', function () {
    var opts = { skipDividers: false };
    eq(core.chooseNextIndex(withDividers, -1, opts), 0, 'start → 0 (divider)');
    eq(core.chooseNextIndex(withDividers, 0, opts), 1, '0 → 1');
    eq(core.chooseNextIndex(withDividers, 2, opts), 3, '2 → 3 (divider)');
});

group('chooseNextIndex — skipEmpty on', function () {
    var opts = { skipEmpty: true };
    eq(core.chooseNextIndex(mixedEmpty, -1, opts), 0, '-1 → 0');
    eq(core.chooseNextIndex(mixedEmpty, 0, opts), 2, '0 skips empty → 2');
    eq(core.chooseNextIndex(mixedEmpty, 2, opts), 3, '2 → 3 (divider-NOT-skipped when skipDividers off)');
    eq(core.chooseNextIndex(mixedEmpty, 3, opts), 5, '3 skips empty → 5');
});

group('chooseNextIndex — skipEmpty+skipDividers both on', function () {
    var opts = { skipEmpty: true, skipDividers: true };
    eq(core.chooseNextIndex(mixedEmpty, -1, opts), 0, 'start → 0');
    eq(core.chooseNextIndex(mixedEmpty, 0, opts), 2, '0 → 2 skip empty');
    eq(core.chooseNextIndex(mixedEmpty, 2, opts), 5, '2 skips Set 2 AND empty → 5');
    eq(core.chooseNextIndex(mixedEmpty, 5, opts), -1, '5 → end');
});

// ---------------------------------------------------------------------------
// choosePrevIndex
// ---------------------------------------------------------------------------
group('choosePrevIndex — empty / boundary', function () {
    eq(core.choosePrevIndex(empty, 0, {}), -1, 'empty → -1');
    eq(core.choosePrevIndex(noDividers, 0, {}), -1, 'first → -1');
    eq(core.choosePrevIndex(noDividers, -1, {}), -1, 'before start → -1');
});

group('choosePrevIndex — no dividers', function () {
    eq(core.choosePrevIndex(noDividers, 2, {}), 1, '2 → 1');
    eq(core.choosePrevIndex(noDividers, 1, {}), 0, '1 → 0');
});

group('choosePrevIndex — skipDividers on', function () {
    var opts = { skipDividers: true };
    eq(core.choosePrevIndex(withDividers, 7, opts), 5, '7 skips Encore → 5');
    eq(core.choosePrevIndex(withDividers, 4, opts), 2, '4 skips Set 2 → 2');
    eq(core.choosePrevIndex(withDividers, 1, opts), -1, '1 skips Set 1 → -1 (clamp)');
});

group('choosePrevIndex — skipEmpty+skipDividers both', function () {
    var opts = { skipEmpty: true, skipDividers: true };
    eq(core.choosePrevIndex(mixedEmpty, 5, opts), 2, '5 skips empty+divider → 2');
    eq(core.choosePrevIndex(mixedEmpty, 2, opts), 0, '2 → 0');
    eq(core.choosePrevIndex(mixedEmpty, 0, opts), -1, '0 → -1');
});

// ---------------------------------------------------------------------------
// routeMidiToAction
// ---------------------------------------------------------------------------
group('routeMidiToAction — default pedals, channel 3', function () {
    var mk = function (note, vel, ch, status) {
        return { status: status || 'noteon', note: note, velocity: vel == null ? 100 : vel, channel: ch == null ? 3 : ch };
    };
    eq(core.routeMidiToAction(mk(4)), 'play', 'note 4 → play');
    eq(core.routeMidiToAction(mk(3)), 'stop', 'note 3 → stop');
    eq(core.routeMidiToAction(mk(6)), 'next_scene', 'note 6 → next');
    eq(core.routeMidiToAction(mk(7)), 'prev_scene', 'note 7 → prev');
    eq(core.routeMidiToAction(mk(5)), null, 'note 5 (record) unmapped → null');
    eq(core.routeMidiToAction(mk(8)), null, 'note 8 (tap) unmapped → null');
});

group('routeMidiToAction — channel filter', function () {
    var mk = function (note, ch) { return { status: 'noteon', note: note, velocity: 100, channel: ch }; };
    eq(core.routeMidiToAction(mk(4, 3)), 'play', 'ch 3 match');
    eq(core.routeMidiToAction(mk(4, 1)), null, 'ch 1 rejected');
    eq(core.routeMidiToAction(mk(4, 16)), null, 'ch 16 rejected');
});

group('routeMidiToAction — omni (channel 0)', function () {
    var omniPedals = {
        play:       { note: 4, channel: 0 },
        stop:       { note: 3, channel: 0 },
        nextScene:  { note: 6, channel: 0 },
        prevScene:  { note: 7, channel: 0 },
        stopAll:    { note: -1, channel: 0 },
        go:         { note: -1, channel: 0 }
    };
    var mk = function (note, ch) { return { status: 'noteon', note: note, velocity: 100, channel: ch }; };
    eq(core.routeMidiToAction(mk(4, 1), omniPedals), 'play', 'omni ch 1 → play');
    eq(core.routeMidiToAction(mk(4, 16), omniPedals), 'play', 'omni ch 16 → play');
    eq(core.routeMidiToAction(mk(6, 7), omniPedals), 'next_scene', 'omni ch 7 → next');
});

group('routeMidiToAction — velocity 0 / NoteOff', function () {
    var mk = function (st, vel) { return { status: st, note: 4, velocity: vel, channel: 3 }; };
    eq(core.routeMidiToAction(mk('noteon', 0)), null, 'vel 0 → null');
    eq(core.routeMidiToAction(mk('noteoff', 100)), null, 'NoteOff → null');
    eq(core.routeMidiToAction(mk('cc', 100)), null, 'CC → null');
});

group('routeMidiToAction — reserved buttons 6/7 (stop_all, go)', function () {
    var mapA = Object.assign({}, core.DEFAULT_PEDAL_MAP, { stopAll: { note: 10, channel: 3 } });
    var mapB = Object.assign({}, core.DEFAULT_PEDAL_MAP, { go:      { note: 11, channel: 3 } });
    var mk = function (note) { return { status: 'noteon', note: note, velocity: 100, channel: 3 }; };
    eq(core.routeMidiToAction(mk(10), mapA), 'stop_all', 'remap stop_all to note 10');
    eq(core.routeMidiToAction(mk(11), mapB), 'go', 'remap go to note 11');
    eq(core.routeMidiToAction(mk(10), core.DEFAULT_PEDAL_MAP), null, 'disabled stopAll → null');
    eq(core.routeMidiToAction(mk(11), core.DEFAULT_PEDAL_MAP), null, 'disabled go → null');
});

group('routeMidiToAction — bad input', function () {
    eq(core.routeMidiToAction(null), null, 'null msg → null');
    eq(core.routeMidiToAction(undefined), null, 'undefined msg → null');
    eq(core.routeMidiToAction({}), null, 'empty obj → null');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n========================================');
console.log('PASSED: ' + passed + '   FAILED: ' + failed);
console.log('========================================');
if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(function (f) { console.log('  • ' + f); });
    process.exit(1);
}
