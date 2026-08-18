#!/usr/bin/env bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0

# benchmarks/sweep.sh — systematic orchestrator × benchmark sweep.
#
# Reads a config file of lines like:
#   <orchestrator>|<benchmark>|<limit>|<seed>|<extra_env_csv>
# where orchestrator is one of:
#   passthrough  — no provider on model channel (fallback to proxyToUpstream)
#                  requires "model" column set to marina:sonnet / :haiku / etc.
#   smart        — smart-provider (memory + translator)
#   nsed-smart   — nsed-smart-provider (ensemble + memory + translator)
#   debate       — debate-provider
#   pipeline     — pipeline-provider
#   foundry      — foundry-provider
#   adaptive     — adaptive-provider (cheap→strong escalation)
#
# Between runs this script:
#   1. Kills the current orchestrator on model channel
#   2. Cleans stale channel memberships
#   3. Launches the new orchestrator with env overrides from extra_env_csv
#   4. Runs harness, captures summary, appends to SWEEP_LOG
#
# Assumes: Marina server + thin providers (sonnet/haiku/qwen/gemma/kimi) + translator
# are already running. Use launch-stack.sh to bring those up first.
#
# Usage:
#   ./benchmarks/sweep.sh benchmarks/sweep-configs/main.tsv

set -uo pipefail
cd "$(dirname "$0")/.."

CONFIG=${1:-benchmarks/sweep-configs/main.tsv}
SWEEP_LOG=/tmp/sweep-$(date +%Y%m%d-%H%M%S).log
CSV=${SWEEP_LOG%.log}.csv

echo "Sweep started $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee "$SWEEP_LOG"
echo "Config: $CONFIG" | tee -a "$SWEEP_LOG"
echo "Log:    $SWEEP_LOG" | tee -a "$SWEEP_LOG"
echo "CSV:    $CSV" | tee -a "$SWEEP_LOG"
echo | tee -a "$SWEEP_LOG"
echo "orchestrator,benchmark,model,limit,seed,overall,answered,errors,timeouts,duration_s,result_file" > "$CSV"

kill_orchestrators() {
  for name in smart-provider nsed-smart-provider nsed-provider debate-provider pipeline-provider foundry-provider adaptive-provider blackboard-provider world-coordinator-provider synthesis-provider; do
    pkill -f "sdk/examples/$name" 2>/dev/null || true
  done
  # Also kill task-workers — they're only needed for the `world` orchestrator
  pkill -f "sdk/examples/task-worker" 2>/dev/null || true
  sleep 3
  sqlite3 marina.db "DELETE FROM channel_members WHERE channel_id='ch:model'" 2>/dev/null || true
}

