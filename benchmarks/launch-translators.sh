#!/usr/bin/env bash
# Launch a translator agent for every substrate on a dedicated channel.
# Each orchestrator picks which translator to consult via TRANSLATOR_CHANNEL.
#
# No defaults. Every translator gets its own substrate explicitly. The user
# (or the meta-agent) chooses which one any given benchmark run consults.
#
# Channels created (one per substrate):
#   translator-haiku     — MARINA_MODEL=marina:haiku
#   translator-gemini    — MARINA_MODEL=marina:gemini
#   translator-qwen      — MARINA_MODEL=marina:qwen
#   translator-nemotron  — MARINA_MODEL=marina:nemotron
#   translator-sonnet    — MARINA_MODEL=marina:sonnet
#   translator-deepseek  — MARINA_MODEL=marina:deepseek
#   translator-llama     — MARINA_MODEL=marina:llama
#   translator-glm       — MARINA_MODEL=marina:glm
#   translator-gemma     — MARINA_MODEL=marina:gemma
#   translator-kimi      — MARINA_MODEL=marina:kimi
#   translator-mistral   — MARINA_MODEL=marina:mistral
#   translator-gpt       — MARINA_MODEL=marina:gpt
#   translator-grok      — MARINA_MODEL=marina:grok
#   translator-minimax   — MARINA_MODEL=marina:minimax
#
# Pick which subset to launch via TRANSLATOR_MODELS env (comma-separated):
#   TRANSLATOR_MODELS=haiku,gemini,nemotron ./benchmarks/launch-translators.sh
# (default: all 14)
#
# Usage:
#   ./benchmarks/launch-translators.sh
#
# Then:
#   TRANSLATOR_CHANNEL=translator-gemini bun run src/sdk/examples/nsed-smart-provider.ts

set -eo pipefail
cd "$(dirname "$0")/.."

pkill -f "sdk/examples/translator.ts" 2>/dev/null || true
sleep 2

MODELS=${TRANSLATOR_MODELS:-haiku,gemini,qwen,nemotron,sonnet,deepseek,llama,glm,gemma,kimi,mistral,gpt,grok,minimax}

launch() {
  local model=$1
  local channel="translator-$model"
  local name="Translator-$model"
  nohup env \
    AGENT_NAME="$name" \
    MARINA_MODEL="marina:$model" \
    TRANSLATOR_CHANNEL="$channel" \
    MEMORY_LEARN=false \
    bun run src/sdk/examples/translator.ts > "/tmp/translator-${model}.log" 2>&1 &
  echo "  $name -> marina:$model on $channel (pid $!)"
  sleep 1
}

echo "Launching translator variants..."
IFS=',' read -ra arr <<< "$MODELS"
for m in "${arr[@]}"; do
  m=$(echo "$m" | xargs)
  [[ -n "$m" ]] && launch "$m"
done

sleep 4
echo ""
echo "Running translator processes:"
ps -eo pid,cmd | grep "sdk/examples/translator" | grep -v grep | awk '{print "  " $0}'
