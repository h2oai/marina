// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { type OutstandingRequests, readRequestLedger } from "../src/agent/outstanding-requests";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MarinaClient } from "../src/sdk/client";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";
import type { Perception } from "../src/types";

type Internals = {
  agent: Agent;
  client: Pick<MarinaClient, "capabilities"> & { emit(event: "perception", p: Perception): void };
  platformMemory: PlatformMemoryBackend;
  autonomousMode: boolean;
  outstandingRequests: OutstandingRequests;
  setupActionTracking(): void;
  flushOutstandingRequests(): Promise<void>;
  buildContinuationPrompt(): Promise<string>;
  loadCheckpointSummary(): Promise<string>;
};

function incoming(message: string): Perception {
  return {
    kind: "message",
    timestamp: 1,
    tag: "tell",
    data: {
      senderName: "Boss",
      text: `Boss tells you: ${message}`,
      message,
    },
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "marina-request-restart-"));
  const path = join(directory, "memory.db");
  let db = new MarinaDB(path, { durability: "full" });
  db.createUser({ id: crypto.randomUUID(), name: "RestartWorker" });
  let beforeOperation: ((request: MemoryOperationRequest) => Promise<void>) | undefined;
  const client = {
    memoryService: async (request: MemoryOperationRequest) => {
      await beforeOperation?.(request);
      return residentMemoryOperation(db, "RestartWorker", request);
    },
  };
  const makeAdapter = (model = "marina/default") => {
    const i = new LeanAgentAdapter(
      { name: "RestartWorker", model, crewResponder: true },
      "ws://unused",
      null,
    ) as unknown as Internals;
    i.platformMemory = new PlatformMemoryBackend(client as MarinaClient);
    i.platformMemory.workInbox = async () => ({ success: true, text: "" });
    i.client.capabilities = async () => ({
      schema: "marina.capabilities.v1",
      revision: 1,
      commands: [],
    });
    i.autonomousMode = true;
    i.agent.transformContext = undefined;
    i.agent.prepareNextTurnWithContext = undefined;
    i.agent.getApiKey = () => undefined;
    return i;
  };
  return {
    makeAdapter,
    before(fn: typeof beforeOperation) {
      beforeOperation = fn;
    },
    reopen() {
      db.close();
      db = new MarinaDB(path, { durability: "full" });
    },
    [Symbol.dispose]() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("an unanswered intake survives a database reopen and a model change, including new boot arrivals", async () => {
  using f = fixture();
  const first = f.makeAdapter();
  first.client.emit("perception", incoming("Check these exact source ranges [re:first1]"));
  await first.flushOutstandingRequests();
  // No model turn or periodic/stop checkpoint was needed to persist the request.
  f.reopen();
  const next = f.makeAdapter("ollama/small-local");
  next.client.emit("perception", incoming("A second request during boot [re:second2]"));
  await next.flushOutstandingRequests();
  await next.loadCheckpointSummary();
  const requests = next.outstandingRequests.entries();
  expect(requests).toHaveLength(2);
  expect(new Set(requests.map((r) => r.id)).size).toBe(2);
  expect(next.outstandingRequests.presentedIds().size).toBe(0);
  const prompt = await next.buildContinuationPrompt();
  expect(prompt).toContain("exact source ranges");
  expect(prompt).toContain("[re:first1]");
  expect(prompt).toContain("[re:second2]");
  expect(next.outstandingRequests.presentedIds().size).toBe(2);
});

for (const failCommit of [false, true])
  it(`reply settlement and tool journal commit together across restart (failure=${failCommit})`, async () => {
    using f = fixture();
    const i = f.makeAdapter();
    const original = incoming("Report findings [re:report1]");
    original.data.messageId = "original";
    i.client.emit("perception", original);
    await i.flushOutstandingRequests();
    const prompt = await i.buildContinuationPrompt();
    i.setupActionTracking();
    let effects = 0,
      calls = 0;
    i.agent.state.tools = [
      {
        name: "reply",
        label: "reply",
        description: "deliver response",
        parameters: Type.Object({}),
        execute: async () => {
          effects++;
          return {
            content: [{ type: "text", text: "delivered" }],
            details: {
              deliveries: [{ kind: "tell", target: "Boss", message: "findings [re:report1]" }],
            },
          };
        },
      },
    ];
    f.before(async (request) => {
      const data = request.input?.data as Record<string, unknown> | undefined;
      if (
        request.operation === "save_checkpoint" &&
        data?.journal &&
        readRequestLedger(data.outstandingRequests).length === 0
      ) {
        if (failCommit) throw new Error("checkpoint storage unavailable");
        // A new perception while the old reply's commit is in progress must survive it.
        i.client.emit("perception", original);
        i.client.emit("perception", incoming("Next request [re:later2]"));
        f.before(undefined);
      }
    });
    i.agent.streamFunction = async (model) => {
      calls++;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: calls,
        content:
          calls === 1
            ? [{ type: "toolCall", name: "reply", id: "reply-1", arguments: {} }]
            : [{ type: "text", text: "done" }],
        stopReason: calls === 1 ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: calls === 1 ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    };
    await i.agent.prompt(prompt);
    await i.agent.waitForIdle();
    await i.flushOutstandingRequests();
    expect(effects).toBe(1);
    if (failCommit) expect(calls).toBe(1);
    f.before(undefined);
    f.reopen();
    const restored = f.makeAdapter();
    await restored.loadCheckpointSummary();
    expect(restored.outstandingRequests.entries().map((r) => r.correlation)).toEqual(
      failCommit ? ["report1"] : ["later2"],
    );
    if (!failCommit) expect((await restored.platformMemory.getCheckpoint())?.journal).toBeDefined();
  });

it("failed intake writes prevent prompt consumption, retry without loss, and corrupt ledgers fail closed", async () => {
  using f = fixture();
  const i = f.makeAdapter();
  f.before(async (request) => {
    if (request.operation === "save_checkpoint") throw new Error("storage unavailable");
  });
  i.client.emit("perception", incoming("Do not lose this [re:retry1]"));
  expect(await i.buildContinuationPrompt().catch((e) => e.message)).toContain(
    "storage unavailable",
  );
  expect(i.outstandingRequests.presentedIds().size).toBe(0);
  f.before(undefined);
  expect(await i.buildContinuationPrompt()).toContain("Do not lose this");
  f.reopen();
  const next = f.makeAdapter();
  await next.loadCheckpointSummary();
  expect(next.outstandingRequests.size).toBe(1);
  await next.platformMemory.saveCheckpoint({ outstandingRequests: { version: 999, requests: [] } });
  expect(
    await f
      .makeAdapter()
      .loadCheckpointSummary()
      .catch((e) => e.message),
  ).toContain("Invalid outstanding-request checkpoint");
});
