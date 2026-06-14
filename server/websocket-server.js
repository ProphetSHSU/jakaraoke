//const { Navigator } = require("node-navigator");
var SERVER_VERSION = '2.5.0-scroll-audit';
console.log('jakaraoke-server v' + SERVER_VERSION + ' starting...');
//const navigator = new Navigator();

//https://github.com/jazz-soft/JZZ - jzz is a node.js midi tool
var navigator = require('jzz');

var fs = require("fs");
var path = require("path");
var chordpro = require("./chordpro-parser");
var additions = require("./server-additions");


// ============================================================
// Configuration & Library Management
// ============================================================

// Load base config
var config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json")).toString('utf-8'));

// Try to load local overrides (machine-specific paths)
var localConfigPath = path.join(__dirname, "config.local.json");
if (fs.existsSync(localConfigPath)) {
    console.log('Loading local config overrides from config.local.json');
    var localConfig = JSON.parse(fs.readFileSync(localConfigPath).toString('utf-8'));
    
    // Deep merge libraries by name
    if (localConfig.libraries) {
        localConfig.libraries.forEach(function(localLib) {
            var baseLib = config.libraries.find(function(l) { return l.name === localLib.name; });
            if (baseLib && localLib.path) {
                baseLib.path = localLib.path;
                console.log('  Overriding path for "' + localLib.name + '": ' + localLib.path);
            }
        });
    }
    
    // Merge other top-level settings (e.g., activeLibrary, activeSetlist, port)
    Object.keys(localConfig).forEach(function(key) {
        if (key !== 'libraries') {
            config[key] = localConfig[key];
        }
    });
} else {
    console.log('No config.local.json found - using config.json only');
    console.log('  (Create config.local.json to override library paths on this machine)');
}

var libraries = config.libraries || [];
var activeLibrary = null;
var availableSongs = [];     // all .txt song files in the active library
var availableSetlists = [];  // all setlist files found in Setlists/ subfolder
var setList = [];            // the active setlist (ordered array of filenames)
var setListName = null;      // name of the active setlist (null = "All Songs")
var songPointer = -1;
var songDurations = {};
var currentSongPayload = null;
var currentlyLoadedSongFile = null;  // filename of song loaded by last scene match (null on divider/no-match) — used by save_song to re-emit tempo_schedule
var lastTrackPayload = null;
var lastPlayheadPayload = null;  // cached last playhead msg for late-joiner sync
var unmatchedScenes = []; // scenes with no matching song file // cached last-sent song payload (for late-joiner sync)      // filename → durationSeconds (parsed from metadata)

// ============================================================
// Transport State Machine
// ============================================================
// States: 'stopped', 'playing', 'paused'
// - stopped + play → playing (from top, elapsedAtPause = 0)
// - playing + pause → paused (freeze, record elapsed)
// - playing + stop → stopped (reset to top)
// - paused + play → playing (resume from elapsedAtPause)
// - paused + stop → stopped (reset to top)

var transport = {
    state: 'stopped',       // 'stopped' | 'playing' | 'paused'
    playStartedAt: null,    // Date.now() when play was last started/resumed
    elapsedAtPause: 0,      // seconds elapsed when paused (for resume)
    tempo: 120,             // BPM (updated from song metadata on song load)
    bpb: 4                  // beats per bar
};

function transportPlay() {
    if (transport.state === 'playing') return;

    if (transport.state === 'paused') {
        // Resume from paused position
        transport.playStartedAt = Date.now() - (transport.elapsedAtPause * 1000);
    } else {
        // Start fresh
        transport.elapsedAtPause = 0;
        transport.playStartedAt = Date.now();
    }
    transport.state = 'playing';
    console.log('Transport: PLAY (elapsed offset: ' + transport.elapsedAtPause.toFixed(1) + 's)');
    broadcastTransport();
}

function transportPause() {
    if (transport.state !== 'playing') return;

    // Record how far we got
    transport.elapsedAtPause = (Date.now() - transport.playStartedAt) / 1000;
    transport.state = 'paused';
    console.log('Transport: PAUSED at ' + transport.elapsedAtPause.toFixed(1) + 's');
    broadcastTransport();
}

function transportStop() {
    if (transport.state === 'stopped') return;

    transport.state = 'stopped';
    transport.elapsedAtPause = 0;
    transport.playStartedAt = null;
    console.log('Transport: STOPPED');
    broadcastTransport();
}

function getTransportPayload() {
    var elapsed = 0;
    if (transport.state === 'playing' && transport.playStartedAt) {
        elapsed = (Date.now() - transport.playStartedAt) / 1000;
    } else if (transport.state === 'paused') {
        elapsed = transport.elapsedAtPause;
    }

    return {
        type: 'transport',
        state: transport.state,
        elapsed: elapsed,
        tempo: transport.tempo,
        bpb: transport.bpb
    };
}

function broadcastTransport() {
    var payload = JSON.stringify(getTransportPayload());
    for (var i = 0; i < remoteConnection.length; i++) {
        remoteConnection[i].sendUTF(payload);
    }
}

