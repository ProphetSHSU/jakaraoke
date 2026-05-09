// Test suite for server-additions.js
// Run: node test-server-additions.js

var additions = require('./server-additions');
var slugify = additions.slugify;
var matchSceneToSong = additions.matchSceneToSong;

var pass = 0, fail = 0;
function assert(condition, msg) {
  if (condition) { pass++; }
  else { fail++; console.log('FAIL: ' + msg); }
}

// ===== slugify tests =====
console.log('--- slugify ---');
assert(slugify('Wagon Wheel') === 'wagon wheel', 'basic');
assert(slugify('wagon-wheel') === 'wagon wheel', 'hyphens');
assert(slugify('Old Crow Medicine Show - Wagon Wheel.txt') === 'old crow medicine show wagon wheel', 'full filename');
assert(slugify("Don't Stop Believin'") === 'dont stop believin', 'apostrophes');
assert(slugify('   Spaces   Everywhere   ') === 'spaces everywhere', 'extra spaces');
assert(slugify('') === '', 'empty');
assert(slugify(null) === '', 'null');
assert(slugify('HALLELUJAH') === 'hallelujah', 'uppercase');
assert(slugify('AC/DC - Back In Black.txt') === 'ac dc back in black', 'slashes');

// ===== matchSceneToSong tests =====
console.log('--- matchSceneToSong ---');

var songs = [
  'Old Crow Medicine Show - Wagon Wheel.txt',
  'Leonard Cohen - Hallelujah.txt',
  'Rick Springfield - Jessies Girl.txt',
  'Amy Winehouse - Valerie_Jake.txt',
  'Eagles - Hotel California.txt',
  'Creedence Clearwater Revival - Fortunate Son.txt'
];

var metaIndex = {
  'Amy Winehouse - Valerie_Jake.txt': { title: 'Valerie', artist: 'Amy Winehouse' },
  'Old Crow Medicine Show - Wagon Wheel.txt': { title: 'Wagon Wheel', artist: 'Old Crow Medicine Show' }
};

// Exact slug match (scene = title portion of "Artist - Title.txt")
var r = matchSceneToSong('Wagon Wheel', songs, metaIndex);
assert(r.filename === 'Old Crow Medicine Show - Wagon Wheel.txt', 'substring match wagon wheel: got ' + r.filename);
assert(r.confidence === 'high', 'wagon wheel confidence');

// Full filename match
r = matchSceneToSong('Leonard Cohen - Hallelujah', songs, metaIndex);
assert(r.filename === 'Leonard Cohen - Hallelujah.txt', 'full name match: got ' + r.filename);

// Scene name that's just the song title (substring of filename)
r = matchSceneToSong('Hallelujah', songs, metaIndex);
assert(r.filename === 'Leonard Cohen - Hallelujah.txt', 'title only substring: got ' + r.filename);

// Metadata title match
r = matchSceneToSong('Valerie', songs, metaIndex);
// 'Valerie' won't substring-match 'Amy Winehouse - Valerie_Jake.txt' as slug because
// 'valerie' is in 'amy winehouse valerie jake'. Actually it IS a substring.
// Let's check:
assert(r.filename === 'Amy Winehouse - Valerie_Jake.txt', 'valerie match: got ' + r.filename);

// No match
r = matchSceneToSong('Bohemian Rhapsody', songs, metaIndex);
assert(r.filename === null, 'no match');
assert(r.confidence === 'none', 'no match confidence');

// Divider-like scene name
r = matchSceneToSong('--- Set 1 ---', songs, metaIndex);
assert(r.filename === null, 'divider no match: got ' + r.filename);

// Case insensitive
r = matchSceneToSong('HOTEL CALIFORNIA', songs, metaIndex);
assert(r.filename === 'Eagles - Hotel California.txt', 'case insensitive: got ' + r.filename);

// ===== Ready-check tests =====
console.log('--- ready-check ---');

// Mock connections
var conn1 = { sendUTF: function() {} };
var conn2 = { sendUTF: function() {} };

additions.registerPlayer(conn1, 'Jake');
additions.registerPlayer(conn2, 'Nate');

var state = additions.getReadyStatePayload();
assert(state.players.length === 2, 'two players registered');
assert(state.players[0].name === 'Jake', 'player 1 name');
assert(state.players[0].ready === false, 'player 1 not ready');

additions.setPlayerReady(conn1, true);
state = additions.getReadyStatePayload();
assert(state.players[0].ready === true, 'jake ready');
assert(state.players[1].ready === false, 'nate not ready');

additions.resetAllReady();
state = additions.getReadyStatePayload();
assert(state.players[0].ready === false, 'reset jake');
assert(state.players[1].ready === false, 'reset nate');

additions.unregisterPlayer(conn1);
state = additions.getReadyStatePayload();
assert(state.players.length === 1, 'jake unregistered');
assert(state.players[0].name === 'Nate', 'nate remains');

// ===== Command relay tests =====
console.log('--- command relay ---');

var calls = [];
var mockFns = {
  transportPlay: function() { calls.push('play'); },
  transportStop: function() { calls.push('stop'); },
  transportPause: function() { calls.push('pause'); },
  sendSong: function(n) { calls.push('sendSong:' + n); }
};

additions.handleCommand({ action: 'play' }, mockFns, 'Toni');
additions.handleCommand({ action: 'stop' }, mockFns, 'Toni');
additions.handleCommand({ action: 'next' }, mockFns, 'Toni');
additions.handleCommand({ action: 'prev' }, mockFns, 'Toni');

assert(calls[0] === 'play', 'play called');
assert(calls[1] === 'stop', 'stop called');
assert(calls[2] === 'sendSong:1', 'next = sendSong(1)');
assert(calls[3] === 'sendSong:2', 'prev = sendSong(2)');

// ===== Summary =====
console.log('\n' + (pass + fail) + ' tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
