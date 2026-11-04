// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina mcp-stdio --start`: the bridge adopts the instance recorded in the
 * data directory or starts one and waits for its endpoint (fakes stand in for
 * the detached server; the real launch is exercised by hand and by the plugin).
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_START_IDLE,
  defaultStartDataDir,
  ensureInstance,
  mcpServerConfig,
  resolveMcpTarget,
  type StartDeps,
  startDataDir,
  startLogPath,
} from "../scripts/mcp-stdio";
import type { EndpointInfo } from "../src/net/instance-lifecycle";

const endpoint: EndpointInfo = {
  url: "http://127.0.0.1:40001",
  mcpUrl: "http://127.0.0.1:40002/mcp",
  pid: 4242,
  apiKey: "mk_local_test",
  version: "0.0.0",
  world: "default",
  startedAt: "2026-11-04T00:00:00.000Z",
  idleShutdownMs: 1_800_000,
};

/** A clock that advances on sleep, an endpoint that appears after `readyAfter` polls. */
function fakeDeps(opts: { readyAfter?: number; running?: boolean } = {}) {
  let now = 0;
  let polls = 0;
  const launches: string[] = [];
  const log: string[] = [];
  const deps: StartDeps = {
    readEndpoint: () => {
      if (opts.running) return endpoint;
      polls++;
      return opts.readyAfter !== undefined && polls > opts.readyAfter ? endpoint : undefined;
    },
    launch: async (o) => {
      launches.push(o.dataDir);
      return 777;
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    log: (line) => log.push(line),
  };
  return { deps, launches, log };
}

describe("ensureInstance", () => {
  it("adopts a running instance without launching anything", async () => {
    const { deps, launches } = fakeDeps({ running: true });
    const got = await ensureInstance({ dataDir: "/d", idle: "30m" }, deps);
    expect(got).toBe(endpoint);
    expect(launches).toEqual([]);
  });

  it("launches once and waits for the endpoint it writes", async () => {
    const { deps, launches, log } = fakeDeps({ readyAfter: 3 });
    const got = await ensureInstance({ dataDir: "/d", idle: "30m" }, deps);
    expect(got.mcpUrl).toBe(endpoint.mcpUrl);
    expect(launches).toEqual(["/d"]);
    expect(log[0]).toContain("pid 777");
    expect(log[0]).toContain(startLogPath("/d"));
    expect(log[1]).toContain(endpoint.url);
  });

  it("gives up after the timeout naming the server log", async () => {
    const { deps } = fakeDeps();
    await expect(
      ensureInstance({ dataDir: "/d", idle: "30m", timeoutMs: 2_000 }, deps),
    ).rejects.toThrow(/did not come up within 2s.*server\.log/);
  });
});

describe("resolveMcpTarget with --start", () => {
  it("defaults the data directory to ~/.marina/mcp and passes the local key as the bearer", async () => {
    const env = { HOME: "/home/t" };
    expect(defaultStartDataDir(env)).toBe(join("/home/t", ".marina", "mcp"));
    expect(startDataDir({}, env)).toBe(join("/home/t", ".marina", "mcp"));
    expect(startDataDir({}, { ...env, MARINA_DATA_DIR: "/data" })).toBe("/data");
    expect(startDataDir({ dataDir: "/flag" }, { ...env, MARINA_DATA_DIR: "/data" })).toBe("/flag");
    const { deps } = fakeDeps({ running: true });
    expect(await resolveMcpTarget({ start: true }, env, deps)).toEqual({
      url: "http://127.0.0.1:40002/mcp",
      token: "mk_local_test",
    });
  });

  it("an explicit URL wins and starts nothing", async () => {
    const { deps, launches } = fakeDeps();
    const got = await resolveMcpTarget(
      { start: true },
      { HOME: "/home/t", MARINA_MCP_URL: "http://h:1/mcp", MARINA_TOKEN: "t" },
      deps,
    );
    expect(got).toEqual({ url: "http://h:1/mcp", token: "t" });
    expect(launches).toEqual([]);
  });

  it("the idle default is thirty minutes", () => {
    expect(DEFAULT_START_IDLE).toBe("30m");
  });
});

describe("mcpServerConfig with --start", () => {
  it("does not inject the default URL when the bridge is asked to start a world", () => {
    const launcher = { compiled: true, execPath: "/usr/local/bin/marina", script: "" };
    expect(mcpServerConfig(["--start"], launcher, {}).mcpServers.marina.args).toEqual([
      "mcp-stdio",
      "--start",
    ]);
  });
});
