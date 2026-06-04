#!/bin/bash
# Marina Clean Script
# Removes database and other persistent data for a fresh start.
# Usage: ./scripts/clean.sh [--yes]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Load DB_PATH from .env or default
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi
DB_PATH="${DB_PATH:-marina.db}"

# Check if server is running
if [ -f "$PROJECT_DIR/marina.pid" ]; then
  PID=$(cat "$PROJECT_DIR/marina.pid")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Error: Server is running (PID $PID). Stop it first."
    exit 1
  fi
fi

# Asset storage directory
ASSETS_DIR="${ASSETS_DIR:-data/assets}"

# Collect what will be removed
FILES=()
DIRS=()
for f in "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm" "${DB_PATH}-journal"; do
  [ -f "$f" ] && FILES+=("$f")
done
[ -f "marina.log" ] && FILES+=("marina.log")
[ -f "marina.pid" ] && FILES+=("marina.pid")
[ -d "$ASSETS_DIR" ] && DIRS+=("$ASSETS_DIR")

if [ ${#FILES[@]} -eq 0 ] && [ ${#DIRS[@]} -eq 0 ]; then
  echo "Nothing to clean."
  exit 0
fi

echo "Will remove:"
for f in "${FILES[@]}"; do
  echo "  $f"
done
for d in "${DIRS[@]}"; do
  echo "  $d/ (uploaded assets)"
done

if [ "${1:-}" != "--yes" ] && [ "${1:-}" != "-y" ]; then
  printf "Proceed? [y/N] "
  read -r REPLY
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

for f in "${FILES[@]}"; do
  rm -f "$f"
done
for d in "${DIRS[@]}"; do
  rm -rf "$d"
done

echo "Clean complete. Next start will create a fresh database."
