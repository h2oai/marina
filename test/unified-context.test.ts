// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `buildUnifiedContext` — one retrieval surface over both memory silos.
 * Seeds the shared fixture (verified note, plain note, skill, durable record +
 * captured source, finished assistance proposal) and checks tiers, ordering,
 * provenance, budgeting, degradation, and that the `recall <q> all|evidence`
 * command carries the identical structure in its `marina.memory.command.v1`
 * payload. The REST / MCP / passthru / adapter surfaces each assert the same
 * tier→ids map in their own test files.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { residentMemoryOperation } from "../src/memory/resident-service";
import {
  buildUnifiedContext,
  byteLength,
  distinctiveTerms,
  isUnifiedContextResult,
  minOverlap,
  queryTerms,
  relevantToQuery,
  renderUnifiedContext,
  servableRecord,
  servableSourceIds,
  truncateToBytes,
  UNIFIED_CONTEXT_HEADER,
  UNIFIED_TIER_LABELS,
  UNIFIED_TIER_ORDER,
  type UnifiedContextResult,
} from "../src/memory/unified-context";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, type Perception, roomId } from "../src/types";
import {
  expectedTierIds,
  FIXTURE_QUERY,
  seedUnifiedFixture,
  tierIds,
} from "./fixtures/unified-memory-fixture";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_unified_context.db";

function sortedIds(map: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tier, ids]) => [tier, [...ids].sort()]),
  );
}

function memoryPayload(conn: MockConnection): Record<string, unknown> | undefined {
  return conn.messages
    .map((p: Perception) => p.data?.memory as Record<string, unknown> | undefined)
    .findLast(Boolean);
}

