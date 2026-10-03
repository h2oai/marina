// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { recordScoredRun } from "../benchmarks/futurex/ledger";
import type { BatchRun, Variant } from "../benchmarks/futurex/run";
import type { BatchScore } from "../benchmarks/futurex/score";
import { ledgerFileBody } from "../benchmarks/ledger-file";
import type { BenchmarkResult } from "../benchmarks/types";
import { loadEvidenceItems } from "../src/engine/benchmark-evidence";
import {
  benchmarkMaxFallbackRate,
  DEFAULT_MAX_FALLBACK_RATE,
  fallbackInvalidReason,
  invalidReason,
  isFallbackItem,
  ledgerFromHarnessResult,
  sliceHash,
} from "../src/engine/benchmark-ledger";
import { getPromotedDefault, lookupChallenge } from "../src/engine/benchmark-promotion";
import { loadReplicateGroup } from "../src/engine/benchmark-replicates";
import { freeTextModifier } from "../src/engine/commands/benchmark";
import { Engine } from "../src/engine/engine";
import { RETENTION_POLICIES } from "../src/engine/retention";
import { grant } from "../src/engine/safety-gates";
import { handleBenchmarkFile } from "../src/net/benchmarks-api";
import type { PassthruAuthResult } from "../src/net/model-api/shared";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const SLOT = "crew:answerer:formation";
const IDS = Array.from({ length: 200 }, (_, i) => `item-${i}`);
const incumbentRight = (i: number) => i % 5 < 2;
const strongRight = (i: number) => i % 5 < 4;

/** Record one ledger run on the shared 200-item slice. */
function recordRun(
  db: MarinaDB,
  id: string,
  correct: (i: number) => boolean,
  extra: {
    group?: string;
    model?: string;
    agent_id?: string;
    invalid_reason?: string;
    participants?: string;
    cost?: number;
  } = {},
): void {
  const items = IDS.map((item_id, i) => ({
    item_id,
    correct: correct(i),
    score: null,
    latency_ms: null,
    cost_usd: extra.cost ?? 0.01,
    trace_id: null,
    participants_json: extra.participants ?? null,
    judge_verdict: null,
  }));
  const right = items.filter((i) => i.correct).length;
  db.recordBenchmarkLedgerRun(
    {
      id,
      benchmark: "synthetic",
      config_hash: id,
      config_json: "{}",
      agent_id: extra.agent_id ?? null,
      started_at: 0,
      completed_at: 1,
      duration_ms: 1,
      score: right / items.length,
      answered: items.length,
      total: items.length,
      cost_usd: (extra.cost ?? 0.01) * items.length,
      n: items.length,
      ci_low: 0,
      ci_high: 1,
      seed: 1,
      slice_hash: sliceHash(IDS),
      judge: "judge/model",
      target_kind: "model",
      target_json: JSON.stringify({ model: extra.model ?? `model-${extra.group ?? id}` }),
      label: id,
      source: "import",
      content_hash: null,
      replicate_group: extra.group ?? id,
      ...(extra.invalid_reason ? { invalid_reason: extra.invalid_reason } : {}),
    },
    items,
  );
}

function invalidate(db: MarinaDB, id: string, reason = "spend cap hit mid-run") {
  const res = db.setBenchmarkRunValidity({
    run_id: id,
    action: "invalidate",
    reason,
    actor: "operator",
    source: "operator",
    created_at: 5,
  });
  expect(res.ok).toBe(true);
}

