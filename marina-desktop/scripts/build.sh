#!/usr/bin/env bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0

# ─────────────────────────────────────────────────────────────────────────────
# Marina Desktop — Full Prepare & Build Pipeline
#
# Usage:
#   ./marina-desktop/scripts/build.sh [options] [env]
#
# Environments:
#   dev      Fast iteration, unsigned, runs after build (default)
#   canary   Pre-release with optional signing
#   stable   Production: signed, notarized, distribution-ready
#
# Options:
#   --skip-tests     Skip test suite
#   --skip-typecheck Skip TypeScript type checking
#   --skip-lint      Skip Biome lint
#   --clean          Remove all build artifacts before building
#   --run            Launch the app after building (dev only)
#   --help           Show this help
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()  { echo -e "${CYAN}[info]${RESET}  $*"; }
ok()    { echo -e "${GREEN}[ok]${RESET}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${RESET}  $*"; }
fail()  { echo -e "${RED}[fail]${RESET}  $*"; exit 1; }
step()  { echo -e "\n${BOLD}── $* ──${RESET}"; }

# ─── Paths ───────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/marina-desktop"
DASHBOARD_DIR="$REPO_ROOT/dashboard"
ASSETS_DIR="$DESKTOP_DIR/assets"
DIST_DIR="$DESKTOP_DIR/dist"
FONTS_DIR="$DIST_DIR/dashboard/assets"

# ─── Parse Arguments ─────────────────────────────────────────────────────────

ENV="dev"
SKIP_TESTS=false
SKIP_TYPECHECK=false
SKIP_LINT=false
CLEAN=false
RUN_AFTER=false

for arg in "$@"; do
  case "$arg" in
    --skip-tests)     SKIP_TESTS=true ;;
    --skip-typecheck) SKIP_TYPECHECK=true ;;
    --skip-lint)      SKIP_LINT=true ;;
    --clean)          CLEAN=true ;;
    --run)            RUN_AFTER=true ;;
    --help|-h)
      head -20 "$0" | tail -17
      exit 0
      ;;
    dev|canary|stable) ENV="$arg" ;;
    *)
      warn "Unknown argument: $arg"
      ;;
  esac
done

# ─── Banner ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║     Marina Desktop Build Pipeline      ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""
info "Environment:  ${BOLD}$ENV${RESET}"
info "Repository:   $REPO_ROOT"
info "Platform:     $(uname -s) $(uname -m)"
info "Bun version:  $(bun --version 2>/dev/null || echo 'not found')"
echo ""

START_TIME=$(date +%s)

# ─── Step 0: Prerequisites ──────────────────────────────────────────────────

step "Step 0/8: Checking prerequisites"

command -v bun >/dev/null 2>&1 || fail "bun is required but not found. Install from https://bun.sh"

BUN_VERSION=$(bun --version)
info "bun $BUN_VERSION"

# Verify we're in the right repo
[ -f "$REPO_ROOT/src/main.ts" ] || fail "Not in the Marina repo root"
[ -d "$DESKTOP_DIR/src/bun" ]   || fail "marina-desktop/src/bun/ not found — run from repo root"

ok "Prerequisites satisfied"

# ─── Step 1: Clean (optional) ───────────────────────────────────────────────

if [ "$CLEAN" = true ]; then
  step "Step 1/8: Cleaning build artifacts"
  rm -rf "$DIST_DIR" "$DESKTOP_DIR/build" "$DESKTOP_DIR/node_modules" "$DESKTOP_DIR/.font-cache"
  rm -rf "$REPO_ROOT/dist/dashboard"
  ok "Cleaned: dist/, build/, .font-cache/, node_modules"
else
  step "Step 1/8: Clean — skipped (use --clean to enable)"
fi

# ─── Step 2: Install Dependencies ───────────────────────────────────────────

step "Step 2/8: Installing dependencies"

info "Root dependencies..."
cd "$REPO_ROOT"
bun install --frozen-lockfile 2>/dev/null || bun install
ok "Root deps installed"

info "Dashboard dependencies..."
cd "$DASHBOARD_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install
ok "Dashboard deps installed"