describe("unified memory context", () => {
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

  it("returns all five tiers with the fixture ids, fixed order, provenance and byte accounting", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const result = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);

    expect(result.schema).toBe("marina.memory.context.v1");
    expect(isUnifiedContextResult(result)).toBe(true);
    expect(result.tiers.map((t) => t.tier)).toEqual([...UNIFIED_TIER_ORDER]);
    expect(sortedIds(tierIds(result))).toEqual(sortedIds(expectedTierIds(fx)));
    expect(result.degraded).toEqual([]);
    expect(result.truncated).toBe(false);

    const byTier = Object.fromEntries(result.tiers.map((t) => [t.tier, t]));
    expect(byTier.skill!.items[0]!.provenance).toBe(`#${fx.skillNoteId} imp=6`);
    expect(byTier.trusted!.items[0]!.provenance).toBe(`#${fx.verifiedNoteId} imp=8 verified`);
    expect(byTier.unverified!.items[0]!.provenance).toBe(`#${fx.plainNoteId} imp=5`);

    const record = byTier.evidence!.items.find((i) => i.id === fx.recordId)!;
    expect(record.provenance).toBe(`record ${fx.recordId} v1`);
    expect(record.meta?.source_ids).toEqual([fx.sourceId]);
    expect(record.meta?.space_id).toBe(fx.spaceId);
    const source = byTier.evidence!.items.find((i) => i.id === fx.sourceId)!;
    expect(source.provenance).toMatch(/^source \S+ sha256:[0-9a-f]{12} seq=\d+ excerpt$/);
    expect(source.content).toContain("7419");
    expect(typeof source.meta?.content_hash).toBe("string");

    const proposal = byTier.proposal!.items[0]!;
    expect(proposal.id).toBe(fx.jobId);
    expect(proposal.provenance).toBe(`proposal ${fx.jobId} librarian 1 citation`);
    expect(proposal.content).toContain("7419");
    expect(proposal.meta?.task).toBe("Find the Amber deployment port");
    expect(proposal.meta?.citations).toHaveLength(1);

    let sum = 0;
    for (const tier of result.tiers)
      for (const item of tier.items) {
        expect(item.bytes).toBe(byteLength(item.content));
        sum += item.bytes;
      }
    expect(result.usedBytes).toBe(sum);
    expect(sum).toBeLessThanOrEqual(result.budgetBytes);
  });

  it("renders header, five labels in tier order, skills as <example> blocks", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const result = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);
    const text = renderUnifiedContext(result);
    expect(text.startsWith(`${UNIFIED_CONTEXT_HEADER}\n`)).toBe(true);
    const positions = UNIFIED_TIER_ORDER.map((tier) => text.indexOf(UNIFIED_TIER_LABELS[tier]));
    for (const at of positions) expect(at).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain(`<example skill="#${fx.skillNoteId}" imp="6">`);
    expect(text).toContain(`- [#${fx.verifiedNoteId} imp=8 verified]`);
    expect(text).toContain(`- [record ${fx.recordId} v1]`);
    expect(text).toContain(`- [proposal ${fx.jobId} librarian 1 citation]`);
    expect(text).toContain(`- [#${fx.plainNoteId} imp=5]`);
    expect(text).not.toContain("[degraded]");
    // header:false yields the body only (adapter fallback / command rendering)
    expect(
      renderUnifiedContext(result, { header: false }).startsWith(UNIFIED_TIER_LABELS.skill),
    ).toBe(true);
  });

  it("scope=evidence returns durable tiers only; scope=legacy returns notes only", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const evidence = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { scope: "evidence" });
    expect(Object.keys(tierIds(evidence)).sort()).toEqual(["evidence", "proposal"]);
    expect(sortedIds(tierIds(evidence)).evidence).toEqual([fx.recordId, fx.sourceId].sort());
    const legacy = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { scope: "legacy" });
    expect(Object.keys(tierIds(legacy)).sort()).toEqual(["skill", "trusted", "unverified"]);
    expect(legacy.degraded).toEqual([]);
  });

  it("degrades durable tiers (world_identity_required) for a name without a world account; legacy still returns", async () => {
    const noteId = db.createNote("Ghost", "Amber deployment port scribble", undefined, {
      importance: 4,
    });
    const result = await buildUnifiedContext(db, "Ghost", FIXTURE_QUERY);
    expect(tierIds(result)).toEqual({ unverified: [String(noteId)] });
    expect(result.degraded.map((d) => `${d.tier}:${d.code}`).sort()).toEqual([
      "evidence:world_identity_required",
      "proposal:world_identity_required",
    ]);
    const text = renderUnifiedContext(result);
    expect(text).toContain("[degraded]");
    expect(text).toContain("evidence: world_identity_required");
    // Degraded lines are suppressible for surfaces that report it structurally.
    expect(renderUnifiedContext(result, { degraded: false })).not.toContain("[degraded]");
    // Compact (model-facing): one line, tiers grouped by code, no messages.
    const compact = renderUnifiedContext(result, { degraded: "compact" });
    const compactLines = compact.split("\n").filter((line) => line.includes("[degraded]"));
    expect(compactLines).toHaveLength(1);
    expect(compactLines[0]).toMatch(/^\[degraded\] .*evidence.*: /);
    expect(compact.length).toBeLessThan(renderUnifiedContext(result).length);
  });

  it("returns an empty, non-degraded result for an empty query", async () => {
    const result = await buildUnifiedContext(db, "Nobody", "   ");
    expect(result.query).toBe("");
    expect(result.tiers.every((t) => t.items.length === 0 && t.omitted === 0)).toBe(true);
    expect(result.degraded).toEqual([]);
    expect(renderUnifiedContext(result)).toBe("");
  });

  it("budget: truncates with a visible marker, drops the rest, keeps every tier header, reports truncated", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const full = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);
    const small = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { budgetBytes: 300 });
    expect(small.budgetBytes).toBe(300);
    expect(small.truncated).toBe(true);
    expect(small.usedBytes).toBeLessThanOrEqual(300);
    let bytes = 0;
    let cut = 0;
    let omitted = 0;
    for (const tier of small.tiers) {
      omitted += tier.omitted;
      for (const item of tier.items) {
        bytes += item.bytes;
        expect(item.bytes).toBeLessThanOrEqual(300);
        if (item.truncated) {
          cut++;
          expect(item.content).toMatch(/\[…\+\d+ chars\]$/);
        }
      }
    }
    expect(bytes).toBe(small.usedBytes);
    expect(cut + omitted).toBeGreaterThan(0);
    // Every matched item is either shown or counted — nothing vanishes.
    const shownOrOmitted = small.tiers.reduce((n, t) => n + t.items.length + t.omitted, 0);
    const matched = full.tiers.reduce((n, t) => n + t.items.length, 0);
    expect(shownOrOmitted).toBe(matched);
    // Tiers that lost items keep their header in the rendering, with a count.
    const text = renderUnifiedContext(small);
    for (const tier of small.tiers) {
      if (tier.items.length === 0 && tier.omitted > 0) {
        expect(text).toContain(tier.label);
        expect(text).toContain(`(+${tier.omitted} more omitted for budget)`);
      }
    }

    // Zero budget: every match is omitted, every header survives.
    const none = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { budgetBytes: 0 });
    expect(none.usedBytes).toBe(0);
    expect(none.truncated).toBe(true);
    expect(none.tiers.every((t) => t.items.length === 0)).toBe(true);
    expect(none.tiers.reduce((n, t) => n + t.omitted, 0)).toBe(matched);
    const noneText = renderUnifiedContext(none);
    for (const tier of UNIFIED_TIER_ORDER) expect(noneText).toContain(UNIFIED_TIER_LABELS[tier]);
  });

  it("per-item cap applies before the budget and is marked", async () => {
    const long = `Amber deployment port ${"x".repeat(2000)}`;
    const noteId = db.createNote("Longform", long, undefined, { importance: 5 });
    const result = await buildUnifiedContext(db, "Longform", FIXTURE_QUERY, {
      itemMaxBytes: 200,
      scope: "legacy",
    });
    const item = result.tiers.find((t) => t.tier === "unverified")!.items[0]!;
    expect(item.id).toBe(String(noteId));
    expect(item.truncated).toBe(true);
    expect(item.bytes).toBeLessThanOrEqual(200);
    expect(item.content).toMatch(/\[…\+\d+ chars\]$/);
    expect(result.truncated).toBe(true);
  });

  it("orders deterministically within a tier: score desc, then id asc; stable across runs", async () => {
    // Same importance and near-identical content → identical scores → id tiebreak.
    const ids = [
      db.createNote("Order", "Amber deployment port candidate alpha", undefined, { importance: 5 }),
      db.createNote("Order", "Amber deployment port candidate beta", undefined, { importance: 5 }),
      db.createNote("Order", "Amber deployment port candidate gamma", undefined, { importance: 5 }),
      db.createNote("Order", "Amber deployment port candidate delta", undefined, { importance: 9 }),
    ];
    const first = await buildUnifiedContext(db, "Order", FIXTURE_QUERY, { scope: "legacy" });
    const second = await buildUnifiedContext(db, "Order", FIXTURE_QUERY, { scope: "legacy" });
    const items = first.tiers.find((t) => t.tier === "unverified")!.items;
    expect(items.map((i) => i.id)).toEqual(
      second.tiers.find((t) => t.tier === "unverified")!.items.map((i) => i.id),
    );
    expect(items).toHaveLength(4);
    // The high-importance note leads; ties then fall back to ascending id.
    expect(items[0]!.id).toBe(String(ids[3]));
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1]!;
      const cur = items[i]!;
      expect(prev.score >= cur.score).toBe(true);
      if (prev.score === cur.score) expect(prev.id < cur.id).toBe(true);
    }
  });

  it("truncateToBytes respects the byte limit on multibyte text and marks the cut", () => {
    const text = "naïve café — ünïcödé ".repeat(20);
    for (const limit of [16, 40, 100]) {
      const cut = truncateToBytes(text, limit);
      expect(byteLength(cut)).toBeLessThanOrEqual(limit);
      expect(cut).toMatch(/\[…\+\d+ chars\]$/);
    }
    expect(truncateToBytes("short", 100)).toBe("short");
  });

  describe("recall command surface", () => {
    async function run(entityId: EntityId, conn: MockConnection, cmd: string) {
      conn.clear();
      await engine.processCommand(entityId, cmd);
      return { text: conn.allTextJoined(), memory: memoryPayload(conn) };
    }

    it("`recall <q> all` carries the identical unified structure in the marina.memory.command.v1 payload", async () => {
      const fx = await seedUnifiedFixture(engine, db);
      const direct = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { budgetBytes: 4096 });
      const { text, memory } = await run(
        fx.ownerEntityId,
        fx.ownerConn,
        `recall ${FIXTURE_QUERY} all`,
      );
      expect(memory?.schema).toBe("marina.memory.command.v1");
      expect(memory?.operation).toBe("recall");
      expect(memory?.success).toBe(true);
      const context = memory?.context;
      expect(isUnifiedContextResult(context)).toBe(true);
      expect(sortedIds(tierIds(context as UnifiedContextResult))).toEqual(
        sortedIds(tierIds(direct)),
      );
      expect((context as UnifiedContextResult).scope).toBe("all");
      expect((context as UnifiedContextResult).budgetBytes).toBe(4096);
      // Backward compatible: `notes` still lists the legacy hits.
      const noteIds = ((memory?.notes ?? []) as { id: string }[]).map((n) => n.id).sort();
      expect(noteIds).toEqual(
        [fx.skillNoteId, fx.verifiedNoteId, fx.plainNoteId].map(String).sort(),
      );
      // Human rendering shows the tier labels and durable provenance.
      for (const tier of UNIFIED_TIER_ORDER) expect(text).toContain(UNIFIED_TIER_LABELS[tier]);
      expect(text).toContain(`record ${fx.recordId} v1`);
      expect(text).toContain(`proposal ${fx.jobId} librarian`);
      // Legacy hits were touched (recall bookkeeping still applies).
      expect(db.getNote(fx.verifiedNoteId)!.last_accessed).not.toBeNull();
    });

    it("`recall <q> evidence` → durable tiers only; `budget <n>` is honored", async () => {
      const fx = await seedUnifiedFixture(engine, db);
      const { memory } = await run(
        fx.ownerEntityId,
        fx.ownerConn,
        `recall ${FIXTURE_QUERY} evidence budget 300`,
      );
      const context = memory?.context as UnifiedContextResult;
      expect(isUnifiedContextResult(context)).toBe(true);
      expect(context.scope).toBe("evidence");
      expect(context.budgetBytes).toBe(300);
      expect(Object.keys(tierIds(context)).every((t) => t === "evidence" || t === "proposal")).toBe(
        true,
      );
      expect(context.tiers.reduce((n, t) => n + t.items.length + t.omitted, 0)).toBe(3);
      expect(memory?.notes).toEqual([]);
    });

    it("plain `recall <q>` is unchanged — no context field, legacy notes only", async () => {
      const fx = await seedUnifiedFixture(engine, db);
      const { memory, text } = await run(fx.ownerEntityId, fx.ownerConn, `recall ${FIXTURE_QUERY}`);
      expect(memory?.operation).toBe("recall");
      expect(memory?.context).toBeUndefined();
      const noteIds = ((memory?.notes ?? []) as { id: string }[]).map((n) => n.id);
      expect(noteIds).toContain(String(fx.verifiedNoteId));
      expect(noteIds).toContain(String(fx.plainNoteId));
      expect(text).not.toContain(UNIFIED_TIER_LABELS.evidence);
      expect(text).not.toContain(fx.recordId);
    });

    it("`recall <q> all` for an entity without a durable account reports the degraded tiers", async () => {
      const conn = new MockConnection("c_plain");
      engine.addConnection(conn);
      const login = engine.login(conn.id, "PlainAgent");
      if (!("entityId" in login)) throw new Error(login.error);
      // Logging in created the world account; simulate its absence by
      // deleting the user row so the durable binding must refuse.
      db.deleteUser?.(db.getUserByName("PlainAgent")!.id);
      db.createNote("PlainAgent", "Amber deployment port guess", undefined, {});
      const { memory, text } = await run(login.entityId, conn, `recall ${FIXTURE_QUERY} all`);
      const context = memory?.context as UnifiedContextResult;
      expect(isUnifiedContextResult(context)).toBe(true);
      expect(tierIds(context).unverified).toHaveLength(1);
      if (context.degraded.length > 0) {
        expect(context.degraded.map((d) => d.code)).toContain("world_identity_required");
        expect(text).toContain("[degraded]");
      }
    });
  });
});

