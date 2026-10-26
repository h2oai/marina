// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The cheap tier's default output cap (`MARINA_MODEL_TIER_CHEAP_MAX_OUTPUT_TOKENS`):
 * a `marina/cheap` request with no output limit gets `max_tokens` (and, on
 * OpenRouter, a reasoning budget below it); the caller's own limit always
 * wins; `0`/`off` disables it; the strong tier and explicit model ids are
 * untouched; a reply cut at the cap is recorded. Fetch and the provider are
 * mocked; no paid call is made.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { usageFromResponse } from "../benchmarks/modes/passthrough";
import type { ResultItem } from "../benchmarks/types";
import { addCallUsage, summarizeUsage } from "../benchmarks/usage";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import { piModels } from "../src/agent/pi-models";
import {
  CHEAP_OUTPUT_CAP_ENV,
  cheapTierOutputCap,
  DEFAULT_CHEAP_OUTPUT_CAP_TOKENS,
  describeModelTiers,
  tierOutputCapFor,
} from "../src/config/model-tiers";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests } from "../src/engine/trust-profile";
import {
  attachModelTraceSink,
  type ModelLifecycleEvent,
  modelComplete,
  modelTurns,
} from "../src/model";
import { handleModelApi } from "../src/net/model/model-api";
import { setEndpointConfig } from "../src/net/model/model-endpoint";
import {
  OUTPUT_CAP_HEADER,
  resetTierOutputCapCountsForTests,
  tierOutputCapCounts,
  withTierOutputCap,
} from "../src/net/model/tier-output-cap";
import { describeEngineModels } from "../src/net/model-api/upstream";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

const CHEAP = "deepseek/deepseek-v4.1-flash-1017";
const REASONING_BUDGET = Math.floor(DEFAULT_CHEAP_OUTPUT_CAP_TOKENS * 0.75);

describe("the cheap tier's output cap setting", () => {
  it("defaults to 16,384 with a 3/4 reasoning budget; a number sets it; 0/off disables it", () => {
    expect(cheapTierOutputCap({})).toEqual({
      maxTokens: 16_384,
      reasoningMaxTokens: REASONING_BUDGET,
      source: "default",
    });
    expect(cheapTierOutputCap({ [CHEAP_OUTPUT_CAP_ENV]: "8000" })).toEqual({
      maxTokens: 8000,
      reasoningMaxTokens: 6000,
      source: `env:${CHEAP_OUTPUT_CAP_ENV}`,
    });
    for (const off of ["0", "off", "OFF", " none "])
      expect(cheapTierOutputCap({ [CHEAP_OUTPUT_CAP_ENV]: off })).toBeUndefined();
    // Junk never lifts the cap: it falls back to the default.
    expect(cheapTierOutputCap({ [CHEAP_OUTPUT_CAP_ENV]: "lots" })?.maxTokens).toBe(16_384);
    expect(cheapTierOutputCap({ [CHEAP_OUTPUT_CAP_ENV]: "-5" })?.maxTokens).toBe(16_384);
    // A cap too small for a sensible reasoning budget sends none.
    expect(cheapTierOutputCap({ [CHEAP_OUTPUT_CAP_ENV]: "1000" })).toEqual({
      maxTokens: 1000,
      source: `env:${CHEAP_OUTPUT_CAP_ENV}`,
    });
  });

  it("applies to the cheap aliases only", () => {
    for (const id of ["marina/cheap", "marina:cheap", "cheap"])
      expect(tierOutputCapFor(id, {})?.maxTokens).toBe(16_384);
    for (const id of ["marina/strong", "strong", "marina/default", `openrouter/${CHEAP}`, "marina"])
      expect(tierOutputCapFor(id, {})).toBeUndefined();
  });

  it("is in the admin models readout", () => {
    const text = describeModelTiers({ env: { OPENROUTER_API_KEY: "k" } }).join("\n");
    expect(text).toContain(
      `cheap output cap 16384 tokens, OpenRouter reasoning ≤ ${REASONING_BUDGET}`,
    );
    expect(text).toContain(CHEAP_OUTPUT_CAP_ENV);
    const off = describeModelTiers({ env: { [CHEAP_OUTPUT_CAP_ENV]: "off" } }).join("\n");
    expect(off).toContain("cheap output cap off");
  });
});