function loadLibrary(libraryName) {
    var lib = libraries.find(function(l) { return l.name === libraryName; });
    if (!lib) {
        console.log('Library not found: ' + libraryName);
        return false;
    }

    var libPath = lib.path;
    // Resolve relative paths from the server directory
    if (!path.isAbsolute(libPath)) {
        libPath = path.join(__dirname, libPath);
    }

    if (!fs.existsSync(libPath)) {
        console.log('Library path does not exist: ' + libPath);
        return false;
    }

    activeLibrary = lib;
    activeLibrary._resolvedPath = libPath;

    // Scan for song files (.txt files in the library root, excluding Setlists dir)
    var files = fs.readdirSync(libPath);
    availableSongs = files.filter(function(f) {
        if (!f.endsWith('.txt')) return false;
        var stat = fs.statSync(path.join(libPath, f));
        return stat.isFile();
    }).sort();

    console.log('Loaded library "' + lib.name + '" with ' + availableSongs.length + ' songs');

    // Parse duration metadata from each song
    songDurations = {};
    var totalDuration = 0;
    availableSongs.forEach(function(f) {
        try {
            var text = fs.readFileSync(path.join(libPath, f), 'utf-8');
            var parsed = chordpro.parse(text);
            var dur = parsed.metadata.durationSeconds || 0;
            songDurations[f] = dur;
            totalDuration += dur;
        } catch(e) {
            songDurations[f] = 0;
        }
    });
    var totalMin = Math.floor(totalDuration / 60);
    var totalSec = totalDuration % 60;
    console.log('Total library duration: ' + totalMin + ':' + (totalSec < 10 ? '0' : '') + totalSec);

    // Scan for setlists
    var setlistDir = path.join(libPath, 'Setlists');
    availableSetlists = [];
    if (fs.existsSync(setlistDir)) {
        var setlistFiles = fs.readdirSync(setlistDir);
        availableSetlists = setlistFiles.filter(function(f) {
            return f.endsWith('.txt');
        }).map(function(f) {
            return f.replace('.txt', '');
        }).sort();
        console.log('Found ' + availableSetlists.length + ' setlists: ' + availableSetlists.join(', '));
    }

    // Default to all songs if no setlist is active
    loadSetlist(null);

    return true;
}

function loadSetlist(name) {
    songPointer = -1;

    if (!name) {
        // "All Songs" mode — use every song in the library alphabetically
        setListName = null;
        setList = availableSongs.slice();
        console.log('Setlist: All Songs (' + setList.length + ' songs)');
        return true;
    }

    var setlistPath = path.join(activeLibrary._resolvedPath, 'Setlists', name + '.txt');
    if (!fs.existsSync(setlistPath)) {
        console.log('Setlist file not found: ' + setlistPath);
        return false;
    }

    var content = fs.readFileSync(setlistPath).toString('utf-8');
    var lines = content.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

    // Each line is either a song name or a set divider (--- or --- Set N ---)
    var setNumber = 1;
    setList = [];
    lines.forEach(function(line) {
        // Match divider lines: --- or --- Set N ---
        if (line === '---' || /^---\s+Set\s+\d+\s+---$/.test(line)) {
            // Set divider marker
            setList.push({ type: 'divider', setNumber: setNumber });
            setNumber++;
        } else {
            // Song filename (add .txt extension)
            setList.push(line + '.txt');
        }
    });

    setListName = name;
    var songCount = setList.filter(function(item) { return typeof item === 'string'; }).length;
    var dividerCount = setList.filter(function(item) { return typeof item === 'object'; }).length;
    console.log('Loaded setlist "' + name + '" with ' + songCount + ' songs and ' + dividerCount + ' set dividers');
    return true;
}

function getSongPath(filename) {
    if (!activeLibrary) return null;
    return path.join(activeLibrary._resolvedPath, filename);
}

// Helper: advance songPointer to next item (song or divider)
function advanceToNextSong() {
    if (songPointer < setList.length - 1) {
        songPointer++;
        return true;
    }
    return false; // reached end of setlist
}

// Helper: go back to previous item (song or divider)
function retreatToPrevSong() {
    if (songPointer > 0) {
        songPointer--;
        return true;
    }
    return false; // reached beginning of setlist
}

// Build a state snapshot to send to clients (e.g. test harness)
function getStatePayload() {
    // Build durations array in setList order (dividers have duration 0)
    var durations = setList.map(function(item) {
        if (typeof item === 'string') {
            return songDurations[item] || 0;
        } else {
            return 0; // dividers have no duration
        }
    });
    var totalSeconds = durations.reduce(function(sum, d) { return sum + d; }, 0);

    // Map setList to client-friendly format (strip .txt from songs, keep dividers)
    var clientSetList = setList.map(function(item) {
        if (typeof item === 'string') {
            return item.replace('.txt', '');
        } else {
            // Return divider object as-is
            return item;
        }
    });

    return {
        type: 'state',
        libraries: libraries.map(function(l) { return l.name; }),
        activeLibrary: activeLibrary ? activeLibrary.name : null,
        availableSetlists: availableSetlists,
        activeSetlist: setListName,
        setList: clientSetList,
        songPointer: songPointer,
        songDurations: durations,
        totalSetSeconds: totalSeconds,
        unmatchedScenes: unmatchedScenes
    };
}

