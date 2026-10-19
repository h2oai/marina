// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The server as an embedder runs it: one data directory, one ephemeral port,
// a discovery file, no credential on stdout, and gone when idle or orphaned.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type EndpointInfo, readEndpointFile } from "../src/net/instance-lifecycle";
import { until } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function spawnMarina(cwd: string, dataDir: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--env-file=/dev/null", resolve("src/main.ts")], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dataDir,
      WS_HOST: "127.0.0.1",
      WS_PORT: "0",
      MARINA_DATA_DIR: dataDir,
      MARINA_SINGLE_PORT: "true",
      MARINA_WORLD: "empty",
      MARINA_ROOM_AGENTS: "false",
      AGENT_AUTORESPAWN: "false",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([out, err]) => `${out}\n${err}`);
  return { child, output };
}

async function waitForEndpoint(
  dataDir: string,
  child: ReturnType<typeof Bun.spawn>,
  output: Promise<string>,
): Promise<EndpointInfo> {
  let endpoint: EndpointInfo | undefined;
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(await output);
      endpoint = readEndpointFile(join(dataDir, "endpoint.json"));
      return endpoint !== undefined;
    },
    { timeoutMs: 15_000 },
  );
  return endpoint!;
}

test("one data dir, one port, endpoint.json, no key on stdout, idle shutdown", async () => {
  const cwd = tmp("marina-embed-cwd-");
  const dataDir = join(tmp("marina-embed-data-"), "instance");
  const { child, output } = spawnMarina(cwd, dataDir, { MARINA_IDLE_SHUTDOWN: "2s" });
  try {
    const endpoint = await waitForEndpoint(dataDir, child, output);
    expect(endpoint.pid).toBe(child.pid);
    expect(endpoint.world).toBe("empty");
    expect(endpoint.idleShutdownMs).toBe(2000);
    expect(endpoint.apiKey).toMatch(/^mk_local_/);
    if (process.platform !== "win32") {
      expect(statSync(join(dataDir, "endpoint.json")).mode & 0o777).toBe(0o600);
    }
    // MCP rides the HTTP port (MARINA_SINGLE_PORT).
    const port = new URL(endpoint.url).port;
    expect(new URL(endpoint.mcpUrl!).port).toBe(port);
    const init = await fetch(endpoint.mcpUrl!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "embed-test", version: "1" },
        },
      }),
    });
    expect(init.status).toBe(200);
    await init.body?.cancel();
    // Everything lives under the data directory; nothing in the working directory.
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(join(dataDir, "marina.db"))).toBe(true);
    expect(existsSync(join(dataDir, "assets"))).toBe(true);
    // Idle: no external request for 2s → a clean exit that removes endpoint.json.
    expect(await Promise.race([child.exited, Bun.sleep(15_000).then(() => "timeout")])).toBe(0);
    expect(existsSync(join(dataDir, "endpoint.json"))).toBe(false);
    const text = await output;
    expect(text).not.toContain(endpoint.apiKey!);
    expect(text).toContain("MARINA_IDLE_SHUTDOWN");
  } finally {
    child.kill("SIGKILL");
  }
}, 40_000);

test("exits when MARINA_PARENT_PID is gone", async () => {
  const cwd = tmp("marina-embed-cwd-");
  const dataDir = join(tmp("marina-embed-data-"), "instance");
  const parent = Bun.spawn(["sleep", "60"]);
  const { child, output } = spawnMarina(cwd, dataDir, { MARINA_PARENT_PID: String(parent.pid) });
  try {
    await waitForEndpoint(dataDir, child, output);
    parent.kill("SIGKILL");
    await parent.exited;
    expect(await Promise.race([child.exited, Bun.sleep(15_000).then(() => "timeout")])).toBe(0);
    expect(await output).toContain("MARINA_PARENT_PID");
  } finally {
    parent.kill("SIGKILL");
    child.kill("SIGKILL");
  }
}, 40_000);