describe("withTierOutputCap", () => {
  const cap = cheapTierOutputCap({})!;
  it("defaults max_tokens and, on OpenRouter, the reasoning budget", () => {
    expect(withTierOutputCap({ model: "m" }, cap, "openrouter")).toEqual({
      model: "m",
      max_tokens: 16_384,
      reasoning: { max_tokens: REASONING_BUDGET },
    });
    // Other providers get the cap only (they may not take the `reasoning` object).
    expect(withTierOutputCap({ model: "m" }, cap, "deepseek")).toEqual({
      model: "m",
      max_tokens: 16_384,
    });
  });

  it("never touches a caller's own limit, smaller or larger", () => {
    expect(withTierOutputCap({ max_tokens: 500 }, cap, "openrouter")).toBeUndefined();
    expect(withTierOutputCap({ max_tokens: 64_000 }, cap, "openrouter")).toBeUndefined();
    expect(withTierOutputCap({ max_completion_tokens: 40_000 }, cap, "openrouter")).toBeUndefined();
  });

  it("keeps a caller's reasoning directive", () => {
    expect(withTierOutputCap({ reasoning: { effort: "low" } }, cap, "openrouter")).toEqual({
      reasoning: { effort: "low" },
      max_tokens: 16_384,
    });
    expect(withTierOutputCap({ reasoning_effort: "high" }, cap, "openrouter")).toEqual({
      reasoning_effort: "high",
      max_tokens: 16_384,
    });
  });
});

// ── /v1 end to end (OpenRouter mocked) ──────────────────────────────────────

const ENV = [
  ...modelSourceEnvKeys(),
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_DAILY_SPEND_CAP_USD",
  "MARINA_MODEL_TIER_CHEAP",
  "MARINA_MODEL_TIER_STRONG",
  "MARINA_DEFAULT_MODEL",
  CHEAP_OUTPUT_CAP_ENV,
] as const;