function broadcastState() {
    var payload = JSON.stringify(getStatePayload());
    for (var i = 0; i < remoteConnection.length; i++) {
        remoteConnection[i].sendUTF(payload);
    }
}

// Load the configured library on startup
var startupLibrary = config.activeLibrary || (libraries.length > 0 ? libraries[0].name : null);
if (startupLibrary) {
    loadLibrary(startupLibrary);
    if (config.activeSetlist) {
        loadSetlist(config.activeSetlist);
    }
}


// ============================================================
// WebSocket Server
// ============================================================

const http = require('http');
const https = require('https');
const WebSocketServer = require('websocket').server;

// Check for SSL certificates
var sslCertPath = path.join(__dirname, 'ssl', 'cert.pem');
var sslKeyPath = path.join(__dirname, 'ssl', 'key.pem');
var useHttps = fs.existsSync(sslCertPath) && fs.existsSync(sslKeyPath);
var sslOptions = null;

if (useHttps) {
    try {
        sslOptions = {
            cert: fs.readFileSync(sslCertPath),
            key: fs.readFileSync(sslKeyPath)
        };
        console.log('✅ SSL certificates found - HTTPS enabled');
    } catch (err) {
        console.log('⚠️  SSL certificate error:', err.message);
        console.log('   Falling back to HTTP only');
        useHttps = false;
    }
} else {
    console.log('ℹ️  No SSL certificates found - HTTP only');
    console.log('   Run ./generate_cert.sh to enable HTTPS');
}

// Request handler for both HTTP and HTTPS
function handleRequest(request, response) {
    // Strip query string and hash fragment so path matching works for URLs
    // like /lyrics.html?debug=kbd (the path is just /lyrics.html).
    var filePath = request.url.split('?')[0].split('#')[0];

    // Default route serves the client
    if (filePath === '/' || filePath === '') {
        filePath = '/client.html';
    }
    
    // Route requests to appropriate directories
    var fullPath;
    if (filePath.startsWith('/client') || filePath === '/client.html') {
        fullPath = path.join(__dirname, '..', 'client', path.basename(filePath));
    } else if (filePath === '/lyrics.html' || filePath === '/navigator.html') {
        // New views served from public_site
        fullPath = path.join(__dirname, '..', 'public_site', path.basename(filePath));
    } else if (filePath.startsWith('/test_harness') || filePath === '/test_harness.html') {
        fullPath = path.join(__dirname, '..', 'public_site', path.basename(filePath));
    } else {
        // Serve from public_site by default
        fullPath = path.join(__dirname, '..', 'public_site', path.basename(filePath));
    }
    
    // Security: prevent directory traversal
    var normalizedPath = path.normalize(fullPath);
    var projectRoot = path.join(__dirname, '..');
    if (!normalizedPath.startsWith(projectRoot)) {
        response.writeHead(403, { 'Content-Type': 'text/plain' });
        response.end('Forbidden');
        return;
    }
    
    // Determine MIME type
    var ext = path.extname(fullPath).toLowerCase();
    var mimeTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
    };
    var contentType = mimeTypes[ext] || 'application/octet-stream';
    
    // Read and serve the file
    fs.readFile(fullPath, function(error, content) {
        if (error) {
            if (error.code === 'ENOENT') {
                response.writeHead(404, { 'Content-Type': 'text/plain' });
                response.end('404 Not Found: ' + filePath);
            } else {
                response.writeHead(500, { 'Content-Type': 'text/plain' });
                response.end('500 Internal Server Error: ' + error.code);
            }
        } else {
            // Add charset=utf-8 for text-based content to properly display emojis
            var contentTypeWithCharset = contentType;
            if (contentType.startsWith('text/') || contentType === 'application/javascript' || contentType === 'application/json') {
                contentTypeWithCharset = contentType + '; charset=utf-8';
            }
            response.writeHead(200, { 'Content-Type': contentTypeWithCharset });
            response.end(content, 'utf-8');
            console.log('Served: ' + filePath);
        }
    });
}

// Create HTTP or HTTPS server
var httpServer = useHttps
    ? https.createServer(sslOptions, handleRequest)
    : http.createServer(handleRequest);

// Bind to all network interfaces (0.0.0.0) so other devices can connect
var port = config.port || 9898;
var host = '0.0.0.0';
httpServer.listen(port, host);