info "Desktop dependencies..."
cd "$DESKTOP_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install
ok "Desktop deps installed"

# ─── Step 3: Quality Gates ──────────────────────────────────────────────────

step "Step 3/8: Quality gates"

if [ "$SKIP_LINT" = false ]; then
  info "Linting (biome)..."
  cd "$REPO_ROOT"
  if bun run lint 2>&1; then
    ok "Lint passed"
  else
    warn "Lint issues found (non-blocking for dev builds)"
    [ "$ENV" = "stable" ] && fail "Lint must pass for stable builds"
  fi
else
  info "Lint — skipped"
fi

if [ "$SKIP_TYPECHECK" = false ]; then
  info "Type checking (engine)..."
  cd "$REPO_ROOT"
  if bun run typecheck 2>&1; then
    ok "Engine typecheck passed"
  else
    warn "Type errors found (non-blocking for dev builds)"
    [ "$ENV" = "stable" ] && fail "Types must pass for stable builds"
  fi

  info "Type checking (desktop)..."
  cd "$DESKTOP_DIR"
  if bun run typecheck 2>&1; then
    ok "Desktop typecheck passed"
  else
    warn "Desktop type errors found (non-blocking for dev builds)"
    [ "$ENV" = "stable" ] && fail "Desktop types must pass for stable builds"
  fi
else
  info "Typecheck — skipped"
fi

if [ "$SKIP_TESTS" = false ]; then
  info "Running test suite..."
  cd "$REPO_ROOT"
  TEST_OUTPUT=$(bun test 2>&1)
  PASS_COUNT=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ pass' | head -1 || echo "? pass")
  FAIL_COUNT=$(echo "$TEST_OUTPUT" | grep -oE '[0-9]+ fail' | head -1 || echo "0 fail")

  if echo "$TEST_OUTPUT" | grep -q " 0 fail"; then
    ok "Tests passed ($PASS_COUNT, $FAIL_COUNT)"
  else
    echo "$TEST_OUTPUT" | tail -20
    fail "Tests failed — aborting build"
  fi
else
  info "Tests — skipped"
fi

# ─── Step 4: Generate Placeholder Assets ────────────────────────────────────

step "Step 4/8: Preparing assets"

mkdir -p "$ASSETS_DIR"

# Generate placeholder tray icons if missing (16x16 PNG)
# These are minimal 1-pixel PNGs — replace with real icons for production
generate_placeholder_png() {
  local path="$1"
  local label="$2"
  if [ ! -f "$path" ]; then
    # Minimal valid 1x1 PNG (67 bytes)
    printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > "$path"
    warn "Generated placeholder: $label"
  else
    ok "Asset exists: $label"
  fi
}

generate_placeholder_png "$ASSETS_DIR/tray-icon.png" "tray-icon.png"
generate_placeholder_png "$ASSETS_DIR/tray-icon-active.png" "tray-icon-active.png"