describe("/v1 marina/cheap", () => {
  let processState: DisposableStack | undefined;
  let saved: Map<string, string | undefined>;
  let originalFetch: typeof fetch;
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  let sent: Record<string, unknown>[];
  let finish: string;

  beforeEach(() => {
    using pending = scopeProcessState();
    saved = new Map(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    process.env.MARINA_OPEN_API = "true";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.MARINA_MODEL_TIER_STRONG = "openrouter/anthropic/claude-opus-5.5";
    resetTrustProfileForTests();
    resetTierOutputCapCountsForTests();
    sent = [];
    finish = "stop";
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("openrouter.ai")) throw new Error(`unexpected ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      const usage = {
        prompt_tokens: 40,
        completion_tokens: finish === "length" ? Number(body.max_tokens ?? 98_000) : 12,
        completion_tokens_details: { reasoning_tokens: finish === "length" ? 12_000 : 8 },
        cost: 0.0001,
      };
      if (body.stream === true) {
        const frames = [
          { choices: [{ index: 0, delta: { role: "assistant", content: "partial" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
          { choices: [], usage },
        ];
        const sse = `${frames.map((f) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", ...f })}\n\n`).join("")}data: [DONE]\n\n`;
        return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({
        id: "c1",
        object: "chat.completion",
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "partial" }, finish_reason: finish },
        ],
        usage,
      });
    }) as typeof fetch;
    dir = mkdtempSync(join(tmpdir(), "cheap-cap-"));
    db = new MarinaDB(join(dir, "w.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    engine.addConnection(new MockConnection("c1"));
    engine.spawnEntity("c1", "Agent1");
    setEndpointConfig(db, { mode: "passthru" });
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
    resetTierOutputCapCountsForTests();
  });

  async function chat(extra: Record<string, unknown>): Promise<Response> {
    const url = new URL("http://localhost:3300/v1/chat/completions");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Who wrote it?" }], ...extra }),
    });
    const resp = await handleModelApi(url, "POST", req, engine);
    if (!resp) throw new Error("no handler");
    return resp;
  }

  type Lifecycle = Extract<EngineEvent, { type: "model_request_lifecycle" }>;
  const completed = (): Lifecycle[] =>
    engine
      .getEventLog()
      .filter(
        (e): e is Lifecycle => e.type === "model_request_lifecycle" && e.phase === "completed",
      );

  it("applies the default cap and reasoning budget when the caller sets none", async () => {
    const resp = await chat({ model: "marina/cheap" });
    expect(resp.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      model: CHEAP,
      max_tokens: 16_384,
      reasoning: { max_tokens: REASONING_BUDGET },
    });
    expect(resp.headers.get(OUTPUT_CAP_HEADER)).toBe("16384");
    expect(completed().at(-1)).toMatchObject({ outputCap: 16_384 });
    expect(completed().at(-1)).not.toHaveProperty("outputCapHit");
    expect(tierOutputCapCounts()).toEqual({ capped: 1, hits: 0 });
  });

  it("the caller's max_tokens wins, larger or smaller, and is not counted as capped", async () => {
    await chat({ model: "marina/cheap", max_tokens: 64_000 });
    await chat({ model: "marina/cheap", max_tokens: 300 });
    expect(sent.map((b) => b.max_tokens)).toEqual([64_000, 300]);
    expect(sent.every((b) => b.reasoning === undefined)).toBe(true);
    expect(completed().every((e) => e.outputCap === undefined)).toBe(true);
    expect(tierOutputCapCounts()).toEqual({ capped: 0, hits: 0 });
  });

  it("off disables it", async () => {
    process.env[CHEAP_OUTPUT_CAP_ENV] = "off";
    const resp = await chat({ model: "marina/cheap" });
    expect(sent[0]).toMatchObject({ model: CHEAP });
    expect(sent[0]).not.toHaveProperty("max_tokens");
    expect(sent[0]).not.toHaveProperty("reasoning");
    expect(resp.headers.get(OUTPUT_CAP_HEADER)).toBeNull();
  });

  it("an env value sets it", async () => {
    process.env[CHEAP_OUTPUT_CAP_ENV] = "4096";
    await chat({ model: "marina/cheap" });
    expect(sent[0]).toMatchObject({ max_tokens: 4096, reasoning: { max_tokens: 3072 } });
  });

  it("leaves the strong tier and an explicit model id alone", async () => {
    await chat({ model: "marina/strong" });
    await chat({ model: `openrouter/${CHEAP}` });
    expect(sent.map((b) => b.model)).toEqual(["anthropic/claude-opus-5.5", CHEAP]);
    for (const b of sent) {
      expect(b).not.toHaveProperty("max_tokens");
      expect(b).not.toHaveProperty("reasoning");
    }
    expect(tierOutputCapCounts()).toEqual({ capped: 0, hits: 0 });
  });

  it("records a reply cut at the cap: header, lifecycle event, counts, admin models", async () => {
    finish = "length";
    const resp = await chat({ model: "marina/cheap" });
    expect(resp.status).toBe(200);
    expect(resp.headers.get(OUTPUT_CAP_HEADER)).toBe("16384; hit");
    expect(completed().at(-1)).toMatchObject({ outputCap: 16_384, outputCapHit: true });
    expect(tierOutputCapCounts()).toEqual({ capped: 1, hits: 1 });
    // A streamed reply is recorded from its finish frame.
    const streamed = await chat({ model: "marina/cheap", stream: true });
    await streamed.text();
    expect(completed().at(-1)).toMatchObject({ outputCap: 16_384, outputCapHit: true });
    expect(tierOutputCapCounts()).toEqual({ capped: 2, hits: 2 });
    expect(describeEngineModels(engine).join("\n")).toContain(
      "cheap output cap since start: 2 capped replies, 2 cut at the cap (100.0 %)",
    );
    // The benchmark harness reads the hit off the header.
    const usage = usageFromResponse(
      (await resp.clone().json()) as { usage?: Record<string, unknown> },
      null,
      resp.headers.get(OUTPUT_CAP_HEADER),
    );
    expect(usage).toMatchObject({ outputCapHit: true, reasoningTokens: 12_000 });
  });
});

// ── src/model (provider mocked) ────────────────────────────────────────────