console.log('');
console.log('🎤 Jakeraoke Server Running');
console.log('=====================================');
if (useHttps) {
    console.log('HTTPS Server: https://' + host + ':' + port);
    console.log('WebSocket: wss://' + host + ':' + port + ' (secure)');
} else {
    console.log('HTTP Server: http://' + host + ':' + port);
    console.log('WebSocket: ws://' + host + ':' + port);
}
console.log('');
console.log('Local access:');
if (useHttps) {
    console.log('  https://localhost:' + port + '/');
    console.log('  https://localhost:' + port + '/test_harness.html');
} else {
    console.log('  http://localhost:' + port + '/');
    console.log('  http://localhost:' + port + '/test_harness.html');
}
console.log('');
console.log('Network access (use your MacBook\'s IP):');
if (useHttps) {
    console.log('  https://YOUR-MACBOOK-IP:' + port + '/');
    console.log('  (Clients will need to accept certificate warning once)');
} else {
    console.log('  http://YOUR-MACBOOK-IP:' + port + '/');
}
console.log('');

const wsServer = new WebSocketServer({
    httpServer: httpServer
});

var remoteConnection = [];
wsServer.on('request', function(request) {
    const connection = request.accept(null, request.origin);
    remoteConnection.push(connection);

    // Send current state, song, transport, and ready-check to the newly connected
    // client. Order matters: SONG must arrive before TRANSPORT so that on the
    // client side, handleTransport can capture currentSongFilename / Meta when
    // setting playingSongFilename for preview mode.
    connection.sendUTF(JSON.stringify(getStatePayload()));
    if (currentSongPayload) connection.sendUTF(currentSongPayload);
    connection.sendUTF(JSON.stringify(getTransportPayload()));
    if (lastPlayheadPayload) connection.sendUTF(lastPlayheadPayload);
    connection.sendUTF(JSON.stringify(additions.getReadyStatePayload()));
    if (lastTrackPayload) connection.sendUTF(lastTrackPayload);

    connection.on('message', function(message) {
      console.log('Received Message:', message.utf8Data);

      // Handle JSON commands from clients (test harness, etc.)
      try {
        var parsed = JSON.parse(message.utf8Data);

        // Simulated MIDI from test harness
        if (parsed.type === 'simulate') {
          console.log('Simulated MIDI - Command: ' + parsed.command + ' Note: ' + parsed.note + ' Velocity: ' + parsed.velocity);
          var simulated = { data: [parsed.command, parsed.note, parsed.velocity || 0] };
          getMIDIMessage(simulated);
          return;
        }

        // Library/setlist management commands
        if (parsed.type === 'selectLibrary') {
          if (loadLibrary(parsed.name)) {
            broadcastState();
          }
          return;
        }

        if (parsed.type === 'selectSetlist') {
          if (loadSetlist(parsed.name)) {
            broadcastState();
          }
          return;
        }

        if (parsed.type === 'getState') {
          connection.sendUTF(JSON.stringify(getStatePayload()));
          return;
        }

        // Jump to specific song by index
        if (parsed.type === 'selectSong' && typeof parsed.index === 'number') {
          var idx = parsed.index;
          if (idx >= 0 && idx < setList.length) {
            var item = setList[idx];
            // Set pointer and send (works for both songs and dividers)
            songPointer = idx - 1; // sendSong increments, so set one before
            sendSong(1); // 1 = next (will increment to idx)
          }
          return;
        }

        // Transport commands from test harness
        if (parsed.type === 'transport') {
          if (parsed.action === 'play') transportPlay();
          else if (parsed.action === 'pause') transportPause();
          else if (parsed.action === 'stop') transportStop();
          return;
        }

        // Player registration (navigator/lyrics views)
        if (parsed.type === 'register') {
          additions.registerPlayer(connection, parsed.name);
          additions.broadcastReadyState(remoteConnection);
          return;
        }

        // Ready toggle
        if (parsed.type === 'ready') {
          additions.setPlayerReady(connection, parsed.ready);
          additions.broadcastReadyState(remoteConnection);
          return;
        }

        // Client commands (play/stop/next/prev/goto from navigator/lyrics)
        if (parsed.type === 'command') {
          additions.handleCommand(parsed, {
            transportPlay: transportPlay,
            transportStop: transportStop,
            transportPause: transportPause,
            sendSong: sendSong,
            gotoIndex: gotoIndex,
            sendUdpCommand: udpBridge.sendCommand
          }, connection._playerName);
          return;
        }
        // Preview load: a single client requests the content of a specific song
        // for browser-side preview ONLY. Does NOT change Ableton's selected scene,
        // does NOT touch transport, does NOT broadcast to other clients. The payload
        // is marked preview:true so the client knows not to re-latch playingSongFilename.
        if (parsed.type === 'previewLoad') {
          var pfn = parsed.filename;
          if (!pfn) {
            connection.sendUTF(JSON.stringify({ type: 'previewLoad_result', ok: false, error: 'Missing filename' }));
            return;
          }
          // Only allow filenames that are part of the active setList (defense vs. path traversal)
          var inSetList = false;
          for (var psi = 0; psi < setList.length; psi++) {
            if (setList[psi] === pfn) { inSetList = true; break; }
          }
          if (!inSetList) {
            console.log('previewLoad: filename not in setList: ' + pfn);
            connection.sendUTF(JSON.stringify({ type: 'previewLoad_result', ok: false, error: 'Not in setList' }));
            return;
          }
          var pPath = getSongPath(pfn);
          if (!pPath) {
            connection.sendUTF(JSON.stringify({ type: 'previewLoad_result', ok: false, error: 'No active library' }));
            return;
          }
          try {
            var pText = fs.readFileSync(pPath).toString('utf-8');
            var pParsed = chordpro.parse(pText);
            var pPayload = {
              "command": 0,
              "song": pParsed,
              "songRaw": pText,
              "filename": pfn,
              "preview": true
            };
            connection.sendUTF(JSON.stringify(pPayload));
            console.log('previewLoad: sent ' + pfn + ' to ' + (connection._playerName || 'unknown'));
          } catch(pErr) {
            console.error('previewLoad error:', pErr.message);
            connection.sendUTF(JSON.stringify({ type: 'previewLoad_result', ok: false, error: pErr.message }));
          }
          return;
        }

        // Save edited ChordPro content
        if (parsed.type === 'save_song') {
          var fn = parsed.filename;
          var content = parsed.content;
          if (!fn || typeof content !== 'string') {
            connection.sendUTF(JSON.stringify({ type: 'save_result', ok: false, error: 'Missing filename or content' }));
            return;
          }
          var savePath = getSongPath(fn);
          if (!savePath) {
            connection.sendUTF(JSON.stringify({ type: 'save_result', ok: false, error: 'No active library' }));
            return;
          }
          try {
            fs.writeFileSync(savePath, content, 'utf-8');
            console.log('Saved song: ' + fn);
            // Re-parse and broadcast to all clients
            var reParsed = chordpro.parse(content);
            var rePayload = { "command": 0, "song": reParsed, "songRaw": content, "filename": fn, "live": true };
            currentSongPayload = JSON.stringify(rePayload);
            for (var ri = 0; ri < remoteConnection.length; ri++) {
              remoteConnection[ri].sendUTF(currentSongPayload);
            }
            // Re-arm tempo schedule on the M4L device if the saved song matches
            // the currently-loaded scene. Sends an empty schedule when the user
            // removes/empties {tempo_map}, which clears any prior schedule.
            if (fn === currentlyLoadedSongFile) {
              var newSchedule = (reParsed.metadata && reParsed.metadata.tempo_map) || [];
              udpBridge.sendCommand({ type: "command", action: "set_tempo_schedule", schedule: newSchedule });
              console.log("UDP: re-armed tempo schedule (save_song) for " + fn + " — " + newSchedule.length + " change(s)");
            }
            connection.sendUTF(JSON.stringify({ type: 'save_result', ok: true }));
          } catch(saveErr) {
            console.error('Save error:', saveErr);
            connection.sendUTF(JSON.stringify({ type: 'save_result', ok: false, error: saveErr.message }));
          }
          return;
        }


      } catch(e) {
        // Not JSON, treat as regular message
      }

      connection.sendUTF('Successfully connected to server!');
    });
    connection.on('close', function(reasonCode, description) {
        console.log('Client has disconnected.');
        additions.unregisterPlayer(connection);
        // Remove from connection list BEFORE broadcasting — sendUTF on a
        // closed connection throws, which would crash the server or abort
        // the broadcast loop before reaching remaining valid clients.
        var idx = remoteConnection.indexOf(connection);
        if (idx > -1) remoteConnection.splice(idx, 1);
        additions.broadcastReadyState(remoteConnection);
    });
});