describe("fallback rate", () => {
  it("parses the threshold conservatively: junk is the default, off disables", () => {
    expect(benchmarkMaxFallbackRate({})).toBe(DEFAULT_MAX_FALLBACK_RATE);
    expect(benchmarkMaxFallbackRate({ MARINA_BENCHMARK_MAX_FALLBACK_RATE: "0.1" })).toBe(0.1);
    expect(benchmarkMaxFallbackRate({ MARINA_BENCHMARK_MAX_FALLBACK_RATE: "off" })).toBeNull();
    expect(benchmarkMaxFallbackRate({ MARINA_BENCHMARK_MAX_FALLBACK_RATE: "1" })).toBeNull();
    for (const junk of ["lots", "-1", "2", " "]) {
      expect(benchmarkMaxFallbackRate({ MARINA_BENCHMARK_MAX_FALLBACK_RATE: junk })).toBe(
        DEFAULT_MAX_FALLBACK_RATE,
      );
    }
  });

  it("names the rate in the reason only when the threshold is exceeded", () => {
    expect(fallbackInvalidReason(114, 96, 0.25)).toBe(
      "fallback rate 84.2% exceeds threshold 25% (96 of 114 items were fallbacks, not answers)",
    );
    expect(fallbackInvalidReason(100, 25, 0.25)).toBeUndefined(); // strictly exceeded
    expect(fallbackInvalidReason(100, 90, null)).toBeUndefined();
    expect(fallbackInvalidReason(0, 0, 0.25)).toBeUndefined();
  });

  it("counts flagged items and the harness's ERROR: marker", () => {
    expect(isFallbackItem({ fallback: true })).toBe(true);
    expect(isFallbackItem({ actual: "ERROR: 429 spend_cap_reached" })).toBe(true);
    expect(isFallbackItem({ actual: "42" })).toBe(false);
    expect(isFallbackItem({})).toBe(false);
  });

  it("builds an invalid ledger run from a mostly-fallback result, and a valid one otherwise", () => {
    const file = (errors: number) => ({
      config: { dataset: "synthetic" },
      items: Array.from({ length: 10 }, (_, i) => ({
        id: `q${i}`,
        correct: i >= errors && i % 2 === 0,
        ...(i < errors ? { actual: "ERROR: daily spend cap reached" } : { actual: "x" }),
      })),
    });
    const opts = { targetKind: "model" as const, target: "m", raw: "", id: "r", now: 1 };
    const bad = ledgerFromHarnessResult(file(6), { ...opts, maxFallbackRate: 0.25 });
    expect(bad.run.invalid_reason).toContain("fallback rate 60%");
    // Item ids and outcomes are kept; the response text never is.
    expect(bad.items).toHaveLength(10);
    expect(JSON.stringify(bad.items)).not.toContain("spend cap");
    const ok = ledgerFromHarnessResult(file(2), { ...opts, maxFallbackRate: 0.25 });
    expect(ok.run.invalid_reason).toBeNull();
    const off = ledgerFromHarnessResult(file(6), { ...opts, maxFallbackRate: null });
    expect(off.run.invalid_reason).toBeNull();
  });

  it("marks errored harness items as fallbacks when filing, without their text", () => {
    const result = {
      config: { name: "x", dataset: "synthetic", endpoint: "e", model: "m" },
      timestamp: 1,
      duration_ms: 1,
      scores: { overall: 0, breakdown: {} },
      metadata: { total: 2, answered: 1, timeouts: 0, errors: 1, avgLatencyMs: 0 },
      items: [
        { id: "a", question: "q", expected: "e", actual: "ERROR: HTTP 429", correct: false },
        { id: "b", question: "q", expected: "e", actual: "fine", correct: true },
      ],
    } as unknown as BenchmarkResult;
    const body = ledgerFileBody(result, { fileTo: "x", targetKind: "model", target: "m" });
    const items = body.result.items as Array<{ id: string; fallback?: boolean }>;
    expect(items.find((i) => i.id === "a")?.fallback).toBe(true);
    expect(items.find((i) => i.id === "b")?.fallback).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("HTTP 429");
  });

  it("records a FutureX run invalid when most rows fell back", () => {
    const db = new MarinaDB(":memory:");
    try {
      const n = 8;
      const results = Array.from({ length: n }, (_, i) => ({
        id: `r${i}`,
        prediction: "A",
        fallback: i < 6,
        costUsd: 0,
        latencyMs: 1,
      }));
      const score = {
        overall: 0.5,
        byLevel: {},
        items: results.map((r) => ({ id: r.id, score: 1, level: 1, metric: "exact" })),
      } as unknown as BatchScore;
      const rec = recordScoredRun(db, {
        benchmark: "futurex-past-clean",
        batchSha: "abcdef1234",
        variant: { label: "v", model: "m", analysts: [] } as unknown as Variant,
        run: {
          variant: "v",
          results,
          costUsd: 0,
          startedAt: "2026-10-01T00:00:00Z",
          finishedAt: "2026-10-01T01:00:00Z",
        } as unknown as BatchRun,
        score,
      });
      expect(rec.invalidReason).toContain("fallback rate 75%");
      const run = db.getBenchmarkRun(rec.id)!;
      expect(run.status).toBe("invalid");
      expect(db.getBenchmarkItems(rec.id)).toHaveLength(n);
      const audit = db.listBenchmarkRunValidity(rec.id);
      expect(audit.map((a) => [a.action, a.source, a.actor])).toEqual([
        ["invalidate", "auto", null],
      ]);
    } finally {
      db.close();
    }
  });
});

