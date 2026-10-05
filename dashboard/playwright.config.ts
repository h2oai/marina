// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir:
    process.env.MARINA_BROWSER_ARTIFACTS ?? join(tmpdir(), "marina-dashboard-browser-results"),
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  // These journeys share ONE fixture server with no per-test reset, and they
  // mutate state other specs read: canvases created with scope "global" surface
  // in the unified view, saved workspace presets persist, and several specs
  // assert exact node counts or panel geometry. With more than one worker the
  // interleaving is timing-dependent, so specs observe each other's writes and a
  // different test fails on each run — accessibility's axe audit picks up
  // `scrollable-region-focusable` once enough global nodes exist, workspace
  // geometry shifts at narrow widths, and so on. That randomness lands on the
  // deploy gate, because qualify:release runs this whole suite. One worker makes
  // the order deterministic: ~2.7m instead of ~1.4m for a suite that reproduces.
  workers: 1,
  // Serialising cuts the flake rate hard but does not reach zero — across five
  // local full-suite runs one still failed (touch-scroll geometry on a phone
  // viewport), because the specs share accumulated server state rather than
  // merely racing for it. Retry the failing test rather than let one flake fail
  // a deploy; a genuine regression still fails all three attempts. Off locally
  // so flakes stay visible to whoever is working on them.
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:14620",
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: "bun run e2e/canvas-server.ts",
    url: "http://127.0.0.1:14620/canvas",
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
