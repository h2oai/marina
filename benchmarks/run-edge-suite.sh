#!/usr/bin/env bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0

# Marina Edge suite — "can we be number 1 at something" attempt.
# Frontier council + calculator + web + decomposition + pool learning.
# Target benchmarks are where orchestration, tools, and memory give
# structural edge over bare LLMs.

set -uo pipefail
cd "$(dirname "$0")/.."

# Targets: benchmark | limit | notes
# (limits chosen to produce meaningful signal in a reasonable runtime)
TARGETS=(
  "simple-qa:100"    # web + pool factual retrieval — baseline LLM ~50%
  "musr:100"         # decomposition pattern — baseline ~75%
  "gsm8k:100"        # calculator — baseline ~95% (headroom small but verify)
  "math:100"         # calculator + reasoning — baseline ~80%
  "truthfulqa:100"   # truthfulness — baseline 95%+ but cheap
  "frames:100"       # multi-hop factual — baseline ~55%
  "aime:30"          # olympiad math, only 30 items exist — baseline ~40%
  "mmlu-pro:100"     # MC reasoning — reference against sweep baseline
)
SEED=42
CONCURRENCY=3
JUDGE="marina:sonnet"
TALLY=benchmarks/results/edge-suite.tsv
LOG=/tmp/edge-suite.log

mkdir -p benchmarks/results
echo -e "idx\tbenchmark\tlimit\taccuracy\tanswered\tduration_s\tresult_file" > "$TALLY"

post_note() {
  local text="$1"
  bun run scripts/connect.ts sweep-monitor -c "pool sweep:edge-attempt-1 add $text importance 7" > /dev/null 2>&1 || true
}

bun run scripts/connect.ts sweep-monitor -c "pool create sweep:edge-attempt-1" > /dev/null 2>&1 || true
post_note "Edge suite started $(date -Iseconds). 8 benchmarks, frontier council + calculator + web."

idx=0
TOTAL=${#TARGETS[@]}
for target in "${TARGETS[@]}"; do
  b="${target%%:*}"
  lim="${target##*:}"
  echo "=== [$idx/$TOTAL] benchmark=$b limit=$lim ===" | tee -a "$LOG"
  t_start=$(date +%s)

  bun run benchmarks/harness.ts \
    --benchmark "$b" \
    --limit "$lim" \
    --seed "$SEED" \
    --mode passthrough \
    --concurrency "$CONCURRENCY" \
    --model marina:edge \
    --judge-model "$JUDGE" >> "$LOG" 2>&1
  t_end=$(date +%s)
  dur=$(( t_end - t_start ))

  rf=$(ls -t benchmarks/results/${b}-passthrough-*.json 2>/dev/null | head -1)
  if [[ -n "$rf" ]]; then
    acc=$(jq -r '.scores.overall // "null"' "$rf" 2>/dev/null)
    ans=$(jq -r '.metadata.answered // 0' "$rf" 2>/dev/null)
    pct=$(printf '%.1f' "$(echo "$acc * 100" | bc -l 2>/dev/null || echo 0)")
    echo -e "$idx\t$b\t$lim\t$acc\t$ans\t$dur\t$rf" >> "$TALLY"
    post_note "Edge $idx/$TOTAL: $b acc=${pct}% ans=$ans dur=${dur}s"
    echo "  -> $b acc=${pct}% ans=$ans dur=${dur}s" | tee -a "$LOG"
  else
    echo -e "$idx\t$b\t$lim\tERR\t0\t$dur\t-" >> "$TALLY"
    post_note "Edge $idx/$TOTAL: $b FAILED dur=${dur}s"
    echo "  -> $b FAILED" | tee -a "$LOG"
  fi
  idx=$(( idx + 1 ))
done

echo "=== Edge suite complete ===" | tee -a "$LOG"
post_note "Edge suite COMPLETE. Tally: $TALLY"

# Pretty-print the final table
echo ""
echo "Final Edge suite scorecard:"
cat "$TALLY" | column -t -s $'\t'
