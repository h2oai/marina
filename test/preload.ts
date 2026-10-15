// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Backend test preload (bunfig.toml `[test] preload`).
 *
 * Asset writes in tests do not make derivatives unless a test opts in: a
 * background derivative job loads the native `sharp` addon and runs libvips
 * work that no test awaits, and under `bun test --isolate` a file's realm is
 * torn down while such work (or its native finalizers) can still be pending.
 * test/asset-library.test.ts opts into `sync` (inline, awaited). An explicit
 * value in the environment wins.
 */
process.env.MARINA_ASSET_DERIVATIVES ??= "off";
