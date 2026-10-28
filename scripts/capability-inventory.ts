#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";

// Imports that read environment at module load must run only in the clean child.
const output = process.argv[2];
if (!output) throw new Error("Usage: bun scripts/capability-inventory.ts /tmp/inventory.json");
const child = Bun.spawn(
  [
    process.execPath,
    "--no-env-file",
    resolve(import.meta.dir, "capabilities/inventory.ts"),
    resolve(output),
  ],
  {
    cwd: resolve(import.meta.dir, ".."),
    env: { PATH: process.env.PATH, LOG_LEVEL: "error" },
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
