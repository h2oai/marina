// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina mcp-stdio` (`scripts/mcp-stdio.ts`) ends when its client goes away:
 * stdin EOF stops the bridge, ends the upstream MCP session with an HTTP
 * DELETE, and the process exits.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mcpServerConfig } from "../scripts/mcp-stdio";

const MARINA = join(import.meta.dir, "..", "scripts", "marina.ts");

interface FakeMcp {
  url: string;
  deletes: string[];
  stop(): void;
}

/** A minimal Streamable HTTP MCP endpoint: answers `initialize` with a session id, records DELETEs. */
function fakeMcp(): FakeMcp {
  const deletes: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "DELETE") {
        deletes.push(req.headers.get("mcp-session-id") ?? "");
        return new Response(null, { status: 200 });
      }
      if (req.method === "GET") return new Response(null, { status: 405 });
      const body = (await req.json()) as { id?: number; method?: string };
      if (body.id === undefined) return new Response(null, { status: 202 });
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "fake", version: "0" },
          },
        },
        { headers: { "mcp-session-id": "sess-1" } },
      );
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, deletes, stop: () => server.stop(true) };
}

let fake: FakeMcp | undefined;
afterEach(() => {
  fake?.stop();
  fake = undefined;
});

async function exitWithin(proc: Bun.Subprocess, ms: number): Promise<number | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    proc.exited,
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
  clearTimeout(timer);
  if (result === "timeout") proc.kill(9);
  return result;
}

describe("marina mcp-stdio lifetime", () => {
  it("exits promptly when stdin is closed before any message", async () => {
    fake = fakeMcp();
    const proc = Bun.spawn(["bun", "--no-env-file", MARINA, "mcp-stdio", "--url", fake.url], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    expect(await exitWithin(proc, 10_000)).toBe(0);
    // No session was opened, so there is nothing to end upstream.
    expect(fake.deletes).toEqual([]);
  });

  it("ends the upstream session and exits on stdin EOF", async () => {
    fake = fakeMcp();
    const proc = Bun.spawn(["bun", "--no-env-file", MARINA, "mcp-stdio", "--url", fake.url], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      })}\n`,
    );
    proc.stdin.flush();
    // Wait for the forwarded reply so the session id is known before EOF.
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let out = "";
    while (!out.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(JSON.parse(out.split("\n")[0]!).id).toBe(1);
    reader.releaseLock();
    proc.stdin.end();
    expect(await exitWithin(proc, 10_000)).toBe(0);
    expect(fake.deletes).toEqual(["sess-1"]);
  });
});

describe("marina mcp-stdio --print-config", () => {
  const launcher = {
    compiled: false,
    execPath: "/opt/bun/bin/bun",
    script: "/src/scripts/marina.ts",
  };

  it("names Bun and the script by absolute path, so a bare PATH still launches it", () => {
    expect(mcpServerConfig([], launcher, {})).toEqual({
      mcpServers: {
        marina: {
          command: "/opt/bun/bin/bun",
          args: [
            "--no-env-file",
            "/src/scripts/marina.ts",
            "mcp-stdio",
            "--url",
            "http://127.0.0.1:3301/mcp",
          ],
        },
      },
    });
  });

  it("keeps given target flags, follows MCP_PORT, and runs a compiled binary directly", () => {
    const given = ["--url", "http://h:9/mcp", "--token", "t"];
    expect(mcpServerConfig(given, launcher, {}).mcpServers.marina.args.slice(3)).toEqual(given);
    expect(mcpServerConfig([], launcher, { MCP_PORT: "4401" }).mcpServers.marina.args).toContain(
      "http://127.0.0.1:4401/mcp",
    );
    expect(
      mcpServerConfig(
        ["--data-dir", "/d"],
        { ...launcher, compiled: true, execPath: "/usr/local/bin/marina" },
        {},
      ),
    ).toEqual({
      mcpServers: {
        marina: { command: "/usr/local/bin/marina", args: ["mcp-stdio", "--data-dir", "/d"] },
      },
    });
  });

  it("prints the entry for the running checkout", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        MARINA,
        "mcp-stdio",
        "--print-config",
        "--url",
        "http://h:9/mcp",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const config = JSON.parse(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(0);
    expect(config.mcpServers.marina.command).toBe(process.execPath);
    expect(config.mcpServers.marina.args).toEqual([
      "--no-env-file",
      MARINA,
      "mcp-stdio",
      "--url",
      "http://h:9/mcp",
    ]);
  });
});
