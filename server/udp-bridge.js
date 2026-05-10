// ===========================================================================
// udp-bridge.js — UDP listener (port 9899) + sender (port 9900)
// ===========================================================================
// Bridges Ableton M4L ↔ jakaraoke server.
// Require from websocket-server.js after server-additions.js.
//
// Usage:
//   var udpBridge = require('./udp-bridge');
//   udpBridge.start({
//     onScene: function(data) { ... },
//     onTransport: function(data) { ... },
//     onPlayhead: function(data) { ... },
//     onScenes: function(data) { ... }
//   });
//   udpBridge.sendCommand({ action: 'play' });
// ===========================================================================

var dgram = require('dgram');

var LISTEN_PORT = 9899;   // M4L → server (state broadcast)
var SEND_PORT = 9900;     // server → M4L (commands)
var HOST = '127.0.0.1';

var udpServer = null;
var udpClient = null;
var handlers = {};

function start(opts) {
  handlers = opts || {};

  // --- Listener (receives state from M4L) ---
  udpServer = dgram.createSocket('udp4');

  udpServer.on('message', function(msg) {
    try {
      var str = msg.toString(); str = str.substring(0, str.lastIndexOf("}") + 1); var data = JSON.parse(str);

      switch (data.type) {
        case 'scene':
          if (handlers.onScene) handlers.onScene(data);
          break;
        case 'transport':
          if (handlers.onTransport) handlers.onTransport(data);
          break;
        case 'playhead':
          if (handlers.onPlayhead) handlers.onPlayhead(data);
          break;
        case 'scenes':
          if (handlers.onScenes) handlers.onScenes(data);
          break;
        case 'tracks':
          if (handlers.onTracks) handlers.onTracks(data);
          break;
        default:
          console.log('UDP: unknown message type: ' + data.type);
      }
    } catch(e) {
      console.error('UDP parse error:', e.message, '| raw:', msg.toString().substring(0, 100));
    }
  });

  udpServer.on('error', function(err) {
    console.error('UDP server error:', err.message);
  });

  udpServer.bind(LISTEN_PORT, HOST, function() {
    console.log('UDP bridge v1.2 listening on ' + HOST + ':' + LISTEN_PORT + ' (Ableton → server)');
  });

  // --- Sender (sends commands to M4L) ---
  udpClient = dgram.createSocket('udp4');
  console.log('UDP bridge ready to send on ' + HOST + ':' + SEND_PORT + ' (server → Ableton)');
}

/**
 * Send a command to the M4L device.
 * @param {object} command - e.g., { type: 'command', action: 'play' }
 */
// Format as OSC message so Max's [udpreceive] accepts it
function oscString(str) {
  var buf = Buffer.from(str + '\0');
  var pad = 4 - (buf.length % 4);
  if (pad < 4) buf = Buffer.concat([buf, Buffer.alloc(pad)]);
  return buf;
}

function sendCommand(command) {
  if (!udpClient) {
    console.error('UDP bridge not started — cannot send command');
    return;
  }
  var json = JSON.stringify(command);
  // OSC message: address '/j', type tag ',s', string argument = json
  var addr = oscString('/j');
  var typeTag = oscString(',s');
  var arg = oscString(json);
  var msg = Buffer.concat([addr, typeTag, arg]);
  udpClient.send(msg, 0, msg.length, SEND_PORT, HOST, function(err) {
    if (err) console.error('UDP send error:', err.message);
  });
}

function stop() {
  if (udpServer) { udpServer.close(); udpServer = null; }
  if (udpClient) { udpClient.close(); udpClient = null; }
}

module.exports = {
  start: start,
  sendCommand: sendCommand,
  stop: stop,
  LISTEN_PORT: LISTEN_PORT,
  SEND_PORT: SEND_PORT
};
