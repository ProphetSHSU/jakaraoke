//const { Navigator } = require("node-navigator");
//const navigator = new Navigator();

//https://github.com/jazz-soft/JZZ - jzz is a node.js midi tool
var navigator = require('jzz');


//websocket code
const http = require('http');
const WebSocketServer = require('websocket').server;

const server = http.createServer();
server.listen(9898);

const wsServer = new WebSocketServer({
    httpServer: server
});

var remoteConnection = [];
wsServer.on('request', function(request) {
    const connection = request.accept(null, request.origin);
    remoteConnection.push(connection);

    connection.on('message', function(message) {
      console.log('Received Message:', message.utf8Data);
      connection.sendUTF('Successfully connected to server!');
    });
    connection.on('close', function(reasonCode, description) {
        console.log('Client has disconnected.');
    }); 
});





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
        case 194: // note off
            sendSong(note);
            console.log('Midi Switch - Command: ' + command + ' Note: ' + note + ' velocity: ' + velocity)
            break;
        // we could easily expand this switch statement to cover other types of commands such as controllers or sysex
    }
}

var songPointer = -1;
var setList = [
"Matchbox20_3am.txt",
"LostTrailers_AmericanBeauty.txt",
"IronWine_Time_After_Time.txt",
"JohnMellencamp_SmallTown.txt",
"PearlJam_ElderlyWoman.txt",
"TomWalker_BetterHalfofMe.txt",
"GarthBrooks_TheRiver.txt",
"BobSeger_Roll_Me_Away.txt",
"TheLumineers_Cleopatra.txt",
"ShawnJames_LikeAStone.txt",
"VanMorrison_BrownEyedGirl.txt",
"WhitneyHouston_IWannaDancewithSomebody.txt",
"PaoloNutini_TheseStreets.txt",
"CCR_SeenTheRain.txt",
"MarcCohn_WalkinginMemphis.txt",
"GeorgeEzra_Budapest.txt",
"AmyWinehouse_Valerie.txt",
"TheLumineers_Angela.txt",
"GarthBrooks_StandingOutsidetheFire.txt",
"JacksonBrowne_DoctorMyEyes.txt",
"PaulSimon_CallMeAl.txt",
"JoshRitter_Kathleen.txt"
]
var fs = require("fs");
function sendSong(note) {
    console.log('entering sendSong - note: ' + note)

    //if note is 2 descend, else ascend
    if(note == 2) {
        if(songPointer > 0) {
            songPointer = songPointer - 1;
        }
    } else {
        if(songPointer < setList.length-1) {
            songPointer = songPointer + 1;
        }
    }

    //console.log('songPointer: ' + songPointer)

    var songSelected = setList[songPointer]

    console.log('song = ' + songSelected)

    try{
        var songText = fs.readFileSync("./songs/" + songSelected).toString('utf-8');

        //console.log('songText = ' + songText)

        var payload = {
            "command": 0,
            "song": songText
        }

        var arrayLength = remoteConnection.length;
        console.log("array Length = " + arrayLength)
        for (var i = 0; i < arrayLength; i++) {
            remoteConnection[i].sendUTF(JSON.stringify(payload));
            console.log('songPointer: ' + songPointer)
        }

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