// ============================================================
// MIDI Setup
// ============================================================

//test to see if the browser supports webMIDI
// MIDI listeners DISABLED (2026-05-09) — UDP bridge is now the sole path.
// Ableton state flows via Set State Broadcaster M4L → UDP:9899 → server.
// Old MIDI path caused state conflicts (song revert on play).
if (false && navigator.requestMIDIAccess) {
    console.log('This browser supports WebMIDI!');

    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);

} else {
    console.log('WebMIDI is not supported in this browser.');
}

// Function to run when requestMIDIAccess is successful
function onMIDISuccess(midiAccess) {
    console.log('Attaching MIDI listeners')
    var inputs = midiAccess.inputs;
    var outputs = midiAccess.outputs;

    // Attach MIDI event "listeners" to each input
    for (var input of midiAccess.inputs.values()) {
        //console.log("********" + input.name);
        //scalett is double sending - remove it from listener for now: 
        if(input.name == "Scarlett 18i20 USB"){
            //input.onmidimessage = getMIDIMessage;
            continue;
        }
        
        if(input.name == "IAC Driver Bus 1"){
            input.onmidimessage = getMIDIMessage;
            continue;
        }
        
        if(input.name == "TinyBox Port 1"){
            input.onmidimessage = getMIDIMessage;
            continue;
        }
        
        console.log("*** input.name is: " + input.name + " not attaching");

    }

    console.log(midiAccess.inputs.values());
}

// Function to run when requestMIDIAccess fails
function onMIDIFailure() {
    console.log('Error: Could not access MIDI devices.');
}


// ============================================================
// MIDI Message Handling
// ============================================================

