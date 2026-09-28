// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, spyOn, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Engine } from "../src/engine/engine";
import { MCP_MAX_SESSION_PENDING, McpAdmission, mcpAdmission } from "../src/net/mcp-admission";
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

test("MCP rejects excess queued mutations before execution and recovers its capacity", async () => {
  const engine = new Engine({ startRoom: roomId("test/bounded") });
  engine.registerRoom(roomId("test/bounded"), makeTestRoom());
  const conn = new MockConnection("mcp-bounded");
  engine.addConnection(conn);
  engine.spawnEntity(conn.id, "BoundedResident");
  const mcp = new McpServer({ name: "bounded-test", version: "1" });
  const session: McpSession = {
    connId: conn.id,
    entityId: conn.entity!,
    throttleKey: "test",
    perceptionBuffer: [],
    commandTail: Promise.resolve(),
    mcp,
    transport: new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined }),
  };
  const sessions = new Map([["bounded", session]]);
  const release = Promise.withResolvers<void>();
  let executed = 0;
  engine.commands.registerOwned("fixture", {
    name: "hold",
    help: "Hold",
    async handler() {
      await release.promise;
      executed++;
    },
  });
  try {
    const admitted = Array.from({ length: MCP_MAX_SESSION_PENDING }, () =>
      cmdTool(engine, sessions, { sessionId: "bounded" }, "/hold"),
    );
    const rejected = await cmdTool(engine, sessions, { sessionId: "bounded" }, "/hold");
    expect(rejected.structuredContent).toMatchObject({
      error: { code: "mcp_overloaded", executed: false, retryable: true },
    });
    expect(mcpAdmission(engine).snapshot().pending).toBe(MCP_MAX_SESSION_PENDING);
    release.resolve();
    await Promise.all(admitted);
    expect(executed).toBe(MCP_MAX_SESSION_PENDING);
    expect(mcpAdmission(engine).snapshot().pending).toBe(0);
    await cmdTool(engine, sessions, { sessionId: "bounded" }, "/hold");
    expect(executed).toBe(MCP_MAX_SESSION_PENDING + 1);
  } finally {
    release.resolve();
    await session.commandTail;
    await mcp.close();
    await engine.shutdown();
  }
});

test("admission limits include all sessions and release is idempotent", () => {
  const admission = new McpAdmission(2, 1, -1);
  const first = {};
  const a = admission.enter(first)!;
  expect(admission.enter(first)).toBeUndefined();
  const b = admission.enter({})!;
  expect(admission.enter({})).toBeUndefined();
  expect(a.canStart()).toBe(false);
  a.release();
  a.release();
  b.release();
  expect(admission.snapshot()).toMatchObject({ pending: 0, highWater: 2, rejected: 2, expired: 1 });
});

test("queue expiry is inclusive at the exact deadline and counts elapsed time from admission", () => {
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  try {
    const admission = new McpAdmission(5, 3, 20);
    const session = {};
    const a = admission.enter(session)!;
    const b = admission.enter(session)!;
    expect(a.canStart()).toBe(true);
    now = 1020;
    expect(a.canStart()).toBe(true);
    now++;
    expect(a.canStart()).toBe(false);
    a.release();
    // Releasing one of two slots must leave one counted in this session.
    const c = admission.enter(session)!;
    const d = admission.enter(session)!;
    expect(admission.enter(session)).toBeUndefined();
    b.release();
    c.release();
    d.release();
    expect(admission.snapshot().pending).toBe(0);
  } finally {
    clock.mockRestore();
  }
});
