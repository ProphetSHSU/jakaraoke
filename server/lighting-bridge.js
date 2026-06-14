// lighting-bridge.js — Stateless MIDI bridge to QLC+ lighting
// Writes directly to "QLC Effects" IAC bus. No state tracking needed
// because QLC+ SoloFrames handle mutual exclusion natively.
//
// Protocol: navigator sends semantic commands via WS, server maps to MIDI notes.

var jzz = require('jzz');

var MIDI_PORT_NAME = 'QLC Controller QLC Effects';
var VELOCITY = 100;

var PALETTES = ['Fire','Ocean','Neon','Jungle','Twilight','Sunset','Arctic',
                'Toxic','Gold','Smoke','Spring','Blood','Vapor','Storm'];

var DIM_NOTES = { 25: 116, 50: 117, 75: 118, 100: 119 };

var midiOut = null;
var ready = false;

function init() {
    jzz().openMidiOut(MIDI_PORT_NAME).and(function() {
        midiOut = this;
        ready = true;
        console.log('[lighting-bridge] MIDI output opened: ' + MIDI_PORT_NAME);
    }).or(function() {
        console.warn('[lighting-bridge] Could not open MIDI port "' + MIDI_PORT_NAME + '"');
        console.warn('[lighting-bridge] Lighting commands will be ignored (no QLC+ connection)');
    });
}

function sendNote(note) {
    if (!midiOut) return;
    midiOut.noteOn(0, note, VELOCITY);
    setTimeout(function() {
        midiOut.noteOff(0, note);
    }, 5);
}

function blackout() {
    if (!midiOut) { console.warn('[lighting-bridge] blackout: no MIDI port'); return; }
    console.log('[lighting-bridge] BLACKOUT');
    sendNote(79);   // amb off (SoloFrame releases active chaser)
    setTimeout(function() { sendNote(0); }, 10);   // system blackout
    setTimeout(function() { sendNote(1); }, 20);   // derby off
    setTimeout(function() { sendNote(4); }, 30);   // laser off
    setTimeout(function() { sendNote(9); }, 40);   // strobe off
}

function launchAmbient(paletteName) {
    var idx = PALETTES.indexOf(paletteName);
    if (idx < 0) {
        console.warn('[lighting-bridge] unknown palette: ' + paletteName);
        return;
    }
    if (!midiOut) { console.warn('[lighting-bridge] ambient: no MIDI port'); return; }
    console.log('[lighting-bridge] GO: ' + paletteName + ' (note ' + (80 + idx) + ')');
    sendNote(79);                                       // stop any running chaser
    setTimeout(function() { sendNote(118); }, 50);      // dim 75%
    setTimeout(function() { sendNote(80 + idx); }, 100); // start chaser
}

function ambientOff() {
    if (!midiOut) return;
    console.log('[lighting-bridge] ambient OFF');
    sendNote(79);
}

function setDim(level) {
    var note = DIM_NOTES[level];
    if (!note) { console.warn('[lighting-bridge] invalid dim level: ' + level); return; }
    if (!midiOut) return;
    console.log('[lighting-bridge] dim ' + level + '% (note ' + note + ')');
    sendNote(note);
}

function handleMessage(parsed) {
    if (parsed.type !== 'lighting') return false;
    switch (parsed.action) {
        case 'blackout':    blackout(); break;
        case 'ambient':     launchAmbient(parsed.palette); break;
        case 'ambientOff':  ambientOff(); break;
        case 'dim':         setDim(parsed.level); break;
        default:
            console.warn('[lighting-bridge] unknown action: ' + parsed.action);
            return false;
    }
    return true;
}

function isReady() { return ready; }
function getPalettes() { return PALETTES.slice(); }

module.exports = {
    init: init,
    handleMessage: handleMessage,
    isReady: isReady,
    getPalettes: getPalettes,
    blackout: blackout,
    launchAmbient: launchAmbient,
    ambientOff: ambientOff,
    setDim: setDim
};