// Function to parse the MIDI messages we receive
// For this app, we're only concerned with the actual note value,
// but we can parse for other information, as well
function getMIDIMessage(message) {
    var command = message.data[0];
    var note = message.data[1];
    var velocity = (message.data.length > 2) ? message.data[2] : 0; // a velocity value might not be included with a noteOff command

    //console.log('Midi Switch - Command: ' + command + ' Note: ' + note + ' velocity: ' + velocity)

    switch (command) {
        case 144: // note on
            if (velocity > 0) {
                noteOn(note, velocity);
            } else {
                noteOff(note);
            }
            break;
        case 128: // note off
            noteOff(note);
            break;
        case 194: // program change - song navigation
            sendSong(note);
            console.log('Midi Switch - Command: ' + command + ' Note: ' + note + ' velocity: ' + velocity)
            break;
        case 250: // 0xFA - MIDI Start
            console.log('MIDI: Start');
            transport.elapsedAtPause = 0; // force fresh start
            transport.state = 'stopped';
            transportPlay();
            break;
        case 251: // 0xFB - MIDI Continue (resume from pause)
            console.log('MIDI: Continue');
            transportPlay();
            break;
        case 252: // 0xFC - MIDI Stop
            console.log('MIDI: Stop');
            transportStop();
            break;
    }
}

// Jump to a specific setlist index. Sends UDP command to M4L (which changes
// Ableton's selected scene and triggers the normal scene→song broadcast).
// Falls back to local pointer-based navigation when M4L is unavailable.
function gotoIndex(index) {
    if (index < 0 || index >= setList.length) {
        console.log('gotoIndex: index ' + index + ' out of range [0,' + (setList.length - 1) + ']');
        return;
    }

    // If M4L has been heard from recently (within 30s), relay via UDP only.
    // M4L will change Ableton's scene and the resulting onScene callback will
    // broadcast to all clients uniformly. Running the local fallback when M4L
    // IS connected causes a double-broadcast with stale elapsed timestamps.
    if (udpBridge.isAlive()) {
        udpBridge.sendCommand({ type: 'command', action: 'goto', index: index });
        console.log('gotoIndex: sent UDP goto index=' + index + ' (M4L alive)');
        return;
    }

    // Standalone fallback: no M4L, load locally and broadcast.
    console.log('gotoIndex: local fallback index=' + index + ' (M4L not alive)');
    songPointer = index;
    var currentItem = setList[songPointer];
    if (typeof currentItem === 'object' && currentItem.type === 'divider') {
        loadSongBySceneName(currentItem.name, index, setList.length);
    } else if (typeof currentItem === 'string') {
        loadSongBySceneName(currentItem.replace(/\.txt$/i, ''), index, setList.length);
    }
}

function sendSong(note) {
    console.log('entering sendSong - note: ' + note)

    //if note is 2 descend, else ascend
    var success = false;
    if(note == 2) {
        success = retreatToPrevSong();
    } else {
        success = advanceToNextSong();
    }

    if (!success) {
        console.log('No more items in that direction');
        broadcastState();
        return;
    }

    var currentItem = setList[songPointer];
    
    // Check if we landed on a divider (set break)
    if (typeof currentItem === 'object' && currentItem.type === 'divider') {
        console.log('At set break (divider) - Set ' + currentItem.setNumber);
        
        // Reset transport at set breaks
        if (transport.state !== 'stopped') {
            transport.state = 'stopped';
            transport.elapsedAtPause = 0;
            transport.playStartedAt = null;
        }

        // Send set break message to clients
        var payload = {
            "command": 0,
            "setBreak": true,
            "setNumber": currentItem.setNumber
        };

        for (var i = 0; i < remoteConnection.length; i++) {
            remoteConnection[i].sendUTF(JSON.stringify(payload));
        }

        // Also broadcast updated state and transport reset
        broadcastState();
        broadcastTransport();

        // Reset ready-check on set break
        additions.resetAllReady();
        additions.broadcastReadyState(remoteConnection);
        return;
    }

    // It's a song - load and send it
    var songPath = getSongPath(currentItem);

    console.log('song = ' + currentItem + ' (path: ' + songPath + ')')

    try{
        var songText = fs.readFileSync(songPath).toString('utf-8');
        var parsed = chordpro.parse(songText);

        // Phase 2b: Ableton is source of truth. Selection-only scene changes
        // (next/prev navigation via MIDI program change) must NOT touch
        // transport.state — see loadSongBySceneName for full rationale.
        if (parsed.metadata.tempo) {
            transport.tempo = parsed.metadata.tempo;
        }

        var payload = {
            "command": 0,
            "song": parsed,
            "songRaw": songText,
            "filename": currentItem,
            "live": true
        }

        currentSongPayload = JSON.stringify(payload);
        var arrayLength = remoteConnection.length;
        console.log("array Length = " + arrayLength)
        for (var i = 0; i < arrayLength; i++) {
            remoteConnection[i].sendUTF(currentSongPayload);
            console.log('songPointer: ' + songPointer)
        }

        // Also broadcast updated state and transport reset so clients know the current position
        broadcastState();
        broadcastTransport();

        // Reset ready-check on song change
        additions.resetAllReady();
        additions.broadcastReadyState(remoteConnection);

    } catch(error) {
        console.log(error)
    }
}
    