describe("src/model on marina/cheap", () => {
  let active: { mockRestore(): void } | undefined;
  let events: ModelLifecycleEvent[];
  let detach: () => void;
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    MODEL_API_KEYS: "test-model-key",
    MARINA_MODEL_RETRY_BASE_MS: "0",
    ...extra,
  });

  function provider(stopReason: AssistantMessage["stopReason"] = "stop") {
    active?.mockRestore();
    const seen: number[] = [];
    active = spyOn(piModels, "completeSimple").mockImplementation((async (
      _model: unknown,
      _context: unknown,
      opts: { maxTokens?: number },
    ) => {
      seen.push(opts.maxTokens ?? -1);
      return {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "openai-completions",
        provider: "marina",
        model: "cheap",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: Date.now(),
      } as AssistantMessage;
    }) as unknown as typeof piModels.completeSimple);
    return seen;
  }

  beforeEach(() => {
    events = [];
    detach = attachModelTraceSink((e) => events.push(e));
    resetTierOutputCapCountsForTests();
  });
  afterEach(() => {
    active?.mockRestore();
    active = undefined;
    detach();
    resetTierOutputCapCountsForTests();
  });

  it("a turn without a caller cap is bounded by the tier's; a length stop is a hit", async () => {
    const seen = provider("length");
    const turns = modelTurns("marina/cheap", env({ [CHEAP_OUTPUT_CAP_ENV]: "4000" }));
    await turns.turn({ messages: [] });
    expect(seen).toEqual([4000]);
    expect(events.find((e) => e.phase === "completed")).toMatchObject({
      outputCap: 4000,
      outputCapHit: true,
    });
    expect(tierOutputCapCounts()).toEqual({ capped: 1, hits: 1 });
  });

  it("the caller's cap wins, and an explicit model or the strong tier is untouched", async () => {
    const seen = provider();
    await modelTurns("marina/cheap", env(), { maxTokens: 30_000 }).turn({ messages: [] });
    await modelTurns("marina/strong", env({ [CHEAP_OUTPUT_CAP_ENV]: "4000" })).turn({
      messages: [],
    });
    await modelTurns("marina/cheap", env({ [CHEAP_OUTPUT_CAP_ENV]: "off" })).turn({
      messages: [],
    });
    expect(seen).toEqual([30_000, 16_000, 16_000]);
    expect(events.every((e) => e.outputCap === undefined)).toBe(true);
    expect(tierOutputCapCounts()).toEqual({ capped: 0, hits: 0 });
  });

  it("modelComplete's automatic cap and its grown retry stay under the tier's", async () => {
    const seen = provider();
    const { complete } = modelComplete("marina/cheap", env({ [CHEAP_OUTPUT_CAP_ENV]: "6000" }));
    await complete("system", "user");
    expect(seen).toEqual([6000]);
    const explicit = modelComplete("marina/cheap", env({ [CHEAP_OUTPUT_CAP_ENV]: "6000" }), {
      maxTokens: 20_000,
    });
    await explicit.complete("system", "user");
    expect(seen.at(-1)).toBe(20_000);
  });
});

describe("benchmark usage", () => {
  it("counts cap hits and reasoning tokens per item and per run", () => {
    const capped = usageFromResponse(
      {
        usage: {
          completion_tokens: 16_384,
          completion_tokens_details: { reasoning_tokens: 16_000 },
        },
      },
      null,
      "16384; hit",
    );
    const normal = usageFromResponse({ usage: { completion_tokens: 200 } }, null, "16384");
    expect(capped.outputCapHit).toBe(true);
    expect(normal).not.toHaveProperty("outputCapHit");
    const item = addCallUsage(addCallUsage(undefined, normal), capped);
    expect(item).toMatchObject({ calls: 2, outputCapHits: 1, reasoningTokens: 16_000 });
    expect(addCallUsage(undefined, normal)).not.toHaveProperty("outputCapHits");
    const summary = summarizeUsage([
      { usage: item } as unknown as ResultItem,
      { usage: addCallUsage(undefined, normal) } as unknown as ResultItem,
    ]);
    expect(summary).toMatchObject({ outputCapHits: 1, reasoningTokens: 16_000 });
  });
});

// ── marina/verify and the ensemble (OpenRouter and Anthropic mocked) ─────────

