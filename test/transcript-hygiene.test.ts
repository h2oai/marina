// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator transcript hygiene: the absolute conversation cap
 * (`MARINA_AGENT_CONTEXT_CAP_TOKENS`) and dropping reasoning blocks from
 * earlier runs (`MARINA_DROP_OLD_THINKING_SIGNATURES`). Both are on by
 * default and leave the transcript untouched when set `off`.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ContextPersistenceError,
  conversationTokenCap,
  conversationTokens,
  createContextManager,
  DEFAULT_CONVERSATION_CAP_TOKENS,
  hasCompletedRun,
  MIN_CONVERSATION_CAP_TOKENS,
} from "../src/agent/context-manager";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { dropOldThinking, dropOldThinkingEnabled } from "../src/agent/transcript-hygiene";
import { scopeProcessState } from "./process-state";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}
function system(text: string): AgentMessage {
  return { role: "system", content: text, timestamp: 1 } as AgentMessage;
}
function assistant(
  content: Array<Record<string, unknown>>,
  api = "anthropic-messages",
): AgentMessage {
  return {
    role: "assistant",
    content,
    api,
    provider: "p",
    model: "m",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  } as unknown as AgentMessage;
}
const thinking = { type: "thinking", thinking: "plan", thinkingSignature: "s".repeat(4000) };
const text = (t: string) => ({ type: "text", text: t });

// A 1M-token window: the ratio threshold never fires in these fixtures.
const bigModel = { contextWindow: 1_000_000, maxTokens: 0 } as never;

function longConversation(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [system("sys"), user("bootstrap")];
  for (let i = 0; i < turns; i++) {
    messages.push(user(`turn ${i} ${"y".repeat(3000)}`));
    messages.push(assistant([text(`reply ${i} ${"z".repeat(3000)}`)], "openai-completions"));
  }
  return messages;
}

describe("conversationTokenCap", () => {
  it("defaults on at 48k with a third as target; 0/off disables; explicit values win", () => {
    const fallback = {
      capTokens: DEFAULT_CONVERSATION_CAP_TOKENS,
      targetTokens: Math.floor(DEFAULT_CONVERSATION_CAP_TOKENS / 3),
      explicit: false,
    };
    expect(conversationTokenCap({})).toEqual(fallback);
    expect(conversationTokenCap({ MARINA_AGENT_CONTEXT_CAP_TOKENS: "" })).toEqual(fallback);
    // Junk never lifts the cap.
    expect(conversationTokenCap({ MARINA_AGENT_CONTEXT_CAP_TOKENS: "junk" })).toEqual(fallback);
    expect(conversationTokenCap({ MARINA_AGENT_CONTEXT_CAP_TOKENS: "0" })).toBeUndefined();
    expect(conversationTokenCap({ MARINA_AGENT_CONTEXT_CAP_TOKENS: "off" })).toBeUndefined();
    expect(conversationTokenCap({ MARINA_AGENT_CONTEXT_CAP_TOKENS: "false" })).toBeUndefined();
    expect(conversationTokenCap({ MARINA_AGENT_CONTEXT_CAP_TOKENS: "96000" })).toEqual({
      capTokens: 96_000,
      targetTokens: 32_000,
      explicit: true,
    });
    expect(
      conversationTokenCap({
        MARINA_AGENT_CONTEXT_CAP_TOKENS: "48000",
        MARINA_AGENT_CONTEXT_TARGET_TOKENS: "20000",
      }),
    ).toEqual({ capTokens: 48_000, targetTokens: 20_000, explicit: true });
    // A target at or above the cap would never shrink anything: fall back.
    expect(
      conversationTokenCap({
        MARINA_AGENT_CONTEXT_CAP_TOKENS: "48000",
        MARINA_AGENT_CONTEXT_TARGET_TOKENS: "60000",
      })?.targetTokens,
    ).toBe(16_000);
    // The default target applies to the default cap too.
    expect(
      conversationTokenCap({ MARINA_AGENT_CONTEXT_TARGET_TOKENS: "12000" })?.targetTokens,
    ).toBe(12_000);
  });

  it("floors a tiny explicit cap", () => {
    expect(conversationTokenCap({ MARINA_AGENT_CONTEXT_CAP_TOKENS: "500" })?.capTokens).toBe(
      MIN_CONVERSATION_CAP_TOKENS,
    );
  });
});

describe("hasCompletedRun", () => {
  it("needs an assistant turn before the latest prompt", () => {
    expect(hasCompletedRun([])).toBe(false);
    expect(hasCompletedRun([system("sys"), user("p1")])).toBe(false);
    expect(hasCompletedRun([user("p1"), assistant([text("a1")])])).toBe(false);
    expect(hasCompletedRun([user("p1"), assistant([text("a1")]), user("p2")])).toBe(true);
  });
});

