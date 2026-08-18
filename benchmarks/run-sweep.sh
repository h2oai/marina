#!/usr/bin/env bash
# Copyright 2025-2026 Marina Contributors
# SPDX-License-Identifier: Apache-2.0

# Multi-substrate / multi-benchmark sweep.
#
# Assumes launch-stack.sh has set up Marina + ThinProviders + Translator.
# This script swaps SmartProvider (or NSEDProvider) answerers between runs,
# and/or runs the harness across multiple benchmarks.
#
# Usage:
#   ./run-sweep.sh mmlu-pro 100 42           # single bench, N=100 seed=42
#   ./run-sweep.sh "mmlu-pro,ifeval" 50 42   # multiple benches
#
# Expects the current SmartProvider/NSEDProvider on channel=model to be the
# "answerer under test". Restart it externally between substrates.

set -euo pipefail
cd "$(dirname "$0")/.."

BENCHES=${1:-mmlu-pro}
LIMIT=${2:-100}
SEED=${3:-42}
CONCURRENCY=${CONCURRENCY:-1}
BUCKET_SIZE=${BUCKET_SIZE:-20}
# Override judge to always use Sonnet (strong judge regardless of answerer)
JUDGE_MODEL=${JUDGE_MODEL:-marina:sonnet}

IFS=',' read -ra BENCH_LIST <<< "$BENCHES"

mkdir -p benchmarks/results
SUMMARY=/tmp/sweep-summary-$(date +%s).log
echo "Sweep started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee "$SUMMARY"
echo "benches=${BENCHES} limit=${LIMIT} seed=${SEED} concurrency=${CONCURRENCY}" | tee -a "$SUMMARY"
echo | tee -a "$SUMMARY"

for bench in "${BENCH_LIST[@]}"; do
  bench=$(echo "$bench" | xargs)
  echo "=== $bench ===" | tee -a "$SUMMARY"
  LOG=/tmp/sweep-$bench.log
  BENCH_BUCKET_SIZE=$BUCKET_SIZE bun run benchmarks/harness.ts \
    --benchmark "$bench" \
    --limit "$LIMIT" \
    --seed "$SEED" \
    --mode passthrough \
    --concurrency "$CONCURRENCY" \
    --judge-model "$JUDGE_MODEL" > "$LOG" 2>&1 || true

  # Pull the summary lines out
  grep -E "(Overall Score|Answered|Errors|Timeouts|Duration|bucket_|Results saved)" "$LOG" | tee -a "$SUMMARY"
  echo | tee -a "$SUMMARY"
done

echo "Sweep done $(date -u +%Y-%m-%dT%H:%M:%SZ). Summary: $SUMMARY"
