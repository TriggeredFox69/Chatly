#!/bin/bash
# ======================================================
# Chatly 2.0 Startup Daemon for Linux / cPanel
# ======================================================
cd "$(dirname "$0")"

NODE_BIN="/opt/alt/alt-nodejs22/root/usr/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(which node 2>/dev/null || echo node)"
fi

echo "Starting Chatly 2.0 with $NODE_BIN..."
PORT=${PORT:-3000} exec "$NODE_BIN" server.js