describe("absolute conversation cap", () => {
  it("leaves a long conversation alone without a cap", async () => {
    const messages = longConversation(30);
    const transform = createContextManager({
      getModel: () => bigModel,
      getSystemPrompt: () => "sys",
    });
    expect(await transform(messages)).toBe(messages);
  });

  it("compacts to the target once the cap is reached, archiving first and keeping system messages", async () => {
    const messages = longConversation(30);
    expect(conversationTokens(messages)).toBeGreaterThan(20_000);
    const archived: number[] = [];
    const transform = createContextManager({
      getModel: () => bigModel,
      getSystemPrompt: () => "sys",
      getTokenCap: () => ({ capTokens: 20_000, targetTokens: 8_000, explicit: true }),
      onBeforeCompact: (original) => {
        archived.push(original.length);
      },
    });
    const compacted = await transform(messages);
    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted[0]).toBe(messages[0]!);
    expect(compacted.filter((m) => m.role === "system")).toHaveLength(1);
    expect(conversationTokens(compacted)).toBeLessThanOrEqual(8_000 * 1.2);
    expect(archived).toEqual([messages.length - 1]);
    // Under the cap, the compacted history passes through unchanged.
    expect(await transform(compacted)).toBe(compacted);
  });

  it("a failed archive keeps the original history (ContextPersistenceError)", async () => {
    const transform = createContextManager({
      getModel: () => bigModel,
      getSystemPrompt: () => "sys",
      getTokenCap: () => ({ capTokens: 20_000, targetTokens: 8_000, explicit: true }),
      onBeforeCompact: () => {
        throw new Error("disk full");
      },
    });
    await expect(transform(longConversation(30))).rejects.toBeInstanceOf(ContextPersistenceError);
  });
});

describe("dropOldThinking", () => {
  it("is on by default; off/false/0 disables", () => {
    expect(dropOldThinkingEnabled({})).toBe(true);
    expect(dropOldThinkingEnabled({ MARINA_DROP_OLD_THINKING_SIGNATURES: "on" })).toBe(true);
    expect(dropOldThinkingEnabled({ MARINA_DROP_OLD_THINKING_SIGNATURES: "off" })).toBe(false);
    expect(dropOldThinkingEnabled({ MARINA_DROP_OLD_THINKING_SIGNATURES: "false" })).toBe(false);
    expect(dropOldThinkingEnabled({ MARINA_DROP_OLD_THINKING_SIGNATURES: "0" })).toBe(false);
  });

  it("drops reasoning from earlier runs and keeps the latest run intact", () => {
    const old = assistant([thinking, text("a1")]);
    const latest = assistant([thinking, { type: "toolCall", id: "c1", name: "t", arguments: {} }]);
    const messages = [system("sys"), user("p1"), old, user("p2"), latest];
    const result = dropOldThinking(messages);
    expect(result).not.toBe(messages);
    expect((result[2] as { content: unknown[] }).content).toEqual([text("a1")]);
    expect(result[4]).toBe(latest);
    expect(result[0]).toBe(messages[0]!);
  });

  it("skips Responses-API messages, whose items are paired with their reasoning item", () => {
    const old = assistant([thinking, text("a1")], "openai-responses");
    const messages = [user("p1"), old, user("p2")];
    expect(dropOldThinking(messages)).toBe(messages);
  });

  it("keeps a reasoning-only message rather than leaving it empty", () => {
    const messages = [user("p1"), assistant([thinking]), user("p2")];
    expect(dropOldThinking(messages)).toBe(messages);
  });

  it("returns the same array when there is nothing to drop", () => {
    const messages = [user("p1"), assistant([text("a1")]), user("p2")];
    expect(dropOldThinking(messages)).toBe(messages);
  });
});