// Function to handle noteOn messages (ie. key is pressed)
// Think of this like an 'onkeydown' event
function noteOn(note, velocity) {
    
    var note = {
        "command": 144,
        "note": note,
        "velocity": velocity
    }
    
    var arrayLength = remoteConnection.length;
    for (var i = 0; i < arrayLength; i++) {
        remoteConnection[i].sendUTF(JSON.stringify(note));
    }

}

// Function to handle noteOff messages (ie. key is released)
// Think of this like an 'onkeyup' event
function noteOff(note) {
    //...
}

// ===========================================================================
// UDP Bridge — Set State Broadcaster integration (Phase 2b)
// ===========================================================================
// Receives state from M4L (scene changes, transport, playhead) and relays
// client commands to M4L. Ableton is the source of truth.

var udpBridge = require("./udp-bridge");

// Load song by scene name (slug-matched, bypasses pointer-based navigation)
function loadSongBySceneName(sceneName, sceneIndex, sceneCount) {
    if (!sceneName) return;

    // Strip leading asterisk (guitar solo marker)
    var cleanName = sceneName.replace(/^\*/, "").trim();

    // Check if divider
    if (cleanName.indexOf("---") !== -1 || cleanName.replace(/-/g, "").trim() === "") {
        console.log("UDP scene: divider - " + sceneName);
        // Determine which set number this divider represents
        var dividerSetNumber = 1;
        for (var di = 0; di < setList.length; di++) {
            if (typeof setList[di] === "object" && setList[di].type === "divider") {
                if (setList[di].name === sceneName || setList[di].name === cleanName) break;
                dividerSetNumber++;
            }
        }
        // Broadcast divider state to clients
        var payload = { "command": 0, "setBreak": true, "setNumber": dividerSetNumber, "sceneName": sceneName };
        currentlyLoadedSongFile = null;
        currentSongPayload = JSON.stringify(payload);
        for (var i = 0; i < remoteConnection.length; i++) {
            remoteConnection[i].sendUTF(currentSongPayload);
        }
        broadcastState();
        additions.resetAllReady();
        additions.broadcastReadyState(remoteConnection);
        return;
    }

    // Slug-match scene name to song file
    var match = additions.matchSceneToSong(cleanName, availableSongs, null);
    if (!match.filename) {
        console.log("UDP scene: NO MATCH for \"" + sceneName + "\" (slug: " + additions.slugify(cleanName) + ")");
        currentlyLoadedSongFile = null;
        // Send scene-name-only to clients (no lyrics). Cache for late-joiners.
        var payload = { "command": 0, "song": { title: cleanName, lines: [], metadata: {} }, "noLyrics": true };
        currentSongPayload = JSON.stringify(payload);
        for (var i = 0; i < remoteConnection.length; i++) {
            remoteConnection[i].sendUTF(currentSongPayload);
        }
        broadcastState();
        return;
    }

    console.log("UDP scene: \"" + sceneName + "\" → " + match.filename + " [" + match.method + "]");
    currentlyLoadedSongFile = match.filename;

    // Load and broadcast song
    var songPath = getSongPath(match.filename);
    try {
        var songText = fs.readFileSync(songPath).toString("utf-8");
        var parsed = chordpro.parse(songText);

        // Push tempo schedule to Ableton if this song has programmed tempo changes.
        // NOTE: We deliberately do NOT auto-prepend a baseline {bar:1, bpm:metadata.tempo}
        // entry. ChordPro {tempo:} is the song's descriptive 'main feel' BPM, not its
        // start tempo — for songs with intros at a different tempo (e.g. 99 Red Balloons:
        // {tempo:194}, intro at 150), prepending would write the wrong value at bar 1.
        // If a user wants tempo control over bar 1, they should add an explicit '1:N'
        // entry to their {tempo_map}.
        if (parsed.metadata.tempo_map && parsed.metadata.tempo_map.length > 0) {
            udpBridge.sendCommand({ type: "command", action: "set_tempo_schedule", schedule: parsed.metadata.tempo_map });
            console.log("UDP: sent tempo schedule for " + match.filename + " — " + parsed.metadata.tempo_map.length + " change(s)");
        }

        // Update internal pointer to match (best-effort sync with setList)
        var setListIdx = setList.indexOf(match.filename);
        if (setListIdx >= 0) songPointer = setListIdx;

        // Phase 2b: Ableton is source of truth. Selection-only scene changes
        // (next/prev navigation) must NOT touch transport.state — the previous
        // song may still be actually playing in Ableton, and the lyrics client
        // relies on transport.state remaining 'playing' so it can enter preview
        // mode. Real transport changes arrive via separate M4L transport msgs.
        if (parsed.metadata.tempo) {
            transport.tempo = parsed.metadata.tempo;
        }

        var payload = { "command": 0, "song": parsed, "songRaw": songText, "filename": match.filename, "live": true };
        currentSongPayload = JSON.stringify(payload);
        for (var i = 0; i < remoteConnection.length; i++) {
            remoteConnection[i].sendUTF(currentSongPayload);
        }

        broadcastState();
        broadcastTransport();
        additions.resetAllReady();
        additions.broadcastReadyState(remoteConnection);
    } catch (e) {
        console.error("UDP scene load error:", e.message);
    }
}

