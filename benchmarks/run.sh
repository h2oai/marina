#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<EOF
Marina Benchmark Runner

Usage:
  ./benchmarks/run.sh                        Start the web UI (port 3303)
  ./benchmarks/run.sh ui [--port PORT]       Start the web UI
  ./benchmarks/run.sh bench [HARNESS_ARGS]   Run a benchmark via CLI
  ./benchmarks/run.sh list                   List available benchmarks
  ./benchmarks/run.sh results                Show past results
  ./benchmarks/run.sh smoke                  Quick smoke test (10 MMLU-Pro questions)

Examples:
  ./benchmarks/run.sh bench --benchmark mmlu-pro --limit 100
  ./benchmarks/run.sh bench --benchmark retention --mode memory --compare passthrough
  ./benchmarks/run.sh ui --port 8080
EOF
}

cd "$PROJECT_DIR"

CMD="${1:-ui}"
shift 2>/dev/null || true

case "$CMD" in
  ui)
    exec bun run benchmarks/server.ts "$@"
    ;;
  bench)
    exec bun run benchmarks/harness.ts "$@"
    ;;
  list)
    exec bun run benchmarks/harness.ts --list
    ;;
  results)
    exec bun run benchmarks/harness.ts --results
    ;;
  smoke)
    echo "  Running smoke test: MMLU-Pro, 10 questions, passthrough..."
    exec bun run benchmarks/harness.ts --benchmark mmlu-pro --limit 10 --mode passthrough "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $CMD"
    usage
    exit 1
    ;;
esac