describe("validity store", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(() => db.close());

  it("invalidates and revalidates with an append-only audit, and keeps every item", () => {
    recordRun(db, "r1", incumbentRight);
    invalidate(db, "r1");
    expect(db.getBenchmarkRun("r1")?.status).toBe("invalid");
    expect(invalidReason(db, db.getBenchmarkRun("r1")!)).toBe("spend cap hit mid-run");
    expect(db.getBenchmarkItems("r1")).toHaveLength(IDS.length);

    // Only completed → invalid and invalid → completed are accepted.
    const again = db.setBenchmarkRunValidity({
      run_id: "r1",
      action: "invalidate",
      reason: "again",
      actor: null,
      source: "operator",
      created_at: 6,
    });
    expect(again).toEqual({
      ok: false,
      error: "Run r1 is invalid; only a completed run can be invalidated.",
    });
    expect(
      db.setBenchmarkRunValidity({
        run_id: "missing",
        action: "invalidate",
        reason: "x",
        actor: null,
        source: "operator",
        created_at: 6,
      }).ok,
    ).toBe(false);

    const back = db.setBenchmarkRunValidity({
      run_id: "r1",
      action: "revalidate",
      reason: "cap was not the cause",
      actor: "operator",
      source: "operator",
      created_at: 7,
    });
    expect(back.ok && back.status).toBe("completed");
    expect(invalidReason(db, db.getBenchmarkRun("r1")!)).toBeUndefined();
    expect(db.listBenchmarkRunValidity("r1").map((r) => r.action)).toEqual([
      "invalidate",
      "revalidate",
    ]);
    const raw = (db as unknown as { db: { run(sql: string): unknown } }).db;
    expect(() => raw.run("UPDATE benchmark_run_validity SET reason = 'x'")).toThrow(/append-only/);
  });

  it("never prunes the validity audit", () => {
    const kinds = Object.fromEntries(RETENTION_POLICIES.map((p) => [p.table, p.kind]));
    expect(kinds.benchmark_run_validity).toBe("append-only");
  });

  it("records an auto-invalid run in the same transaction as its items", () => {
    recordRun(db, "bad", incumbentRight, { invalid_reason: "fallback rate 90% exceeds threshold" });
    expect(db.getBenchmarkRun("bad")?.status).toBe("invalid");
    expect(db.listBenchmarkRunValidity("bad")[0]).toMatchObject({
      action: "invalidate",
      source: "auto",
      reason: "fallback rate 90% exceeds threshold",
    });
  });
});

