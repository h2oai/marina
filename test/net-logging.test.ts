// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server code logs through the structured `Logger`, never `console.*`.
 *
 * `console.*` bypasses every sink the operator configured — the structured-log
 * table behind `/api/logs` and the log viewer, the OTLP log exporter, and the
 * redaction pass in `redactLogData` — so a startup line or an adapter failure
 * written with `console` is invisible to everything but a terminal that happened
 * to be attached. This is a static fence over all of `src/**` (the external
 * SDK package excepted), plus a check that each converted module actually
 * declares a module logger.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Roots the fence covers. Started as `src/net` + `src/integrations`; widened
 * to all of `src/` once the engine/agent/persistence stragglers were converted. */
const FENCED_ROOTS = ["src"];

/**
 * Paths excluded from the fence. Anything added here needs a reason.
 *
 * `src/sdk/` is the separately published `@marina/agent-sdk` package: it runs
 * in the CLIENT's process, has no access to the server `Logger`, and its
 * examples print to the terminal on purpose.
 */
const EXCLUDED_PREFIXES: string[] = ["src/sdk/"];

/**
 * Deliberate `console.*` survivors, by path. Each entry needs a reason.
 */
const CONSOLE_ALLOWLIST: Record<string, string> = {
  "src/engine/logger.ts": "the Logger's own stdout/stderr text and JSON sinks",
  "src/memory/import-process.ts":
    "child process whose stdout IS the result channel (one JSON line read by the parent)",
  "src/main.ts": "the multi-line boot banner, pinned to exactly one call by its own test below",
};

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
    expect(files.length).toBeGreaterThan(400);
    for (const root of ["src/engine", "src/agent", "src/persistence", "src/net"]) {
      expect(
        files.some((f) => f.startsWith(`${root}/`)),
        root,
      ).toBe(true);
    }
    expect(files.some((f) => f.startsWith("src/sdk/"))).toBe(false);
    // The fence must actually reach the split dashboard-api route groups.
    expect(files.filter((f) => f.startsWith("src/net/dashboard-api")).length).toBeGreaterThan(5);
  });

  it("has no direct console.* calls in server code", () => {
    const hits: string[] = [];
    for (const path of fencedFiles()) {
      if (path in CONSOLE_ALLOWLIST) continue;
      const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (CONSOLE_CALL.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, `console.* found in server code:\n${hits.join("\n")}`).toEqual([]);
  });

  it("keeps the console allowlist honest", () => {
    const files = new Set(fencedFiles());
    for (const [path, reason] of Object.entries(CONSOLE_ALLOWLIST)) {
      expect(files.has(path), `allowlisted path no longer exists: ${path}`).toBe(true);
      expect(reason.length, `allowlist entry ${path} needs a reason`).toBeGreaterThan(10);
    }
  });

  it("declares a module logger in every converted module", () => {
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
      ["src/agent/agent-runtime.ts", "agents"],
      ["src/engine/gateway-runtime.ts", "gateway"],
      ["src/engine/connector-runtime.ts", "connectors"],
      ["src/persistence/db-channels.ts", "db"],
      ["src/persistence/db-notes.ts", "db"],
      ["src/resolvers/calibration.ts", "calibration"],
      ["src/world/room-loader.ts", "rooms"],
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
    // main.ts is allowlisted for exactly this: the multi-line boot banner is
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
