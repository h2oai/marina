// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "./explorer-tests",
  outputDir: "/tmp/marina-explorer-browser-results",
  use: { ...base.use, baseURL: "http://127.0.0.1:14621" },
  webServer: {
    // Keep ownership in Playwright even when Astro detects a coding-agent shell.
    command: "bun run --cwd ../site preview --ignore-lock --host 127.0.0.1 --port 14621",
    url: "http://127.0.0.1:14621/api",
    timeout: 30000,
    reuseExistingServer: false,
  },
});
