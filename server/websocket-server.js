//const { Navigator } = require("node-navigator");
//const navigator = new Navigator();

//https://github.com/jazz-soft/JZZ - jzz is a node.js midi tool
var navigator = require('jzz');

var fs = require("fs");
var path = require("path");
var chordpro = require("./chordpro-parser");


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
var songDurations = {};      // filename → durationSeconds (parsed from metadata)

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
        totalSetSeconds: totalSeconds
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
const WebSocketServer = require('websocket').server;

// HTTP server to serve static files (test harness, client app, etc.)
const httpServer = http.createServer(function(request, response) {
    var filePath = request.url;
    
    // Default route serves the client
    if (filePath === '/' || filePath === '') {
        filePath = '/client.html';
    }
    
    // Route requests to appropriate directories
    var fullPath;
    if (filePath.startsWith('/client') || filePath === '/client.html') {
        fullPath = path.join(__dirname, '..', 'client', path.basename(filePath));
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
            response.writeHead(200, { 'Content-Type': contentType });
            response.end(content, 'utf-8');
            console.log('Served: ' + filePath);
        }
    });
});

// Bind to all network interfaces (0.0.0.0) so other devices can connect
var port = config.port || 9898;
var host = '0.0.0.0';
httpServer.listen(port, host);

console.log('');
console.log('🎤 Jakeraoke Server Running');
console.log('=====================================');
console.log('HTTP Server: http://' + host + ':' + port);
console.log('WebSocket: ws://' + host + ':' + port);
console.log('');
console.log('Local access:');
console.log('  http://localhost:' + port + '/');
console.log('  http://localhost:' + port + '/test_harness.html');
console.log('');
console.log('Network access (use your MacBook\'s IP):');
console.log('  http://YOUR-MACBOOK-IP:' + port + '/');
console.log('');

const wsServer = new WebSocketServer({
    httpServer: httpServer
});

var remoteConnection = [];
wsServer.on('request', function(request) {
    const connection = request.accept(null, request.origin);
    remoteConnection.push(connection);

    // Send current state and transport to the newly connected client
    connection.sendUTF(JSON.stringify(getStatePayload()));
    connection.sendUTF(JSON.stringify(getTransportPayload()));

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

      } catch(e) {
        // Not JSON, treat as regular message
      }

      connection.sendUTF('Successfully connected to server!');
    });
    connection.on('close', function(reasonCode, description) {
        console.log('Client has disconnected.');
        // Remove from connection list
        var idx = remoteConnection.indexOf(connection);
        if (idx > -1) remoteConnection.splice(idx, 1);
    });
});


// ============================================================
// MIDI Setup
// ============================================================

//test to see if the browser supports webMIDI
if (navigator.requestMIDIAccess) {
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
        return;
    }

    // It's a song - load and send it
    var songPath = getSongPath(currentItem);

    console.log('song = ' + currentItem + ' (path: ' + songPath + ')')

    try{
        var songText = fs.readFileSync(songPath).toString('utf-8');
        var parsed = chordpro.parse(songText);

        // Reset transport on song change & update tempo from metadata
        if (transport.state !== 'stopped') {
            transport.state = 'stopped';
            transport.elapsedAtPause = 0;
            transport.playStartedAt = null;
        }
        if (parsed.metadata.tempo) {
            transport.tempo = parsed.metadata.tempo;
        }

        var payload = {
            "command": 0,
            "song": parsed,
            "songRaw": songText
        }

        var arrayLength = remoteConnection.length;
        console.log("array Length = " + arrayLength)
        for (var i = 0; i < arrayLength; i++) {
            remoteConnection[i].sendUTF(JSON.stringify(payload));
            console.log('songPointer: ' + songPointer)
        }

        // Also broadcast updated state and transport reset so clients know the current position
        broadcastState();
        broadcastTransport();

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
