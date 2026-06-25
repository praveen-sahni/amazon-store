#!/bin/bash
# Amazon Store - Simple Launcher
# One command to install deps and start the server

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "============================================"
echo "  Amazon Store - Starting..."
echo "============================================"

# Setup virtual environment if needed
if [ ! -d "venv" ]; then
    echo "[1/3] Creating virtual environment..."
    python3 -m venv venv
fi

echo "[1/3] Installing dependencies..."
source venv/bin/activate
pip install -q -r requirements.txt

# Kill any existing process on port 8080
lsof -ti :8080 | xargs kill -9 2>/dev/null || true
sleep 1

echo "[2/3] Starting server..."
nohup gunicorn --bind 0.0.0.0:8080 --workers 2 --timeout 120 server:app > /tmp/amazon-server.log 2>&1 &
disown
sleep 2

# Verify
if curl -sf http://localhost:8080/api/health > /dev/null 2>&1; then
    echo "  OK - Server running at http://localhost:8080"
    echo "  Admin: http://localhost:8080/admin"
else
    echo "  ERROR: Server failed to start"
    cat /tmp/amazon-server.log
    exit 1
fi

# Try tunnel
echo "[3/3] Setting up public tunnel..."
TUNNEL_URL=""

if command -v autossh &>/dev/null; then
    nohup autossh -M 0 -o "ServerAliveInterval=30" -o "ServerAliveCountMax=3" \
        -o "ExitOnForwardFailure=yes" -o "StrictHostKeyChecking=no" \
        -o "UserKnownHostsFile=/dev/null" -R 80:localhost:8080 \
        nokey@localhost.run > /tmp/amazon-tunnel.log 2>&1 &
    disown
    for i in $(seq 1 15); do
        sleep 1
        TUNNEL_URL=$(grep -oE 'https://[a-z0-9]+\.lhr\.life' /tmp/amazon-tunnel.log 2>/dev/null | head -1)
        [ -n "$TUNNEL_URL" ] && break
    done
fi

if [ -z "$TUNNEL_URL" ] && command -v cloudflared &>/dev/null; then
    nohup cloudflared tunnel --url http://localhost:8080 > /tmp/amazon-tunnel.log 2>&1 &
    disown
    for i in $(seq 1 15); do
        sleep 1
        TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/amazon-tunnel.log 2>/dev/null | head -1)
        [ -n "$TUNNEL_URL" ] && break
    done
fi

echo ""
echo "============================================"
echo "  Local:  http://localhost:8080"
[ -n "$TUNNEL_URL" ] && echo "  Public: $TUNNEL_URL"
[ -n "$TUNNEL_URL" ] && echo "  Admin:  $TUNNEL_URL/admin"
echo "============================================"
echo ""
echo "  Press Ctrl+C to stop the server."
echo ""

# Wait - keep the tunnel alive
wait
