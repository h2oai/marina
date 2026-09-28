// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import dashboardPackage from "./package.json" with { type: "json" };

// Bun 1.4.2 fails jsdom's EventTarget receiver check in both VM and thread pools,
// before setupFiles run. Use Vitest's supported Node runtime; Bun manages packages.
if (process.versions.bun)
  throw new Error(
    `Run dashboard tests with \`bun run test\` (without --bun), using Node ${dashboardPackage.engines.node}.`,
  );

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    // One jsdom per worker instead of one per test file (was 49 environments,
    // ~54% of wall time). vmThreads keeps per-file module isolation.
    pool: "vmThreads",
    maxWorkers: 4,
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