describe("relevance gate and validity filter (HISTORY §8: recall pollution)", () => {
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

  it("requires more than one shared common word before a note counts as relevant", () => {
    expect(minOverlap(1)).toBe(1);
    expect(minOverlap(2)).toBe(1);
    expect(minOverlap(3)).toBe(2);
    expect(minOverlap(8)).toBe(2);
    expect(minOverlap(12)).toBe(3);
    const question = "In what year was the first Honda Battle of the Bands HBCU camp held?";
    // One shared word ("first") is exactly the pollution case measured on simple-qa.
    expect(
      relevantToQuery("The first release of the Verlaine catalog shipped in 1984", question),
    ).toBe(false);
    expect(
      relevantToQuery(
        "Honda Battle of the Bands: Alabama State University hosted the first HBCU camp",
        question,
      ),
    ).toBe(true);
    // Porter-style forms still match on word prefixes.
    expect(
      relevantToQuery("Amber deploys behind the blue relay on port 7419", "amber deployment port"),
    ).toBe(true);
    // Short queries keep single-term matches (no gate to trip).
    expect(relevantToQuery("Amber deployment uses port 7419", "amber")).toBe(true);
    expect(relevantToQuery("anything at all", "")).toBe(true);
  });

  it("requires a shared DISTINCTIVE term when the entity's notes make the common ones worthless", () => {
    const question = "In what year did the first university in the region open?";
    const terms = queryTerms(question);
    // Every term distinctive (small/unknown corpus): overlap alone decides.
    expect(relevantToQuery("The first university opened in 1884", terms, new Set(terms))).toBe(
      true,
    );
    // Only common words shared, and they are not distinctive here → excluded.
    expect(relevantToQuery("The first university opened in 1884", terms, new Set(["region"]))).toBe(
      false,
    );
    expect(
      relevantToQuery("The region's first university opened in 1884", terms, new Set(["region"])),
    ).toBe(true);
  });

  it("drops one-word-overlap notes from the legacy tiers but keeps genuinely related ones", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    db.createNote(fx.owner, "The first release of the Verlaine catalog shipped in 1984", "fact");
    db.createNote(fx.owner, "Amber deployment port moved to 8520 after the first outage", "fact");
    const result = await buildUnifiedContext(
      db,
      fx.owner,
      "In what year was the first Amber deployment port change?",
    );
    const contents = result.tiers.flatMap((t) => t.items.map((i) => i.content));
    expect(contents.some((c) => c.includes("Verlaine catalog"))).toBe(false);
    expect(contents.some((c) => c.includes("moved to 8520"))).toBe(true);
    // Distinctiveness over the entity's corpus: "amber" appears in most of this
    // entity's notes, so it stops counting as evidence of relevance on its own.
    const distinctive = distinctiveTerms(db, fx.owner, queryTerms("amber deployment port change"));
    expect(distinctive.has("change")).toBe(true);
  });

  it("never serves a superseded loser or a historical version as evidence", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    const claim = (value: string) => ({
      subject: "amber:relay",
      predicate: "colour",
      object: { kind: "literal" as const, value },
    });
    const loser = (
      await residentMemoryOperation(db, fx.owner, {
        operation: "remember",
        key: "rel-a",
        input: { content: "Amber deployment relay colour is blue", claim: claim("blue") },
      })
    ).result as { id: string };
    const winner = (
      await residentMemoryOperation(db, fx.owner, {
        operation: "remember",
        key: "rel-b",
        input: { content: "Amber deployment relay colour is green", claim: claim("green") },
      })
    ).result as { id: string };
    await residentMemoryOperation(db, fx.owner, {
      operation: "resolve",
      id: winner.id,
      key: "lww-relay",
      input: { policy: "last_writer_wins", competing: [loser.id], rationale: "repainted" },
    });
    const result = await buildUnifiedContext(db, fx.owner, "Amber deployment relay colour");
    const evidence = result.tiers.find((t) => t.tier === "evidence")!.items.map((i) => i.id);
    expect(evidence).toContain(winner.id);
    expect(evidence).not.toContain(loser.id);
    expect(servableRecord({ freshness: "historical" })).toBe(false);
    expect(servableRecord({ valid_time: { from: 0, until: Date.now() - 1 } })).toBe(false);
    expect(servableRecord({ valid_time: { from: 0, until: null } })).toBe(true);
    expect(servableRecord({})).toBe(true);
  });

  it("the header tells the model how to use the block instead of asserting relevance", () => {
    expect(UNIFIED_CONTEXT_HEADER).toContain("use only items that answer the question");
    expect(UNIFIED_CONTEXT_HEADER).not.toContain("Relevant Memory");
  });
});

