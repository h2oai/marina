// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Side-effect entry: apply `MARINA_DATA_DIR` (src/config/data-dir.ts) before
 * any other server module evaluates. ES imports are hoisted and evaluated in
 * order, and many modules read the environment at load time (`constants.ts`,
 * `agent-runtime.ts`, …), so `src/main.ts` imports this FIRST — a call inside
 * main's body would run after every import had already read its settings and
 * miss what the settings editor saved to `<MARINA_DATA_DIR>/.env`.
 *
 * Precedence, highest first: the process environment (including a `.env` that
 * Bun loads from the working directory before any code runs), then
 * `<MARINA_DATA_DIR>/.env`, then each setting's default.
 */

import { applyDataDir } from "./data-dir";

applyDataDir(process.env);
