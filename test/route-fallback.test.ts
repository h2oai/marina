// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Usage-limited routes (`src/net/model/route-health.ts`): a first-party key's
 * usage limit is a limit of that ROUTE. The classifier separates it from auth
 * refusals and rate limits; the registry remembers it until the reset (or a
 * bounded re-probe); the `/v1` proxy serves the SAME model via OpenRouter
 * (labelled, priced at OpenRouter) and returns to the direct key once the
 * re-probe succeeds. Never a different model. Fake upstreams only.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openRouterIdCandidates,
  openRouterSameModel,
  primeOpenRouterCatalogForTests,
  resetOpenRouterPricesForTests,
} from "../src/agent/provider-cost";
import { renderRouteHealth } from "../src/engine/commands/readiness";
import { Engine } from "../src/engine/engine";
import { computeReadiness } from "../src/engine/readiness";
import { resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";
import {
  attachRouteHealthStore,
  classifyUpstreamRefusal,
  coreMemoryRouteStore,
  describeRouteHealth,
  isDirectRoute,
  noteRouteOk,
  noteRouteRefusal,
  parseLimitReset,
  ROUTE_PROBE_BASE_MS,
  resetRouteHealthForTests,
  routeChoice,
  routeLabel,
  routeLimitOf,
  sameModelFallback,
} from "../src/net/model/route-health";
import { proxyToUpstream } from "../src/net/model-api/upstream";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, roomId } from "../src/types";
import { makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

const WORKSPACE_LIMIT =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."},"request_id":"req_x"}';
const RESET = Date.parse("2026-11-01T00:00:00Z");
const NOW = Date.parse("2026-10-14T00:00:00Z");

afterEach(() => {
  resetRouteHealthForTests();
  resetOpenRouterPricesForTests();
});

describe("classifyUpstreamRefusal", () => {
  it("a workspace usage limit is a route limit with its reset", () => {
    const r = classifyUpstreamRefusal(WORKSPACE_LIMIT, undefined, NOW);
    expect(r.kind).toBe("usage-limit");
    expect(r.status).toBe(400);
    expect(r.resetAt).toBe(RESET);
  });

  it("covers the providers' quota/credit refusals", () => {
    for (const [msg, status] of [
      ["Your credit balance is too low to access the Anthropic API.", 400],
      ["You exceeded your current quota, please check your plan. insufficient_quota", 429],
      ["This request requires more credits", 402],
      ["Payment Required", 402],
    ] as const)
      expect(classifyUpstreamRefusal(msg, status).kind).toBe("usage-limit");
  });

  it("auth stays auth, a rate limit stays transient, Marina's own cap is not a route", () => {
    expect(classifyUpstreamRefusal('401 {"type":"authentication_error"}').kind).toBe("auth");
    expect(classifyUpstreamRefusal("403 permission_error").kind).toBe("auth");
    expect(classifyUpstreamRefusal("429 rate_limit_error: slow down").kind).toBe("rate-limit");
    expect(
      classifyUpstreamRefusal("429 rate_limit_error: usage of 50 requests per minute").kind,
    ).toBe("rate-limit");
    expect(classifyUpstreamRefusal("daily spend cap reached ($5 today ≥ $5)").kind).toBe("other");
    expect(classifyUpstreamRefusal("spend_cap_reached", 429).kind).toBe("other");
    expect(classifyUpstreamRefusal("500 Internal Server Error").kind).toBe("other");
  });

  it("reads reset times in the common shapes, ignoring past dates", () => {
    expect(parseLimitReset("regain access on 2026-11-01 at 00:00 UTC", NOW)).toBe(RESET);
    expect(parseLimitReset("resets at 2026-11-01T00:00:00Z", NOW)).toBe(RESET);
    expect(parseLimitReset("until 2026-11-01 00:00 UTC", NOW)).toBe(RESET);
    expect(parseLimitReset("until 2026-11-01", NOW)).toBe(RESET);
    expect(parseLimitReset("on 2020-01-01 at 00:00 UTC", NOW)).toBeUndefined();
    expect(parseLimitReset("no date here", NOW)).toBeUndefined();
  });
});

describe("route registry", () => {
  it("avoids a limited route until its reset, then lets ONE caller re-probe", () => {
    const limit = noteRouteRefusal(
      "anthropic",
      classifyUpstreamRefusal(WORKSPACE_LIMIT, undefined, NOW),
      NOW,
    );
    expect(limit?.until).toBe(RESET);
    expect(routeChoice("anthropic", NOW + 1000)).toBe("avoid");
    expect(routeChoice("anthropic", RESET + 1)).toBe("probe");
    expect(routeChoice("anthropic", RESET + 2)).toBe("avoid"); // probe in flight
    noteRouteOk("anthropic");
    expect(routeChoice("anthropic", RESET + 3)).toBe("direct");
  });

  it("an unknown reset backs off from 15 min, doubling per refused probe", () => {
    const refusal = classifyUpstreamRefusal("insufficient_quota", 429, NOW);
    expect(noteRouteRefusal("openai", refusal, NOW)?.until).toBe(NOW + ROUTE_PROBE_BASE_MS);
    const t = NOW + ROUTE_PROBE_BASE_MS;
    expect(routeChoice("openai", t)).toBe("probe");
    expect(noteRouteRefusal("openai", refusal, t)?.until).toBe(t + 2 * ROUTE_PROBE_BASE_MS);
  });

  it("only usage limits mark a route", () => {
    expect(noteRouteRefusal("anthropic", classifyUpstreamRefusal("429 rate_limit"))).toBe(
      undefined,
    );
    expect(routeChoice("anthropic")).toBe("direct");
  });

  it("survives a restart through core memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "route-health-"));
    const db = new MarinaDB(join(dir, "w.db"));
    try {
      attachRouteHealthStore(coreMemoryRouteStore(db), NOW);
      noteRouteRefusal("anthropic", classifyUpstreamRefusal(WORKSPACE_LIMIT, undefined, NOW), NOW);
      resetRouteHealthForTests();
      expect(routeLimitOf("anthropic")).toBeUndefined();
      attachRouteHealthStore(coreMemoryRouteStore(db), NOW);
      expect(routeLimitOf("anthropic")?.resetAt).toBe(RESET);
      noteRouteOk("anthropic");
      resetRouteHealthForTests();
      attachRouteHealthStore(coreMemoryRouteStore(db), NOW);
      expect(routeLimitOf("anthropic")).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names routes: direct key vs OpenRouter", () => {
    expect(routeLabel("anthropic")).toBe("Anthropic API (direct key)");
    expect(routeLabel("openrouter")).toBe("OpenRouter");
    expect(isDirectRoute("anthropic", "https://api.anthropic.com")).toBe(true);
    expect(isDirectRoute("openai", "http://localhost:8080/v1")).toBe(false); // a local runtime
  });
});

describe("same-model mapping", () => {
  it("maps Anthropic dash versions to OpenRouter dots, verified against the catalog", async () => {
    expect(openRouterIdCandidates("anthropic", "claude-opus-5-5")).toEqual([
      "anthropic/claude-opus-5-5",
      "anthropic/claude-opus-5.5",
    ]);
    expect(openRouterIdCandidates("xai", "grok-5")).toEqual(["x-ai/grok-5"]);
    expect(openRouterIdCandidates("openrouter", "x")).toEqual([]);
    primeOpenRouterCatalogForTests(["anthropic/claude-opus-5.5", "openai/gpt-6.1-sol"]);
    expect(await openRouterSameModel("anthropic", "claude-opus-5-5")).toBe(
      "anthropic/claude-opus-5.5",
    );
    expect(await openRouterSameModel("openai", "gpt-6.1-sol")).toBe("openai/gpt-6.1-sol");
    // Never a different model: an unlisted id has no fallback.
    expect(await openRouterSameModel("anthropic", "claude-opus-5-6")).toBeUndefined();
  });

  it("needs an OpenRouter key, the knob on, and OpenRouter itself not limited", async () => {
    primeOpenRouterCatalogForTests(["anthropic/claude-opus-5.5"]);
    const ok = { hasOpenRouterKey: true, env: {} };
    expect(await sameModelFallback("anthropic", "claude-opus-5-5", ok)).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-opus-5.5",
    });
    expect(
      await sameModelFallback("anthropic", "claude-opus-5-5", { ...ok, hasOpenRouterKey: false }),
    ).toBeUndefined();
    expect(
      await sameModelFallback("anthropic", "claude-opus-5-5", {
        ...ok,
        env: { MARINA_PROVIDER_FALLBACK: "off" },
      }),
    ).toBeUndefined();
    noteRouteRefusal("openrouter", classifyUpstreamRefusal("Payment Required", 402));
    expect(await sameModelFallback("anthropic", "claude-opus-5-5", ok)).toBeUndefined();
  });
});

