// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared in-process model backend (`src/model/`): every library call is
 * labelled by purpose in the spend ledger (coarse source + `purpose:<name>`
 * row), a loopback `marina/*` call is never counted twice, transient failures
 * get a bounded retry, and every call is traced. The provider is mocked;
 * nothing is called.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { piModels } from "../src/agent/pi-models";
import {
  primeOpenRouterCatalogForTests,
  resetOpenRouterPricesForTests,
} from "../src/agent/provider-cost";
import * as arenaForecaster from "../src/arena/model-forecaster";
import { tavilyProvider } from "../src/engine/search-providers/tavily";
import {
  attachSpendLedger,
  dbSpendSink,
  purposeSpendToday,
  recordPurposeSpend,
  recordSpend,
  resetSpendLedgerForTests,
  type SpendSource,
  scopeSpendToday,
  spendScope,
  utcDay,
} from "../src/engine/spend-ledger";
import { projectTraces } from "../src/engine/trace-projection";
import {
  attachModelTraceSink,
  MODEL_PURPOSES,
  type ModelLifecycleEvent,
  type ModelPurpose,
  modelComplete,
  modelTurns,
  parseReply,
  spendSourceFor,
} from "../src/model";
import { isLoopbackMarinaSpec } from "../src/model/access";
import { failureKind, modelRetries, retryDelayMs } from "../src/model/retry";
import { resetRouteHealthForTests, routeLimitOf } from "../src/net/model/route-health";
import { MarinaDB } from "../src/persistence/database";
import { ProvenanceCache } from "../src/research/provenance-cache";
import { researchEnvironment } from "../src/research/web-agent";

const SPEC = "anthropic/claude-opus-5-5";

interface Row {
  source: SpendSource;
  usd: number;
  scope?: string;
  purpose?: string;
}

let rows: Row[];
let detach: () => void;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ANTHROPIC_API_KEY: "test-key",
    MARINA_MODEL_RETRY_BASE_MS: "0",
    ...extra,
  };
}

function reply(over: Partial<AssistantMessage> & { costTotal?: number } = {}): AssistantMessage {
  const { costTotal = 0.01, ...rest } = over;
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5-5",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...rest,
  } as AssistantMessage;
}

function failed(message: string): AssistantMessage {
  return reply({ stopReason: "error", errorMessage: message, costTotal: 0 });
}

let active: { mockRestore(): void } | undefined;

