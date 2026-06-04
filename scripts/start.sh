#!/bin/bash
# Marina Server Start Script
# Usage: ./scripts/start.sh [--background]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if it exists
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

# Defaults (can be overridden via .env or environment)
export WS_PORT="${WS_PORT:-3300}"
export TELNET_PORT="${TELNET_PORT:-4000}"
export MCP_PORT="${MCP_PORT:-3301}"
export TICK_MS="${TICK_MS:-1000}"
export START_ROOM="${START_ROOM:-}"
export DB_PATH="${DB_PATH:-marina.db}"
export ASSETS_DIR="${ASSETS_DIR:-data/assets}"

echo "Marina Server"
echo "───────────────────────────────────"
echo "  WebSocket:  ws://localhost:${WS_PORT}/ws"
echo "  Web Chat:   http://localhost:${WS_PORT}/"
echo "  Telnet:     localhost:${TELNET_PORT}"
echo "  MCP:        http://localhost:${MCP_PORT}/mcp"
echo "  Dashboard:  http://localhost:${WS_PORT}/dashboard"
echo "  Canvas:     http://localhost:${WS_PORT}/canvas"
echo "  Database:   ${DB_PATH}"
echo "  Assets:     ${ASSETS_DIR}"
echo "───────────────────────────────────"

cd "$PROJECT_DIR"

if [ "${1:-}" = "--background" ] || [ "${1:-}" = "-d" ]; then
  LOG_FILE="${PROJECT_DIR}/marina.log"
  bun run src/main.ts >> "$LOG_FILE" 2>&1 &
  PID=$!
  echo "$PID" > "$PROJECT_DIR/marina.pid"
  echo "Started in background (PID: $PID)"
  echo "Log: $LOG_FILE"
  echo "Stop with: kill \$(cat marina.pid)"
else
  exec bun run src/main.ts
fi