# Generate placeholder .icns (macOS) if missing
if [ ! -f "$ASSETS_DIR/icon.icns" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    # On macOS, generate a proper .icns from a 1024x1024 PNG via iconutil
    ICONSET_DIR="$ASSETS_DIR/icon.iconset"
    mkdir -p "$ICONSET_DIR"
    # Create a minimal icon at required sizes using sips if available
    if command -v sips >/dev/null 2>&1; then
      # Start with a placeholder 1024x1024
      TEMP_PNG="$ASSETS_DIR/_icon_1024.png"
      if command -v python3 >/dev/null 2>&1; then
        python3 -c "
import struct, zlib
def png(w, h, r, g, b):
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    raw = b''
    for _ in range(h):
        raw += b'\x00' + bytes([r, g, b]) * w
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
with open('$TEMP_PNG', 'wb') as f:
    f.write(png(1024, 1024, 26, 26, 46))
"
        for size in 16 32 64 128 256 512 1024; do
          sips -z $size $size "$TEMP_PNG" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null 2>&1
          if [ $size -le 512 ]; then
            double=$((size * 2))
            sips -z $double $double "$TEMP_PNG" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null 2>&1
          fi
        done
        iconutil -c icns "$ICONSET_DIR" -o "$ASSETS_DIR/icon.icns" 2>/dev/null && \
          ok "Generated placeholder icon.icns" || \
          warn "iconutil failed — icon.icns not generated"
        rm -f "$TEMP_PNG"
      else
        warn "python3 not found — cannot generate icon.icns placeholder"
      fi
      rm -rf "$ICONSET_DIR"
    fi
  else
    warn "Not on macOS — skipping icon.icns generation"
  fi
fi

# Generate placeholder .ico (Windows) if missing
if [ ! -f "$ASSETS_DIR/icon.ico" ]; then
  # Minimal placeholder — a proper .ico should be created for production
  generate_placeholder_png "$ASSETS_DIR/icon.ico" "icon.ico (placeholder)"
fi

# Generate placeholder .png (Linux) if missing
generate_placeholder_png "$ASSETS_DIR/icon.png" "icon.png"

# ─── Step 5: Download Offline Fonts ─────────────────────────────────────────

step "Step 5/8: Bundling offline fonts"

# Cache fonts outside dist/ so Vite's emptyOutDir doesn't wipe them
FONT_CACHE="$DESKTOP_DIR/.font-cache"
mkdir -p "$FONT_CACHE"

download_font() {
  local url="$1"
  local dest="$2"
  local label="$3"

  if [ -f "$dest" ] && [ -s "$dest" ]; then
    ok "Font cached: $label ($(du -h "$dest" | cut -f1 | xargs))"
    return 0
  fi

  info "Downloading $label..."
  if curl -fsSL --max-time 15 -o "$dest" "$url" 2>/dev/null; then
    local size
    size=$(du -h "$dest" | cut -f1 | xargs)
    ok "Downloaded $label ($size)"
  else
    warn "Failed to download $label — dashboard will fall back to system fonts"
    touch "$dest"
  fi
}

# Google Fonts woff2 URLs (latin subset, stable CDN paths)
ORBITRON_URL="https://fonts.gstatic.com/s/orbitron/v31/yMJRMIlzdpvBhQQL_Qq7dy0.woff2"
SHARE_TECH_MONO_URL="https://fonts.gstatic.com/s/sharetechmono/v15/J7aHnp1uDWRBEqV98dVQztYldFcLowEF.woff2"

download_font "$ORBITRON_URL" "$FONT_CACHE/orbitron.woff2" "Orbitron"
download_font "$SHARE_TECH_MONO_URL" "$FONT_CACHE/share-tech-mono.woff2" "Share Tech Mono"

# ─── Step 6: Build Dashboard SPA ────────────────────────────────────────────

step "Step 6/8: Building dashboard SPA"

cd "$DESKTOP_DIR"
info "Vite build with desktop config (base: './')..."
bunx vite build --config "$DESKTOP_DIR/vite.desktop.config.ts" 2>&1

# Verify build output
if [ -f "$DIST_DIR/dashboard/index.js" ]; then
  DASH_SIZE=$(du -sh "$DIST_DIR/dashboard" | cut -f1 | xargs)
  ok "Dashboard built ($DASH_SIZE) → marina-desktop/dist/dashboard/"
else
  # Vite may use a hashed entry — check for any JS
  JS_COUNT=$(find "$DIST_DIR/dashboard" -name "*.js" 2>/dev/null | wc -l | xargs)
  if [ "$JS_COUNT" -gt 0 ]; then
    DASH_SIZE=$(du -sh "$DIST_DIR/dashboard" | cut -f1 | xargs)
    ok "Dashboard built ($DASH_SIZE, $JS_COUNT JS files) → marina-desktop/dist/dashboard/"
  else
    fail "Dashboard build produced no JS output"
  fi
fi

# Copy cached fonts into the Vite output (Vite's emptyOutDir wiped them)
mkdir -p "$FONTS_DIR"
cp "$FONT_CACHE/orbitron.woff2" "$FONTS_DIR/orbitron.woff2" 2>/dev/null
cp "$FONT_CACHE/share-tech-mono.woff2" "$FONTS_DIR/share-tech-mono.woff2" 2>/dev/null
ok "Offline fonts copied to build output"

# The distributed app must carry the project license and the NOTICE file
# (which includes the OFL attribution for the bundled fonts).
cp "$REPO_ROOT/LICENSE" "$REPO_ROOT/NOTICE" "$DIST_DIR/" 2>/dev/null
ok "LICENSE and NOTICE copied to build output"

# ─── Step 7: Build Electrobun App ────────────────────────────────────────────

step "Step 7/8: Building Electrobun app (env=$ENV)"

cd "$DESKTOP_DIR"

# Signing config for stable builds
if [ "$ENV" = "stable" ]; then
  if [ -z "${ELECTROBUN_DEVELOPER_ID:-}" ]; then
    warn "ELECTROBUN_DEVELOPER_ID not set — build will be unsigned"
  fi
  if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
    warn "APPLE_ID / APPLE_TEAM_ID not set — notarization will be skipped"
  fi
fi

bunx electrobun build --env="$ENV" 2>&1

# Copy app icon into the correct macOS bundle location
# Electrobun copies to Resources/app/ but macOS expects icon at Resources/
BUILD_APP="$DESKTOP_DIR/build/${ENV}-macos-$(uname -m | sed 's/arm64/arm64/;s/x86_64/x64/')"
APP_BUNDLE=$(ls -d "$BUILD_APP"/*.app 2>/dev/null | head -1)
if [ -n "$APP_BUNDLE" ] && [ -f "$DESKTOP_DIR/assets/icon.icns" ]; then
  cp "$DESKTOP_DIR/assets/icon.icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
  ok "App icon installed"
fi

ok "Electrobun build complete"

# ─── Step 8: Summary ────────────────────────────────────────────────────────

step "Step 8/8: Build summary"

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
MINUTES=$((ELAPSED / 60))
SECONDS=$((ELAPSED % 60))

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║            Build Complete                ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""
info "Environment:  $ENV"
info "Duration:     ${MINUTES}m ${SECONDS}s"
info "Platform:     $(uname -s) $(uname -m)"

# Report output artifacts
echo ""
if [ -d "$DESKTOP_DIR/build" ]; then
  info "Build output:"
  echo ""

  # macOS .app / .dmg
  for f in "$DESKTOP_DIR/build"/*.app "$DESKTOP_DIR/build"/*.dmg; do
    [ -e "$f" ] && echo -e "  ${GREEN}$(basename "$f")${RESET}  $(du -sh "$f" | cut -f1 | xargs)"
  done

  # Windows .exe
  for f in "$DESKTOP_DIR/build"/*.exe; do
    [ -e "$f" ] && echo -e "  ${GREEN}$(basename "$f")${RESET}  $(du -sh "$f" | cut -f1 | xargs)"
  done

  # Linux .deb / .AppImage
  for f in "$DESKTOP_DIR/build"/*.deb "$DESKTOP_DIR/build"/*.AppImage; do
    [ -e "$f" ] && echo -e "  ${GREEN}$(basename "$f")${RESET}  $(du -sh "$f" | cut -f1 | xargs)"
  done

  # Catch-all for other artifacts
  for f in "$DESKTOP_DIR/build"/*; do
    [ -e "$f" ] || continue
    case "$f" in
      *.app|*.dmg|*.exe|*.deb|*.AppImage) ;; # already printed
      *) echo -e "  ${DIM}$(basename "$f")${RESET}  $(du -sh "$f" | cut -f1 | xargs)" ;;
    esac
  done
  echo ""
else
  warn "No build/ directory found — Electrobun may output elsewhere"
fi

# Post-build actions
if [ "$RUN_AFTER" = true ] && [ "$ENV" = "dev" ]; then
  echo ""
  info "Launching app..."
  cd "$DESKTOP_DIR"
  exec bunx electrobun build --env=dev --run
fi

if [ "$ENV" = "dev" ]; then
  echo -e "${DIM}To run:  cd marina-desktop && bunx electrobun build --env=dev --run${RESET}"
elif [ "$ENV" = "stable" ]; then
  echo -e "${DIM}Distribution artifacts are in marina-desktop/build/${RESET}"
fi
echo ""
