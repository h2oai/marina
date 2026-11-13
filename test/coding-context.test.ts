// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import type { Agent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { isCodingTaskMessage } from "../src/agent/coding-context";
import {
  ContextPersistenceError,
  createContextManager,
  effectivePromptWindow,
  isContextSummaryMessage,
} from "../src/agent/context-manager";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import type { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { piModels } from "../src/agent/pi-models";
import { scopeProcessState } from "./process-state";

const task = `  Fix the parser without changing its public API.\n${"Keep constraints. ".repeat(100)}\nRun the focused checks; do not commit.  `;
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const model = { contextWindow: 128_000, maxTokens: 16_384 } as never;

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "fixture",
    stopReason: "toolUse",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function history(): AgentMessage[] {
  return [
    user("bootstrap before the task was assigned"),
    user(task),
    assistant([
      { type: "text", text: "Keep the public API. Next read the regression fixture." },
      {
        type: "toolCall",
        id: "edit-1",
        name: "marina_code",
        arguments: { action: "edit", path: "src/parser.ts" },
      },
      {
        type: "toolCall",
        id: "read-1",
        name: "marina_code",
        arguments: { action: "read", path: "test/parser.test.ts" },
      },
      {
        type: "toolCall",
        id: "read-2",
        name: "marina_code_read_file",
        arguments: { path: "src/tokens.ts" },
      },
      {
        type: "toolCall",
        id: "patch-1",
        name: "marina_code_patch",
        arguments: { diff: "--- /dev/null\n+++ b/test/regression.test.ts\n@@ -0,0 +1 @@\n+test" },
      },
      {
        type: "toolCall",
        id: "decision-1",
        name: "marina_code_decision",
        arguments: { text: "Use the existing tokenizer to preserve compatibility." },
      },
    ]),
    ...Array.from({ length: 16 }, (_, n) => user(`Completed observation ${n}`)),
  ];
}

function expectTask(messages: AgentMessage[], expected = task) {
  const reminders = messages.filter(isCodingTaskMessage);
  expect(reminders).toHaveLength(1);
  expect(reminders[0]!.content).toBe(`[Active Coding Task]\n${expected}`);
}

describe("coding task continuity through compaction", () => {
  it("replays the exact task after repeated reductions, independently of the summary model", async () => {
    let active: string | null = task;
    const prefix: AgentMessage = { role: "system", content: "stable identity", timestamp: 1 };
    const transform = createContextManager({
      getModel: () => model,
      getSystemPrompt: () => "stable identity",
      getActiveCodingTask: () => active,
      summarizeWithLLM: async () => "A summary that omitted the task entirely.",
    });
    let messages = [prefix, ...history()];
    for (let i = 0; i < 3; i++) {
      messages = await transform(messages, undefined, { force: true });
      expectTask(messages);
      expect(messages[0]).toBe(prefix);
      expect(messages.filter((m) => m.role === "system")).toEqual([prefix]);
      expect(await transform(messages)).toBe(messages);
      messages.push(...Array.from({ length: 15 }, () => user("More progress")));
    }
    active = "A replacement task with different constraints";
    messages = await transform(messages);
    expectTask(messages, active);
    active = null;
    expect((await transform(messages)).some(isCodingTaskMessage)).toBe(false);
  });

  it("keeps structured coding progress when the summary provider is unavailable", async () => {
    const transform = createContextManager({
      getModel: () => model,
      getSystemPrompt: () => "sys",
      getActiveCodingTask: () => task,
      summarizeWithLLM: async () => {
        throw new Error("provider unavailable");
      },
    });
    const messages = await transform(history(), undefined, { force: true });
    const summary = messages.find(isContextSummaryMessage)?.content;
    expect(summary).toContain("Task:");
    expect(summary).toContain("Constraints:");
    expect(summary).toContain("Files read (requested): test/parser.test.ts");
    expect(summary).toContain("Files modified (attempted; confirm results): src/parser.ts");
    expect(summary).toContain("src/tokens.ts");
    expect(summary).toContain("test/regression.test.ts");
    expect(summary).not.toContain("/dev/null");
    expect(summary).toContain("Use the existing tokenizer to preserve compatibility.");
    expect(summary).toContain("Keep the public API. Next read the regression fixture.");
    expect(summary).toContain("Next step:");
    expectTask(messages);
  });

  it("uses the usable model window and preserves the task even during emergency compaction", async () => {
    let archives = 0;
    const transform = createContextManager({
      getModel: () => model,
      getSystemPrompt: () => "sys",
      getActiveCodingTask: () => task,
      onBeforeCompact: () => {
        archives++;
      },
    });
    const messages = [...history(), ...Array.from({ length: 20 }, () => user("x".repeat(14_000)))];
    // ~94k tokens: above the resident cap and 0.8 ratio, below the coder reserve.
    expect(effectivePromptWindow(model)).toBe(109_056);
    expect(await transform(messages)).toBe(messages);
    expect(archives).toBe(0);
    messages.push(user("x".repeat(80_000)));
    const compacted = await transform(messages);
    expect(archives).toBe(1);
    expectTask(compacted);
    expect(compacted.some(isContextSummaryMessage)).toBe(true);
    expect(compacted.length).toBeLessThan(messages.length);
  });

  it("keeps the original transcript when archival fails", async () => {
    const messages = history();
    const original = messages.slice();
    const transform = createContextManager({
      getModel: () => model,
      getSystemPrompt: () => "sys",
      getActiveCodingTask: () => task,
      onBeforeCompact: () => {
        throw new Error("archive offline");
      },
    });
    await expect(transform(messages, undefined, { force: true })).rejects.toBeInstanceOf(
      ContextPersistenceError,
    );
    expect(messages).toEqual(original);
  });

  it("protects the task when only a large tool result is truncated below the compaction threshold", async () => {
    const transform = createContextManager({
      getModel: () => model,
      getSystemPrompt: () => "sys",
      getActiveCodingTask: () => task,
      maxToolResultTokens: 100,
    });
    const call = assistant([
      { type: "toolCall", id: "read", name: "marina_code", arguments: { action: "read" } },
    ]);
    const result: AgentMessage = {
      role: "toolResult",
      toolCallId: "read",
      toolName: "marina_code",
      content: [{ type: "text", text: "code".repeat(2000) }],
      isError: false,
      timestamp: 1,
    };
    const reduced = await transform([user("bootstrap"), call, result]);
    expectTask(reduced);
    expect(JSON.stringify(reduced)).toContain("incomplete output");
    expect(reduced.some(isContextSummaryMessage)).toBe(false);
  });

  it("a live coder sees its task on the next model call after a large file read", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: {
        MARINA_AGENT_CONTEXT_CAP_TOKENS: "8000",
        MARINA_AGENT_CONTEXT_TARGET_TOKENS: "4000",
      },
    });
    const adapter = new LeanAgentAdapter(
      { name: "task-preserving-coder", model: "marina/default", contextWindow: 128_000 },
      "ws://127.0.0.1:3300",
      null,
    );
    const i = adapter as unknown as {
      agent: Agent;
      platformMemory: PlatformMemoryBackend;
      tidyTranscriptBeforePrompt(): Promise<void>;
      metrics: { midRunCompactions: number };
    };
    let archives = 0;
    i.platformMemory.archiveContext = async () => {
      archives++;
    };
    const summaryRequests: { system?: string; taskPresent: boolean }[] = [];
    const summary = spyOn(piModels, "completeSimple").mockImplementation(
      async (_model, context) => {
        summaryRequests.push({
          system: context.systemPrompt,
          taskPresent: context.messages.some((m) => m.content === `[Active Coding Task]\n${task}`),
        });
        return {
          ...assistant([{ type: "text", text: "The task text was omitted by the summarizer." }]),
          stopReason: "stop",
        };
      },
    );
    try {
      adapter.setSystemPrompt("stable identity");
      adapter.setActiveCodingTask(task);
      const agent = i.agent;
      const prefix = agent.state.messages[0]!;
      agent.state.messages.push(...history());
      agent.state.tools = [
        {
          name: "probe",
          label: "read file",
          description: "Deterministic large file read",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "source line\n".repeat(5000) }],
            details: {},
          }),
        } as AgentTool,
      ];
      agent.getApiKey = () => undefined;
      let calls = 0;
      agent.streamFunction = async (_model, context) => {
        calls++;
        expect(context.messages[0]).toBe(prefix);
        if (calls === 2) {
          expectTask(context.messages as AgentMessage[]);
          // The original request was summarized away: only the protected copy
          // now supplies its full text, including the final constraint.
          expect(context.messages.some((m) => m.content === task)).toBe(false);
        }
        const message = assistant(
          calls === 1
            ? [{ type: "toolCall", id: "large-read", name: "probe", arguments: {} }]
            : [{ type: "text", text: "The task and its final constraint are still visible." }],
        );
        if (calls === 2) message.stopReason = "stop";
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
        return stream;
      };
      await agent.prompt("Continue the assigned task");
      expect(calls).toBe(2);
      expect(i.metrics.midRunCompactions).toBeGreaterThan(0);
      expect(archives).toBeGreaterThan(0);
      // pi's public state retains the original transcript; the running context
      // above is the reduced projection actually sent to the model.
      expect(agent.state.messages.some((m) => m.content === task)).toBe(true);
      expect(agent.state.messages[0]).toBe(prefix);
      expect(agent.state.systemPrompt).toBe("stable identity");

      // The between-prompt path and explicit/manual compaction use the same protection.
      agent.state.messages.push(
        ...Array.from({ length: 24 }, () => user("more source ".repeat(150))),
      );
      await i.tidyTranscriptBeforePrompt();
      expectTask(agent.state.messages);
      await adapter.compactNow();
      expectTask(agent.state.messages);
      expect(agent.state.messages[0]).toBe(prefix);
      expect(summaryRequests.length).toBeGreaterThan(0);
      for (const request of summaryRequests) {
        expect(request.system).toContain("Files read, Files modified");
        expect(request.system).not.toContain(task);
        expect(request.taskPresent).toBe(true);
      }
    } finally {
      summary.mockRestore();
    }
  });
});
