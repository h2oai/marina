// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { agentCompactionModelSpec, LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import type { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { dailyBudget, recordSpend, resetSpendLedgerForTests } from "../src/engine/spend-ledger";
import { resetSamplingParamsForTests } from "../src/net/model/sampling-params";
import { scopeProcessState } from "./process-state";

type Internals = {
  agent: Agent;
  model: Model<"openai-completions">;
  providerFetch: typeof fetch;
  platformMemory: PlatformMemoryBackend;
};

function setup(
  options: { fail?: boolean; unpriced?: boolean; proxy?: boolean; budgetCalls?: number } = {},
) {
  const adapter = new LeanAgentAdapter(
    { name: "Compactor", model: "openai/gpt-4o-mini", budgetCalls: options.budgetCalls ?? 20 },
    "ws://127.0.0.1:39998",
    null,
    "fixture-key",
  );
  const internals = adapter as unknown as Internals;
  const history: AgentMessage[] = [
    { role: "system", content: "Keep the user's constraints.", timestamp: 1 },
    ...Array.from({ length: 30 }, (_, n) => ({
      role: "user" as const,
      content: `Turn ${n}: constraint-${n}. ${"A bounded historical observation. ".repeat(12)}`,
      timestamp: n + 2,
    })),
  ];
  internals.agent.state.messages = history;
  internals.model = {
    ...internals.model,
    api: "openai-completions",
    ...(options.proxy ? { name: "Marina fixture" } : {}),
    ...(options.unpriced ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}),
  };
  const requests: unknown[] = [];
  const archives: AgentMessage[][] = [];
  internals.providerFetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (options.fail) return new Response("fixture unavailable", { status: 400 });
    const chunk = {
      id: "fixture-summary",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Keep constraint-0 and all unresolved work." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2000, completion_tokens: 30, total_tokens: 2030, cost: 0.125 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: {
        "content-type": "text/event-stream",
        ...(options.proxy ? { "x-marina-cost-usd": "0.125" } : {}),
      },
    });
  }) as typeof fetch;
  internals.platformMemory.archiveContext = async (messages) => {
    archives.push(messages.slice() as AgentMessage[]);
  };
  return { adapter, internals, history: internals.agent.state.messages, requests, archives };
}

afterEach(() => {
  resetSpendLedgerForTests();
  resetSamplingParamsForTests();
});

