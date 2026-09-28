// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Engine } from "../src/engine/engine";
import { cmdTool } from "../src/net/mcp-session";
import type { McpSession } from "../src/net/mcp-types";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

test("cancelling queued work skips its mutation without releasing an executing command's FIFO slot", async () => {
  const engine = new Engine({ startRoom: roomId("test/queue") });
  engine.registerRoom(roomId("test/queue"), makeTestRoom());
  const conn = new MockConnection("mcp-queue");
  engine.addConnection(conn);
  engine.spawnEntity(conn.id, "QueueResident");
  const mcp = new McpServer({ name: "queue-test", version: "1" });
  const session: McpSession = {
    connId: conn.id,
    entityId: conn.entity!,
    throttleKey: "test",
    perceptionBuffer: [],
    commandTail: Promise.resolve(),
    mcp,
    transport: new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined }),
  };
  const sessions = new Map([["session", session]]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  engine.commands.registerOwned("fixture", {
    name: "hold",
    help: "Hold",
    async handler() {
      calls.push("start");
      entered.resolve();
      await release.promise;
      calls.push("complete");
    },
  });
  engine.commands.registerOwned("fixture", {
    name: "mark",
    help: "Mark",
    handler(_ctx, input) {
      calls.push(input.args);
    },
  });
  const active = new AbortController();
  const cancelled = new AbortController();
  try {
    const first = cmdTool(
      engine,
      sessions,
      { sessionId: "session", signal: active.signal },
      "/hold",
    );
    await entered.promise;
    const skip = cmdTool(
      engine,
      sessions,
      { sessionId: "session", signal: cancelled.signal },
      "/mark forbidden",
    );
    const next = cmdTool(engine, sessions, { sessionId: "session" }, "/mark next");
    cancelled.abort();
    active.abort();
    await Promise.resolve();
    expect(calls).toEqual(["start"]);
    release.resolve();
    await first;
    expect((await skip).isError).toBe(true);
    await next;
    expect(calls).toEqual(["start", "complete", "next"]);
  } finally {
    release.resolve();
    await session.commandTail;
    await mcp.close();
    await engine.shutdown();
  }
});
