#!/usr/bin/env bash
# Copyright 2025-2026 Marina Contributors
# SPDX-License-Identifier: Apache-2.0

# Bare-Gemini baseline on the 5 Marina Edge benchmarks.
# No orchestration, no council, no calculator — just one frontier model
# answering directly. This is the number we need to beat.

set -uo pipefail
cd "$(dirname "$0")/.."

TARGETS=(
  "simple-qa:50"
  "musr:50"
  "gsm8k:50"
  "math:50"
  "aime:30"
)
SEED=42
TALLY=benchmarks/results/baseline-gemini.tsv
LOG=/tmp/baseline-gemini.log

mkdir -p benchmarks/results
echo -e "benchmark\tlimit\taccuracy\tanswered\tduration_s\tresult_file" > "$TALLY"

idx=0
for target in "${TARGETS[@]}"; do
  b="${target%%:*}"
  lim="${target##*:}"
  echo "=== baseline [$idx] $b limit=$lim ===" | tee -a "$LOG"
  t_start=$(date +%s)
  HARNESS_TIMEOUT_MS=180000 bun run benchmarks/harness.ts \
    --benchmark "$b" \
    --limit "$lim" \
    --seed "$SEED" \
    --mode passthrough \
    --concurrency 3 \
    --model marina:gemini \
    --judge-model marina:gemini >> "$LOG" 2>&1
  t_end=$(date +%s)
  dur=$(( t_end - t_start ))
  rf=$(ls -t benchmarks/results/${b}-passthrough-*.json 2>/dev/null | head -1)
  if [[ -n "$rf" ]]; then
    acc=$(jq -r '.scores.overall // "null"' "$rf" 2>/dev/null)
    ans=$(jq -r '.metadata.answered // 0' "$rf" 2>/dev/null)
    pct=$(printf '%.1f' "$(echo "$acc * 100" | bc -l 2>/dev/null || echo 0)")
    echo -e "$b\t$lim\t$acc\t$ans\t$dur\t$rf" >> "$TALLY"
    echo "  -> $b acc=${pct}% ans=$ans dur=${dur}s" | tee -a "$LOG"
  else
    echo -e "$b\t$lim\tERR\t0\t$dur\t-" >> "$TALLY"
    echo "  -> $b FAILED" | tee -a "$LOG"
  fi
  idx=$(( idx + 1 ))
done

echo "=== Baseline scorecard ==="
cat "$TALLY" | column -t -s $'\t'
