// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The memory relevance gate (`src/memory/relevance-gate.ts`): the pure policy
 * (drop only, exempt core/pinned, unscored kept, at most N), the backends
 * (decision layer, single-LLM fallback, mechanical floor), fail-open with a
 * label, observe mode, and its place in `buildUnifiedContext` — where every
 * surface (builder, `recall <q> all`, passthru injection) must still agree.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DecisionProvider, DecisionRequest, DecisionResult } from "../src/decisions/types";
import { Engine } from "../src/engine/engine";
import { contextCacheStats } from "../src/memory/context-cache";
import {
  CALIBRATED_KEEP_AT,
  gateRelevance,
  gateVerdicts,
  MECHANICAL_COVERAGE_FLOOR,
  mechanicalScores,
  RELEVANCE_GATE_BATCH,
  type RelevanceCandidate,
  relevanceGateMode,
  relevanceGateModel,
  relevanceGateProvider,
  relevanceRequest,
  UNCALIBRATED_KEEP_AT,
} from "../src/memory/relevance-gate";
import {
  buildUnifiedContext,
  NO_RELEVANT_MEMORY,
  renderUnifiedContext,
  type UnifiedContextResult,
} from "../src/memory/unified-context";
import { buildInjectedContext, resolvePassthruIdentity } from "../src/net/passthru-context";
import { MarinaDB } from "../src/persistence/database";
import { type Perception, roomId } from "../src/types";
import { FIXTURE_QUERY, seedUnifiedFixture, tierIds } from "./fixtures/unified-memory-fixture";
import { cleanupDb, makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

const cand = (key: string, content = key, exempt = false): RelevanceCandidate => ({
  key,
  tier: "evidence",
  content,
  exempt,
});

/** A decision backend that answers each memory with the probability `score(text)`. */
function fakeProvider(
  score: (text: string) => number | undefined,
  opts: { calibrated?: boolean; fail?: boolean; costUsd?: number } = {},
): DecisionProvider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    kind: "decisions-api",
    model: "test/judge",
    ...(opts.calibrated === false ? { calibrated: false } : {}),
    requests,
    async ask(request: DecisionRequest): Promise<DecisionResult> {
      requests.push(request);
      if (opts.fail) throw new Error("backend down");
      const memories = (request.state as { memories: { id: string; text: string }[] }).memories;
      const answers: DecisionResult["answers"] = {};
      for (const m of memories) {
        const p = score(m.text);
        if (p !== undefined) answers[m.id] = { type: "noul", noul: p };
      }
      return {
        answers,
        model: "test/judge",
        provider: "decisions-api",
        latencyMs: 1,
        ...(opts.costUsd === undefined ? {} : { costUsd: opts.costUsd }),
      };
    },
  };
}

describe("relevance gate policy (pure)", () => {
  it("drops only below the threshold, keeps exempt and unscored items, never reorders", () => {
    const v = gateVerdicts(
      [cand("a"), cand("b"), cand("c", "c", true), cand("d")],
      [0.9, 0.1, 0.0, undefined],
      { keepAt: 0.3, maxItems: 10 },
    );
    expect(v.keep).toEqual([true, false, true, true]);
    expect(v.why).toEqual(["kept", "irrelevant", "exempt", "unscored"]);
  });

  it("keeps at most N judged items (highest first); exempt items do not count", () => {
    const v = gateVerdicts(
      [cand("a"), cand("b"), cand("c"), cand("x", "x", true)],
      [0.5, 0.9, 0.7, undefined],
      { keepAt: 0.3, maxItems: 2 },
    );
    expect(v.keep).toEqual([false, true, true, true]);
    expect(v.why[0]).toBe("max");
  });

  it("mode and model switches: default off, `none` selects the mechanical floor", () => {
    expect(relevanceGateMode({})).toBe("off");
    expect(relevanceGateMode({ MARINA_MEMORY_RELEVANCE_GATE: "observe" })).toBe("observe");
    expect(relevanceGateMode({ MARINA_MEMORY_RELEVANCE_GATE: "ON" })).toBe("on");
    expect(relevanceGateMode({ MARINA_MEMORY_RELEVANCE_GATE: "bogus" })).toBe("off");
    expect(relevanceGateModel({})).toBe("marina/default");
    expect(relevanceGateModel({ MARINA_MEMORY_RELEVANCE_GATE_MODEL: "none" })).toBeUndefined();
    expect(relevanceGateProvider({ MARINA_MEMORY_RELEVANCE_GATE_MODEL: "none" })).toBeUndefined();
  });

  it("the decision request carries one noul per memory and never more than the item cap", () => {
    const req = relevanceRequest("when did I buy the red kettle?", [
      { content: "x".repeat(5_000) },
      { content: "kettle receipt" },
    ]);
    expect(Object.keys(req.questions)).toEqual(["M1", "M2"]);
    expect(req.questions.M1!.type).toBe("noul");
    const state = req.state as { memories: { text: string }[] };
    expect(Buffer.byteLength(state.memories[0]!.text)).toBeLessThanOrEqual(800);
  });
});