launch_orchestrator() {
  local orch=$1 extra=$2
  local ofile=""
  case "$orch" in
    passthrough) return 0 ;;  # no provider needed
    smart)       ofile=smart-provider.ts ;;
    nsed-smart)  ofile=nsed-smart-provider.ts ;;
    debate)      ofile=debate-provider.ts ;;
    pipeline)    ofile=pipeline-provider.ts ;;
    foundry)     ofile=foundry-provider.ts ;;
    adaptive)    ofile=adaptive-provider.ts ;;
    blackboard)  ofile=blackboard-provider.ts ;;
    world)       ofile=world-coordinator-provider.ts ;;
    synthesis)   ofile=synthesis-provider.ts ;;
    *)           echo "unknown orchestrator: $orch" >&2; return 1 ;;
  esac

  # Build env from extra: uses ";" between pairs, values may contain commas.
  # Each pair is K=V; exports them into the child process.
  local envs=()
  if [[ -n "$extra" ]]; then
    # shellcheck disable=SC2206
    IFS=';' read -ra envs <<< "$extra"
  fi
  # trim each entry
  local cleanenvs=()
  for kv in "${envs[@]}"; do
    kv=$(echo "$kv" | xargs)
    [[ -n "$kv" ]] && cleanenvs+=("$kv")
  done
  env "${cleanenvs[@]}" nohup bun run src/sdk/examples/$ofile > "/tmp/$orch.log" 2>&1 &
  sleep 5
  if ! pgrep -f "sdk/examples/$ofile" > /dev/null; then
    echo "[sweep] failed to start $orch — check /tmp/$orch.log" | tee -a "$SWEEP_LOG"
    return 1
  fi
  # For `world` orchestrator, also spawn task-workers. Number + substrates
  # configurable via WORLD_WORKERS and WORLD_WORKER_SUBSTRATES env in sweep row.
  if [[ "$orch" == "world" ]]; then
    local worker_count=${WORLD_WORKERS:-3}
    local worker_subs=${WORLD_WORKER_SUBSTRATES:-marina:haiku,marina:qwen,marina:gemma}
    IFS=',' read -ra subs_arr <<< "$worker_subs"
    for i in $(seq 1 "$worker_count"); do
      local idx=$(( (i - 1) % ${#subs_arr[@]} ))
      local sub=${subs_arr[$idx]}
      env "${cleanenvs[@]}" WORKER_NAME="Worker${i}" WORKER_SUBSTRATE="$sub" \
        nohup bun run src/sdk/examples/task-worker.ts > "/tmp/worker${i}.log" 2>&1 &
      sleep 1
    done
    echo "[sweep]   spawned $worker_count task-workers" | tee -a "$SWEEP_LOG"
  fi
  return 0
}

run_harness() {
  local orch=$1 bench=$2 limit=$3 seed=$4 model=$5
  local flags="--benchmark $bench --limit $limit --seed $seed --mode passthrough --concurrency 1 --judge-model marina:sonnet"
  # For passthrough we set --model; for orchestrators, we don't override (they answer on 'model' channel as 'marina')
  if [[ "$orch" == "passthrough" ]]; then
    flags="$flags --model $model"
  fi
  local bucket=20
  if [[ "$bench" == "ifeval" ]]; then bucket=10; fi

  local out=/tmp/sweep-$orch-$bench.log
  BENCH_BUCKET_SIZE=$bucket bun run benchmarks/harness.ts $flags > "$out" 2>&1
  # Parse summary from harness output
  local overall answered errors timeouts duration result
  overall=$(tr '\r' '\n' < "$out" | awk -F: '/Overall Score:/ {gsub("%",""); print $2; exit}' | xargs)
  answered=$(tr '\r' '\n' < "$out" | awk -F: '/Answered:/ {print $2; exit}' | xargs | awk -F/ '{print $1}')
  errors=$(tr '\r' '\n' < "$out" | awk -F: '/Errors:/ {print $2; exit}' | xargs)
  timeouts=$(tr '\r' '\n' < "$out" | awk -F: '/Timeouts:/ {print $2; exit}' | xargs)
  duration=$(tr '\r' '\n' < "$out" | awk -F: '/Duration:/ {gsub("s",""); print $2; exit}' | xargs)
  result=$(tr '\r' '\n' < "$out" | awk -F: '/Results saved:/ {print $2; exit}' | xargs)
  echo "$orch,$bench,$model,$limit,$seed,$overall,$answered,$errors,$timeouts,$duration,$result" >> "$CSV"
  printf "  %-12s %-12s %-20s score=%s answered=%s errors=%s duration=%ss\n" "$orch" "$bench" "$model" "$overall" "$answered" "$errors" "$duration" | tee -a "$SWEEP_LOG"
}

# Main loop
grep -v '^\s*#' "$CONFIG" | grep -v '^\s*$' | while IFS='|' read -r orch bench limit seed extra; do
  orch=$(echo "$orch" | xargs)
  bench=$(echo "$bench" | xargs)
  limit=$(echo "${limit:-100}" | xargs)
  seed=$(echo "${seed:-42}" | xargs)
  extra=$(echo "${extra:-}" | xargs)

  # model is pulled from extra (MODEL=…) for passthrough, else "marina"
  local_model=$(echo "$extra" | tr ';' '\n' | awk -F= '$1=="MODEL" {print $2; exit}' | xargs)
  [[ -z "$local_model" ]] && local_model=marina

  echo "" | tee -a "$SWEEP_LOG"
  echo "=== orch=$orch bench=$bench limit=$limit seed=$seed ===" | tee -a "$SWEEP_LOG"
  [[ -n "$extra" ]] && echo "    env: $extra" | tee -a "$SWEEP_LOG"

  kill_orchestrators
  if ! launch_orchestrator "$orch" "$extra"; then
    echo "  SKIP — orchestrator launch failed" | tee -a "$SWEEP_LOG"
    continue
  fi
  run_harness "$orch" "$bench" "$limit" "$seed" "$local_model"
done

echo | tee -a "$SWEEP_LOG"
echo "Sweep done $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$SWEEP_LOG"
echo "Summary CSV: $CSV" | tee -a "$SWEEP_LOG"
