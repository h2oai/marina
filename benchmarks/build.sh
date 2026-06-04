#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "  Marina Benchmark — Build"
echo "  ────────────────────────────────────────"

# Check bun
if ! command -v bun &>/dev/null; then
  echo "  ERROR: bun is not installed. Install from https://bun.sh"
  exit 1
fi

echo "  Bun: $(bun --version)"

# Install dependencies
echo "  Installing dependencies..."
cd "$PROJECT_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install

# Typecheck
echo "  Running typecheck..."
bun run typecheck

# Lint
echo "  Running lint..."
bunx biome check benchmarks/

# Verify harness loads
echo "  Verifying harness..."
bun run benchmarks/harness.ts --list >/dev/null

# Check for Python (optional, for HumanEval)
if command -v python3 &>/dev/null; then
  echo "  Python: $(python3 --version 2>&1) (HumanEval available)"
else
  echo "  Python: not found (HumanEval will be unavailable)"
fi

echo ""
echo "  Build complete."
echo "  Run ./benchmarks/run.sh to start."
