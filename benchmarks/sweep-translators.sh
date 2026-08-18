#!/usr/bin/env bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0

# Full translator ablation sweep.
# 15 translators (14 + none) x 8 benchmarks x N=50, seed=42.
# Fixed: orchestrator=synthesis, council=haiku+qwen+kimi+gemma, escalator=gemini.
# Varies: TRANSLATOR_CHANNEL per cell.
#
# Progress is written to:
#   - /tmp/sweep-translators.log        (full driver output)
#   - benchmarks/results/translator-ablation.tsv (per-cell tally)
#   - Marina pool "sweep:translator-ablation" (note per cell)
#
# Usage: ./benchmarks/sweep-translators.sh [START_INDEX]
# START_INDEX lets you resume after a crash (default 0).
#
# Safe to interrupt with Ctrl-C — the next cell won't start until you rerun.

set -uo pipefail
cd "$(dirname "$0")/.."

TRANSLATORS=(none haiku sonnet gemini gpt grok minimax nemotron deepseek llama glm qwen gemma kimi mistral)
BENCHMARKS=(mmlu-pro truthfulqa ifeval arc-challenge bbh musr gsm8k simple-qa)
LIMIT=${LIMIT:-100}
SEED=${SEED:-42}
CONCURRENCY=${CONCURRENCY:-3}
JUDGE="marina:sonnet"
TALLY=benchmarks/results/translator-ablation.tsv
LOG=/tmp/sweep-translators.log
POOL=sweep:translator-ablation
START_INDEX=${1:-0}

mkdir -p benchmarks/results
if [[ ! -f "$TALLY" ]]; then
  echo -e "idx\ttranslator\tbenchmark\taccuracy\tanswered\tduration_s\tresult_file" > "$TALLY"
fi

post_note() {
  local text="$1"
  local imp="${2:-5}"
  bun run scripts/connect.ts sweep-monitor -c "pool $POOL add $text importance $imp" > /dev/null 2>&1 || true
}

restart_synthesis() {
  local translator="$1"
  pkill -f "sdk/examples/synthesis-provider.ts" 2>/dev/null || true
  sleep 3

  local channel=""
  if [[ "$translator" != "none" ]]; then
    channel="translator-$translator"
  fi

  # Use the standalone launch-synthesis.sh script — it handles environment
  # plumbing and is the path verified by our internal tests.
  TRANSLATOR_CHANNEL="$channel" \
    nohup bash benchmarks/launch-synthesis.sh > /tmp/synthesis-provider.log 2>&1 &
  sleep 5
}

TOTAL=$(( ${#TRANSLATORS[@]} * ${#BENCHMARKS[@]} ))
idx=0
for t in "${TRANSLATORS[@]}"; do
  restart_synthesis "$t"
  post_note "Cell set: translator=$t synthesis-provider restarted" 5

  for b in "${BENCHMARKS[@]}"; do
    if (( idx < START_INDEX )); then
      idx=$(( idx + 1 ))
      continue
    fi
    echo "=== [$idx/$TOTAL] translator=$t benchmark=$b ===" | tee -a "$LOG"
    t_start=$(date +%s)
    bun run benchmarks/harness.ts \
      --benchmark "$b" \
      --limit "$LIMIT" \
      --seed "$SEED" \
      --mode passthrough \
      --concurrency "$CONCURRENCY" \
      --judge-model "$JUDGE" >> "$LOG" 2>&1
    t_end=$(date +%s)
    dur=$(( t_end - t_start ))

    # Latest result file for this benchmark
    rf=$(ls -t benchmarks/results/${b}-passthrough-*.json 2>/dev/null | head -1)
    if [[ -n "$rf" ]]; then
      acc=$(jq -r '.scores.overall // "null"' "$rf")
      ans=$(jq -r '.metadata.answered // 0' "$rf")
      pct=$(printf '%.1f' "$(echo "$acc * 100" | bc -l 2>/dev/null || echo 0)")
      echo -e "$idx\t$t\t$b\t$acc\t$ans\t$dur\t$rf" >> "$TALLY"
      post_note "Cell $idx/$TOTAL t=$t b=$b acc=${pct}% ans=$ans dur=${dur}s" 6
      echo "  -> acc=$pct% ans=$ans dur=${dur}s" | tee -a "$LOG"
    else
      echo -e "$idx\t$t\t$b\tERR\t0\t$dur\t-" >> "$TALLY"
      post_note "Cell $idx/$TOTAL t=$t b=$b FAILED dur=${dur}s" 7
      echo "  -> FAILED no result file" | tee -a "$LOG"
    fi

    idx=$(( idx + 1 ))
  done
done

echo "=== Sweep complete. Tally: $TALLY ===" | tee -a "$LOG"
post_note "Translator ablation sweep COMPLETE. See tally at $TALLY" 9
