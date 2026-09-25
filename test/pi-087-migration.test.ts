// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * pi-agent-core 0.86/0.87 moved the system prompt and tool declarations into
 * the transcript as `system` messages and replaced `shouldStopAfterTurn` with
 * `finishTurn`. These pin Marina's adaptations.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createContextManager } from "../src/agent/context-manager";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { MAX_TURNS_PER_PROMPT } from "../src/engine/constants";

const model8k = {
  id: "m",
  name: "m",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "http://x",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 1_000,
} as unknown as Model<string>;

const system = (content: string): AgentMessage =>
  ({ role: "system", content, timestamp: 1 }) as AgentMessage;
const user = (text: string): AgentMessage =>
  ({ role: "user", content: text, timestamp: Date.now() }) as AgentMessage;
const assistant = (text: string): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  }) as unknown as AgentMessage;

describe("compaction keeps transcript system messages", () => {
  it("compacts the conversation only, with every system message leading the result", async () => {
    const prompt = system("You are here.");
    const toolNotice = system("tool announcement");
    const messages: AgentMessage[] = [prompt, user("bootstrap")];
    for (let i = 0; i < 20; i++) {
      messages.push(
        user(`turn ${i} ${"y".repeat(400)}`),
        assistant(`reply ${i} ${"z".repeat(400)}`),
      );
      if (i === 5) messages.push(toolNotice);
    }
    const manager = createContextManager({ getModel: () => model8k, getSystemPrompt: () => "sys" });
    const out = await manager(messages);
    expect(out.length).toBeLessThan(messages.length);
    expect(out[0]).toBe(prompt);
    expect(out[1]).toBe(toolNotice);
    expect(out.slice(2).some((m) => m.role === "system")).toBe(false);
  });

  it("returns the original array untouched when nothing needs compacting (stable prefix)", async () => {
    const messages = [
      system("You are here."),
      user("hi"),
      assistant("hello"),
      system("late notice"),
    ];
    const manager = createContextManager({ getModel: () => model8k, getSystemPrompt: () => "sys" });
    expect(await manager(messages)).toBe(messages);
  });
});

describe("LeanAgentAdapter on pi-agent-core 0.87", () => {
  type Internals = {
    agent: {
      state: { systemPrompt: string; messages: AgentMessage[] };
      finishTurn?: (turn: unknown) => unknown;
    };
    currentPromptTurns: number;
  };

  it("setSystemPrompt replaces the leading system message instead of appending one", () => {
    const adapter = new LeanAgentAdapter(
      { name: "prompt-probe" } as never,
      "ws://127.0.0.1:3300",
      null,
    );
    const i = adapter as unknown as Internals;
    const before = i.agent.state.messages.length;
    expect(i.agent.state.messages[0]?.role).toBe("system");
    adapter.setSystemPrompt("replacement prompt");
    expect(i.agent.state.systemPrompt).toBe("replacement prompt");
    expect(i.agent.state.messages.length).toBe(before);
    expect(i.agent.state.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("finishTurn ends the run once the per-prompt turn cap is reached", () => {
    const adapter = new LeanAgentAdapter(
      { name: "cap-probe" } as never,
      "ws://127.0.0.1:3300",
      null,
    );
    const i = adapter as unknown as Internals;
    i.currentPromptTurns = MAX_TURNS_PER_PROMPT - 1;
    expect(i.agent.finishTurn?.({})).toBeUndefined();
    i.currentPromptTurns = MAX_TURNS_PER_PROMPT;
    expect(i.agent.finishTurn?.({})).toEqual({ action: "end" });
  });
});
