#!/usr/bin/env bash
# Copyright 2025-2026 Marina Contributors
# SPDX-License-Identifier: Apache-2.0

# Launch all 14 ThinProviders with correct upstream API wiring.
#
# Anthropic substrates (sonnet/haiku): PROVIDER_URL=api.anthropic.com
# Everything else: OpenRouter (PROVIDER_URL=openrouter.ai)
#
# Usage:
#   ./benchmarks/launch-providers.sh
#
# Loads ANTHROPIC_API_KEY + OPENROUTER_API_KEY from .env.

set -eo pipefail
cd "$(dirname "$0")/.."

# Load env
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ANTHROPIC_API_KEY not set (sonnet/haiku providers need it)" >&2
fi
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY not set (most substrates need it)" >&2
fi

pkill -f "sdk/examples/provider.ts" 2>/dev/null || true
sleep 2

start_anthropic() {
  local role=$1 model=$2
  local channel="model-$role"
  local name="${role^}Provider"
  case "$role" in
    glm) name="GlmProvider" ;;
    gpt) name="GptProvider" ;;
  esac
  AGENT_NAME=$name MODEL_CHANNEL=$channel \
    PROVIDER_URL=https://api.anthropic.com PROVIDER_KEY=${ANTHROPIC_API_KEY:-} \
    PROVIDER_MODEL=$model PROVIDER_FORMAT=anthropic \
    nohup bun run src/sdk/examples/provider.ts > "/tmp/provider-${role}.log" 2>&1 &
  echo "  $name -> anthropic:$model on $channel"
}

start_openrouter() {
  local role=$1 model=$2
  local channel="model-$role"
  local name="${role^}Provider"
  case "$role" in
    glm) name="GlmProvider" ;;
    gpt) name="GptProvider" ;;
  esac
  AGENT_NAME=$name MODEL_CHANNEL=$channel \
    PROVIDER_URL=https://openrouter.ai/api/v1 PROVIDER_KEY=${OPENROUTER_API_KEY:-} \
    PROVIDER_MODEL=$model PROVIDER_FORMAT=openai \
    nohup bun run src/sdk/examples/provider.ts > "/tmp/provider-${role}.log" 2>&1 &
  echo "  $name -> openrouter:$model on $channel"
}

echo "Launching 14 providers..."

# Anthropic (Claude 4.x current model IDs)
start_anthropic sonnet claude-sonnet-4-6
start_anthropic haiku  claude-haiku-4-5-20251001
sleep 1

# OpenRouter — flagship per vendor (verified IDs from openrouter.ai/api/v1/models)
start_openrouter gemini    google/gemini-2.5-pro
start_openrouter gpt       openai/gpt-5.4-pro
start_openrouter grok      x-ai/grok-4.20
start_openrouter minimax   minimax/minimax-m2.7
start_openrouter nemotron  nvidia/nemotron-3-super-120b-a12b
start_openrouter deepseek  deepseek/deepseek-v3.2
start_openrouter llama     meta-llama/llama-3.3-70b-instruct
start_openrouter glm       z-ai/glm-5.1
start_openrouter gemma     google/gemma-4-31b-it
start_openrouter kimi      moonshotai/kimi-k2.5
start_openrouter mistral   mistralai/mistral-small-2603
start_openrouter qwen      qwen/qwen3.5-35b-a3b

sleep 4
echo ""
echo "Running provider processes:"
ps -eo pid,cmd | grep "sdk/examples/provider" | grep -v grep | awk '{print "  " $0}'