describe("between-prompt hygiene in the adapter", () => {
  type Internals = {
    agent: { state: { messages: AgentMessage[] } };
    tidyTranscriptBeforePrompt(): Promise<void>;
  };
  const make = () =>
    new LeanAgentAdapter(
      { name: "Tidy", model: "marina/default" },
      "ws://unused",
      null,
    ) as unknown as Internals;

  it("drops old reasoning by default and leaves the history alone when off", async () => {
    const messages = [user("p1"), assistant([thinking, text("a1")]), user("p2")];
    {
      using _state = scopeProcessState({ env: { MARINA_DROP_OLD_THINKING_SIGNATURES: "off" } });
      const i = make();
      i.agent.state.messages = messages;
      await i.tidyTranscriptBeforePrompt();
      expect(i.agent.state.messages).toEqual(messages);
    }
    {
      using _state = scopeProcessState({
        env: { MARINA_DROP_OLD_THINKING_SIGNATURES: undefined },
      });
      const i = make();
      i.agent.state.messages = messages;
      await i.tidyTranscriptBeforePrompt();
      const kept = i.agent.state.messages.find((m) => m.role === "assistant") as {
        content: unknown[];
      };
      expect(kept.content).toEqual([text("a1")]);
    }
  });

  type CapInternals = Internals & {
    activeCodingTask: string | null;
    tokenCapFor(
      messages: readonly AgentMessage[],
      opts?: { betweenPrompts?: boolean },
    ): { capTokens: number } | undefined;
  };
  const done = [user("p1"), assistant([text("a1")]), user("p2")];

  it("applies the default cap after the first run, never during it", () => {
    using _state = scopeProcessState({ env: { MARINA_AGENT_CONTEXT_CAP_TOKENS: undefined } });
    const i = make() as unknown as CapInternals;
    expect(i.tokenCapFor([user("p1")])).toBeUndefined();
    expect(i.tokenCapFor(done)?.capTokens).toBe(DEFAULT_CONVERSATION_CAP_TOKENS);
  });

  it("caps a bound coder after work starts, including tool turns in its first prompt", () => {
    {
      using _state = scopeProcessState({ env: { MARINA_AGENT_CONTEXT_CAP_TOKENS: undefined } });
      const i = make() as unknown as CapInternals;
      i.activeCodingTask = "fix the parser";
      expect(i.tokenCapFor([user("fix the parser")])).toBeUndefined();
      expect(
        i.tokenCapFor([
          user("fix the parser"),
          assistant([
            {
              type: "toolCall",
              id: "read-1",
              name: "marina_code",
              arguments: { action: "read", path: "source.ts" },
            },
          ]),
        ])?.capTokens,
      ).toBe(DEFAULT_CONVERSATION_CAP_TOKENS);
      expect(i.tokenCapFor(done)?.capTokens).toBe(DEFAULT_CONVERSATION_CAP_TOKENS);
    }
    {
      using _state = scopeProcessState({ env: { MARINA_AGENT_CONTEXT_CAP_TOKENS: "64000" } });
      const i = make() as unknown as CapInternals;
      i.activeCodingTask = "fix the parser";
      expect(i.tokenCapFor(done)?.capTokens).toBe(64_000);
    }
  });

  it("off disables the cap for every agent", () => {
    using _state = scopeProcessState({ env: { MARINA_AGENT_CONTEXT_CAP_TOKENS: "off" } });
    expect((make() as unknown as CapInternals).tokenCapFor(done)).toBeUndefined();
  });

  it("repeatedly compacts a first coding task without losing its request or unarchived evidence", async () => {
    using _state = scopeProcessState({
      env: { MARINA_AGENT_CONTEXT_CAP_TOKENS: "20000", MARINA_AGENT_CONTEXT_TARGET_TOKENS: "8000" },
    });
    const adapter = make() as unknown as CapInternals;
    adapter.activeCodingTask = "Task #1; full request: code show task_run_test";
    const request = user(adapter.activeCodingTask);
    const prefix = system("Authority and trust remain unchanged");
    const archived = new Set<AgentMessage>();
    let compactions = 0;
    const transform = createContextManager({
      getModel: () => bigModel,
      getSystemPrompt: () => "Authority and trust remain unchanged",
      getTokenCap: (messages) =>
        adapter.tokenCapFor(messages) as ReturnType<typeof conversationTokenCap>,
      onBeforeCompact: (messages) => {
        compactions++;
        for (const message of messages) archived.add(message);
      },
    });
    const evidence: AgentMessage[] = [];
    let working = [prefix, request];
    for (let turn = 0; turn < 100; turn++) {
      const call = assistant([
        {
          type: "toolCall",
          id: `read-${turn}`,
          name: "marina_code",
          arguments: { action: "read", path: `src/module-${turn}.ts` },
        },
      ]);
      const result = {
        role: "toolResult",
        toolCallId: `read-${turn}`,
        toolName: "marina_code",
        content: [{ type: "text", text: `Evidence ${turn}: ${"x".repeat(5000)}` }],
        isError: false,
        timestamp: turn,
      } as AgentMessage;
      evidence.push(call, result);
      working = await transform([...working, call, result]);
      expect(working[0]).toBe(prefix);
      expect(working).toContain(request);
      expect(working).toContain(result);
      expect(conversationTokens(working)).toBeLessThan(22_000);
    }
    expect(compactions).toBeGreaterThan(2);
    for (const message of evidence)
      expect(archived.has(message) || working.includes(message)).toBe(true);
  });
});
