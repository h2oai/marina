#!/usr/bin/env bash
# Copyright 2025-2026 Marina Contributors
# SPDX-License-Identifier: Apache-2.0

# Coding Quickstart — a narrated tour of Marina's coding loop.
#
# Pipes a sequence of `code` commands to the `marina` CLI (scripts/connect.ts) so
# you can watch a full session scroll by: start -> orient -> checkpoint -> summary -> done.
# Read-mostly and fast; the only writes are session records + a checkpoint artifact.
#
# Usage:
#   ./examples/coding-quickstart/session.sh [entity-name]
#   MARINA_URL=ws://host:3300 ./examples/coding-quickstart/session.sh ada
#
# Prereq: Marina running (bun run start) — defaults to ws://localhost:3300.
set -euo pipefail

NAME="${1:-coder}"

# Resolve the repo root from this script's location so it runs from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "▶ Running the Marina coding quickstart as '${NAME}' against ${MARINA_URL:-ws://localhost:3300}"
echo

# Pipe mode: each line is sent as one command, in order.
bun run scripts/connect.ts "$NAME" <<'EOF'
code start Quickstart Tour
code doctor
code files
code read README.md
code search marina
code diff
code checkpoint tour-start
code summary Explored files, read the README, searched, diffed, and checkpointed.
code done Finished the quickstart tour.
EOF

echo
echo "✔ Done. Resume or inspect later with:  code list   |   code resume <session_id>   |   code history"
