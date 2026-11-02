// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Usefulness raters and the posterior (`src/memory/usefulness.ts`):
 *   - citation: a note or task submission naming a served note rates it,
 *     once per citing ref, never for a note that was not served;
 *   - outcome: the `usefulness` consumer rates what was served during the work;
 *   - explicit: `memory useful|useless` needs a recent serve, once a day;
 *   - unused: the settle job rates old uncited serves, capped, durable cursor;
 *   - posterior: prior 1/1, self-ratings excluded for shared ranking;
 *   - ranking: `observe` reports, `on` reorders, `off` reports nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import {
  settleUnusedServes as _settle,
  CITATION_WINDOW_MS,
  citedNoteIds,
  observeUsefulnessEvent,
  rateCitations,
  rateExplicit,
  rateOutcomeUsefulness,
  settleUnusedServes,
  UNUSED_DAILY_CAP,
  UNUSED_GRACE_MS,
  usefulnessRankingMode,
  usefulnessTerm,
} from "../src/memory/usefulness";
import { consumersFor, OUTCOME_CONSUMERS } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import { applyReputationRerank } from "../src/persistence/db-memory-ranking";
import { posteriorMean } from "../src/persistence/db-memory-usefulness";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_memory_usefulness_raters.db");
const HOUR = 60 * 60 * 1000;

function serve(
  db: MarinaDB,
  entityName: string,
  itemId: string,
  at: number,
  opts: { arm?: "lexical" | "hybrid" | "as-of"; recordId?: string | null } = {},
) {
  db.recordMemoryServed([
    {
      entityName,
      surface: "prompt",
      arm: opts.arm ?? "lexical",
      tier: "unverified",
      itemId,
      recordId: opts.recordId ?? null,
      rank: 1,
      queryHash: "0123456789abcdef",
      servedAt: at,
    },
  ]);
}

