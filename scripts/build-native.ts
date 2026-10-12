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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
const version = pkg.version ?? "unknown";

const proc = Bun.spawn(
  [
    "bun",
    "build",
    "scripts/marina.ts",
    "--compile",
    "--outfile",
    "dist/marina",
    "--define",
    `MARINA_VERSION=${JSON.stringify(version)}`,
  ],
  { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
);
process.exit(await proc.exited);
