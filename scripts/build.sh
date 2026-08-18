#!/bin/bash
# Copyright 2025-2026 Marina Contributors
# SPDX-License-Identifier: Apache-2.0

# Marina Full Build Script
# Builds all parts of the Marina platform: server + dashboard
# Usage: ./scripts/build.sh [--skip-tests] [--skip-dashboard]
#
# Independent steps within each phase run in parallel, and each step's output
# is buffered — only printed if that step fails. A clean build is quiet; a
# broken one shows exactly the failing step's log.

# Note: intentionally NOT using `set -e`. We run steps as background jobs and
# aggregate their exit codes explicitly (see launch/collect), so a single
# failure must not abort the script before the summary prints.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR" || { echo "ERROR: cannot cd to $PROJECT_DIR"; exit 1; }

# Prefer user-local bun (system bun may have Date.now() overflow bug)
if [ -x "$HOME/.bun/bin/bun" ]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Verify Date.now() works (some bun builds overflow to INT32_MIN)
DATE_CHECK=$(bun -e "const d = Date.now(); process.exit(d > 0 ? 0 : 1)" 2>&1 && echo ok || echo broken)
if [ "$DATE_CHECK" = "broken" ]; then
  echo "ERROR: Your bun installation has a broken Date.now() (returns negative value)."
  echo "This is a known bug in some bun 1.3.x system packages."
  echo ""
  echo "Fix: install bun via the official installer:"
  echo "  curl -fsSL https://bun.sh/install | bash"
  echo ""
  echo "Then re-run this script."
  exit 1
fi

SKIP_TESTS=false
SKIP_DASHBOARD=false

for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=true ;;
    --skip-dashboard) SKIP_DASHBOARD=true ;;
    --help|-h)
      echo "Usage: ./scripts/build.sh [--skip-tests] [--skip-dashboard]"
      echo ""
      echo "Options:"
      echo "  --skip-tests      Skip test suite"
      echo "  --skip-dashboard  Skip dashboard frontend build"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      exit 1
      ;;
  esac
done

HAS_DASHBOARD=false
if [ "$SKIP_DASHBOARD" = false ] && [ -d "$PROJECT_DIR/dashboard" ]; then
  HAS_DASHBOARD=true
fi

PASS=0
FAIL=0

# Buffered, parallel step machinery ───────────────────────────────────────────
# Logs for in-flight jobs land here; only failing logs are ever printed.
LOGDIR="$(mktemp -d)"
trap 'rm -rf "$LOGDIR"' EXIT

# Parallel arrays tracking the jobs launched since the last collect().
# Initialized empty; accessed only via C-style loops guarded by ${#...[@]}
# so they stay safe under `set -u` on bash 3.2.
JOB_PIDS=()
JOB_LABELS=()
JOB_LOGS=()
JOB_COUNT=0

step() {
  echo ""
  echo "━━━ $1 ━━━"
}

pass() {
  echo "  ✓ $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  ✗ $1"
  FAIL=$((FAIL + 1))
}

# launch "<label>" <function-name> [args...]
# Runs the function in the background, redirecting its output to a per-job log.
launch() {
  local label=$1
  shift
  JOB_COUNT=$((JOB_COUNT + 1))
  local log="$LOGDIR/job_${JOB_COUNT}.log"
  ( "$@" ) >"$log" 2>&1 &
  JOB_PIDS+=("$!")
  JOB_LABELS+=("$label")
  JOB_LOGS+=("$log")
}

# collect — wait on every launched job, report pass/fail, dump only failing logs,
# then reset the job arrays for the next phase.
collect() {
  local n=${#JOB_PIDS[@]}
  local i
  for ((i = 0; i < n; i++)); do
    if wait "${JOB_PIDS[$i]}"; then
      pass "${JOB_LABELS[$i]}"
    else
      fail "${JOB_LABELS[$i]}"
      echo ""
      echo "  ── output: ${JOB_LABELS[$i]} ──────────────────────────────"
      cat "${JOB_LOGS[$i]}"
      echo "  ───────────────────────────────────────────────────────────"
    fi
  done
  JOB_PIDS=()
  JOB_LABELS=()
  JOB_LOGS=()
}

# Step bodies (each is a single command/subshell so it can run as a job) ───────
install_server()      { bun install --frozen-lockfile; }
install_dashboard()   { (cd dashboard && bun install --frozen-lockfile); }
lint_all()            { bun run lint; }
typecheck_server()    { bun run typecheck; }
# bunx resolves the dashboard's local tsc without re-hitting the npm resolver
# the way `npx` does.
typecheck_dashboard() { (cd dashboard && bunx tsc --noEmit); }
test_server()         { bun run test; }
test_dashboard()      { (cd dashboard && bun run test); }
# `bun build`/`vite build` are emit-only — neither type-checks. The tsc passes
# above are the sole type gate; don't add a second type pass here.
build_server()        { bun run build; }
build_dashboard()     { bun run dashboard:build; }

# ── 1. Install dependencies (parallel) ────────────────────────────────────────

step "Installing dependencies"
launch "Server dependencies" install_server
if [ "$HAS_DASHBOARD" = true ]; then
  launch "Dashboard dependencies" install_dashboard
fi
collect

# ── 2. Verify: lint + typecheck (parallel) ────────────────────────────────────

step "Verifying (lint + typecheck)"
launch "Lint" lint_all
launch "Server typecheck" typecheck_server
if [ "$HAS_DASHBOARD" = true ]; then
  launch "Dashboard typecheck" typecheck_dashboard
fi
collect

# ── 3. Tests (parallel) ───────────────────────────────────────────────────────

if [ "$SKIP_TESTS" = false ]; then
  step "Running tests"
  launch "Server tests" test_server
  if [ "$HAS_DASHBOARD" = true ]; then
    launch "Dashboard tests" test_dashboard
  fi
  collect
else
  echo ""
  echo "━━━ Tests (skipped) ━━━"
fi

# ── 4. Build bundles (parallel) ───────────────────────────────────────────────

step "Building bundles"
launch "Server build → dist/" build_server
if [ "$HAS_DASHBOARD" = true ]; then
  launch "Dashboard build → dist/dashboard/" build_dashboard
fi
collect

if [ "$SKIP_DASHBOARD" = true ] || [ ! -d "$PROJECT_DIR/dashboard" ]; then
  echo ""
  echo "━━━ Dashboard steps (skipped) ━━━"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════"
echo "  Build complete: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
