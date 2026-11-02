// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retrieval telemetry and usefulness evidence (migration 188,
 * `src/persistence/db-memory-usefulness.ts`):
 *   - every unified-context build records one `memory_served` row per served
 *     item (cache hits included) with surface, arm, tier, rank and a query
 *     hash — never text;
 *   - `applyUsefulness` is the one chokepoint for `memory_ratings`;
 *   - a near-duplicate note write is STORED and rates the earlier note `repeat`
 *     (a lexical match cannot tell a restatement from a correction, so merging
 *     is the consolidation pass's call); exact duplicates return the existing
 *     handle and say so;
 *   - `memory usefulness [window]` renders the summary;
 *   - both tables have retention policies.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { RETENTION_POLICIES } from "../src/engine/retention";
import {
  NEAR_DUPLICATE_MIN_WORDS,
  nearDuplicate,
  shingleSimilarity,
} from "../src/memory/near-duplicate";
import { buildUnifiedContext } from "../src/memory/unified-context";
import { MarinaDB } from "../src/persistence/database";
import { memoryQueryHash } from "../src/persistence/db-memory-usefulness";
import { roomId } from "../src/types";
import { FIXTURE_QUERY, seedUnifiedFixture } from "./fixtures/unified-memory-fixture";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_memory_usefulness.db");

interface ServedRow {
  entity_name: string;
  surface: string;
  arm: string;
  tier: string;
  item_id: string;
  record_id: string | null;
  rank: number;
  query_hash: string;
  served_at: number;
}

describe("memory usefulness — retrieval telemetry", () => {
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

  const served = () =>
    db.memoryRepository().raw.query("SELECT * FROM memory_served ORDER BY id").all() as ServedRow[];

  it("records one row per served item with surface, arm, tier, rank and a query hash — no text", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const result = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { surface: "prompt" });
    const items = result.tiers.flatMap((tier) => tier.items.map((item, i) => ({ tier, item, i })));
    expect(items.length).toBeGreaterThan(0);

    const rows = served();
    expect(rows.length).toBe(items.length);
    const hash = memoryQueryHash(FIXTURE_QUERY);
    for (const [index, row] of rows.entries()) {
      const { tier, item, i } = items[index]!;
      expect(row.entity_name).toBe(fx.owner);
      expect(row.surface).toBe("prompt");
      expect(row.arm).toBe("lexical");
      expect(row.tier).toBe(tier.tier);
      expect(row.item_id).toBe(item.id);
      expect(row.rank).toBe(i + 1);
      expect(row.query_hash).toBe(hash);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    }
    // The durable twin of a legacy note is recorded as its record id.
    const twin = rows.find((row) => row.item_id === String(fx.verifiedNoteId));
    expect(twin?.record_id).toBeTruthy();
    // No column carries the query or the item text.
    const columns = (
      db.memoryRepository().raw.query("PRAGMA table_info(memory_served)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(columns).not.toContain("content");
    expect(columns).not.toContain("query");
  });

  it("records a cache hit too — a cached result is still served", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { surface: "recall" });
    const first = served().length;
    await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { surface: "mcp" });
    const rows = served();
    expect(rows.length).toBe(first * 2);
    expect(new Set(rows.map((r) => r.surface))).toEqual(new Set(["recall", "mcp"]));
  });

  it("labels the as-of fence as its own arm and defaults the surface to context", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { asOf: Date.now() + 60_000 });
    const rows = served();
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.arm))).toEqual(new Set(["as-of"]));
    expect(new Set(rows.map((r) => r.surface))).toEqual(new Set(["context"]));
  });

  it("summarises serves per surface, arm and tier and renders through `memory usefulness`", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { surface: "prompt" });
    await buildUnifiedContext(db, fx.owner, "amber port", { surface: "recall" });
    const summary = db.memoryUsefulnessSummary(fx.owner, Date.now() - 60_000);
    expect(summary.serves).toBe(served().length);
    expect(summary.distinctQueries).toBe(2);
    expect(summary.bySurface.prompt).toBeGreaterThan(0);
    expect(summary.bySurface.recall).toBeGreaterThan(0);
    expect(summary.byArm.lexical).toBe(summary.serves);
    expect(summary.topItems.length).toBeGreaterThan(0);
    expect(summary.topItems[0]!.serves).toBeGreaterThanOrEqual(summary.topItems.at(-1)!.serves);

    fx.ownerConn.clear();
    await engine.processCommand(fx.ownerEntityId, "memory usefulness 1d");
    const text = fx.ownerConn.lastText();
    expect(text).toContain("Memory served");
    expect(text).toContain(`${summary.serves} item serve`);
    expect(text).toContain("prompt");
    expect(text).toContain("Most served");
    expect(text).toContain("exposure, not use");

    // Another entity sees nothing of it.
    const other = new MockConnection("other");
    engine.addConnection(other);
    engine.spawnEntity("other", "Cy");
    other.clear();
    await engine.processCommand(other.entity!, "memory usefulness");
    expect(other.lastText()).toContain("Nothing served");

    other.clear();
    await engine.processCommand(other.entity!, "memory usefulness soon");
    expect(other.lastText()).toContain("Usage: memory usefulness");
  });

  it("has retention policies: served rows are telemetry, ratings are append-only", () => {
    const servedPolicy = RETENTION_POLICIES.find((p) => p.table === "memory_served");
    expect(servedPolicy?.kind).toBe("telemetry");
    expect(servedPolicy?.timeColumn).toBe("served_at");
    expect(servedPolicy?.keepMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(RETENTION_POLICIES.find((p) => p.table === "memory_ratings")?.kind).toBe("append-only");
  });
});