describe("every ledger reader excludes invalid runs", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(() => db.close());

  it("leaderboard and frontier (leaderboardBenchmark)", () => {
    recordRun(db, "good", incumbentRight);
    recordRun(db, "bad", strongRight);
    invalidate(db, "bad");
    expect(db.leaderboardBenchmark("synthetic", 50).map((r) => r.id)).toEqual(["good"]);
  });

  it("participants (items of completed runs only)", () => {
    const p = (agent: string) => JSON.stringify([{ agent, model: "m" }]);
    recordRun(db, "good", incumbentRight, { participants: p("Alice") });
    recordRun(db, "bad", strongRight, { participants: p("Mallory") });
    invalidate(db, "bad");
    const runIds = new Set(db.getBenchmarkItemsForBenchmark("synthetic").map((i) => i.run_id));
    expect([...runIds]).toEqual(["good"]);
  });

  it("replicate pooling, including the invalid run's own group", () => {
    recordRun(db, "a1", incumbentRight, { group: "g" });
    recordRun(db, "a2", incumbentRight, { group: "g" });
    recordRun(db, "a3", strongRight, { group: "g" });
    invalidate(db, "a3");
    const g = loadReplicateGroup(db, db.getBenchmarkRun("a1")!);
    expect(g.runs.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
    const own = loadReplicateGroup(db, db.getBenchmarkRun("a3")!);
    expect(own.runs.map((r) => r.id).sort()).toEqual(["a1", "a2"]);
  });

  it("route evidence (loadEvidenceItems)", () => {
    recordRun(db, "good", incumbentRight, { model: "model-good" });
    recordRun(db, "bad", strongRight, { model: "model-bad" });
    invalidate(db, "bad");
    const items = loadEvidenceItems(db, ["synthetic"]);
    expect(items).toHaveLength(IDS.length);
    expect(new Set(items.map((i) => i.targetModel))).toEqual(new Set(["model-good"]));
  });

  it("promotion: an invalid challenger is refused; an invalid incumbent is re-seeded", () => {
    recordRun(db, "base", incumbentRight, { group: "base" });
    recordRun(db, "base-r2", incumbentRight, { group: "base" });
    recordRun(db, "strong", strongRight, { group: "strong" });
    recordRun(db, "strong-r2", strongRight, { group: "strong" });
    db.recordBenchmarkPromotion({
      slot: SLOT,
      outcome: "seeded",
      challenger_run_id: "base",
      incumbent_run_id: null,
      value_json: JSON.stringify({ model: "model-base" }),
      actor: "op",
      stats_json: null,
      reason: "first incumbent",
      created_at: 1,
    });
    expect(getPromotedDefault<{ model: string }>(db, SLOT)?.model).toBe("model-base");

    invalidate(db, "strong");
    const refused = lookupChallenge(db, SLOT, "strong", "selection");
    expect(refused.kind).toBe("error");
    expect(refused.kind === "error" && refused.message).toContain("invalid (spend cap hit");
    // The invalid replicate no longer counts toward its group's replicates.
    const peer = lookupChallenge(db, SLOT, "strong-r2", "holdout", { minReplicates: 2 });
    expect(peer.kind === "error" && peer.message).toContain("Not replicated");

    invalidate(db, "base");
    // The default rests on no valid evidence: it reads as unset.
    expect(getPromotedDefault(db, SLOT)).toBeUndefined();
    const reseed = lookupChallenge(db, SLOT, "base-r2", "holdout", { minReplicates: 1 });
    expect(reseed.kind).toBe("seed");
    // The slot never had another valid incumbent: replicates alone re-seed it.
    expect(reseed.kind === "seed" && reseed.invalidIncumbent).toEqual({
      id: "base",
      invalidatedBy: "operator",
    });
  });

  it("promotion: with a valid earlier incumbent, the challenger must beat it on the holdout", () => {
    const seed = (outcome: "seeded" | "promoted", run: string, model: string, at: number) =>
      db.recordBenchmarkPromotion({
        slot: SLOT,
        outcome,
        challenger_run_id: run,
        incumbent_run_id: null,
        value_json: JSON.stringify({ model }),
        actor: "op",
        stats_json: null,
        reason: null,
        created_at: at,
      });
    const weak = (i: number) => i % 5 < 1;
    recordRun(db, "base", incumbentRight, { group: "base" });
    recordRun(db, "base-r2", incumbentRight, { group: "base" });
    recordRun(db, "low", weak, { group: "low" });
    recordRun(db, "mid", strongRight, { group: "mid" });
    recordRun(db, "twin", incumbentRight, { group: "twin" });
    recordRun(db, "twin-r2", incumbentRight, { group: "twin" });
    seed("seeded", "low", "model-low", 1);
    seed("promoted", "base", "model-base", 2);
    seed("promoted", "mid", "model-mid", 3);
    invalidate(db, "mid");

    // The best earlier incumbent still valid is `base` (higher accuracy than `low`).
    const tie = lookupChallenge(db, SLOT, "twin", "holdout");
    expect(tie.kind).toBe("contest");
    if (tie.kind !== "contest") return;
    expect(tie.incumbent.id).toBe("base");
    expect(tie.invalidIncumbent?.id).toBe("mid");
    // A twin of that run does not earn the slot by the invalidation alone.
    expect(tie.evaluation.ok).toBe(false);
  });
});