describe("manual compaction through the real context manager and provider parser", () => {
  it("does not summarize a short history or grow it with a summary marker", async () => {
    const { adapter, internals, requests, archives } = setup();
    internals.agent.state.messages = internals.agent.state.messages.slice(0, 6);
    const original = internals.agent.state.messages;
    expect(await adapter.compactNow()).toEqual({ before: 6, after: 6 });
    expect(internals.agent.state.messages).toEqual(original);
    expect(requests).toHaveLength(0);
    expect(archives).toHaveLength(0);
  });

  it("compacts below the automatic threshold, archives first, and accounts for the call", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_DAILY_SPEND_CAP_USD: "50" },
    });
    resetSpendLedgerForTests();
    const { adapter, internals, history, requests, archives } = setup();
    const result = await adapter.compactNow();
    expect(result?.before).toBe(history.length);
    expect(result!.after).toBeLessThan(history.length);
    expect(requests).toHaveLength(1);
    expect(archives[0]).toEqual(history.filter((m) => m.role !== "system"));
    expect(internals.agent.state.messages[0]).toBe(history[0]!);
    expect(internals.agent.state.messages.at(-1)).toBe(history.at(-1)!);
    expect(JSON.stringify(internals.agent.state.messages)).toContain("constraint-0");
    expect(adapter.getOperatorStatus().totalCostUsd!).toBeGreaterThan(0);
    expect(dailyBudget()!.spentUsd).toBeCloseTo(adapter.getOperatorStatus().totalCostUsd!);
  });

  it("honors the daily cap with a deterministic archived summary and no model call", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_DAILY_SPEND_CAP_USD: "1" },
    });
    resetSpendLedgerForTests();
    recordSpend("agent", 1);
    const { adapter, history, requests, archives } = setup();
    expect((await adapter.compactNow())!.after).toBeLessThan(history.length);
    expect(requests).toHaveLength(0);
    expect(archives).toHaveLength(1);
    expect(dailyBudget()!.spentUsd).toBe(1);
  });

  it("retains all history if durable archival fails", async () => {
    using _state = scopeProcessState({ trustProfile: "shared" });
    const { adapter, internals, history } = setup({ fail: true });
    internals.platformMemory.archiveContext = async () => {
      throw new Error("archive offline");
    };
    await expect(adapter.compactNow()).rejects.toThrow("Context archival failed");
    expect(internals.agent.state.messages).toBe(history);
  });

  it("falls back to a deterministic summary when the provider fails, after archiving", async () => {
    using _state = scopeProcessState({ trustProfile: "shared" });
    const { adapter, internals, history, requests, archives } = setup({ fail: true });
    expect((await adapter.compactNow())!.after).toBeLessThan(history.length);
    expect(requests).toHaveLength(1);
    expect(archives).toHaveLength(1);
    expect(JSON.stringify(internals.agent.state.messages)).toContain("constraint-0");
  });

  it("refuses during a running turn without calling or archiving", async () => {
    const { adapter, internals, requests, archives } = setup();
    Object.defineProperty(internals.agent.state, "isStreaming", { value: true });
    await expect(adapter.compactNow()).rejects.toThrow("agent is working");
    expect(requests).toHaveLength(0);
    expect(archives).toHaveLength(0);
  });

  it.each(["append", "replace"])(
    "never overwrites a concurrent %s, and coalesces duplicate requests",
    async (mode) => {
      using _state = scopeProcessState({ trustProfile: "shared" });
      const { adapter, internals, history, requests } = setup();
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      internals.platformMemory.archiveContext = async () => {
        entered.resolve();
        await gate.promise;
      };
      const first = adapter.compactNow().catch((error: Error) => error);
      const second = adapter.compactNow().catch((error: Error) => error);
      await entered.promise;
      const added = {
        role: "user" as const,
        content: "New instruction must survive",
        timestamp: 99,
      };
      if (mode === "append") history.push(added);
      else internals.agent.state.messages = [...history, added];
      gate.resolve();
      for (const outcome of await Promise.all([first, second])) {
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toContain("conversation changed");
      }
      expect(internals.agent.state.messages.at(-1)).toBe(added);
      expect(internals.agent.state.messages).toHaveLength(32);
      expect(requests).toHaveLength(1);
    },
  );

  it("uses provider-reported costs when the catalog cannot price the model", async () => {
    // The default daily cap, whatever the operator configured.
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_DAILY_SPEND_CAP_USD: undefined },
    });
    resetSpendLedgerForTests();
    const { adapter } = setup({ unpriced: true });
    await adapter.compactNow();
    expect(dailyBudget()!.spentUsd).toBe(0.125);
    expect(adapter.getOperatorStatus().totalCostUsd!).toBe(0.125);
  });

  it("does not charge a proxied call to the daily ledger a second time", async () => {
    // The default daily cap, whatever the operator configured.
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_DAILY_SPEND_CAP_USD: undefined },
    });
    resetSpendLedgerForTests();
    const { adapter } = setup({ proxy: true, unpriced: true });
    await adapter.compactNow();
    expect(dailyBudget()!.spentUsd).toBe(0);
    expect(adapter.getOperatorStatus().totalCostUsd!).toBe(0.125);
  });
});

for (const budgetCalls of [1, 2]) {
  it(`accounts for a sampling-capability retry within the call budget (${budgetCalls})`, async () => {
    const { adapter, internals, archives } = setup({ budgetCalls });
    internals.model = { ...internals.model, id: "compaction-sampling-fixture" };
    const answer = internals.providerFetch;
    const bodies: { temperature?: number }[] = [];
    internals.providerFetch = (async (input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1)
        return Response.json({ error: { message: "unsupported temperature" } }, { status: 400 });
      return answer(input, init);
    }) as typeof fetch;
    const compacted = await adapter.compactNow();
    expect(compacted!.after).toBeLessThan(compacted!.before);
    expect(archives).toHaveLength(1);
    expect(bodies).toHaveLength(budgetCalls);
    expect(bodies[0]?.temperature).toBe(0.3);
    if (budgetCalls === 2) expect(bodies[1]?.temperature).toBeUndefined();
    expect(adapter.getStatus().modelCalls).toBe(budgetCalls);
    expect(adapter.getStatus().budgetExhausted).toBe(true);
  });
}

