#!/bin/bash
# Marina Full Build Script
# Builds all parts of the Marina platform: server + dashboard
# Usage: ./scripts/build.sh [--skip-tests] [--skip-dashboard]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

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

PASS=0
FAIL=0

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

# ── 1. Install dependencies ─────────────────────────────────────────────────

step "Installing server dependencies"
if bun install --frozen-lockfile 2>&1; then
  pass "Server dependencies"
else
  fail "Server dependencies"
fi

if [ "$SKIP_DASHBOARD" = false ] && [ -d "$PROJECT_DIR/dashboard" ]; then
  step "Installing dashboard dependencies"
  if (cd dashboard && bun install --frozen-lockfile 2>&1); then
    pass "Dashboard dependencies"
  else
    fail "Dashboard dependencies"
  fi
fi

# ── 2. Lint ──────────────────────────────────────────────────────────────────

step "Linting (biome)"
if bun run lint 2>&1; then
  pass "Lint"
else
  fail "Lint"
fi

# ── 3. Type check ───────────────────────────────────────────────────────────

step "Type checking server"
if bun run typecheck 2>&1; then
  pass "Server typecheck"
else
  fail "Server typecheck"
fi

if [ "$SKIP_DASHBOARD" = false ] && [ -d "$PROJECT_DIR/dashboard" ]; then
  step "Type checking dashboard"
  if (cd dashboard && npx tsc --noEmit 2>&1); then
    pass "Dashboard typecheck"
  else
    fail "Dashboard typecheck"
  fi
fi

# ── 4. Tests ─────────────────────────────────────────────────────────────────

if [ "$SKIP_TESTS" = false ]; then
  step "Running server tests"
  if bun run test 2>&1; then
    pass "Server tests"
  else
    fail "Server tests"
  fi

  if [ "$SKIP_DASHBOARD" = false ] && [ -d "$PROJECT_DIR/dashboard" ]; then
    step "Running dashboard tests"
    if (cd dashboard && bun run test 2>&1); then
      pass "Dashboard tests"
    else
      fail "Dashboard tests"
    fi
  fi
else
  echo ""
  echo "━━━ Tests (skipped) ━━━"
fi

# ── 5. Build server bundle ──────────────────────────────────────────────────

step "Building server bundle"
if bun run build 2>&1; then
  pass "Server build → dist/"
else
  fail "Server build"
fi

# ── 6. Build dashboard ──────────────────────────────────────────────────────

if [ "$SKIP_DASHBOARD" = false ] && [ -d "$PROJECT_DIR/dashboard" ]; then
  step "Building dashboard"
  if bun run dashboard:build 2>&1; then
    pass "Dashboard build → dist/dashboard/"
  else
    fail "Dashboard build"
  fi
else
  echo ""
  echo "━━━ Dashboard build (skipped) ━━━"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════"
echo "  Build complete: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