describe("gateRelevance backends", () => {
  const items = [
    cand("evidence:r1", "the red kettle was bought on 3 May at the corner shop"),
    cand("evidence:r2", "a weather report for Lisbon"),
    cand("trusted:7", "core identity: I am the household assistant", true),
  ];

  it("on: drops what the decision layer judges irrelevant; core is never sent or dropped", async () => {
    const provider = fakeProvider((t) => (t.includes("kettle") ? 0.95 : 0.05), { costUsd: 0.001 });
    const r = await gateRelevance("when did I buy the red kettle?", items, {
      mode: "on",
      provider,
    });
    expect([...r.keep].sort()).toEqual(["evidence:r1", "trusted:7"]);
    expect(r.report).toMatchObject({
      outcome: "applied",
      backend: "decision:decisions-api:test/judge",
      calibrated: true,
      candidates: 3,
      exempt: 1,
      scored: 2,
      dropped: ["evidence:r2"],
      kept: 2,
      calls: 1,
      keepAt: CALIBRATED_KEEP_AT,
      costUsd: 0.001,
    });
    const sent = (provider.requests[0]!.state as { memories: { text: string }[] }).memories;
    expect(sent.map((m) => m.text).some((t) => t.includes("core identity"))).toBe(false);
  });

  it("observe: reports the would-be drops and serves everything", async () => {
    const provider = fakeProvider((t) => (t.includes("kettle") ? 0.95 : 0.05));
    const r = await gateRelevance("red kettle", items, { mode: "observe", provider });
    expect(r.keep.size).toBe(3);
    expect(r.report.outcome).toBe("observed");
    expect(r.report.dropped).toEqual(["evidence:r2"]);
  });

  it("fails OPEN on an outage, an incomplete reply, or the spend cap — labelled", async () => {
    const down = await gateRelevance("red kettle", items, {
      mode: "on",
      provider: fakeProvider(() => 0, { fail: true }),
    });
    expect(down.keep.size).toBe(3);
    expect(down.report).toMatchObject({ outcome: "fail_open", reason: "backend_unavailable" });

    const silent = await gateRelevance("red kettle", items, {
      mode: "on",
      provider: fakeProvider(() => undefined),
    });
    expect(silent.keep.size).toBe(3);
    expect(silent.report).toMatchObject({ outcome: "fail_open", reason: "incomplete" });

    const provider = fakeProvider(() => 0);
    const capped = await gateRelevance("red kettle", items, {
      mode: "on",
      provider,
      spendCheck: () => "daily spend cap reached",
    });
    expect(capped.keep.size).toBe(3);
    expect(capped.report).toMatchObject({ outcome: "fail_open", reason: "spend_cap", calls: 0 });
    expect(provider.requests).toHaveLength(0);
  });

  it("an uncalibrated backend gets one cut at 0.5", async () => {
    const provider = fakeProvider((t) => (t.includes("kettle") ? 0.6 : 0.4), { calibrated: false });
    const r = await gateRelevance("red kettle", items, { mode: "on", provider });
    expect(r.report.keepAt).toBe(UNCALIBRATED_KEEP_AT);
    expect(r.report.dropped).toEqual(["evidence:r2"]); // 0.4 would pass a calibrated 0.3 cut
  });

  it("batches judged items, one request per batch", async () => {
    const many = Array.from({ length: RELEVANCE_GATE_BATCH * 2 + 1 }, (_, i) =>
      cand(`evidence:r${i}`, `memory ${i}`),
    );
    const provider = fakeProvider(() => 0.9);
    const r = await gateRelevance("memory", many, { mode: "on", provider, maxItems: 100 });
    expect(provider.requests).toHaveLength(3);
    expect(r.report.calls).toBe(3);
    expect(r.keep.size).toBe(many.length);
  });

  it("mechanical floor (no model): query-term coverage below the floor is dropped", async () => {
    const query = "which corner shop sold the red kettle in May";
    const scores = mechanicalScores(query, items);
    expect(scores[0]!).toBeGreaterThanOrEqual(MECHANICAL_COVERAGE_FLOOR);
    expect(scores[1]!).toBeLessThan(MECHANICAL_COVERAGE_FLOOR);
    const r = await gateRelevance(query, items, { mode: "on" });
    expect(r.report).toMatchObject({ backend: "mechanical", calibrated: false, calls: 0 });
    expect(r.report.dropped).toEqual(["evidence:r2"]);
  });

  it("single-LLM fallback: one verbalized call per batch through this Marina's /v1", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body });
      return new Response(
        JSON.stringify({
          model: "local/one-model",
          choices: [
            {
              message: {
                content: JSON.stringify({ answers: { M1: { noul: 0.9 }, M2: { noul: 0.1 } } }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = relevanceGateProvider(
      {},
      { fetch, selfBaseUrl: "http://127.0.0.1:9/v1", token: async () => "internal" },
    );
    expect(provider?.kind).toBe("marina-classifier");
    expect(provider?.calibrated).toBe(false);
    const r = await gateRelevance("red kettle", items, { mode: "on", provider });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(calls[0]!.body.model).toBe("marina/default");
    expect(r.report).toMatchObject({
      outcome: "applied",
      backend: "model:marina/classifier:marina/default",
      keepAt: UNCALIBRATED_KEEP_AT,
      dropped: ["evidence:r2"],
    });
  });
});

describe("relevance gate inside buildUnifiedContext", () => {
  const TEST_DB = "test_memory_relevance_gate.db";
  let db: MarinaDB;
  let engine: Engine;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const idsOf = (r: UnifiedContextResult) => tierIds(r);

  it("off is unchanged; observe serves the same tiers and only reports", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const off = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);
    expect(off.relevance).toBeUndefined();
    const provider = fakeProvider((t) => (t.includes("hunch") ? 0.01 : 0.9));
    const observed = await buildUnifiedContext(
      db,
      fx.owner,
      FIXTURE_QUERY,
      { relevanceGate: { mode: "observe" } },
      { relevanceProvider: provider },
    );
    expect(idsOf(observed)).toEqual(idsOf(off));
    expect(observed.relevance).toMatchObject({ mode: "observe", outcome: "observed" });
    expect(observed.relevance!.dropped).toEqual([`unverified:${fx.plainNoteId}`]);
  });

  it("on: drops only the judged-irrelevant item; content of the rest is untouched", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const off = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);
    const provider = fakeProvider((t) => (t.includes("hunch") ? 0.01 : 0.9));
    const on = await buildUnifiedContext(
      db,
      fx.owner,
      FIXTURE_QUERY,
      { relevanceGate: { mode: "on" } },
      { relevanceProvider: provider },
    );
    const expected = idsOf(off);
    delete expected.unverified;
    expect(idsOf(on)).toEqual(expected);
    const contents = (r: UnifiedContextResult) =>
      r.tiers.flatMap((t) => t.items.map((i) => `${t.tier}:${i.id}:${i.content}`));
    for (const line of contents(on)) expect(contents(off)).toContain(line);
    expect(on.relevance).toMatchObject({ outcome: "applied", none: false });
  });

  it("never drops a core note", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const coreId = db.createNote(
      fx.owner,
      "Amber deployment core belief: port numbers matter",
      undefined,
      {
        importance: 9,
        noteType: "fact",
        tier: "core",
      },
    );
    const probe = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);
    const surfaced = Object.values(idsOf(probe)).flat().includes(String(coreId));
    expect(surfaced).toBe(true);
    const on = await buildUnifiedContext(
      db,
      fx.owner,
      FIXTURE_QUERY,
      { relevanceGate: { mode: "on" } },
      { relevanceProvider: fakeProvider(() => 0) },
    );
    // Everything judged is dropped; a surfaced core note is exempt and stays.
    expect(Object.values(idsOf(on)).flat()).toEqual(surfaced ? [String(coreId)] : []);
    if (surfaced) expect(on.relevance!.exempt).toBeGreaterThan(0);
  });

  it("nothing relevant ⇒ every render says so explicitly", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const none = await buildUnifiedContext(
      db,
      fx.owner,
      FIXTURE_QUERY,
      { relevanceGate: { mode: "on" } },
      { relevanceProvider: fakeProvider(() => 0) },
    );
    expect(none.tiers.every((t) => t.items.length === 0)).toBe(true);
    expect(none.relevance).toMatchObject({ outcome: "applied", none: true });
    expect(renderUnifiedContext(none)).toBe(NO_RELEVANT_MEMORY);
    expect(renderUnifiedContext(none, { header: false })).toBe(NO_RELEVANT_MEMORY);
  });

  it("a fail-open result is served ungated, labelled, and never cached", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const off = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);
    const provider = fakeProvider(() => 0, { fail: true });
    const opts = { relevanceGate: { mode: "on" as const } };
    const first = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, opts, {
      relevanceProvider: provider,
    });
    expect(idsOf(first)).toEqual(idsOf(off));
    expect(first.relevance).toMatchObject({ outcome: "fail_open", reason: "backend_unavailable" });
    expect(first.relevance!.none).toBeUndefined();
    const hits = contextCacheStats(db).hits;
    await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, opts, { relevanceProvider: provider });
    expect(contextCacheStats(db).hits).toBe(hits);
    expect(provider.requests).toHaveLength(2);
  });

  it("hybrid search is an explicit operator choice; without embeddings it is labelled, not an error", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const lexical = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);
    expect(lexical.degraded).toEqual([]);
    using _env = scopeProcessState({ env: { MARINA_MEMORY_CONTEXT_SEARCH: "hybrid" } });
    const hybrid = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);
    expect(hybrid.degraded).toContainEqual(
      expect.objectContaining({ tier: "evidence", code: "semantic_degraded" }),
    );
    expect(tierIds(hybrid).evidence).toEqual(tierIds(lexical).evidence);
  });

  it("parity: with the gate on (env), the builder, `recall <q> all` and passthru agree", async () => {
    using _env = scopeProcessState({
      env: {
        MARINA_MEMORY_RELEVANCE_GATE: "on",
        MARINA_MEMORY_RELEVANCE_GATE_MODEL: "none",
        MARINA_DECISIONS: undefined,
        MARINA_DECISION_ENGINE: undefined,
      },
    });
    const fx = await seedUnifiedFixture(engine, db);
    // A long query: the mechanical floor (term coverage) separates what the
    // overlap filter alone lets through.
    const query = "Amber deployment production port 7419 ops wiki verified listens excerpt runbook";
    const direct = await buildUnifiedContext(db, fx.owner, query, { budgetBytes: 4096 });
    expect(direct.relevance).toMatchObject({ mode: "on", backend: "mechanical" });
    expect(direct.relevance!.outcome).toBe("applied");
    expect(direct.relevance!.dropped.length).toBeGreaterThan(0);
    expect(Object.keys(tierIds(direct)).length).toBeGreaterThan(0);

    fx.ownerConn.clear();
    await engine.processCommand(fx.ownerEntityId, `recall ${query} all`);
    const memory = fx.ownerConn.messages
      .map((p: Perception) => p.data?.memory as Record<string, unknown> | undefined)
      .findLast(Boolean);
    const recalled = memory?.context as UnifiedContextResult;
    expect(tierIds(recalled)).toEqual(tierIds(direct));
    expect(recalled.relevance?.dropped).toEqual(direct.relevance!.dropped);

    const me = resolvePassthruIdentity(engine, new Headers({ "X-Marina-Agent": fx.owner }), {
      canNameMap: true,
    });
    const { systemAddendum } = await buildInjectedContext(engine, me.entityId, [
      { role: "user", content: query },
    ]);
    // Passthru uses its own tier caps, so compare drops, not whole tier maps.
    for (const key of direct.relevance!.dropped) {
      const [tier, id] = key.split(":") as [string, string];
      const numeric = ["skill", "trusted", "unverified"].includes(tier);
      expect(systemAddendum ?? "").not.toContain(numeric ? `(#${id} ` : id);
    }
  });
});
