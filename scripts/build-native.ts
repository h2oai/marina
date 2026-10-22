#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile the `marina` dispatcher into a standalone native binary, embedding
 * the package version so `marina --version` works without a `package.json` on
 * disk. The binary re-spawns itself in server mode for the folder-scoped
 * coding flow, and loads worlds from the bundled registry — no `bun` or repo
 * required at runtime.
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// Version comes from src/version.ts's static package import. One compile flag
// selects executable-relative paths and child-process dispatch throughout.
const proc = Bun.spawn(
  [
    process.execPath,
    "build",
    "scripts/marina.ts",
    "--compile",
    // Settings come from scripts/cli-env.ts, never the caller's working directory.
    "--no-compile-autoload-dotenv",
    "--outfile",
    "dist/marina",
    "--define",
    "MARINA_COMPILED=true",
  ],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
);
process.exit(await proc.exited);
