// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, unlinkSync } from "node:fs";

const codingRoot = mkdtempSync("/tmp/marina-browser-code-");
process.on("exit", () => rmSync(codingRoot, { recursive: true, force: true }));

const dbPath = "/tmp/marina-canvas-browser-test.db";
for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

Object.assign(process.env, {
  DB_PATH: dbPath,
  ASSETS_DIR: "/tmp/marina-canvas-browser-test-assets",
  WS_PORT: "14620",
  MCP_PORT: "14621",
  LOG_PORT: "14622",
  TELNET_PORT: "14623",
  MARINA_OPEN_API: "true",
  MARINA_ENDPOINTS: "none",
  MARINA_WORLD: "default",
  MARINA_UNIFIED_CANVAS: "true",
  AGENT_AUTORESPAWN: "false",
  MARINA_CODE_ROOTS: codingRoot,
  MARINA_CODE_DEFAULT_ROOT: codingRoot,
});

await import("../../src/main.ts");
