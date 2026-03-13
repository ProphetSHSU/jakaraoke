#!/bin/bash
# Jakeraoke - Start everything
# Usage: ./start.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.server.pid"

# Check if already running
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "⚠️  Server is already running (PID $(cat "$PID_FILE")). Run ./stop.sh first."
    exit 1
fi

# Start the server in the background
echo "🚀 Starting Jakeraoke server..."
cd "$SCRIPT_DIR/server"
node websocket-server.js &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Give the server a moment to bind the port
sleep 1

# Verify it started
if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✅ Server running on ws://localhost:9898 (PID $SERVER_PID)"
else
    echo "❌ Server failed to start"
    rm -f "$PID_FILE"
    exit 1
fi

# Open the clients in the browser
echo "🎤 Opening display client..."
open "$SCRIPT_DIR/client/client.html"

echo "🎛️  Opening test harness..."
open "$SCRIPT_DIR/public_site/test_harness.html"

echo ""
echo "Ready! To stop: ./stop.sh"