// ─── /v1 proxy with fake upstreams ───────────────────────────────────────────

const ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "HUGGINGFACE_API_KEY",
  "HF_TOKEN",
  "LLAMA_API_KEY",
  "LLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "MARINA_DAILY_SPEND_CAP_USD",
  "MARINA_PROVIDER_FALLBACK",
] as const;

const ANTHROPIC_LIMIT = () =>
  new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
      },
    }),
    { status: 400, statusText: "Bad Request", headers: { "Content-Type": "application/json" } },
  );

const ANTHROPIC_OK = () =>
  Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "direct" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  });

const OPENROUTER_OK = (model: string) =>
  Response.json({
    id: "gen-1",
    object: "chat.completion",
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: "via or" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

describe("proxyToUpstream: a usage-limited direct route", () => {
  let processState: DisposableStack | undefined;
  let saved: Map<string, string | undefined>;
  let originalFetch: typeof fetch;
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  let calls: { host: string; model: unknown }[];
  let events: EngineEvent[];
  let anthropicReply: () => Response;

  beforeEach(() => {
    using pending = scopeProcessState();
    saved = new Map(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.MARINA_DAILY_SPEND_CAP_USD = "0";
    resetSpendLedgerForTests();
    primeOpenRouterCatalogForTests(["anthropic/claude-opus-5.5"]);
    originalFetch = globalThis.fetch;
    calls = [];
    anthropicReply = ANTHROPIC_LIMIT;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const body = (await req.json()) as { model?: unknown };
      const host = new URL(req.url).host;
      calls.push({ host, model: body.model });
      if (host === "api.anthropic.com") return anthropicReply();
      return OPENROUTER_OK(String(body.model));
    }) as typeof fetch;
    dir = mkdtempSync(join(tmpdir(), "route-fallback-"));
    db = new MarinaDB(join(dir, "w.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    events = [];
    engine.addEventListener((e) => events.push(e));
    processState = pending.move();
  });

  afterEach(() => {
    using _state = processState;
    processState = undefined;
    globalThis.fetch = originalFetch;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    engine.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    resetSpendLedgerForTests();
  });

  const routedTargets = () =>
    events
      .filter(
        (e): e is Extract<EngineEvent, { type: "model_request_lifecycle" }> =>
          e.type === "model_request_lifecycle" && e.phase === "routed",
      )
      .map((e) => e.target);

  const ask = (model: string) =>
    proxyToUpstream(engine, { model, messages: [{ role: "user", content: "hi" }] }, undefined, {
      routeKind: "passthru",
    });

  it("serves the same model via OpenRouter, labelled and priced as OpenRouter", async () => {
    const resp = await ask("anthropic/claude-opus-5-5");
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { model: string }).model).toBe("anthropic/claude-opus-5.5");
    expect(calls).toEqual([
      { host: "api.anthropic.com", model: "claude-opus-5-5" },
      { host: "openrouter.ai", model: "anthropic/claude-opus-5.5" },
    ]);
    // servedBy is OpenRouter — never credited to the direct provider.
    expect(routedTargets()).toEqual(["openrouter/anthropic/claude-opus-5.5"]);
    expect(resp.headers.get("x-marina-upstream-model")).toBe(
      "openrouter/anthropic/claude-opus-5.5",
    );
    expect(resp.headers.get("x-marina-route")).toBe(
      "via=openrouter; anthropic:direct=usage-limit; until=2026-11-01T00:00:00.000Z",
    );
    // OpenRouter's list price for the model: 10 × $4/M + 5 × $20/M.
    expect(Number(resp.headers.get("x-marina-cost-usd"))).toBeCloseTo(0.00014, 8);
    expect(spentTodayUsd()).toBeCloseTo(0.00014, 8);
    expect(routeLimitOf("anthropic")?.resetAt).toBe(RESET);
  });

  it("does not call the limited direct route again until its reset", async () => {
    await ask("anthropic/claude-opus-5-5");
    calls = [];
    const resp = await ask("anthropic/claude-opus-5-5");
    expect(resp.status).toBe(200);
    expect(calls.map((c) => c.host)).toEqual(["openrouter.ai"]);
  });

  it("a successful re-probe restores the direct route", async () => {
    await ask("anthropic/claude-opus-5-5");
    // The limit's time is up: the next call is the one re-probe.
    const limit = routeLimitOf("anthropic")!;
    limit.until = Date.now() - 1;
    anthropicReply = ANTHROPIC_OK;
    calls = [];
    events = [];
    const resp = await ask("anthropic/claude-opus-5-5");
    expect(resp.status).toBe(200);
    expect(calls.map((c) => c.host)).toEqual(["api.anthropic.com"]);
    expect(routedTargets()).toEqual(["anthropic/claude-opus-5-5"]);
    expect(routeLimitOf("anthropic")).toBeUndefined();
  });

  it("with no OpenRouter key: a route-specific refusal, the direct route not hammered", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const first = await ask("anthropic/claude-opus-5-5");
    expect(first.status).toBe(400);
    calls = [];
    const second = await ask("anthropic/claude-opus-5-5");
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("route_usage_limit");
    expect(body.error.message).toContain("Anthropic API (direct key) usage limit until 2026-11-01");
    expect(body.error.message).toContain("no other route serves anthropic/claude-opus-5-5");
    expect(calls).toEqual([]);
  });

  it("never substitutes a different model when OpenRouter does not list this one", async () => {
    primeOpenRouterCatalogForTests(["anthropic/claude-sonnet-5.5"]);
    const resp = await ask("anthropic/claude-opus-5-5");
    expect(resp.status).toBe(400);
    expect(calls.map((c) => c.host)).toEqual(["api.anthropic.com"]);
  });

  it("MARINA_PROVIDER_FALLBACK=off keeps the direct refusal", async () => {
    process.env.MARINA_PROVIDER_FALLBACK = "off";
    const resp = await ask("anthropic/claude-opus-5-5");
    expect(resp.status).toBe(400);
    expect(calls.map((c) => c.host)).toEqual(["api.anthropic.com"]);
  });

  it("a rate limit is not a route limit", async () => {
    anthropicReply = () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow" } }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    const resp = await ask("anthropic/claude-opus-5-5");
    expect(resp.status).toBe(429);
    expect(calls.map((c) => c.host)).toEqual(["api.anthropic.com"]);
    expect(routeLimitOf("anthropic")).toBeUndefined();
  });

  it("readiness names the route, distinct from the daily spend cap", async () => {
    await ask("anthropic/claude-opus-5-5");
    const check = computeReadiness(engine).checks.find((c) => c.id === "provider-routes");
    expect(check?.status).toBe("degraded");
    expect(check?.detail).toContain(
      "anthropic (direct key): usage limit until 2026-11-01 00:00 UTC; anthropic models served via openrouter",
    );
    const lines = renderRouteHealth(describeRouteHealth({ hasOpenRouterKey: true }));
    expect(lines[0]).toContain("not Marina's daily spend cap");
    expect(lines[1]).toContain("anthropic (direct key): usage limit until 2026-11-01 00:00 UTC");
  });
});
