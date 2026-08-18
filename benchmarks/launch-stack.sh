#!/usr/bin/env bash
# Copyright 2025-2026 Marina Contributors
# SPDX-License-Identifier: Apache-2.0

# Launch the self-referential benchmark stack.
#
# Usage:
#   ./launch-stack.sh                          # Sonnet answerer + Haiku translator/reflection
#   ./launch-stack.sh --answerer marina:haiku # all-cheap config
#   ./launch-stack.sh --extra qwen:qwen/qwen-2.5-72b-instruct  # add a Qwen substrate
#
# Starts: marina server, one ThinProvider per substrate, TranslatorAgent,
# SmartProvider. Leaves them running in the background. `pkill -f 'bun.*(main.ts|sdk/examples)'` to stop.

set -euo pipefail
cd "$(dirname "$0")/.."

ANSWERER=${ANSWERER:-marina:sonnet}
TRANSLATOR=${TRANSLATOR:-marina:haiku}
REFLECTOR=${REFLECTOR:-marina:haiku}
EXTRAS=()
CLEAN_DB=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --answerer)   ANSWERER=$2; shift 2 ;;
    --translator) TRANSLATOR=$2; shift 2 ;;
    --reflector)  REFLECTOR=$2; shift 2 ;;
    --extra)      EXTRAS+=("$2"); shift 2 ;;  # name:model-path
    --clean-db)   CLEAN_DB=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Load env
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

echo "[launch] killing any existing stack..."
pkill -f "bun.*main.ts" 2>/dev/null || true
pkill -f "bun.*sdk/examples" 2>/dev/null || true
pkill -f "bun.*benchmarks/harness" 2>/dev/null || true
sleep 3

if [[ $CLEAN_DB -eq 1 ]]; then
  echo "[launch] cleaning DB..."
  bun run clean >/dev/null
fi

echo "[launch] starting Marina server..."
MARINA_OPEN_API=true nohup bun run start > /tmp/marina-server.log 2>&1 &
sleep 6
if ! curl -fsS http://localhost:3300/v1/models >/dev/null 2>&1; then
  echo "[launch] server did not come up — see /tmp/marina-server.log" >&2
  exit 1
fi
echo "[launch] server ready"

start_anthropic_provider() {
  local role=$1 model=$2
  local channel="model-$role"
  local name="${role^}Provider"
  echo "[launch] $name -> $model on channel $channel"
  AGENT_NAME=$name MODEL_CHANNEL=$channel \
    PROVIDER_URL=https://api.anthropic.com PROVIDER_KEY=$ANTHROPIC_API_KEY \
    PROVIDER_MODEL=$model PROVIDER_FORMAT=anthropic \
    nohup bun run src/sdk/examples/provider.ts > /tmp/$role-provider.log 2>&1 &
}

start_openrouter_provider() {
  local role=$1 model=$2
  local channel="model-$role"
  local name="${role^}Provider"
  echo "[launch] $name -> $model on channel $channel (OpenRouter)"
  AGENT_NAME=$name MODEL_CHANNEL=$channel \
    PROVIDER_URL=https://openrouter.ai/api/v1 PROVIDER_KEY=$OPENROUTER_API_KEY \
    PROVIDER_MODEL=$model PROVIDER_FORMAT=openai \
    nohup bun run src/sdk/examples/provider.ts > /tmp/$role-provider.log 2>&1 &
}

# Built-in Anthropic substrates (always available when ANTHROPIC_API_KEY is set)
start_anthropic_provider sonnet  claude-sonnet-4-20250514
start_anthropic_provider haiku   claude-haiku-4-5-20251001
start_anthropic_provider opus    claude-opus-4-20250514

# User-supplied extras (name:model) via OpenRouter
for extra in "${EXTRAS[@]}"; do
  name=${extra%%:*}
  model=${extra#*:}
  start_openrouter_provider "$name" "$model"
done

sleep 3

echo "[launch] TranslatorAgent -> $TRANSLATOR"
MARINA_MODEL=$TRANSLATOR MEMORY_LEARN=false \
  nohup bun run src/sdk/examples/translator.ts > /tmp/translator.log 2>&1 &

echo "[launch] SmartProvider answerer=$ANSWERER reflector=$REFLECTOR"
PROVIDER_URL=http://localhost:3300/v1 PROVIDER_MODEL=$ANSWERER PROVIDER_FORMAT=openai \
  REFLECTION_PROVIDER_MODEL=$REFLECTOR \
  MEMORY_LEARN=true MEMORY_MODE=reflect USE_TRANSLATOR=true \
  nohup bun run src/sdk/examples/smart-provider.ts > /tmp/smart-provider.log 2>&1 &

sleep 4

echo "[launch] done. Processes:"
ps -eo pid,etime,cmd | grep -E "sdk/examples|main.ts" | grep -v grep
echo
echo "[launch] channel state:"
sqlite3 marina.db "SELECT c.name, COUNT(ch.entity_id) AS members FROM channels c LEFT JOIN channel_members ch ON ch.channel_id = c.id WHERE c.name IN ('model','translator') OR c.name LIKE 'model-%' GROUP BY c.name" 2>/dev/null || true
