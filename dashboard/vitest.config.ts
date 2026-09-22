// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

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
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