describe("tier members inside marina/verify and the ensemble", () => {
  let processState: DisposableStack | undefined;
  let saved: Map<string, string | undefined>;
  let originalFetch: typeof fetch;
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  let calls: { url: string; body: Record<string, unknown> }[];
  let proposerFinish: string;

  const isChecker = (body: Record<string, unknown>) =>
    JSON.stringify(body.messages ?? body.system ?? "").includes(
      "You review an assistant's DRAFT",
    ) || JSON.stringify(body.system ?? "").includes("You review an assistant's DRAFT");

  beforeEach(() => {
    using pending = scopeProcessState();
    saved = new Map(
      [...ENV, "MARINA_VERIFY_CHECKER_MODEL", "MARINA_VERIFY_ROUNDS", "MARINA_ENSEMBLE_SIZE"].map(
        (k) => [k, process.env[k]],
      ),
    );
    for (const k of saved.keys()) delete process.env[k];
    process.env.MARINA_OPEN_API = "true";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.MARINA_MODEL_TIER_CHEAP = `openrouter/${CHEAP}`;
    process.env.MARINA_MODEL_TIER_STRONG = "openrouter/anthropic/claude-opus-5.5";
    resetTrustProfileForTests();
    resetTierOutputCapCountsForTests();
    calls = [];
    proposerFinish = "stop";
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      const checker = isChecker(body);
      const text = checker ? '{"verdict":"approve","issues":""}' : "Ray Charles";
      if (url.includes("api.anthropic.com")) {
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 8 },
        });
      }
      if (!url.includes("openrouter.ai")) throw new Error(`unexpected ${url}`);
      const finish = checker ? "stop" : proposerFinish;
      return Response.json({
        id: "c1",
        object: "chat.completion",
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: finish },
        ],
        usage: { prompt_tokens: 20, completion_tokens: finish === "length" ? 16_384 : 8 },
      });
    }) as typeof fetch;
    dir = mkdtempSync(join(tmpdir(), "cheap-cap-verify-"));
    db = new MarinaDB(join(dir, "w.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    engine.addConnection(new MockConnection("c1"));
    engine.spawnEntity("c1", "Agent1");
    processState = pending.move();
  });

  afterEach(async () => {
    using _state = processState;
    processState = undefined;
    await engine.shutdown();
    globalThis.fetch = originalFetch;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
    resetTierOutputCapCountsForTests();
  });

  async function chat(model: string, headers: Record<string, string> = {}): Promise<Response> {
    const url = new URL("http://localhost:3300/v1/chat/completions");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Who sang it?" }] }),
    });
    const resp = await handleModelApi(url, "POST", req, engine);
    if (!resp) throw new Error("no handler");
    return resp;
  }

  type Lifecycle = Extract<EngineEvent, { type: "model_request_lifecycle" }>;
  const completedFor = (reason: string): Lifecycle[] =>
    engine
      .getEventLog()
      .filter(
        (e): e is Lifecycle =>
          e.type === "model_request_lifecycle" &&
          e.phase === "completed" &&
          e.routeReason === reason,
      );

  it("a marina/cheap proposer gets the tier model and its cap; an explicit checker is untouched", async () => {
    proposerFinish = "length";
    const resp = await chat("marina/verify:marina/cheap+anthropic/claude-opus-5-5");
    expect(resp.status).toBe(200);
    const proposer = calls.find((c) => c.url.includes("openrouter.ai"));
    expect(proposer?.body).toMatchObject({
      model: CHEAP,
      max_tokens: 16_384,
      reasoning: { max_tokens: REASONING_BUDGET },
    });
    expect(completedFor("verify:proposer").at(-1)).toMatchObject({
      outputCap: 16_384,
      outputCapHit: true,
    });
    // The checker, named explicitly, goes to Anthropic with no tier cap.
    const checker = calls.find((c) => c.url.includes("api.anthropic.com"));
    expect(checker?.body.model).toBe("claude-opus-5-5");
    expect(checker?.body.max_tokens).not.toBe(16_384);
    expect(checker?.body).not.toHaveProperty("reasoning");
    expect(completedFor("verify:checker").at(-1)).not.toHaveProperty("outputCap");
    expect(tierOutputCapCounts()).toEqual({ capped: 1, hits: 1 });
  });

  it("marina/strong inside verify resolves to the strong tier with no cap", async () => {
    const resp = await chat("marina/verify:marina/strong");
    expect(resp.status).toBe(200);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.body.model).toBe("anthropic/claude-opus-5.5");
      expect(c.body).not.toHaveProperty("max_tokens");
      expect(c.body).not.toHaveProperty("reasoning");
    }
    expect(tierOutputCapCounts()).toEqual({ capped: 0, hits: 0 });
  });

  it("an explicit proposer id in a verify spec is untouched", async () => {
    await chat(`marina/verify:openrouter/${CHEAP}+anthropic/claude-opus-5-5`);
    const proposer = calls.find((c) => c.url.includes("openrouter.ai"));
    expect(proposer?.body.model).toBe(CHEAP);
    expect(proposer?.body).not.toHaveProperty("max_tokens");
    expect(tierOutputCapCounts()).toEqual({ capped: 0, hits: 0 });
  });

  it("the ensemble's cheap drafts record a hit", async () => {
    process.env.MARINA_ENSEMBLE_SIZE = "2";
    proposerFinish = "length";
    const resp = await chat("marina/cheap", { "x-marina-stack": "ensemble" });
    expect(resp.status).toBe(200);
    const drafts = calls.filter((c) => c.url.includes("openrouter.ai") && !isChecker(c.body));
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    for (const d of drafts) expect(d.body).toMatchObject({ model: CHEAP, max_tokens: 16_384 });
    const hits = engine
      .getEventLog()
      .filter(
        (e) =>
          e.type === "model_request_lifecycle" &&
          e.phase === "completed" &&
          e.routeReason?.startsWith("ensemble:proposer") &&
          e.outputCapHit === true,
      );
    expect(hits).toHaveLength(drafts.length);
  });
});
