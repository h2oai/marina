#!/usr/bin/env bash
# Copyright 2025-2026 Marina Contributors
# SPDX-License-Identifier: Apache-2.0

# Launch the "Marina Edge" synthesis-provider — maximum-fidelity config
# aimed at benchmarks where an orchestrated system can beat a bare LLM:
#   - Frontier council: sonnet + gemini + gpt + grok + minimax
#   - Escalator: gemini (current solo leader on MMLU-Pro at 90)
#   - Translator: sonnet (best structured output for analyze protocol)
#   - Calculator: enabled (python3 subprocess for math benchmarks)
#   - Web: enabled (kills SimpleQA hallucination)
#   - Pools: all domain + benchmark-specific (learning loop)
#   - Threshold: 0.6 (frontier disagreement is informative — escalate more)
#
# Listens on MODEL_CHANNEL=model-edge so benchmarks route via
# `--model marina:edge` without colliding with the default model channel.

set -euo pipefail
cd "$(dirname "$0")/.."

pkill -f "AGENT_NAME=EdgeProvider" 2>/dev/null || true
pkill -f "model-edge" 2>/dev/null || true
sleep 2

exec env \
  AGENT_NAME="EdgeProvider" \
  MODEL_CHANNEL="model-edge" \
  SYNTH_COUNCIL="marina:sonnet,marina:gemini,marina:gpt,marina:grok,marina:minimax" \
  SYNTH_STRONG="marina:gemini" \
  SYNTH_ESCALATE_T=0.6 \
  SYNTH_CALCULATOR=true \
  SYNTH_USE_WEB=true \
  TRANSLATOR_CHANNEL="translator-sonnet" \
  SYNTH_TRACE=true \
  bun run src/sdk/examples/synthesis-provider.ts