describe("usefulness raters", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let ada: EntityId;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Ada");
    ada = conn.entity!;
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("parses `note:N` refs and bare `#N` handles, distinct and capped", () => {
    expect(citedNoteIds("see note:12 and #12, also #7 (and #7) plus note:3")).toEqual([12, 3, 7]);
    expect(citedNoteIds("importance !8 and #decision tags are not refs")).toEqual([]);
    expect(citedNoteIds(Array.from({ length: 40 }, (_, i) => `#${i + 1}`).join(" ")).length).toBe(
      16,
    );
  });

  it("a citation rates only a note served to the citer within the window, once per ref", () => {
    const now = Date.now();
    const served = db.createNote("Ada", "The amber port is 8443 on staging behind the proxy");
    const unserved = db.createNote("Ada", "An unrelated fact nobody was ever served");
    serve(db, "Ada", String(served), now - HOUR);

    const rated = rateCitations(db, {
      entityName: "Ada",
      text: `Confirmed from #${served} and note:${unserved}.`,
      ref: "task:1:submission:1",
      at: now,
    });
    expect(rated).toEqual([served]);
    expect(db.usefulnessRatingsFor(String(served))).toHaveLength(1);
    expect(db.usefulnessRatingsFor(String(served))[0]).toMatchObject({
      rater: "citation",
      rater_entity: "Ada",
      alpha: 1,
      ref: "task:1:submission:1",
    });
    expect(db.usefulnessRatingsFor(String(unserved))).toHaveLength(0);

    // Same ref again: idempotent. A new ref: new evidence.
    expect(
      rateCitations(db, {
        entityName: "Ada",
        text: `#${served}`,
        ref: "task:1:submission:1",
        at: now,
      }),
    ).toEqual([]);
    expect(
      rateCitations(db, { entityName: "Ada", text: `#${served}`, ref: "note:99", at: now }),
    ).toEqual([served]);
    expect(db.usefulnessRatingsFor(String(served))).toHaveLength(2);

    // Served to someone else, or too long ago: not a retrieval citation.
    expect(
      rateCitations(db, { entityName: "Bea", text: `#${served}`, ref: "note:100", at: now }),
    ).toEqual([]);
    const stale = db.createNote("Ada", "A note served long ago and cited late");
    serve(db, "Ada", String(stale), now - CITATION_WINDOW_MS - HOUR);
    expect(
      rateCitations(db, { entityName: "Ada", text: `#${stale}`, ref: "note:101", at: now }),
    ).toEqual([]);
  });

  it("the engine observer rates citations in saved notes and task submissions", async () => {
    const now = Date.now();
    const served = db.createNote("Ada", "Served fact: the amber deployment uses port 8443");
    serve(db, "Ada", String(served), now - HOUR);

    // A saved note naming the served note.
    await engine.processCommand(ada, `memory note Building on #${served}: the port is confirmed`);
    expect(db.usefulnessRatingsFor(String(served)).map((r) => r.rater)).toEqual(["citation"]);

    // A task submission naming it, through the real event.
    observeUsefulnessEvent(db, {
      type: "note_created",
      entity: ada,
      noteId: 999,
      authorName: "Ada",
      content: `Also note:${served} held up`,
      importance: 5,
      noteType: "observation",
      timestamp: now,
    });
    expect(db.usefulnessRatingsFor(String(served))).toHaveLength(2);
    // Never throws on a submission with no claim text.
    observeUsefulnessEvent(db, {
      type: "task_submitted",
      entity: ada,
      taskId: 4242,
      timestamp: now,
    });
    expect(db.usefulnessRatingsFor(String(served))).toHaveLength(2);
  });

  it("the outcome consumer rates what the owner was served during the work, once per outcome", () => {
    const now = Date.now();
    const a = db.createNote("Ada", "Served during the work, number one of two");
    const b = db.createNote("Ada", "Served during the work, number two of two");
    const before = db.createNote("Ada", "Served the day before yesterday, outside the window");
    serve(db, "Ada", String(a), now - 2 * HOUR);
    serve(db, "Ada", String(b), now - HOUR);
    serve(db, "Ada", String(before), now - 40 * HOUR);
    serve(db, "Bea", String(a), now - HOUR);

    expect(consumersFor("task")).toContain("usefulness");
    expect(consumersFor("forecast", "mechanical", { source: "market" })).toEqual([
      "lessons",
      "usefulness",
    ]);
    expect(consumersFor("request")).toEqual([]);
    expect(OUTCOME_CONSUMERS).toContain("usefulness");

    const outcome = {
      id: 1,
      subject: "task:9:Ada",
      kind: "task",
      source: "task:verdict",
      domain: "tools",
      owner: "Ada",
      succeeded: 1,
      quality: 1,
      loss: null,
      metric: "creator-verdict",
      truth_json: null,
      detail: null,
      basis: "mechanical",
      judge: null,
      eval_mode: null,
      participants_json: null,
      refs_json: JSON.stringify(["task:9"]),
      resolved_at: now,
      created_at: now,
    } as Parameters<typeof rateOutcomeUsefulness>[1];
    expect(rateOutcomeUsefulness(db, outcome)).toBe(2);
    expect(db.usefulnessRatingsFor(String(a))).toHaveLength(1);
    expect(db.usefulnessRatingsFor(String(a))[0]).toMatchObject({
      rater: "outcome",
      alpha: 1,
      beta: 0,
      ref: "outcome:1",
      rater_entity: "Ada",
    });
    expect(db.usefulnessRatingsFor(String(before))).toHaveLength(0);
    // Idempotent per outcome; a failure is a quarter against.
    expect(rateOutcomeUsefulness(db, outcome)).toBe(0);
    expect(rateOutcomeUsefulness(db, { ...outcome, id: 2, succeeded: 0 })).toBe(2);
    expect(db.usefulnessRatingsFor(String(a))[0]).toMatchObject({ alpha: 0, beta: 0.25 });
    // No owner: nothing to rate.
    expect(rateOutcomeUsefulness(db, { ...outcome, id: 3, owner: null })).toBe(0);
  });

  it("explicit votes need a recent serve and are once per item per day", async () => {
    const now = Date.now();
    const served = db.createNote("Ada", "A served note the agent found useful");
    const never = db.createNote("Ada", "A note never served to anyone");
    serve(db, "Ada", String(served), now - HOUR);

    expect(rateExplicit(db, { entityName: "Ada", itemId: String(never), vote: "useful" })).toMatch(
      /not served to you/,
    );
    expect(rateExplicit(db, { entityName: "Ada", itemId: String(served), vote: "useless" })).toBe(
      undefined,
    );
    expect(db.usefulnessRatingsFor(String(served))[0]).toMatchObject({
      rater: "explicit",
      alpha: 0,
      beta: 0.5,
      ref: "explicit:useless",
    });
    expect(rateExplicit(db, { entityName: "Ada", itemId: String(served), vote: "useful" })).toMatch(
      /already voted/,
    );

    await engine.processCommand(ada, `memory useful ${never}`);
    expect(conn.lastText()).toContain("Not recorded");
    conn.clear();
    const other = db.createNote("Ada", "A second served note");
    serve(db, "Ada", String(other), now - HOUR);
    await engine.processCommand(ada, `memory useful #${other}`);
    expect(conn.lastText()).toContain(`Recorded: #${other} useful`);
    expect(db.usefulnessRatingsFor(String(other))[0]).toMatchObject({ alpha: 0.5, beta: 0 });
    conn.clear();
    await engine.processCommand(ada, "memory useful");
    expect(conn.lastText()).toContain("Usage: memory useful");
  });

  it("the settle job rates old uncited serves `unused`, capped per item per day, with a durable cursor", () => {
    const now = Date.now();
    const cited = db.createNote("Ada", "Served then cited: counts as used");
    const ignored = db.createNote("Ada", "Served then ignored: counts against");
    const fresh = db.createNote("Ada", "Served just now: too early to judge");
    serve(db, "Ada", String(cited), now - 8 * HOUR);
    db.applyUsefulness({
      itemId: String(cited),
      rater: "citation",
      raterEntity: "Ada",
      alpha: 1,
      ref: "note:1",
      createdAt: now - 7 * HOUR,
    });
    for (let i = 0; i < UNUSED_DAILY_CAP + 2; i++)
      serve(db, "Ada", String(ignored), now - 9 * HOUR + i * 1000);
    serve(db, "Ada", String(fresh), now - HOUR);

    const first = settleUnusedServes(db, { now });
    expect(first).toMatchObject({
      scanned: 1 + UNUSED_DAILY_CAP + 2,
      cited: 1,
      unused: UNUSED_DAILY_CAP,
      capped: 2,
    });
    expect(db.usefulnessRatingsFor(String(ignored))).toHaveLength(UNUSED_DAILY_CAP);
    expect(db.usefulnessRatingsFor(String(ignored))[0]).toMatchObject({
      rater: "unused",
      beta: 0.25,
    });
    expect(db.usefulnessRatingsFor(String(fresh))).toHaveLength(0);

    // Nothing new to settle: the cursor holds, nothing is re-rated.
    expect(settleUnusedServes(db, { now })).toMatchObject({ scanned: 0, unused: 0 });
    expect(db.usefulnessRatingsFor(String(ignored))).toHaveLength(UNUSED_DAILY_CAP);
    // Once the fresh serve ages past the grace period it settles too.
    const later = settleUnusedServes(db, { now: now + UNUSED_GRACE_MS });
    expect(later).toMatchObject({ scanned: 1, unused: 1 });
    expect(_settle).toBe(settleUnusedServes);
  });

  it("the posterior starts at the prior and excludes self-ratings for shared ranking", () => {
    const mine = db.createNote("Ada", "A note Ada wrote and others found useful");
    expect(posteriorMean(0, 0)).toBe(0.5);
    expect(db.usefulnessPosterior([String(mine)]).get(String(mine))).toMatchObject({
      alpha: 0,
      beta: 0,
      n: 0,
      mean: 0.5,
    });
    db.applyUsefulness({ itemId: String(mine), rater: "citation", raterEntity: "Ada", alpha: 1 });
    db.applyUsefulness({ itemId: String(mine), rater: "citation", raterEntity: "Ada", alpha: 1 });
    db.applyUsefulness({ itemId: String(mine), rater: "outcome", raterEntity: "Bea", alpha: 1 });
    db.applyUsefulness({ itemId: String(mine), rater: "unused", raterEntity: "Cy", beta: 0.25 });
    const all = db.usefulnessPosterior([String(mine)]).get(String(mine))!;
    expect(all).toMatchObject({ alpha: 3, beta: 0.25, n: 4 });
    expect(all.mean).toBeCloseTo((1 + 3) / (2 + 3.25), 6);
    const others = db.usefulnessPosterior([String(mine)], { excludeSelf: true }).get(String(mine))!;
    expect(others).toMatchObject({ alpha: 1, beta: 0.25, n: 2 });
    expect(usefulnessTerm(1)).toBeCloseTo(0.1, 9);
    expect(usefulnessTerm(0)).toBeCloseTo(-0.1, 9);
    expect(usefulnessTerm(0.5)).toBe(0);
  });

  it("the shared rerank reports the term in observe and applies it in on, never in off", () => {
    const raw = db.memoryRepository().raw;
    const actor = { principalId: "reader", credentialId: "c", scopes: [] as never[] };
    db.applyUsefulness({ itemId: "r_low", rater: "unused", raterEntity: "Bea", beta: 4 });
    db.applyUsefulness({ itemId: "r_high", rater: "citation", raterEntity: "Bea", alpha: 4 });
    const results = [
      { id: "r_low", score: 0.1 },
      { id: "r_high", score: 0.1 - 1e-6 },
    ];

    const off = applyReputationRerank(raw, actor, results, { usefulness: "off" });
    expect(off.ranking.usefulness).toBeUndefined();
    expect(off.results.map((r) => r.id)).toEqual(["r_low", "r_high"]);

    const observe = applyReputationRerank(raw, actor, results, { usefulness: "observe" });
    expect(observe.ranking.usefulness?.mode).toBe("observe");
    expect(observe.ranking.usefulness?.applied).toBe(false);
    expect(observe.ranking.usefulness?.items.r_high?.term).toBeGreaterThan(0);
    expect(observe.ranking.usefulness?.items.r_low?.term).toBeLessThan(0);
    expect(observe.results.map((r) => r.id)).toEqual(["r_low", "r_high"]);

    const on = applyReputationRerank(raw, actor, results, { usefulness: "on" });
    expect(on.ranking.usefulness?.applied).toBe(true);
    expect(on.results.map((r) => r.id)).toEqual(["r_high", "r_low"]);

    expect(usefulnessRankingMode({})).toBe("observe");
    expect(usefulnessRankingMode({ MARINA_MEMORY_USEFULNESS_RANKING: "on" })).toBe("on");
    expect(usefulnessRankingMode({ MARINA_MEMORY_USEFULNESS_RANKING: "off" })).toBe("off");
  });

  it("pool recall adds the usefulness term only when the factor is on", () => {
    const poolId = "pool_shared_usefulness";
    db.createMemoryPool(poolId, "shared-pool", "Ada");
    const strong = db.addPoolNote(
      poolId,
      "Bea",
      "quartz lattice spacing measured at three angstrom",
      5,
    );
    const weak = db.addPoolNote(
      poolId,
      "Bea",
      "quartz lattice spacing measured at three angstroms",
      5,
    );
    // Others rate `weak` down and `strong` up; Bea's own vote on `strong` must not count.
    db.applyUsefulness({ itemId: String(weak), rater: "unused", raterEntity: "Ada", beta: 4 });
    db.applyUsefulness({ itemId: String(strong), rater: "citation", raterEntity: "Ada", alpha: 4 });
    db.applyUsefulness({ itemId: String(weak), rater: "citation", raterEntity: "Bea", alpha: 40 });
    const order = (env: string) => {
      const prev = process.env.MARINA_MEMORY_USEFULNESS_RANKING;
      process.env.MARINA_MEMORY_USEFULNESS_RANKING = env;
      try {
        return db.recallPoolNotes(poolId, "quartz lattice spacing").map((n) => n.id);
      } finally {
        if (prev === undefined) delete process.env.MARINA_MEMORY_USEFULNESS_RANKING;
        else process.env.MARINA_MEMORY_USEFULNESS_RANKING = prev;
      }
    };
    const baseline = order("off");
    expect(order("observe")).toEqual(baseline);
    const on = order("on");
    expect(on[0]).toBe(strong);
    expect(on).toContain(weak);
  });
});