// Start UDP bridge
udpBridge.start({
    onScene: function(data) {
        // data: { type:"scene", index, name, count }
        loadSongBySceneName(data.name, data.index, data.count);
    },
    onTracks: function(data) {
        // data: { type:"tracks", tracks: { "Original": true/false, "BT": true/false } }
        console.log("UDP: track mutes -", JSON.stringify(data.tracks));
        var payload = JSON.stringify(data);
        for (var i = 0; i < remoteConnection.length; i++) {
            remoteConnection[i].sendUTF(payload);
        }
        // Cache for late-joiners
        lastTrackPayload = payload;
    },
    onTransport: function(data) {
        // data: { type:"transport", state:"playing"|"stopped", tempo, time_sig }
        if (data.state === "playing" && transport.state !== "playing") {
            transport.playStartedAt = Date.now();
            transport.state = "playing";
            broadcastTransport();
        } else if (data.state === "stopped" && transport.state !== "stopped") {
            transport.state = "stopped";
            transport.elapsedAtPause = 0;
            transport.playStartedAt = null;
            broadcastTransport();
        }
        if (data.tempo && data.tempo !== transport.tempo) {
            transport.tempo = data.tempo;
            broadcastTransport();
        }
    },
    onPlayhead: function(data) {
        // data: { type:"playhead", bar, beat, bpb }
        // Forward to all WS clients for measure-accurate scroll
        var payload = { "type": "playhead", "bar": data.bar, "beat": data.beat };
        if (data.bpb) payload.bpb = data.bpb;
        var payloadStr = JSON.stringify(payload);
        lastPlayheadPayload = payloadStr;
        for (var i = 0; i < remoteConnection.length; i++) {
            remoteConnection[i].sendUTF(payloadStr);
        }
    },
    onScenes: function(data) {
        // data: { type:"scenes", scenes:["name1","name2",...] }
        console.log("UDP: received scene list (" + data.scenes.length + " scenes)");

        // Rebuild setList from Ableton scenes (replaces Dropbox-derived list)
        var newSetList = [];
        unmatchedScenes = [];
        var parkingLot = false;
        for (var i = 0; i < data.scenes.length; i++) {
            var name = data.scenes[i];
            // Detect parking lot divider (all hyphens, 6+ chars)
            if (name.replace(/-/g, "").trim() === "" && name.length >= 6) {
                parkingLot = true;
                continue;
            }
            if (parkingLot) continue; // skip parking lot songs

            // Detect named dividers
            if (name.indexOf("---") !== -1) {
                newSetList.push({ type: "divider", name: name, setNumber: newSetList.filter(function(x){return x.type==="divider";}).length + 1 });
                continue;
            }

            // Strip asterisk, slug-match to file
            var clean = name.replace(/^\*/, "").trim();
            var match = additions.matchSceneToSong(clean, availableSongs, null);
            if (match.filename) {
                newSetList.push(match.filename);
            } else {
                // No match — include scene name as-is (will show no lyrics)
                newSetList.push(name);
                unmatchedScenes.push(name);
            }
        }

        setList = newSetList;
        songPointer = -1;
        console.log("UDP: setList rebuilt from Ableton (" + newSetList.length + " items)");
        broadcastState();
    }

});

// Update handleCommand to relay commands to M4L (Phase 2b)
// ONLY relay to M4L — do NOT execute locally. Ableton is source of truth.
// Scene change will come back via UDP observer and trigger loadSongBySceneName.
additions.handleCommand = function(parsed, fns, playerName) {
    if (parsed.action) {
        var cmd = { type: "command", action: parsed.action }; if (parsed.index !== undefined) cmd.index = parsed.index; if (parsed.track) cmd.track = parsed.track; udpBridge.sendCommand(cmd);
        console.log("UDP: relayed " + parsed.action + " from " + (playerName || "unknown"));

        // Also update server transport state immediately (don't rely solely on M4L round-trip)
        if (parsed.action === 'play') {
            if (transport.state !== 'playing') {
                transport.playStartedAt = Date.now();
                transport.state = 'playing';
                broadcastTransport();
            }
        } else if (parsed.action === 'stop') {
            if (transport.state !== 'stopped') {
                transport.state = 'stopped';
                transport.elapsedAtPause = 0;
                transport.playStartedAt = null;
                broadcastTransport();
            }
        }
    }
};

console.log("UDP bridge integration active (Phase 2b) — udp-bridge v1.2");

// Request state refresh from M4L (handles "server starts after Ableton" case)
setTimeout(function() {
    udpBridge.sendCommand({ type: "command", action: "refresh" });
    console.log("UDP: requested state refresh from M4L");
}, 1000);