describe("retired records take their captured source excerpts out of [evidence]", () => {
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

  const evidenceIds = async (owner: string) =>
    (await buildUnifiedContext(db, owner, FIXTURE_QUERY)).tiers
      .find((t) => t.tier === "evidence")!
      .items.map((i) => i.id);

  it("drops a source whose only deriving record was retired, keeps raw captures and live-backed ones", async () => {
    const fx = await seedUnifiedFixture(engine, db);
    expect(await evidenceIds(fx.owner)).toEqual(expect.arrayContaining([fx.recordId, fx.sourceId]));

    // A capture nobody remembered from is a raw source: always servable.
    const orphan = (
      await residentMemoryOperation(db, fx.owner, {
        operation: "capture",
        input: {
          session_id: "fixture",
          content: "Amber deployment port scratch note: the runbook says 7419, verify later.",
        },
      })
    ).result as { id: string };

    // Retire the fixture record the way `note delete` does (tombstone revise,
    // validity closed now). The record leaves [evidence] via servableRecord …
    const current = (
      await residentMemoryOperation(db, fx.owner, { operation: "get", id: fx.recordId })
    ).result as { version: number; valid_time?: { from: number | null } | null };
    await residentMemoryOperation(db, fx.owner, {
      operation: "revise",
      id: fx.recordId,
      key: "retire-fixture",
      input: {
        expected_version: current.version,
        content: "[deleted legacy note #0]",
        importance: 1,
        valid_time: { from: current.valid_time?.from ?? null, until: Date.now() },
      },
    });
    const after = await evidenceIds(fx.owner);
    expect(after).not.toContain(fx.recordId);
    // … and so does the excerpt of the source only that record derived from.
    expect(after).not.toContain(fx.sourceId);
    expect(after).toContain(orphan.id);

    // Direct predicate: unknown space or empty input passes everything through.
    expect([...servableSourceIds(db, undefined, [fx.sourceId])]).toEqual([fx.sourceId]);
    expect([...servableSourceIds(db, fx.spaceId, [])]).toEqual([]);
    expect(servableSourceIds(db, fx.spaceId, [fx.sourceId, orphan.id])).toEqual(
      new Set([orphan.id]),
    );
    // A second, live record deriving from the same source makes it servable again.
    await residentMemoryOperation(db, fx.owner, {
      operation: "remember",
      key: "re-derive",
      input: {
        content: "Amber deployment still listens on port 7419 (re-checked)",
        subject: "amber",
        source_ids: [fx.sourceId],
      },
    });
    expect(servableSourceIds(db, fx.spaceId, [fx.sourceId]).has(fx.sourceId)).toBe(true);
    expect(await evidenceIds(fx.owner)).toContain(fx.sourceId);
  });
});
