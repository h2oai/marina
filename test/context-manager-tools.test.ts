// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The compactor counts tool schemas in its fixed prefix, anchors on
 * provider-reported usage when available, and cuts truncated text where its
 * own estimate says the budget ends.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  computeContextBudget,
  createContextManager,
  effectivePromptWindow,
  estimateMessageTokens,
  estimateToolSchemaTokens,
  truncateOversizedToolResults,
} from "../src/agent/context-manager";
import { maxToolResultTokensForWindow } from "../src/engine/constants";
import { scopeProcessState } from "./process-state";

function fakeTools(totalBytes: number, count = 12): AgentTool[] {
  const per = Math.floor(totalBytes / count);
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${i}`,
    label: `Tool ${i}`,
    description: "d".repeat(Math.max(0, per - 120)),
    parameters: Type.Object({ a: Type.String({ description: "x".repeat(40) }) }),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  }));
}

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}
function assistant(text: string, usageTotal?: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "m",
    usage: {
      input: usageTotal ?? 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usageTotal ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

// contextWindow 8448 with no output reservation → 8448 − max(256, 2%) = 8192.
const model8k = { contextWindow: 8448, maxTokens: 0 } as never;

describe("computeContextBudget", () => {
  it("has an 8k effective window for the fixture model", () => {
    expect(effectivePromptWindow(model8k)).toBe(8192);
  });

  it("charges 36 KB of tool schemas against the message budget", () => {
    const tools = fakeTools(36_000);
    const toolTokens = estimateToolSchemaTokens(tools);
    expect(toolTokens).toBeGreaterThan(9000); // 36 KB / 3 chars per token ≈ 12k
    const messages = [user("hello"), assistant("hi")];
    const bare = computeContextBudget({
      model: model8k,
      systemPrompt: "sys",
      messages,
      targetRatio: 0.6,
    });
    const withTools = computeContextBudget({
      model: model8k,
      systemPrompt: "sys",
      tools,
      messages,
      targetRatio: 0.6,
    });
    expect(withTools.toolTokens).toBe(toolTokens);
    expect(withTools.fixedTokens).toBe(bare.fixedTokens + toolTokens);
    expect(withTools.budgetForMessages).toBe(bare.budgetForMessages - toolTokens);
    // 36 KB of schemas does not fit an 8k window at all — the compactor must
    // see that, where before it saw a nearly empty context.
    expect(withTools.budgetForMessages).toBeLessThan(0);
    expect(withTools.usageRatio).toBeGreaterThan(1);
    expect(bare.usageRatio).toBeLessThan(0.1);
  });

  it("anchors on provider-reported usage when the transcript carries it", () => {
    const messages = [user("q1"), assistant("a1", 5000), user("q2 ".repeat(100))];
    const budget = computeContextBudget({
      model: model8k,
      systemPrompt: "sys",
      messages,
      targetRatio: 0.6,
    });
    expect(budget.usageAnchored).toBe(true);
    const trailing = estimateMessageTokens(messages[2]!);
    expect(budget.totalTokens).toBe(5000 + trailing);
  });
});

describe("createContextManager with getTools", () => {
  it("compacts a transcript that only overflows once tool schemas are counted", async () => {
    const messages: AgentMessage[] = [user("bootstrap")];
    for (let i = 0; i < 12; i++) {
      messages.push(user(`turn ${i} ${"y".repeat(200)}`));
      messages.push(assistant(`reply ${i} ${"z".repeat(200)}`));
    }
    const bare = createContextManager({ getModel: () => model8k, getSystemPrompt: () => "sys" });
    const counted = createContextManager({
      getModel: () => model8k,
      getSystemPrompt: () => "sys",
      getTools: () => fakeTools(36_000),
    });
    const untouched = await bare(messages);
    expect(untouched.length).toBe(messages.length);
    const compacted = await counted(messages);
    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted.length).toBeLessThanOrEqual(5);
  });
});

describe("truncation cut consistency", () => {
  it("cuts oversized tool results where the estimate says the budget ends", () => {
    const big: AgentMessage = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "marina_command",
      content: [{ type: "text", text: "r".repeat(10_000) }],
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage;
    const [out] = truncateOversizedToolResults([big], 100);
    const text = (out as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("[...truncated");
    // Re-estimating the truncated result lands at the budget (+ suffix), not
    // ~20 % over it as with the old `*4/1.1` cut.
    expect(estimateMessageTokens(out!)).toBeLessThanOrEqual(100 + 40);
    expect(text).toContain("incomplete output");
    expect(truncateOversizedToolResults([out!], 100)[0]).toBe(out);
  });
});

describe("model-aware tool result allowance", () => {
  const evidence = JSON.stringify({
    records: Array.from({ length: 8 }, (_, i) => ({
      id: `record_${i}`,
      version: 1,
      content: "Verified deployment evidence with a reproducible check. ".repeat(25),
      sources: [{ id: `source_${i}`, range: { start: i * 100, end: i * 100 + 99 } }],
    })),
  });
  const result: AgentMessage = {
    role: "toolResult",
    toolCallId: "retrieve_1",
    toolName: "memory_retrieve",
    content: [{ type: "text", text: evidence }],
    isError: false,
    timestamp: 1,
  };
  const resultText = (message: AgentMessage) =>
    (message as { content: Array<{ text: string }> }).content[0]!.text;

  it("keeps realistic retrieval evidence intact at 128k and adapts when the live window shrinks", async () => {
    using _state = scopeProcessState({ env: { MARINA_MAX_TOOL_RESULT_TOKENS: undefined } });
    let window = 128_000;
    const archived: AgentMessage[][] = [];
    const transform = createContextManager({
      getModel: () => ({ contextWindow: window, maxTokens: 0 }) as never,
      getSystemPrompt: () => "sys",
      onBeforeCompact: (messages) => {
        archived.push(messages);
      },
    });
    expect(estimateMessageTokens(result)).toBeGreaterThan(2000);
    const large = await transform([result]);
    expect(JSON.parse(resultText(large[0]!))).toEqual(JSON.parse(evidence));
    expect(archived).toHaveLength(0);
    window = 8448;
    const small = await transform([result]);
    expect(resultText(small[0]!)).toContain("incomplete output");
    expect(estimateMessageTokens(small[0]!)).toBeLessThanOrEqual(2020);
    expect(resultText(archived[0]![0]!)).toBe(evidence);
    expect(resultText(result)).toBe(evidence);
  });

  it("honors the env override, with explicit per-manager configuration taking precedence", async () => {
    using _state = scopeProcessState({ env: { MARINA_MAX_TOOL_RESULT_TOKENS: "2500" } });
    const options = {
      getModel: () => ({ contextWindow: 128_000, maxTokens: 0 }) as never,
      getSystemPrompt: () => "sys",
    };
    expect(resultText((await createContextManager(options)([result]))[0]!)).toContain("truncated");
    const explicit = createContextManager({ ...options, maxToolResultTokens: 8000 });
    expect(resultText((await explicit([result]))[0]!)).toBe(evidence);
  });

  it("rejects invalid environment caps instead of disabling truncation", () => {
    for (const value of ["0", "-4", "NaN", "Infinity", "invalid"]) {
      expect(maxToolResultTokensForWindow(8000, { MARINA_MAX_TOOL_RESULT_TOKENS: value })).toBe(
        2000,
      );
    }
  });
});

describe("short history compaction", () => {
  it("never emits the first message twice when the history is shorter than keepRecent", async () => {
    // A tiny effective window forces compaction on a 3-message history: the
    // first message is pinned AND used to fall inside the recent window, so it
    // appeared twice. Same shape with a 1-message history must not blow up.
    const tiny = { contextWindow: 600, maxTokens: 0 } as never;
    const manager = createContextManager({
      getModel: () => tiny,
      getSystemPrompt: () => "sys",
      getTools: () => fakeTools(1_200, 3),
    });
    const three: AgentMessage[] = [
      user(`bootstrap ${"b".repeat(300)}`),
      user(`q ${"y".repeat(300)}`),
      assistant(`a ${"z".repeat(300)}`),
    ];
    const out = await manager(three);
    const firsts = out.filter(
      (m) =>
        m.role === "user" && typeof m.content === "string" && m.content.startsWith("bootstrap"),
    );
    expect(firsts.length).toBe(1);
    expect(out.length).toBeLessThanOrEqual(three.length + 1); // + at most one summary
    const one = await manager([user(`only ${"o".repeat(400)}`)]);
    expect(one.length).toBe(1);
  });
});
