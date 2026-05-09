// ===========================================================================
// server-additions.js — Ready-check, command relay, slug matcher
// ===========================================================================
// Require this from websocket-server.js and wire into the WS message handler.
// See INTEGRATION_GUIDE at bottom for exact insertion points.
// ===========================================================================

var path = require('path');

// ---------- Slug Matcher ----------
// Normalizes song names for fuzzy matching between Ableton scene names and
// ChordPro filenames. Used by Phase 2b Set State Broadcaster.

function slugify(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\.txt$/i, '')          // strip extension
    .replace(/['']/g, '')            // strip apostrophes
    .replace(/[^a-z0-9]+/g, ' ')    // non-alphanumeric → space
    .trim()
    .replace(/\s+/g, ' ');           // collapse whitespace
}

/**
 * Find the best matching song file for a scene name.
 * Strategy: slug match first, then metadata title fallback.
 *
 * @param {string} sceneName - Ableton scene name (e.g., "Wagon Wheel")
 * @param {string[]} availableSongs - list of filenames (e.g., ["Artist - Song.txt", ...])
 * @param {object} songMetadataIndex - filename → {title, artist} (built at library load)
 * @returns {{ filename: string|null, method: string, confidence: string }}
 */
function matchSceneToSong(sceneName, availableSongs, songMetadataIndex) {
  if (!sceneName || !availableSongs || availableSongs.length === 0) {
    return { filename: null, method: 'none', confidence: 'none' };
  }

  var sceneSlug = slugify(sceneName);

  // Pass 1: exact slug match against filename
  for (var i = 0; i < availableSongs.length; i++) {
    var fileSlug = slugify(availableSongs[i]);
    if (fileSlug === sceneSlug) {
      return { filename: availableSongs[i], method: 'slug-exact', confidence: 'high' };
    }
  }

  // Pass 2: scene slug is a substring of file slug at a word boundary
  // Word-boundary prevents "try" matching "symmetry", etc.
  var substringMatches = [];
  var wordBoundaryRe = new RegExp('(^|\\s)' + sceneSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)');
  for (var i = 0; i < availableSongs.length; i++) {
    var fileSlug = slugify(availableSongs[i]);
    if (wordBoundaryRe.test(fileSlug)) {
      substringMatches.push(availableSongs[i]);
    }
  }
  if (substringMatches.length === 1) {
    return { filename: substringMatches[0], method: 'slug-substring', confidence: 'high' };
  }
  if (substringMatches.length > 1) {
    // Ambiguous — prefer shortest filename (closest to exact match)
    substringMatches.sort(function(a, b) { return slugify(a).length - slugify(b).length; });
    return { filename: substringMatches[0], method: 'slug-substring-shortest', confidence: 'high' };
  }

  // Pass 3: metadata title match
  if (songMetadataIndex) {
    for (var filename in songMetadataIndex) {
      var meta = songMetadataIndex[filename];
      if (meta.title && slugify(meta.title) === sceneSlug) {
        return { filename: filename, method: 'metadata-title', confidence: 'high' };
      }
    }
    // Substring in title
    for (var filename in songMetadataIndex) {
      var meta = songMetadataIndex[filename];
      if (meta.title && slugify(meta.title).indexOf(sceneSlug) !== -1) {
        return { filename: filename, method: 'metadata-title-substring', confidence: 'medium' };
      }
    }
  }

  // No match
  return { filename: null, method: 'none', confidence: 'none' };
}


// ---------- Ready-Check Protocol ----------
// Players register with a name, toggle ready state.
// Server broadcasts readyState to all clients on any change.
// Resets on song change (not on stop/play).

var players = [];  // [{ name, connectionId, ready }]
var connectionIdCounter = 0;

function registerPlayer(connection, name) {
  // Remove existing registration for this connection
  unregisterPlayer(connection);

  connection._playerId = ++connectionIdCounter;
  connection._playerName = name;

  players.push({
    name: name,
    connectionId: connection._playerId,
    ready: false
  });

  console.log('Player registered: ' + name + ' (id=' + connection._playerId + ')');
}

