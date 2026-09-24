// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Network surfaces log through the structured `Logger`, never `console.*`.
 *
 * `console.*` bypasses every sink the operator configured — the structured-log
 * table behind `/api/logs` and the log viewer, the OTLP log exporter, and the
 * redaction pass in `redactLogData` — so a startup line or an adapter failure
 * written with `console` is invisible to everything but a terminal that happened
 * to be attached. This is a static fence over `src/net/**` and
 * `src/integrations/**`, plus a check that each converted module actually
 * declares a module logger.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Roots the fence covers. */
const FENCED_ROOTS = ["src/net", "src/integrations"];

/**
 * Paths excluded from the fence.
 *
 * Empty: the fence covers ALL of `src/net/**` and `src/integrations/**`,
 * including the `src/net/dashboard-api/` route-group modules. (An exclusion
 * lived here while that split was in flight; it landed clean, so the fence now
 * runs over everything.) Anything added here needs a reason and an expiry.
 */
const EXCLUDED_PREFIXES: string[] = [];

/**
 * Deliberate `console.*` survivors, by path. Each entry needs a reason.
 *
 * Empty for the fenced roots: every startup line, adapter failure and broadcast
 * error under `src/net/**` now goes through `Logger`. The one banner Marina
 * still prints directly lives in `src/main.ts` (outside these roots) and is
 * pinned by its own assertion below.
 */
const CONSOLE_ALLOWLIST: Record<string, string> = {};

const CONSOLE_CALL = /\bconsole\.(log|warn|error|info|debug|trace|dir|table)\(/;

function fencedFiles(): string[] {
  const files: string[] = [];
  for (const root of FENCED_ROOTS) {
    const glob = new Bun.Glob("**/*.ts");
    for (const rel of glob.scanSync({ cwd: join(ROOT, root) })) {
      const path = `${root}/${rel}`;
      if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
      files.push(path);
    }
  }
  return files.sort();
}

describe("network-surface logging", () => {
  it("scans a meaningful number of files (fence sanity)", () => {
    const files = fencedFiles();
    expect(files.length).toBeGreaterThan(50);
    // The fence must actually reach the split dashboard-api route groups.
    expect(files.filter((f) => f.startsWith("src/net/dashboard-api")).length).toBeGreaterThan(5);
  });

  it("has no direct console.* calls under src/net or src/integrations", () => {
    const hits: string[] = [];
    for (const path of fencedFiles()) {
      if (path in CONSOLE_ALLOWLIST) continue;
      const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (CONSOLE_CALL.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, `console.* found on a network surface:\n${hits.join("\n")}`).toEqual([]);
  });

  it("keeps the console allowlist honest", () => {
    const files = new Set(fencedFiles());
    for (const [path, reason] of Object.entries(CONSOLE_ALLOWLIST)) {
      expect(files.has(path), `allowlisted path no longer exists: ${path}`).toBe(true);
      expect(reason.length, `allowlist entry ${path} needs a reason`).toBeGreaterThan(10);
    }
  });

  it("declares a module logger in every converted network module", () => {
    // These modules used to write startup/runtime lines with `console.*`.
    const converted: Array<[string, string]> = [
      ["src/net/websocket-server.ts", "ws"],
      ["src/net/mcp-server.ts", "mcp"],
      ["src/net/telnet-server.ts", "telnet"],
      ["src/net/discord-adapter.ts", "discord"],
      ["src/net/telegram-adapter.ts", "telegram"],
      ["src/net/feed-publisher.ts", "feed"],
      ["src/net/dashboard-ws.ts", "dashboard-ws"],
      ["src/net/log-server.ts", "log-server"],
      ["src/net/adapter-manager.ts", "adapters"],
      ["src/net/ops-api.ts", "ops"],
      ["src/net/probe-api.ts", "probe"],
      ["src/net/model-api/upstream.ts", "model-api"],
      ["src/net/dashboard-api/shared.ts", "dashboard-api"],
    ];
    const missingLogger: string[] = [];
    const missingCategory: string[] = [];
    for (const [path, category] of converted) {
      const source = readFileSync(join(ROOT, path), "utf8");
      if (!source.includes("const logger = new Logger();")) missingLogger.push(path);
      if (!source.includes(`logger.info("${category}"`) && !source.includes(`"${category}",`))
        missingCategory.push(`${path} (${category})`);
    }
    expect(missingLogger).toEqual([]);
    expect(missingCategory).toEqual([]);
  });

  it("keeps exactly one deliberate console line in src/main.ts (the boot banner)", () => {
    // main.ts is outside the fenced roots: the multi-line boot banner is
    // intentionally plain stdout because Logger's text sink stamps every entry
    // with `[iso] LEVEL [category]`, which would mangle a banner. Everything
    // else in main.ts — fatal boot errors, trims, port conflicts, crash
    // handlers — routes through `logger`.
    const lines = readFileSync(join(ROOT, "src/main.ts"), "utf8").split("\n");
    const hits = lines
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => CONSOLE_CALL.test(line));
    expect(hits.map((h) => `${h.n}: ${h.line}`)).toHaveLength(1);
    expect(hits[0]?.line).toBe("console.log(");
  });
});
