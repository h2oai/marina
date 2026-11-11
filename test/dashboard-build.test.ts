// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// A checkout builds its dashboard at boot when the bundle is missing or older
// than its sources, so the link a `marina` session prints always works.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../src/engine/logger";
import { dashboardBuildState, ensureDashboardBuilt } from "../src/net/dashboard-build";

const silent = { info() {}, warn() {}, debug() {}, error() {} } as unknown as Logger;

describe("dashboard build state", () => {
  let root: string;
  const file = (path: string, at: number) => {
    const p = join(root, path);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x");
    utimesSync(p, at / 1000, at / 1000);
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marina-dash-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is unavailable without the dashboard sources", () => {
    file("src/main.ts", 1_000_000);
    expect(dashboardBuildState(root)).toBe("unavailable");
  });

  it("is missing, then fresh, then stale when a dashboard or server source changes", () => {
    const t = Date.parse("2026-11-01T00:00:00Z");
    file("dashboard/index.html", t);
    file("dashboard/vite.config.ts", t);
    file("dashboard/src/App.tsx", t);
    file("src/types.ts", t);
    expect(dashboardBuildState(root)).toBe("missing");
    file("dist/dashboard/index.html", t + 1000);
    expect(dashboardBuildState(root)).toBe("fresh");
    // Dependencies and other builds never make it stale.
    file("dashboard/node_modules/x/index.js", t + 5000);
    expect(dashboardBuildState(root)).toBe("fresh");
    file("src/types.ts", t + 2000);
    expect(dashboardBuildState(root)).toBe("stale");
    file("dist/dashboard/index.html", t + 3000);
    file("dashboard/src/App.tsx", t + 4000);
    expect(dashboardBuildState(root)).toBe("stale");
  });

  it("does nothing when off, fresh, unavailable, or while another build holds the lock", async () => {
    expect(
      await ensureDashboardBuilt(silent, { root, env: { MARINA_DASHBOARD_AUTOBUILD: "off" } }),
    ).toBe("off");
    expect(await ensureDashboardBuilt(silent, { root, env: {} })).toBe("unavailable");
    const t = Date.now() - 60_000;
    file("dashboard/index.html", t);
    file("dashboard/vite.config.ts", t);
    file("dist/dashboard/index.html", t + 1000);
    expect(await ensureDashboardBuilt(silent, { root, env: {} })).toBe("fresh");
    rmSync(join(root, "dist/dashboard"), { recursive: true });
    writeFileSync(join(root, "dist/.dashboard-build.lock"), "");
    expect(await ensureDashboardBuilt(silent, { root, env: {} })).toBe("busy");
  });
});