describe("benchmark invalidate | revalidate — commands", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-invalidate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "Lobby", long: "Lobby." }));
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  function login(name: string) {
    const conn = new MockConnection(`c-${name}`);
    engine.addConnection(conn);
    engine.login(conn.id, name);
    conn.clear();
    const send = (cmd: string): string => {
      conn.clear();
      engine.processCommand(conn.entity!, cmd);
      return stripAnsi(conn.allTextJoined());
    };
    return { conn, send };
  }

  it("parses a free-text reason in every modifier spelling", () => {
    expect(freeTextModifier(["reason:spend", "cap", "hit"], "reason")).toBe("spend cap hit");
    expect(freeTextModifier(["--reason", "spend", "cap"], "reason")).toBe("spend cap");
    expect(freeTextModifier(["reason=a"], "reason")).toBe("a");
    expect(freeTextModifier(["reason:"], "reason")).toBeUndefined();
    expect(freeTextModifier(["spend", "cap"], "reason")).toBeUndefined();
  });

  it("refuses without role.edit and writes nothing", () => {
    recordRun(db, "r1", incumbentRight);
    const viewer = login("Viewer");
    const reply = viewer.send("benchmark invalidate r1 reason:spend cap");
    expect(reply).toContain("held: challenge");
    expect(db.getBenchmarkRun("r1")?.status).toBe("completed");
    expect(db.listBenchmarkRunValidity("r1")).toHaveLength(0);
    expect(viewer.send("benchmark invalidate r1")).toContain("Usage: benchmark invalidate");
  });

  it("invalidates, shows it marked everywhere it is listed, and hides it from every ranking", () => {
    recordRun(db, "good", incumbentRight, { group: "g1" });
    recordRun(db, "good-r2", incumbentRight, { group: "g1" });
    recordRun(db, "bad", strongRight, { group: "g2" });
    const op = login("Operator");
    grant(db, op.conn.entity!, "role.edit");

    const done = op.send("benchmark invalidate bad reason:96 of 114 rows fell back after the cap");
    expect(done).toContain("Invalidated bad");
    expect(db.getBenchmarkRun("bad")?.status).toBe("invalid");
    const [row] = db.listBenchmarkRunValidity("bad");
    expect(row).toMatchObject({
      action: "invalidate",
      source: "in-world",
      reason: "96 of 114 rows fell back after the cap",
    });
    expect(row?.actor).toBe(db.durableEntityKey(op.conn.entity!));
    expect(db.getBenchmarkItems("bad")).toHaveLength(IDS.length);

    const runs = op.send("benchmark runs");
    expect(runs).toContain("bad");
    expect(runs).toContain("INVALID");
    expect(runs).toContain("96 of 114 rows fell back after the cap");
    const result = op.send("benchmark result bad");
    expect(result).toContain("invalid");
    expect(result).toContain("96 of 114 rows fell back after the cap");
    expect(result).toContain("validity:");

    const board = op.send("benchmark leaderboard synthetic");
    expect(board).toContain("good");
    expect(board).not.toContain("bad");
    const frontier = op.send("benchmark frontier synthetic");
    expect(frontier).not.toContain("bad");
    expect(op.send("benchmark compare good bad")).toContain("invalid runs are never compared");
    expect(op.send("benchmark replicates bad")).toContain("excluded from its group");
    expect(op.send("benchmark participants synthetic")).not.toContain("bad");
    expect(op.send(`benchmark challenge ${SLOT} bad`)).toContain("an invalid run is never");
  });

  it("never lets the invalidator of an incumbent fill its slot, and makes others earn it", () => {
    const op = login("Invalidator");
    grant(db, op.conn.entity!, "role.edit");
    const other = login("Promoter");
    grant(db, other.conn.entity!, "role.edit");
    recordRun(db, "base", incumbentRight, { group: "base" });
    recordRun(db, "base-r2", incumbentRight, { group: "base" });
    recordRun(db, "mid", (i) => i % 5 < 3, { group: "mid" });
    recordRun(db, "mid-r2", (i) => i % 5 < 3, { group: "mid" });
    recordRun(db, "twin", incumbentRight, { group: "twin" });
    recordRun(db, "twin-r2", incumbentRight, { group: "twin" });
    recordRun(db, "mine", strongRight, { group: "mine", agent_id: op.conn.entity! });
    recordRun(db, "mine-r2", strongRight, { group: "mine", agent_id: op.conn.entity! });
    recordRun(db, "strong", strongRight, { group: "strong" });
    recordRun(db, "strong-r2", strongRight, { group: "strong" });
    expect(other.send(`benchmark promote ${SLOT} base`)).toContain(`Seeded ${SLOT}`);
    expect(other.send(`benchmark promote ${SLOT} mid`)).toContain("Promoted");

    expect(op.send("benchmark invalidate mid reason:cap")).toContain("Invalidated mid");
    // The invalidator may not promote anything into the slot…
    expect(op.send(`benchmark promote ${SLOT} strong`)).toContain(
      "you invalidated the incumbent mid",
    );
    // …nor may anyone promote a run the invalidator authored.
    expect(other.send(`benchmark promote ${SLOT} mine`)).toContain(
      "the author of mine invalidated the incumbent mid",
    );
    const before = db.listBenchmarkPromotions(SLOT).length;
    expect(before).toBe(2); // refusals for self-attestation record nothing

    // Someone else must beat the best earlier incumbent still valid (`base`).
    const tie = other.send(`benchmark promote ${SLOT} twin`);
    expect(tie).toContain("did not beat base");
    expect(getPromotedDefault(db, SLOT)).toBeUndefined();
    const won = other.send(`benchmark promote ${SLOT} strong`);
    expect(won).toContain("Promoted");
    expect(won).toContain("the invalidated mid");
    expect(getPromotedDefault<{ model: string }>(db, SLOT)?.model).toBe("model-strong");
  });

  it("refuses a re-seed by the account that invalidated the only incumbent", () => {
    const op = login("Invalidator2");
    grant(db, op.conn.entity!, "role.edit");
    const other = login("Seeder2");
    grant(db, other.conn.entity!, "role.edit");
    recordRun(db, "base", incumbentRight, { group: "base" });
    recordRun(db, "base-r2", incumbentRight, { group: "base" });
    recordRun(db, "next", strongRight, { group: "next" });
    recordRun(db, "next-r2", strongRight, { group: "next" });
    other.send(`benchmark promote ${SLOT} base`);
    op.send("benchmark invalidate base reason:cap");
    expect(op.send(`benchmark promote ${SLOT} next`)).toContain("self-attestation");
    expect(other.send(`benchmark promote ${SLOT} next`)).toContain(`Re-seeded ${SLOT}`);
  });

  it("revalidates (audited), but never for the run's own author", () => {
    const author = login("Author");
    grant(db, author.conn.entity!, "role.edit");
    recordRun(db, "mine", strongRight, { agent_id: author.conn.entity! });
    // Retiring your own run is fine; re-admitting it is self-attestation.
    expect(author.send("benchmark invalidate mine reason:cap")).toContain("Invalidated mine");
    expect(author.send("benchmark revalidate mine reason:looks fine")).toContain(
      "self-attestation",
    );
    expect(db.getBenchmarkRun("mine")?.status).toBe("invalid");

    const other = login("Reviewer");
    grant(db, other.conn.entity!, "role.edit");
    expect(other.send("benchmark revalidate mine reason:cap did not bind")).toContain(
      "Revalidated mine",
    );
    expect(db.getBenchmarkRun("mine")?.status).toBe("completed");
    expect(db.listBenchmarkRunValidity("mine").map((r) => r.action)).toEqual([
      "invalidate",
      "revalidate",
    ]);
    expect(other.send("benchmark revalidate mine reason:again")).toContain("not invalid");
  });
});

describe("POST /v1/benchmarks/runs — fallback rate", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-invalid-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("records a mostly-fallback filing invalid and says so", async () => {
    const res = await handleBenchmarkFile(
      new Request("http://local/v1/benchmarks/runs", {
        method: "POST",
        body: JSON.stringify({
          targetKind: "model",
          target: "m",
          result: {
            config: { dataset: "synthetic-set" },
            items: Array.from({ length: 10 }, (_, i) => ({
              id: `q${i}`,
              correct: i === 9,
              ...(i < 8 ? { fallback: true } : {}),
            })),
          },
        }),
      }),
      engine,
      { matchedKey: "k", internal: false, openMode: false } as PassthruAuthResult,
    );
    expect(res.status).toBe(201);
    const out = (await res.json()) as { runId: string; status: string; invalidReason?: string };
    expect(out.status).toBe("invalid");
    expect(out.invalidReason).toContain("fallback rate 80%");
    expect(db.getBenchmarkRun(out.runId)?.status).toBe("invalid");
    expect(db.leaderboardBenchmark("synthetic-set")).toHaveLength(0);
  });
});
