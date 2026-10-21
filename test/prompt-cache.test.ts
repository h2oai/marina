// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cache-aware idle handling (`src/agent/prompt-cache.ts`): which providers
 * cache and for how long, cold-turn detection, compaction before a cold turn
 * (incremental, pointers kept), the 1 h static-prefix TTL rewrite, and the
 * opt-in keep-alive with its count/spend bounds.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  CONTEXT_SUMMARY_PREFIX,
  type ConversationTokenCap,
  conversationTokens,
  createContextManager,
  extractPointers,
  isContextSummaryMessage,
  POINTER_PREFIX,
} from "../src/agent/context-manager";
import { type AgentOperatorStatus, LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { piModels } from "../src/agent/pi-models";
import {
  COLD_COMPACT_MIN_SAVING_TOKENS,
  coldCompactionThreshold,
  isColdTurn,
  keepAliveHit,
  keepAlivePolicy,
  PromptCacheTracker,
  parsePromptCacheTtls,
  promptCacheFamily,
  promptCacheTtlMs,
  staticPrefixTtl,
  withStaticPrefixTtl,
} from "../src/agent/prompt-cache";
import { scopeProcessState } from "./process-state";

const MIN = 60_000;
const CAP: ConversationTokenCap = { capTokens: 48_000, targetTokens: 16_000, explicit: false };

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}
function system(text: string): AgentMessage {
  return { role: "system", content: text, timestamp: 1 } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
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
/** ~2k estimated tokens per turn pair. */
function conversation(turns: number, tag = "t"): AgentMessage[] {
  const out: AgentMessage[] = [system("sys"), user("bootstrap")];
  for (let i = 0; i < turns; i++) {
    out.push(user(`${tag} ${i} see https://example.test/${tag}/${i} ${"y".repeat(3000)}`));
    out.push(assistant(`reply ${tag} ${i} wrote note:${100 + i} ${"z".repeat(3000)}`));
  }
  return out;
}
const bigModel = { contextWindow: 1_000_000, maxTokens: 0 } as never;

describe("prompt cache policy", () => {
  it("knows which providers cache, and for how long", () => {
    const m = (provider: string, api = "openai-completions") => ({ provider, api, id: "x" });
    expect(promptCacheFamily(m("anthropic", "anthropic-messages"), {})).toBe("anthropic");
    expect(promptCacheFamily({ ...m("marina"), proxied: true }, {})).toBe("marina");
    expect(
      promptCacheFamily({ ...m("marina"), proxied: true }, { MARINA_AGENT_PROMPT_CACHE: "off" }),
    ).toBeUndefined();
    expect(promptCacheFamily({ ...m("ollama"), local: true }, {})).toBeUndefined();
    expect(promptCacheTtlMs("anthropic", {})).toBe(5 * MIN);
    expect(promptCacheTtlMs("openrouter", {})).toBe(5 * MIN);
    // A provider with no known cache: never cold, unless the operator names it.
    expect(promptCacheTtlMs("deepseek", {})).toBeUndefined();
    expect(promptCacheTtlMs("deepseek", { MARINA_PROMPT_CACHE_TTL: "deepseek=2h" })).toBe(
      120 * MIN,
    );
    expect(promptCacheTtlMs(undefined, {})).toBeUndefined();
  });

  it("parses MARINA_PROMPT_CACHE_TTL: a default, per-family values, off", () => {
    expect(parsePromptCacheTtls("10m,openai=1h,anthropic=off,junk=zz")).toEqual({
      fallback: 10 * MIN,
      families: { openai: 60 * MIN, anthropic: null },
    });
    const env = { MARINA_PROMPT_CACHE_TTL: "10m,anthropic=off" };
    expect(promptCacheTtlMs("anthropic", env)).toBeUndefined();
    expect(promptCacheTtlMs("openai", env)).toBe(10 * MIN);
  });

  it("a turn is cold only after the cache lifetime since the last request", () => {
    const now = 100 * MIN;
    expect(isColdTurn(0, now, 5 * MIN)).toBe(false); // never requested: nothing cached anyway
    expect(isColdTurn(now - 4 * MIN, now, 5 * MIN)).toBe(false);
    expect(isColdTurn(now - 6 * MIN, now, 5 * MIN)).toBe(true);
    expect(isColdTurn(now - 60 * MIN, now, undefined)).toBe(false);
  });

  it("compacts before a cold turn from the cap's target + 8k, below the cap only", () => {
    expect(coldCompactionThreshold(CAP, {})).toBe(16_000 + COLD_COMPACT_MIN_SAVING_TOKENS);
    expect(coldCompactionThreshold(CAP, { MARINA_AGENT_COLD_COMPACT: "off" })).toBeUndefined();
    expect(coldCompactionThreshold(undefined, {})).toBeUndefined();
    expect(coldCompactionThreshold(CAP, { MARINA_AGENT_COLD_COMPACT_MIN_TOKENS: "30000" })).toBe(
      30_000,
    );
    // Never below target + 8k (too little saved), never at the cap (the cap compacts there).
    expect(coldCompactionThreshold(CAP, { MARINA_AGENT_COLD_COMPACT_MIN_TOKENS: "17000" })).toBe(
      24_000,
    );
    expect(
      coldCompactionThreshold(CAP, { MARINA_AGENT_COLD_COMPACT_MIN_TOKENS: "60000" }),
    ).toBeUndefined();
  });

  it("marks only the static prefix with a 1h TTL, on direct Anthropic requests", () => {
    const anthropic = { provider: "anthropic", api: "anthropic-messages" };
    expect(staticPrefixTtl(anthropic, {})).toBe("1h");
    expect(staticPrefixTtl(anthropic, { MARINA_PROMPT_CACHE_STATIC_TTL: "off" })).toBeUndefined();
    expect(
      staticPrefixTtl({ ...anthropic, compat: { supportsLongCacheRetention: false } }, {}),
    ).toBeUndefined();
    expect(staticPrefixTtl({ provider: "marina", api: "openai-completions" }, {})).toBeUndefined();
    expect(staticPrefixTtl({ provider: "openrouter", api: "openai-completions" }, {})).toBe(
      undefined,
    );

    const cc: { type: string; ttl?: string } = { type: "ephemeral" };
    const payload = {
      system: [{ type: "text", text: "sys", cache_control: cc }],
      tools: [{ name: "a" }, { name: "b", cache_control: cc }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: cc }] }],
    };
    const out = withStaticPrefixTtl(payload, "1h") as typeof payload;
    expect(out.system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect((out.tools[1] as { cache_control?: unknown }).cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    expect((out.tools[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    // The conversation keeps the default lifetime and comes last (longer TTLs first).
    expect(out.messages).toBe(payload.messages);
    expect(payload.system[0]!.cache_control).toEqual(cc); // input untouched
    expect(withStaticPrefixTtl(out, "1h")).toBeUndefined(); // idempotent
    expect(withStaticPrefixTtl(payload, undefined)).toBeUndefined();
    expect(withStaticPrefixTtl({ messages: [] }, "1h")).toBeUndefined();
  });

  it("keep-alive is off by default and bounded per gap, per window and per day", () => {
    expect(keepAlivePolicy(5 * MIN, {})).toBeUndefined();
    expect(keepAlivePolicy(undefined, { MARINA_AGENT_CACHE_KEEPALIVE: "on" })).toBeUndefined();
    const policy = keepAlivePolicy(5 * MIN, {
      MARINA_AGENT_CACHE_KEEPALIVE: "on",
      MARINA_AGENT_CACHE_KEEPALIVE_MAX: "2",
      MARINA_AGENT_CACHE_KEEPALIVE_DAILY_USD: "0.015",
    })!;
    expect(policy).toEqual({
      intervalMs: 4.5 * MIN,
      windowMs: 30 * MIN,
      maxPerGap: 2,
      dailyUsd: 0.015,
    });

    const t = new PromptCacheTracker();
    const start = Date.parse("2026-10-20T10:00:00Z");
    expect(t.keepAliveRefusal(policy, start)).toBe("no request yet");
    t.notePrompt(start);
    t.noteRequest(start);
    expect(t.keepAliveRefusal(policy, start + MIN)).toBe("not due");
    expect(t.keepAliveRefusal(policy, start + 4.5 * MIN)).toBeNull();
    t.noteKeepAlive(start + 4.5 * MIN, 0.008);
    expect(t.keepAliveRefusal(policy, start + 9 * MIN)).toBeNull();
    t.noteKeepAlive(start + 9 * MIN, 0.008);
    expect(t.keepAliveRefusal(policy, start + 13.5 * MIN)).toBe("gap cap");
    // A new prompt opens a new gap; the day's spend still counts.
    t.notePrompt(start + 14 * MIN);
    t.noteRequest(start + 14 * MIN);
    expect(t.keepAliveRefusal(policy, start + 18.5 * MIN)).toBe("daily cap");
    // Outside the window after the last prompt: no pings.
    const wide = { ...policy, maxPerGap: 99, dailyUsd: 99 };
    expect(t.keepAliveRefusal(wide, start + 14 * MIN + 31 * MIN)).toBe("outside window");
    expect(t.metrics.keepAlives).toBe(2);
    expect(t.metrics.keepAliveCostUsd).toBeCloseTo(0.016);
  });

  it("a keep-alive counts only when it read the cache and wrote almost nothing", () => {
    expect(keepAliveHit({ cacheReadTokens: 30_000, cacheWriteTokens: 40 })).toBe(true);
    expect(keepAliveHit({ cacheReadTokens: 0, cacheWriteTokens: 30_000 })).toBe(false);
    expect(keepAliveHit({ cacheReadTokens: 5_000, cacheWriteTokens: 25_000 })).toBe(false);
    expect(keepAliveHit({})).toBe(false);
  });
});

describe("incremental compaction keeps earlier summaries and pointers", () => {
  const cap = { capTokens: 20_000, targetTokens: 8_000, explicit: true };
  const summarized: AgentMessage[][] = [];
  const transform = createContextManager({
    getModel: () => bigModel,
    getSystemPrompt: () => "sys",
    getTokenCap: () => cap,
    summarizeWithLLM: async (messages, fallback) => {
      summarized.push(messages);
      return `summary of ${messages.length}: ${fallback.slice(0, 200)}`;
    },
  });

  it("summarizes only new messages; an earlier summary is kept verbatim", async () => {
    summarized.length = 0;
    const first = await transform(conversation(12, "a"));
    const firstSummary = first.find(isContextSummaryMessage)!;
    expect(firstSummary).toBeDefined();
    const text1 = firstSummary.content as string;
    expect(text1.startsWith(CONTEXT_SUMMARY_PREFIX)).toBe(true);
    // Pointers survive: URLs and typed ids the dropped messages named.
    expect(text1).toContain(POINTER_PREFIX);
    expect(text1).toContain("https://example.test/a/0");
    expect(text1).toContain("note:100");

    // Grow past the cap again: the first summary rides along untouched and is
    // NOT fed back to the summarizer (no summary of a summary).
    const grown = [...first, ...conversation(12, "b").slice(2)];
    const second = await transform(grown);
    const summaries = second.filter(isContextSummaryMessage);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toBe(firstSummary);
    expect(summarized).toHaveLength(2);
    expect(summarized[1]!.some(isContextSummaryMessage)).toBe(false);
    expect(summaries[1]!.content as string).toContain("https://example.test/b/0");
    expect(conversationTokens(second)).toBeLessThan(cap.capTokens);
  });

  it("an earlier summary dropped for room hands its pointers on", async () => {
    const roomy = createContextManager({
      getModel: () => bigModel,
      getSystemPrompt: () => "sys",
      getTokenCap: () => cap,
      // Long summaries: the earlier-summary budget (2 × 800 tokens) forces drops.
      summarizeWithLLM: async (_messages, fallback) => fallback.repeat(4),
    });
    const pointersOf = (m: AgentMessage) =>
      ((m.content as string).split("\n").find((l) => l.startsWith(POINTER_PREFIX)) ?? "")
        .slice(POINTER_PREFIX.length)
        .split(" ")
        .filter(Boolean);
    let working = conversation(12, "r0");
    let handedOn = 0;
    for (let round = 1; round <= 6; round++) {
      const before = working.filter(isContextSummaryMessage);
      working = await roomy([...working, ...conversation(12, `r${round}`).slice(2)]);
      const after = working.filter(isContextSummaryMessage);
      // Bounded: old summaries do not pile up.
      expect(after.length).toBeLessThanOrEqual(3);
      const dropped = before.filter((m) => !after.includes(m));
      const newest = pointersOf(after.at(-1)!);
      expect(newest.length).toBeLessThanOrEqual(40);
      if (dropped.length > 0) {
        handedOn++;
        expect(dropped.flatMap(pointersOf).some((p) => newest.includes(p))).toBe(true);
      }
      expect(conversationTokens(working)).toBeLessThan(cap.capTokens);
    }
    expect(handedOn).toBeGreaterThan(0);
  });

  it("extracts URLs, typed ids, #handles and paths", () => {
    const got = extractPointers([
      user("read https://a.test/x?y=1, then note:12 and task#7; see #245 and src/agent/x.ts."),
      user("again https://a.test/x?y=1"),
    ]);
    expect(got).toEqual(["note:12", "task#7", "#245", "src/agent/x.ts", "https://a.test/x?y=1"]);
  });
});

describe("cold-turn compaction in the adapter", () => {
  type Internals = {
    agent: { state: { messages: AgentMessage[] } };
    contextTransform: ReturnType<typeof createContextManager>;
    promptCache: PromptCacheTracker;
    tokenCapFor(messages: readonly AgentMessage[]): ConversationTokenCap | undefined;
    tidyTranscriptBeforePrompt(): Promise<void>;
    getOperatorStatus(): AgentOperatorStatus;
  };
  const make = (model = "marina/default") => {
    const i = new LeanAgentAdapter(
      { name: "Cold", model },
      "ws://unused",
      null,
    ) as unknown as Internals;
    let archived = 0;
    i.contextTransform = createContextManager({
      getModel: () => bigModel,
      getSystemPrompt: () => "sys",
      getTokenCap: (messages) => i.tokenCapFor(messages),
      onBeforeCompact: () => {
        archived++;
      },
    });
    return { i, archived: () => archived };
  };
  // ~30k estimated tokens: above the 24k cold threshold, below the 48k cap.
  const history = () => conversation(15, "h");

  it("compacts a history past the threshold when the cache has expired", async () => {
    using _s = scopeProcessState({
      env: {
        MARINA_AGENT_CONTEXT_CAP_TOKENS: undefined,
        MARINA_AGENT_COLD_COMPACT: undefined,
        MARINA_AGENT_COLD_COMPACT_MIN_TOKENS: undefined,
        MARINA_PROMPT_CACHE_TTL: undefined,
      },
    });
    const { i, archived } = make();
    const messages = history();
    const before = conversationTokens(messages);
    expect(before).toBeGreaterThan(24_000);
    expect(before).toBeLessThan(48_000);

    // Warm (last request 2 min ago): untouched.
    i.agent.state.messages = messages;
    i.promptCache.noteRequest(Date.now() - 2 * MIN);
    await i.tidyTranscriptBeforePrompt();
    expect(i.agent.state.messages).toEqual(messages);
    expect(i.promptCache.metrics.coldTurns).toBe(0);

    // Cold (6 min): compacted to the target, archived first, counted.
    i.promptCache.noteRequest(Date.now() - 6 * MIN);
    await i.tidyTranscriptBeforePrompt();
    const after = conversationTokens(i.agent.state.messages);
    expect(after).toBeLessThanOrEqual(16_500);
    expect(archived()).toBe(1);
    expect(i.agent.state.messages[0]!.role).toBe("system");
    const status = i.getOperatorStatus().promptCache!;
    expect(status.coldTurns).toBe(1);
    expect(status.coldCompactions).toBe(1);
    expect(status.coldWriteTokensAvoided).toBe(before - after);
    expect(status.coldWriteBytesAvoided).toBeGreaterThan(30_000);
    // The override is gone: the ordinary cap applies again.
    expect(i.tokenCapFor(messages)?.capTokens).toBe(48_000);
  });

  it("counts but does not compact below the threshold, or when off", async () => {
    using _s = scopeProcessState({
      env: { MARINA_AGENT_CONTEXT_CAP_TOKENS: undefined, MARINA_AGENT_COLD_COMPACT: undefined },
    });
    const small = conversation(8, "s"); // ~16k
    {
      const { i } = make();
      i.agent.state.messages = small;
      i.promptCache.noteRequest(Date.now() - 6 * MIN);
      await i.tidyTranscriptBeforePrompt();
      expect(i.agent.state.messages).toEqual(small);
      expect(i.promptCache.metrics).toMatchObject({ coldTurns: 1, coldCompactions: 0 });
    }
    {
      using _off = scopeProcessState({ env: { MARINA_AGENT_COLD_COMPACT: "off" } });
      const { i } = make();
      const messages = history();
      i.agent.state.messages = messages;
      i.promptCache.noteRequest(Date.now() - 6 * MIN);
      await i.tidyTranscriptBeforePrompt();
      expect(i.agent.state.messages).toEqual(messages);
      expect(i.promptCache.metrics).toMatchObject({ coldTurns: 1, coldCompactions: 0 });
    }
  });

  it("a provider with no cache is never cold", async () => {
    using _s = scopeProcessState({
      env: { MARINA_AGENT_CONTEXT_CAP_TOKENS: undefined, MARINA_PROMPT_CACHE_TTL: "marina=off" },
    });
    const { i } = make();
    const messages = history();
    i.agent.state.messages = messages;
    i.promptCache.noteRequest(Date.now() - 60 * MIN);
    await i.tidyTranscriptBeforePrompt();
    expect(i.agent.state.messages).toEqual(messages);
    expect(i.promptCache.metrics.coldTurns).toBe(0);
  });
});

describe("cache keep-alive in the adapter (opt-in)", () => {
  type Internals = {
    autonomousLoopRunning: boolean;
    model: unknown;
    lastModelRequest: unknown;
    promptCache: PromptCacheTracker;
    sendKeepAlive(): Promise<void>;
    cancelKeepAlive(): void;
    getOperatorStatus(): AgentOperatorStatus;
  };
  const fakeReply = (cacheRead: number, cacheWrite: number) => ({
    role: "assistant",
    content: [],
    stopReason: "length",
    usage: {
      input: 3,
      output: 1,
      cacheRead,
      cacheWrite,
      totalTokens: cacheRead + cacheWrite + 4,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.006 },
    },
  });

  it("replays the last request with max_tokens 1, then stops after a miss", async () => {
    using _s = scopeProcessState({
      env: { MARINA_AGENT_CACHE_KEEPALIVE: "on", MARINA_PROMPT_CACHE_TTL: undefined },
    });
    const i = new LeanAgentAdapter(
      { name: "Warm", model: "anthropic/claude-opus-5-5" },
      "ws://unused",
      null,
    ) as unknown as Internals;
    const calls: { maxTokens?: number; messages: number }[] = [];
    const replies = [fakeReply(30_000, 0), fakeReply(0, 30_000)];
    const original = piModels.completeSimple;
    (piModels as { completeSimple: unknown }).completeSimple = async (
      _m: unknown,
      context: { messages: unknown[] },
      options: { maxTokens?: number },
    ) => {
      calls.push({ maxTokens: options.maxTokens, messages: context.messages.length });
      return replies.shift();
    };
    try {
      i.autonomousLoopRunning = true;
      i.lastModelRequest = {
        model: i.model,
        context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
        options: { sessionId: "marina-agent:Warm" },
      };
      const at = Date.now() - 5 * MIN;
      i.promptCache.notePrompt(at);
      i.promptCache.noteRequest(at);
      await i.sendKeepAlive();
      expect(calls).toEqual([{ maxTokens: 1, messages: 1 }]);
      expect(i.getOperatorStatus().promptCache).toMatchObject({ keepAlives: 1 });
      // The cache was refreshed: not due again yet.
      await i.sendKeepAlive();
      expect(calls).toHaveLength(1);
      // Due again; this replay MISSES (it wrote instead of reading): disabled for good.
      i.promptCache.noteRequest(Date.now() - 5 * MIN);
      await i.sendKeepAlive();
      expect(calls).toHaveLength(2);
      expect(i.promptCache.disabled).toBe(true);
      i.promptCache.noteRequest(Date.now() - 5 * MIN);
      await i.sendKeepAlive();
      expect(calls).toHaveLength(2);
    } finally {
      (piModels as { completeSimple: unknown }).completeSimple = original;
      i.cancelKeepAlive();
    }
  });

  it("sends nothing when off (the default)", async () => {
    using _s = scopeProcessState({ env: { MARINA_AGENT_CACHE_KEEPALIVE: undefined } });
    const i = new LeanAgentAdapter(
      { name: "Cool", model: "anthropic/claude-opus-5-5" },
      "ws://unused",
      null,
    ) as unknown as Internals;
    let called = 0;
    const original = piModels.completeSimple;
    (piModels as { completeSimple: unknown }).completeSimple = async () => {
      called++;
      return fakeReply(1, 0);
    };
    try {
      i.autonomousLoopRunning = true;
      i.lastModelRequest = { model: i.model, context: { messages: [] }, options: {} };
      i.promptCache.notePrompt(Date.now() - 5 * MIN);
      i.promptCache.noteRequest(Date.now() - 5 * MIN);
      await i.sendKeepAlive();
      expect(called).toBe(0);
    } finally {
      (piModels as { completeSimple: unknown }).completeSimple = original;
    }
  });
});

describe("the static-prefix TTL on the wire", () => {
  it("a direct Anthropic request marks tools and system 1h, the conversation keeps 5m", async () => {
    using _s = scopeProcessState({ env: { MARINA_PROMPT_CACHE_STATIC_TTL: undefined } });
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch = (async (_input: unknown, init?: { body?: unknown }) => {
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "stop" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const adapter = new LeanAgentAdapter(
      { name: "Wire", model: "anthropic/claude-opus-5-5" },
      "ws://unused",
      null,
      "sk-ant-test",
      undefined,
      undefined,
      fakeFetch,
    ) as unknown as { agent: { prompt(text: string): Promise<void> } };
    await adapter.agent.prompt("hello").catch(() => undefined);
    const body = bodies.find((b) => Array.isArray(b.system)) as {
      system: { cache_control?: { type: string; ttl?: string } }[];
      tools: { cache_control?: { type: string; ttl?: string } }[];
      messages: unknown[];
    };
    expect(body).toBeDefined();
    expect(body.system.at(-1)!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // The tool breakpoint (pi-ai marks the last real tool; a deferred placeholder may follow).
    const marked = body.tools.filter((t) => t.cache_control);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const conversation = JSON.stringify(body.messages);
    expect(conversation).toContain('"cache_control":{"type":"ephemeral"}');
    expect(conversation).not.toContain('"ttl"');
  });
});
