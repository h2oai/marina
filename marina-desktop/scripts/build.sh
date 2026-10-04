#!/usr/bin/env bash
# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

DESKTOP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOSITORY_ROOT="$(cd "$DESKTOP_ROOT/.." && pwd)"
BUILD_ENV=dev
SKIP_TESTS=false
SKIP_TYPES=false
SKIP_LINT=false
CLEAN_BUILD=false
RUN_AFTER=false
for argument in "$@"; do
  case "$argument" in
    dev|canary|stable) BUILD_ENV="$argument" ;;
    --skip-tests) SKIP_TESTS=true ;;
    --skip-typecheck) SKIP_TYPES=true ;;
    --skip-lint) SKIP_LINT=true ;;
    --clean) CLEAN_BUILD=true ;;
    --run) RUN_AFTER=true ;;
    --help)
      echo "Usage: $0 [dev|canary|stable] [--skip-tests] [--skip-typecheck] [--skip-lint] [--clean] [--run]"
      exit 0 ;;
    *) echo "Unknown argument: $argument" >&2; exit 1 ;;
  esac
done
if [ "$RUN_AFTER" = true ] && [ "$BUILD_ENV" != dev ]; then
  echo "--run is supported only for dev builds" >&2
  exit 1
fi
cd "$REPOSITORY_ROOT"
EXPECTED_BUN="$(tr -d '[:space:]' < .bun-version)"
if [ "$(bun --version)" != "$EXPECTED_BUN" ]; then
  echo "Desktop packaging requires Bun $EXPECTED_BUN (see .bun-version)" >&2
  exit 1
fi
bun install --frozen-lockfile
if [ "$CLEAN_BUILD" = true ]; then
  rm -rf "$DESKTOP_ROOT/build" "$DESKTOP_ROOT/dist" "$DESKTOP_ROOT/artifacts"
fi
cd "$DESKTOP_ROOT"
bun run sync
if [ "$SKIP_TYPES" = false ]; then
  (cd "$REPOSITORY_ROOT" && bun run typecheck)
  bun run typecheck
fi
if [ "$SKIP_LINT" = false ]; then
  (cd "$REPOSITORY_ROOT" && bun run lint)
fi
if [ "$SKIP_TESTS" = false ]; then
  (cd "$REPOSITORY_ROOT" && bun run test)
  bun run test
fi
bun run build:dashboard
if [ "$RUN_AFTER" = true ]; then
  exec bun scripts/electrobun.ts dev
fi
bun scripts/electrobun.ts build --env="$BUILD_ENV"
echo "Desktop $BUILD_ENV build complete. App: marina-desktop/build; release payloads: marina-desktop/artifacts."
