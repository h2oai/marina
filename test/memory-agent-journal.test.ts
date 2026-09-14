// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { DurableResidentMemory } from "../src/agent/durable-memory";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MarinaClient } from "../src/sdk/client";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";

for (const failResult of [false, true])
  it(`resident tool-result persistence ${failResult ? "halts continuation on storage failure" : "precedes the next model call"}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "marina-tool-journal-"));
    const db = new MarinaDB(join(directory, "memory.db"), { durability: "full" });
    try {
      db.createUser({ id: crypto.randomUUID(), name: "ToolResident" });
      const client = {
        memoryService: async (request: MemoryOperationRequest) => {
          if (
            failResult &&
            request.operation === "capture_batch" &&
            JSON.stringify(request.input).includes("tool-origin-evidence")
          )
            throw new Error("result storage failed");
          return residentMemoryOperation(db, "ToolResident", request);
        },
      };
      const durable = new DurableResidentMemory(client);
      const adapter = new LeanAgentAdapter({ name: "ToolResident" }, "ws://127.0.0.1:3300", null);
      const internal = adapter as unknown as {
        agent: Agent;
        platformMemory: PlatformMemoryBackend;
        setupActionTracking(): void;
      };
      internal.platformMemory = new PlatformMemoryBackend(client as MarinaClient);
      internal.setupActionTracking();
      const agent = internal.agent;
      agent.transformContext = undefined;
      agent.getApiKey = () => undefined;
      let effects = 0,
        calls = 0;
      agent.state.tools = [
        {
          name: "probe",
          label: "probe",
          description: "Deterministic test tool",
          parameters: Type.Object({}),
          execute: async () => {
            effects++;
            return { content: [{ type: "text", text: "tool-origin-evidence" }], details: {} };
          },
        },
      ];
      agent.streamFunction = async (model) => {
        calls++;
        const checkpoint = (await durable.checkpoint())!;
        expect(checkpoint.version).toBe(calls === 1 ? 1 : 3);
        if (calls === 2) {
          const journal = checkpoint.data.journal as { source_ids: string[] };
          let original = "";
          for (const id of journal.source_ids)
            original += (
              (await residentMemoryOperation(db, "ToolResident", { operation: "source_range", id }))
                .result as { text: string }
            ).text;
          expect(JSON.parse(original)[0]).toMatchObject({
            role: "toolResult",
            toolName: "probe",
            content: [{ type: "text", text: "tool-origin-evidence" }],
          });
        }
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 1,
          content:
            calls === 1
              ? [{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }]
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
        return stream;
      };
      await agent.prompt("run the test tool");
      await agent.waitForIdle();
      expect(effects).toBe(1);
      expect(calls).toBe(failResult ? 1 : 2);
      expect((await durable.checkpoint())!.version).toBe(failResult ? 2 : 4);
      if (failResult) {
        expect(agent.state.errorMessage).toContain("result storage failed");
        expect(agent.state.messages.some((message) => message.role === "toolResult")).toBe(true);
      }
    } finally {
      db.close();
      rmSync(directory, { recursive: true });
    }
  });
