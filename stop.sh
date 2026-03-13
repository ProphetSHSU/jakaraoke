#!/bin/bash
# Jakeraoke - Stop the server
# Usage: ./stop.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.server.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "⚠️  No server PID file found. Nothing to stop."
    exit 0
fi

SERVER_PID=$(cat "$PID_FILE")

if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID"
    echo "✅ Server stopped (PID $SERVER_PID)"
else
    echo "ℹ️  Server was not running (stale PID $SERVER_PID)"
fi

rm -f "$PID_FILE"
