// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { inferCrewResponder } from "../src/agent/agent-runtime";
import { SocialAwareness } from "../src/agent/social";
import { Engine } from "../src/engine/engine";
import { McpServerAdapter } from "../src/net/mcp-server";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { MarinaClient } from "../src/sdk/client";
import type { MemoryAssistanceJob } from "../src/sdk/memory-assistance";
import { MarinaMemoryAssistance } from "../src/sdk/memory-assistance-client";
import type { MemoryOperationResult } from "../src/sdk/memory-operations";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";

it("connects human requests, resident helpers, correlated SDK replies and MCP over the same durable job", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-assistance-wire-"));
  const db = new MarinaDB(join(directory, "world.db"));
  const engine = new Engine({ db, startRoom: roomId("test/start"), tickInterval: 100 });
  engine.registerRoom(roomId("test/start"), makeTestRoom());
  const ws = new WebSocketServer(engine, 0);
  ws.setDb(db);
  const mcp = new McpServerAdapter(engine, 0);
  let resident: MarinaClient | undefined;
  const external = new Client({ name: "assistance-owner", version: "1" });
  try {
    ws.start();
    mcp.start();
    engine.start();
    resident = new MarinaClient(`ws://127.0.0.1:${ws.getPort()}`, {
      autoReconnect: false,
      pingInterval: 0,
      commandDrainTimeout: 1,
    });
    await resident.connect("Librarian");
    const notices: unknown[] = [];
    const notification = Promise.withResolvers<void>();
    const social = new SocialAwareness();
    const priorities: number[] = [];
    resident.onPerception((p) => {
      if (p.data?.memory_assistance) {
        notices.push(p.data.memory_assistance);
        for (const event of social.handlePerception(p))
          priorities.push(social.scorePerception(event, "Librarian"));
        notification.resolve();
      }
    });
    await external.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.getPort()}/mcp`)),
    );
    await external.callTool({ name: "login", arguments: { name: "Reader" } });
    const saved = await external.callTool({
      name: "memory_remember",
      arguments: { content: "Deploy Amber on port 7419" },
    });
    const savedEnvelope = saved.structuredContent as { space_id: string; result: { id: string } };
    const reply = await external.callTool({
      name: "memory_assist",
      arguments: {
        space_id: savedEnvelope.space_id,
        role: "librarian",
        worker_id: db.getUserByName("Librarian")!.id,
        task: "Find Amber's port",
        key: "one-request",
      },
    });
    expect(reply.isError).toBeFalsy();
    const jobId = (reply.structuredContent as { result: { id: string } }).result.id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        notification.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Missing assistance notification")), 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(notices).toContainEqual(expect.objectContaining({ id: jobId, state: "pending" }));
    expect(priorities).toContain(100);
    const helper = new MarinaMemoryAssistance(async (request) => {
      const response = await resident!.memoryService(request);
      if (!response.ok) throw new Error(response.error.message);
      return response.result;
    });
    const claim = await helper.claim(jobId);
    const requests = [
      resident.memoryService({ operation: "capabilities" }),
      helper.read(jobId, claim.lease_token, { operation: "get", id: savedEnvelope.result.id }),
    ];
    const results = await Promise.all(requests);
    expect((results[1] as { content: string }).content).toContain("7419");
    await helper.finish(jobId, claim.lease_token, {
      status: "answered",
      answer: "7419",
      citations: [
        {
          kind: "record",
          space_id: savedEnvelope.space_id,
          id: savedEnvelope.result.id,
          version: 1,
          quote: "7419",
        },
      ],
    });
    const read = await external.callTool({
      name: "memory_service",
      arguments: { operation: "assist_get", id: jobId },
    });
    const result = read.structuredContent as MemoryOperationResult & {
      result: MemoryAssistanceJob;
    };
    expect(result.result.result).toMatchObject({ status: "answered", answer: "7419" });
    expect(
      (await resident.memoryService({ operation: "query", space_id: savedEnvelope.space_id })).ok,
    ).toBe(false);
    const human = await external.callTool({
      name: "command",
      arguments: { input: "memory assist reflector Librarian Inspect the deployment evidence" },
    });
    expect(human.isError).toBeFalsy();
    expect((await helper.jobs()).jobs).toHaveLength(2);
    for (const role of ["memory-librarian", "memory-reflector", "memory-evaluator"]) {
      expect(db.getRole(role)).toBeDefined();
      expect(inferCrewResponder(role)).toBe(true);
    }
  } finally {
    resident?.disconnect();
    await external.close();
    mcp.stop();
    ws.stop();
    await Bun.sleep(30);
    engine.stop();
    db.close();
    rmSync(directory, { recursive: true });
  }
});