/** Mock the provider with a queue of replies (or thrown errors); records each call's model. */
function provider(queue: (AssistantMessage | Error)[]) {
  active?.mockRestore();
  const seen: { model: string; apiKey?: string }[] = [];
  const spy = spyOn(piModels, "completeSimple").mockImplementation((async (
    model: { id: string; provider: string },
    _context: unknown,
    opts: { apiKey?: string },
  ) => {
    seen.push({ model: `${model.provider}/${model.id}`, apiKey: opts.apiKey });
    const next = queue.shift() ?? reply();
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof piModels.completeSimple);
  active = spy;
  return { spy, seen };
}

beforeEach(() => {
  rows = [];
  resetSpendLedgerForTests();
  detach = attachSpendLedger({
    add: (_day, source, usd, scope, purpose) =>
      rows.push({
        source,
        usd,
        ...(scope ? { scope } : {}),
        ...(purpose ? { purpose } : {}),
      }),
    totalFor: () => 0,
  });
});

afterEach(() => {
  active?.mockRestore();
  active = undefined;
  detach();
  resetSpendLedgerForTests();
  resetRouteHealthForTests();
  resetOpenRouterPricesForTests();
});

describe("spend labels by purpose", () => {
  it("maps every purpose onto a source the spend_daily CHECK accepts", () => {
    const allowed = new Set(["model_api", "agent", "decision", "forecast", "media", "search"]);
    for (const purpose of MODEL_PURPOSES) expect(allowed.has(spendSourceFor(purpose))).toBe(true);
    expect(spendSourceFor("forecast")).toBe("forecast");
    expect(spendSourceFor("arena")).toBe("forecast");
    expect(spendSourceFor("research")).toBe("forecast");
    expect(spendSourceFor("lessons")).toBe("model_api");
    expect(spendSourceFor("outcomes")).toBe("model_api");
    expect(spendSourceFor("swarm")).toBe("model_api");
    expect(spendSourceFor("judge")).toBe("decision");
    expect(spendSourceFor("benchmark")).toBe("model_api");
  });

  it("records each call once, under its purpose's source and a purpose row", async () => {
    const cases: [ModelPurpose | undefined, SpendSource, string][] = [
      [undefined, "forecast", "purpose:forecast"], // the old default label is kept
      ["forecast", "forecast", "purpose:forecast"],
      ["arena", "forecast", "purpose:arena"],
      ["research", "forecast", "purpose:research"],
      ["lessons", "model_api", "purpose:lessons"],
      ["outcomes", "model_api", "purpose:outcomes"],
      ["swarm", "model_api", "purpose:swarm"],
      ["judge", "decision", "purpose:judge"],
      ["benchmark", "model_api", "purpose:benchmark"],
    ];
    provider([]);
    for (const [purpose, source, label] of cases) {
      rows = [];
      const made = modelComplete(SPEC, env(), { maxTokens: 100, ...(purpose ? { purpose } : {}) });
      expect(await made.complete("system", "user")).toBe("ok");
      expect(rows).toEqual([{ source, usd: 0.01, purpose: label }]);
      expect(made.usage).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20 });
    }
  });

  it("an explicit spendSource overrides the purpose's source; turns default to agent", async () => {
    provider([]);
    await modelComplete(SPEC, env(), {
      maxTokens: 100,
      purpose: "lessons",
      spendSource: "forecast",
    }).complete("s", "u");
    await modelTurns(SPEC, env()).turn({ messages: [] });
    await modelTurns(SPEC, env(), { purpose: "benchmark" }).turn({ messages: [] });
    expect(rows).toEqual([
      { source: "forecast", usd: 0.01, purpose: "purpose:lessons" },
      { source: "agent", usd: 0.01, purpose: "purpose:research" },
      { source: "model_api", usd: 0.01, purpose: "purpose:benchmark" },
    ]);
  });

  it("purpose rows live beside the global row in one write, outside the budget-scope readouts", () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-purpose-"));
    const db = new MarinaDB(join(dir, "w.db"));
    detach();
    detach = attachSpendLedger(dbSpendSink(db));
    try {
      const scoped = { MARINA_SPEND_SCOPE: "futurex-live" };
      recordPurposeSpend("lessons", "model_api", 0.5, scoped);
      recordPurposeSpend("forecast", "forecast", 0.25);
      recordSpend("agent", 1);
      const day = utcDay();
      const global = db.getDailySpend(day);
      expect(global.reduce((t, r) => t + r.cost_usd, 0)).toBeCloseTo(1.75, 10);
      expect(global.find((r) => r.source === "model_api")).toMatchObject({
        cost_usd: 0.5,
        calls: 1,
      });
      // The budget scope keeps its own row; the purpose rows are a breakdown, not scopes.
      expect(scopeSpendToday(db)).toEqual([{ scope: "futurex-live", spentUsd: 0.5 }]);
      expect(purposeSpendToday(db)).toEqual([
        { purpose: "lessons", spentUsd: 0.5 },
        { purpose: "forecast", spentUsd: 0.25 },
      ]);
      // A budget scope may not alias a purpose row.
      expect(spendScope({ MARINA_SPEND_SCOPE: "purpose:lessons" })?.valid).toBe(false);
      // A malformed purpose still records the dollar, just without a breakdown row.
      recordPurposeSpend("Bad Name!", "model_api", 0.1);
      expect(db.getDailySpend(day).reduce((t, r) => t + r.cost_usd, 0)).toBeCloseTo(1.85, 10);
      expect(purposeSpendToday(db)).toHaveLength(2);
    } finally {
      detach();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("no double count for marina/*", () => {
  it("a loopback marina/* call is left to the /v1 passthru that serves it", async () => {
    provider([reply({ costTotal: 0 })]);
    const made = modelComplete(
      "marina/claude-opus-5-5",
      { MODEL_API_KEYS: "k" },
      { maxTokens: 50 },
    );
    expect(await made.complete("s", "u")).toBe("ok");
    // Priced from the list (the caller's own accounting) but never recorded here:
    // the passthru records the same call as model_api where it leaves Marina.
    expect(made.usage.costUsd).toBeGreaterThan(0);
    expect(rows).toEqual([]);
  });

  it("another Marina (marina/x@host) and every vendor spec are recorded", () => {
    expect(isLoopbackMarinaSpec("marina/default")).toBe(true);
    expect(isLoopbackMarinaSpec("marina/claude-opus-5-5")).toBe(true);
    expect(isLoopbackMarinaSpec("marina/default@marina.example.com")).toBe(false);
    expect(isLoopbackMarinaSpec(SPEC)).toBe(false);
    expect(isLoopbackMarinaSpec("openrouter/marina/x")).toBe(false);
  });
});

describe("bounded retry", () => {
  it("defaults to one retry; 0/off disables; junk keeps the default; capped at 5", () => {
    expect(modelRetries({})).toBe(1);
    expect(modelRetries({ MARINA_MODEL_RETRIES: "0" })).toBe(0);
    expect(modelRetries({ MARINA_MODEL_RETRIES: "off" })).toBe(0);
    expect(modelRetries({ MARINA_MODEL_RETRIES: "x" })).toBe(1);
    expect(modelRetries({ MARINA_MODEL_RETRIES: "50" })).toBe(5);
    expect(retryDelayMs(0, 1000, () => 0)).toBe(1000);
    expect(retryDelayMs(2, 1000, () => 1)).toBe(5000);
    expect(retryDelayMs(10, 1000, () => 0)).toBe(30_000);
  });

  it("classifies only 429, 5xx and network failures as transient", () => {
    expect(failureKind('429 {"error":"rate_limit_exceeded"}')).toBe("rate_limit");
    expect(failureKind("529 overloaded_error")).toBe("rate_limit");
    expect(failureKind("503 Service Unavailable")).toBe("provider");
    expect(failureKind("fetch failed: ECONNRESET")).toBe("network");
    expect(failureKind("Connection error.")).toBe("network");
    expect(failureKind("401 invalid x-api-key")).toBe("auth");
    expect(failureKind("insufficient_quota: exceeded your current quota")).toBe("quota");
    expect(failureKind("daily spend cap reached ($50.00)")).toBe("quota");
    expect(failureKind("400 bad request")).toBe("unknown");
    expect(failureKind("The operation was aborted due to timeout")).toBe("timeout");
  });

  it("retries a transient failure once, then succeeds; each attempt is priced", async () => {
    const mocked = provider([failed("429 rate_limit_error"), reply()]);
    const made = modelComplete(SPEC, env(), { maxTokens: 10, purpose: "lessons" });
    expect(await made.complete("s", "u")).toBe("ok");
    expect(mocked.seen).toHaveLength(2);
    expect(made.usage.calls).toBe(2);
    expect(rows).toEqual([{ source: "model_api", usd: 0.01, purpose: "purpose:lessons" }]);
  });

  it("retries a thrown network error", async () => {
    const mocked = provider([new Error("fetch failed"), reply()]);
    expect(await modelComplete(SPEC, env(), { maxTokens: 10 }).complete("s", "u")).toBe("ok");
    expect(mocked.seen).toHaveLength(2);
  });

  it("gives up after the bound with the last error", async () => {
    const mocked = provider([failed("503 overloaded"), failed("503 overloaded"), reply()]);
    await expect(modelComplete(SPEC, env(), { maxTokens: 10 }).complete("s", "u")).rejects.toThrow(
      "503 overloaded",
    );
    expect(mocked.seen).toHaveLength(2);
  });

  it("honours MARINA_MODEL_RETRIES", async () => {
    const off = provider([failed("503 down"), reply()]);
    await expect(
      modelComplete(SPEC, env({ MARINA_MODEL_RETRIES: "0" }), { maxTokens: 10 }).complete("s", "u"),
    ).rejects.toThrow("503 down");
    expect(off.seen).toHaveLength(1);
  });

  it("never retries an auth refusal, a bad request, a usage limit or an abort", async () => {
    for (const message of ["401 invalid x-api-key", "400 bad request", "insufficient_quota"]) {
      const mocked = provider([failed(message), reply()]);
      await expect(
        modelComplete(SPEC, env(), { maxTokens: 10 }).complete("s", "u"),
      ).rejects.toThrow();
      expect(mocked.seen).toHaveLength(1);
    }
    const controller = new AbortController();
    const mocked = provider([]);
    mocked.spy.mockImplementation((async () => {
      controller.abort();
      return failed("503 down");
    }) as unknown as typeof piModels.completeSimple);
    await expect(
      modelComplete(SPEC, env(), { maxTokens: 10, signal: controller.signal }).complete("s", "u"),
    ).rejects.toThrow();
    expect(mocked.spy).toHaveBeenCalledTimes(1);
  });

  it("tool turns retry the same way", async () => {
    const mocked = provider([failed("500 internal server error"), reply()]);
    const turns = modelTurns(SPEC, env());
    const out = await turns.turn({ messages: [] });
    expect(mocked.seen).toHaveLength(2);
    expect(out.stopReason).toBe("stop");
    expect(turns.usage.calls).toBe(2);
  });
});

describe("traces", () => {
  it("each call mints a request id and emits received → completed with purpose and context", async () => {
    const events: ModelLifecycleEvent[] = [];
    provider([failed("429 rate limit"), reply()]);
    const release = attachModelTraceSink((e) => events.push(e));
    try {
      const made = modelComplete(SPEC, env(), {
        maxTokens: 10,
        purpose: "outcomes",
        trace: { caller: "outcomes.extractor", questionId: "q-1", traceId: "req-parent" },
      });
      await made.complete("s", "u");
    } finally {
      release();
    }
    expect(events.map((e) => e.phase)).toEqual(["received", "completed"]);
    const [start, end] = events as [ModelLifecycleEvent, ModelLifecycleEvent];
    expect(start.requestId).toMatch(/^req-[0-9a-f]{8}$/);
    expect(end.requestId).toBe(start.requestId);
    expect(end).toMatchObject({
      traceId: "req-parent",
      spanId: `span-${start.requestId}`,
      model: SPEC,
      routeKind: "direct",
      purpose: "outcomes",
      traceContext: { caller: "outcomes.extractor", questionId: "q-1" },
      // Both attempts' tokens (the failed one was billed too) and cost.
      costUsd: 0.01,
      inputTokens: 200,
      outputTokens: 40,
      detail: "retries:1",
    });
    // The single span-tree projection reads it like any /v1 request.
    const [trace] = projectTraces(events);
    expect(trace?.traceId).toBe("req-parent");
    expect(trace?.spans[0]?.attributes).toMatchObject({
      purpose: "outcomes",
      routeKind: "direct",
      "context.caller": "outcomes.extractor",
      "context.questionId": "q-1",
    });
  });

  it("a failed call ends its span failed with an error kind; distinct calls get distinct ids", async () => {
    const events: ModelLifecycleEvent[] = [];
    provider([failed("401 invalid x-api-key"), reply()]);
    const release = attachModelTraceSink((e) => events.push(e));
    try {
      const made = modelComplete(SPEC, env(), { maxTokens: 10 });
      await expect(made.complete("s", "u")).rejects.toThrow();
      await made.complete("s", "u");
    } finally {
      release();
    }
    expect(events.map((e) => e.phase)).toEqual(["received", "failed", "received", "completed"]);
    expect(events[1]).toMatchObject({ errorKind: "auth", purpose: "forecast" });
    expect(events[0]!.requestId).not.toBe(events[2]!.requestId);
    // Without trace context the call is its own trace.
    expect(events[2]!.traceId).toBe(events[2]!.requestId);
  });
});

describe("same-model route fallback (opt-in)", () => {
  const LIMIT = "You have reached your specified workspace API usage limits.";

  it("is off by default: a usage limit fails the call and marks nothing", async () => {
    const mocked = provider([failed(LIMIT), reply()]);
    await expect(
      modelComplete(SPEC, env({ OPENROUTER_API_KEY: "or" }), { maxTokens: 10 }).complete("s", "u"),
    ).rejects.toThrow("usage limits");
    expect(mocked.seen).toHaveLength(1);
    expect(routeLimitOf("anthropic")).toBeUndefined();
  });

  it("on: a usage limit marks the route and the SAME model is served via OpenRouter", async () => {
    primeOpenRouterCatalogForTests(["anthropic/claude-opus-5.5"]);
    const mocked = provider([failed(LIMIT), reply(), reply()]);
    const events: ModelLifecycleEvent[] = [];
    const release = attachModelTraceSink((e) => events.push(e));
    const e = env({ OPENROUTER_API_KEY: "or-key", MARINA_MODEL_ROUTE_FALLBACK: "on" });
    try {
      const made = modelComplete(SPEC, e, { maxTokens: 10 });
      expect(await made.complete("s", "u")).toBe("ok");
      expect(mocked.seen.map((s) => s.model)).toEqual([
        SPEC,
        "openrouter/anthropic/claude-opus-5.5",
      ]);
      expect(mocked.seen[1]?.apiKey).toBe("or-key");
      expect(routeLimitOf("anthropic")).toBeDefined();
      // The next call skips the limited direct route.
      await made.complete("s", "u");
      expect(mocked.seen[2]?.model).toBe("openrouter/anthropic/claude-opus-5.5");
    } finally {
      release();
    }
    const completed = events.filter((x) => x.phase === "completed");
    expect(completed.map((x) => x.routeKind)).toEqual(["fallback", "fallback"]);
    expect(events.find((x) => x.phase === "completed")?.target).toBe(
      "openrouter/anthropic/claude-opus-5.5",
    );
  });
});

describe("web-agent search spend", () => {
  it("a paid search from the web agent reaches the ledger as `search`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-agent-spend-"));
    try {
      const environment = researchEnvironment({
        cache: new ProvenanceCache(dir),
        backends: [tavilyProvider("tvly-test")],
        http: {
          httpGet: async () => ({ error: "unused" }),
          httpPost: async () => ({
            status: 200,
            body: JSON.stringify({
              results: [{ title: "A", url: "https://a.example/x", content: "text" }],
              usage: { credits: 2 },
            }),
          }),
        } as never,
      });
      const results = await environment.search("query", 5);
      expect(results).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe("search");
      expect(environment.stats.searchUsd).toBeCloseTo(rows[0]!.usd, 10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("re-export shims", () => {
  it("the arena forecaster re-exports the shared reply parser", () => {
    expect(arenaForecaster.parseReply).toBe(parseReply);
    expect(parseReply('noise {"a": 1} tail')).toEqual({ a: 1 });
  });
});
