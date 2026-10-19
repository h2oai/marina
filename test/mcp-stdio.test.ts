// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `marina mcp-stdio` (`scripts/mcp-stdio.ts`) ends when its client goes away:
 * stdin EOF stops the bridge, ends the upstream MCP session with an HTTP
 * DELETE, and the process exits.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

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