describe("memory usefulness — ratings chokepoint", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("appends a validated row and refuses unknown raters and empty or negative increments", () => {
    const id = db.applyUsefulness({
      itemId: "12",
      rater: "repeat",
      raterEntity: "Ada",
      alpha: 1,
      ref: "note:13",
    });
    expect(id).toBeGreaterThan(0);
    const rows = db.usefulnessRatingsFor("12");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rater: "repeat", rater_entity: "Ada", alpha: 1, beta: 0 });

    expect(() =>
      db.applyUsefulness({ itemId: "12", rater: "vibes" as "repeat", alpha: 1 }),
    ).toThrow(/Unknown usefulness rater/);
    expect(() => db.applyUsefulness({ itemId: "12", rater: "repeat" })).toThrow(/must move/);
    expect(() => db.applyUsefulness({ itemId: "12", rater: "repeat", beta: -1 })).toThrow(
      /non-negative/,
    );
    expect(() => db.applyUsefulness({ itemId: "", rater: "repeat", alpha: 1 })).toThrow(
      /names an item/,
    );
    expect(db.usefulnessRatingsFor("12")).toHaveLength(1);
  });
});

describe("memory usefulness — near-duplicate writes rate the earlier note", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  const base =
    "The deployment port for the amber service is 8443 on the staging host behind the proxy";
  const reworded =
    "The deployment port for the amber service is 8443 on the staging host behind the gateway";
  const differentClaim =
    "The deployment port for the amber service moved to 9443 after the proxy upgrade last week";

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Ada");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("shingle similarity is high for a rewording and low for a different claim", () => {
    expect(shingleSimilarity(base, reworded)).toBeGreaterThanOrEqual(0.8);
    expect(shingleSimilarity(base, differentClaim)).toBeLessThan(0.5);
    expect(nearDuplicate("too short to judge", [{ content: "too short to judge it" }])).toBe(
      undefined,
    );
    expect("a b c d e f g".split(" ").length).toBeLessThan(NEAR_DUPLICATE_MIN_WORDS);
  });

  it("stores the restatement, records `repeat` evidence on the earlier note, and the note command says so", async () => {
    const first = db.createNoteDetailed("Ada", base);
    expect(first.duplicate).toBeUndefined();
    expect(first.similar).toBeUndefined();

    // Exact: nothing stored, the existing handle.
    const exact = db.createNoteDetailed("Ada", base);
    expect(exact).toEqual({ id: first.id, duplicate: { kind: "exact" } });

    // Near: stored — the differing word may be the point — and rated on the earlier note.
    const near = db.createNoteDetailed("Ada", reworded);
    expect(near.id).not.toBe(first.id);
    expect(near.duplicate).toBeUndefined();
    expect(near.similar?.id).toBe(first.id);
    expect(near.similar?.overlap).toBeGreaterThanOrEqual(0.8);
    expect(db.getNotesByEntity("Ada").filter((n) => n.content === reworded)).toHaveLength(1);
    const ratings = db.usefulnessRatingsFor(String(first.id));
    expect(ratings).toHaveLength(1);
    expect(ratings[0]).toMatchObject({
      rater: "repeat",
      rater_entity: "Ada",
      alpha: 1,
      ref: `note:${near.id}`,
    });
    // The new copy carries no evidence of its own.
    expect(db.usefulnessRatingsFor(String(near.id))).toHaveLength(0);

    // A different claim about the same subject is just a new note.
    const distinct = db.createNoteDetailed("Ada", differentClaim);
    expect(distinct.similar).toBeUndefined();

    // Another writer's rewording is their own note (the check is per writer).
    expect(db.createNoteDetailed("Bea", reworded).similar).toBeUndefined();

    // skipDedup skips the check too.
    expect(
      db.createNoteDetailed("Ada", `${base} again`, undefined, { skipDedup: true }).similar,
    ).toBeUndefined();

    // One appended word: 15 shingles vs 14 shared (0.93) — over the threshold.
    conn.clear();
    await engine.processCommand(conn.entity!, `memory note ${base} today`);
    const text = conn.lastText();
    expect(text).toMatch(/^Note #\d+ saved/);
    expect(text).toContain(`Nearly the same as #${first.id}`);
    expect(text).toContain(`note evolve ${first.id}`);
    expect(db.usefulnessRatingsFor(String(first.id)).length).toBeGreaterThanOrEqual(2);

    conn.clear();
    await engine.processCommand(conn.entity!, `memory note ${base}`);
    expect(conn.lastText()).toBe(`Note #${first.id} already holds this.`);
  });

  it("counts the repeat evidence against the served item in the summary", async () => {
    const first = db.createNoteDetailed("Ada", base);
    db.createNoteDetailed("Ada", reworded);
    await buildUnifiedContext(db, "Ada", "amber deployment port", { surface: "prompt" });
    const summary = db.memoryUsefulnessSummary("Ada", Date.now() - 60_000);
    const item = summary.topItems.find((i) => i.itemId === String(first.id));
    expect(item?.repeatAlpha).toBe(1);
    expect(summary.ratingsByRater.repeat).toBe(1);
  });
});