function unregisterPlayer(connection) {
  if (connection._playerId) {
    players = players.filter(function(p) { return p.connectionId !== connection._playerId; });
    console.log('Player unregistered: ' + (connection._playerName || 'unknown'));
  }
}

function setPlayerReady(connection, ready) {
  var player = players.find(function(p) { return p.connectionId === connection._playerId; });
  if (player) {
    player.ready = !!ready;
  }
}

function resetAllReady() {
  players.forEach(function(p) { p.ready = false; });
}

function getReadyStatePayload() {
  return {
    type: 'readyState',
    players: players.map(function(p) {
      return { name: p.name, ready: p.ready };
    })
  };
}

function broadcastReadyState(connections) {
  var payload = JSON.stringify(getReadyStatePayload());
  for (var i = 0; i < connections.length; i++) {
    connections[i].sendUTF(payload);
  }
}


// ---------- Command Relay ----------
// Receives commands from clients (play, stop, next, prev).
// In Phase 1: executes locally (calls server transport/nav functions).
// In Phase 2b: forwards via UDP to M4L Set State Broadcaster.

/**
 * Handle a command message from a client.
 * @param {object} parsed - {type:"command", action:"play"|"stop"|"next"|"prev"}
 * @param {object} serverFunctions - {transportPlay, transportStop, sendSong}
 * @param {string} playerName - who sent the command
 */
function handleCommand(parsed, serverFunctions, playerName) {
  var action = parsed.action;
  console.log('Command from ' + (playerName || 'unknown') + ': ' + action);

  switch (action) {
    case 'play':
      serverFunctions.transportPlay();
      break;
    case 'stop':
      serverFunctions.transportStop();
      break;
    case 'pause':
      serverFunctions.transportPause();
      break;
    case 'next':
      serverFunctions.sendSong(1); // 1 = advance
      break;
    case 'prev':
      serverFunctions.sendSong(2); // 2 = retreat
      break;
    default:
      console.log('Unknown command action: ' + action);
  }
}


// ---------- Exports ----------
module.exports = {
  // Slug matcher
  slugify: slugify,
  matchSceneToSong: matchSceneToSong,

  // Ready-check
  registerPlayer: registerPlayer,
  unregisterPlayer: unregisterPlayer,
  setPlayerReady: setPlayerReady,
  resetAllReady: resetAllReady,
  getReadyStatePayload: getReadyStatePayload,
  broadcastReadyState: broadcastReadyState,
  players: players, // direct access for testing

  // Command relay
  handleCommand: handleCommand
};


// ===========================================================================
// INTEGRATION GUIDE
// ===========================================================================
// Add to top of websocket-server.js (after var chordpro = require(...)):
//
//   var additions = require('./server-additions');
//
// ---------------------------------------------------------------------------
// In wsServer.on('request', ...) — after connection.on('message', ...) handler,
// add these cases inside the try { var parsed = JSON.parse(...) } block:
//
//   // Player registration
//   if (parsed.type === 'register') {
//     additions.registerPlayer(connection, parsed.name);
//     additions.broadcastReadyState(remoteConnection);
//     return;
//   }
//
//   // Ready toggle
//   if (parsed.type === 'ready') {
//     additions.setPlayerReady(connection, parsed.ready);
//     additions.broadcastReadyState(remoteConnection);
//     return;
//   }
//
//   // Client commands (play/stop/next/prev)
//   if (parsed.type === 'command') {
//     additions.handleCommand(parsed, {
//       transportPlay: transportPlay,
//       transportStop: transportStop,
//       transportPause: transportPause,
//       sendSong: sendSong
//     }, connection._playerName);
//     return;
//   }
//
// ---------------------------------------------------------------------------
// In connection.on('close', ...) — add before splice:
//
//   additions.unregisterPlayer(connection);
//   additions.broadcastReadyState(remoteConnection);
//
// ---------------------------------------------------------------------------
// In sendSong() — after broadcastState() call (around line 718), add:
//
//   additions.resetAllReady();
//   additions.broadcastReadyState(remoteConnection);
//
// ---------------------------------------------------------------------------
// On new connection (after sending state + transport), add:
//
//   connection.sendUTF(JSON.stringify(additions.getReadyStatePayload()));
//
// ===========================================================================