describe("MARINA_AGENT_COMPACTION_MODEL", () => {
  it("parses the spec: unset, self and default mean the agent's own model", () => {
    expect(agentCompactionModelSpec({})).toBeUndefined();
    expect(agentCompactionModelSpec({ MARINA_AGENT_COMPACTION_MODEL: " " })).toBeUndefined();
    expect(agentCompactionModelSpec({ MARINA_AGENT_COMPACTION_MODEL: "self" })).toBeUndefined();
    expect(agentCompactionModelSpec({ MARINA_AGENT_COMPACTION_MODEL: "Default" })).toBeUndefined();
    expect(
      agentCompactionModelSpec({
        MARINA_AGENT_COMPACTION_MODEL: " openrouter/inception/mercury-3 ",
      }),
    ).toBe("openrouter/inception/mercury-3");
  });

  function routed(fail: (url: string) => boolean) {
    const { adapter, internals } = setup();
    const answer = internals.providerFetch;
    const calls: { url: string; model: string; auth: string | null }[] = [];
    internals.providerFetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = JSON.parse(String(init?.body));
      calls.push({ url, model: body.model, auth: new Headers(init?.headers).get("authorization") });
      if (fail(url)) return new Response("fixture unavailable", { status: 400 });
      return answer(input, init);
    }) as typeof fetch;
    return { adapter, internals, calls };
  }

  it("writes the summary with the configured model and its route's key", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: {
        MARINA_AGENT_COMPACTION_MODEL: "openrouter/inception/mercury-3",
        OPENROUTER_API_KEY: "fixture-or-key",
      },
    });
    const { adapter, internals, calls } = routed(() => false);
    const compacted = await adapter.compactNow();
    expect(compacted!.after).toBeLessThan(compacted!.before);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.model).toBe("inception/mercury-3");
    expect(calls[0]!.auth).toBe("Bearer fixture-or-key");
    expect(JSON.stringify(internals.agent.state.messages)).toContain("Keep constraint-0");
  });

  it("falls back to the agent's own model when the configured one fails", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: {
        MARINA_AGENT_COMPACTION_MODEL: "openrouter/inception/mercury-3",
        OPENROUTER_API_KEY: "fixture-or-key",
      },
    });
    const { adapter, internals, calls } = routed((url) => url.includes("openrouter.ai"));
    await adapter.compactNow();
    expect(calls.map((c) => c.model)).toEqual(["inception/mercury-3", "gpt-4o-mini"]);
    expect(calls[1]!.auth).toBe("Bearer fixture-key");
    expect(JSON.stringify(internals.agent.state.messages)).toContain("Keep constraint-0");
  });

  it("ignores an unknown provider and keeps the agent's own model", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_AGENT_COMPACTION_MODEL: "nosuchprovider/x" },
    });
    const { adapter, calls } = routed(() => false);
    await adapter.compactNow();
    expect(calls.map((c) => c.model)).toEqual(["gpt-4o-mini"]);
  });
});

describe("the compaction summary call", () => {
  function capture(reply: string, finish = "stop") {
    const { adapter, internals } = setup();
    const bodies: Record<string, unknown>[] = [];
    internals.providerFetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [
          { index: 0, delta: { role: "assistant", content: reply }, finish_reason: finish },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    return { adapter, internals, bodies };
  }

  it("does not replace context with an unfinished summary", async () => {
    using _state = scopeProcessState({ trustProfile: "shared" });
    const { adapter, internals } = capture("UNFINISHED SUMMARY MUST NOT BE TRUSTED", "length");
    await adapter.compactNow();
    const text = JSON.stringify(internals.agent.state.messages);
    expect(text).not.toContain("UNFINISHED SUMMARY MUST NOT BE TRUSTED");
    expect(text).toContain("[Context summary");
    expect(text).toContain("constraint-");
  });

  it("turns reasoning off and uses the 800-token default cap", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: {
        MARINA_AGENT_COMPACTION_MODEL: "openrouter/deepseek/deepseek-v4.1-flash",
        MARINA_AGENT_COMPACTION_MAX_TOKENS: undefined,
        OPENROUTER_API_KEY: "fixture-or-key",
      },
    });
    const { adapter, bodies } = capture("Keep constraint-0.");
    await adapter.compactNow();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.reasoning).toEqual({ enabled: false });
    expect(bodies[0]!.max_completion_tokens ?? bodies[0]!.max_tokens).toBe(800);
  });

  it("honours MARINA_AGENT_COMPACTION_MAX_TOKENS", async () => {
    using _state = scopeProcessState({
      trustProfile: "shared",
      env: { MARINA_AGENT_COMPACTION_MAX_TOKENS: "1200" },
    });
    const { adapter, bodies } = capture("Keep constraint-0.");
    await adapter.compactNow();
    expect(bodies[0]!.max_completion_tokens ?? bodies[0]!.max_tokens).toBe(1200);
  });

  it("strips leaked reasoning, and falls back when the reply is only reasoning", async () => {
    using _state = scopeProcessState({ trustProfile: "shared" });
    const leaked = capture("<think>first I will plan</think>Keep constraint-0 and open work.");
    await leaked.adapter.compactNow();
    const text = JSON.stringify(leaked.internals.agent.state.messages);
    expect(text).toContain("Keep constraint-0 and open work.");
    expect(text).not.toContain("first I will plan");

    const only = capture("Thinking Process:\n\n1. **Analyze the Request:** compress it");
    await only.adapter.compactNow();
    const fallback = JSON.stringify(only.internals.agent.state.messages);
    expect(fallback).not.toContain("Analyze the Request");
    expect(fallback).toContain("[Context summary");
  });
});
