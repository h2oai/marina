#!/usr/bin/env bash
# Launch an evolver agent.
#
# Usage:
#   ./scripts/evolver.sh                     # default: Evolver, no advisor
#   ./scripts/evolver.sh Electro              # custom name
#   ./scripts/evolver.sh Electro Scholar     # with advisor agent
#   ./scripts/evolver.sh Electro Scholar 30  # 30s cycles
#
# The evolver will:
#   1. Connect and bootstrap itself to builder rank
#   2. Create a mind-room at mind/<name>
#   3. Start an evolution loop: explore, reason, act, benchmark, journal
#
# Environment:
#   WS_URL       — Server URL (default: ws://localhost:3300)
#   MARINA_ADMINS — Comma-separated admin names (include evolver name for instant rank)

set -euo pipefail

NAME="${1:-Evolver}"
ADVISOR="${2:-}"
CYCLE="${3:-60}"

echo "Starting evolver: $NAME"
[ -n "$ADVISOR" ] && echo "  Advisor: $ADVISOR"
echo "  Cycle: ${CYCLE}s"
echo ""

AGENT_NAME="$NAME" ADVISOR="$ADVISOR" CYCLE_SECS="$CYCLE" \
  bun run src/sdk/examples/evolver.ts
