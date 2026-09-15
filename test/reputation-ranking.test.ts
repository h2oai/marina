// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 3.6–3.7: reputation-weighted SHARED retrieval, writer-level
 * corroboration, and the generational credit loop on the read paths.
 *
 *  - pool recall adds a bounded `REPUTATION_WEIGHT * clamp(standing/100)` term
 *    from the WRITER's cached standing (users.id); personal recall never does
 *  - the durable re-sort applies the same term to records by OTHER principals
 *    and reports an inspectable `ranking` block
 *  - calibrateMemoryConfidence counts independent WRITERS, not rows
 *  - recap/ask/dig (retrieval-core) and the unified context pay the author of
 *    a cross-entity reflection; self-reads and repeats earn nothing
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ledgerFor } from "../src/agent/standing";
import { Engine } from "../src/engine/engine";
import { MemoryService } from "../src/memory/service";
import {
  creditUnifiedReflections,
  inheritedAuthority,
  UNIFIED_CONTEXT_SCHEMA,
  type UnifiedContextResult,
} from "../src/memory/unified-context";
import { handleMemoryServiceApi } from "../src/net/memory-service-api";
import { MarinaDB } from "../src/persistence/database";
import {
  applyReputationRerank,
  REPUTATION_WEIGHT,
  recordAuthors,
  reputationTerm,
} from "../src/persistence/db-memory-ranking";
import { countIndependentSources } from "../src/persistence/db-notes";
import { MarinaMemoryClient } from "../src/sdk/memory-client";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_reputation_ranking.db";

describe("reputation-weighted shared retrieval", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    db.createUser({ id: "u_alice", name: "Alice" });
    db.createUser({ id: "u_bob", name: "Bob" });
    db.createMemoryPool("pool_wisdom", "wisdom", "Alice");
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const scoreOf = (rows: { entity_name: string; score: number }[], who: string) =>
    rows.find((r) => r.entity_name === who)?.score ?? Number.NaN;

  it("pool recall adds the bounded writer-standing term; unknown writers and empty caches score 0", () => {
    const text = "Amber deploys on port 7419 behind the blue relay";
    db.addPoolNote("pool_wisdom", "Alice", text, 6);
    db.addPoolNote("pool_wisdom", "Bob", text, 6);
    db.addPoolNote("pool_wisdom", "Nobody", text, 6); // no world account at all

    // No cache rows yet: identical content, identical scores (recency jitter is ~1e-8).
    const baseline = db.recallPoolNotes("pool_wisdom", "amber deploy port relay");
    expect(baseline).toHaveLength(3);
    expect(scoreOf(baseline, "Bob")).toBeCloseTo(scoreOf(baseline, "Alice"), 5);
    expect(scoreOf(baseline, "Nobody")).toBeCloseTo(scoreOf(baseline, "Alice"), 5);

    // Bob at standing 100 (the rank-4 threshold) earns exactly REPUTATION_WEIGHT.
    db.setStandingCache("u_bob", 100, Date.now());
    const ranked = db.recallPoolNotes("pool_wisdom", "amber deploy port relay");
    expect(ranked[0]!.entity_name).toBe("Bob");
    expect(scoreOf(ranked, "Bob") - scoreOf(ranked, "Alice")).toBeCloseTo(REPUTATION_WEIGHT, 4);
    expect(scoreOf(ranked, "Nobody")).toBeCloseTo(scoreOf(ranked, "Alice"), 5);

    // Bounded: standing 400 is still +REPUTATION_WEIGHT, never more.
    db.setStandingCache("u_bob", 400, Date.now());
    const capped = db.recallPoolNotes("pool_wisdom", "amber deploy port relay");
    expect(scoreOf(capped, "Bob") - scoreOf(capped, "Alice")).toBeCloseTo(REPUTATION_WEIGHT, 4);

    // Half way: standing 50 → half the weight.
    db.setStandingCache("u_bob", 50, Date.now());
    const half = db.recallPoolNotes("pool_wisdom", "amber deploy port relay");
    expect(scoreOf(half, "Bob") - scoreOf(half, "Alice")).toBeCloseTo(REPUTATION_WEIGHT / 2, 4);
    expect(reputationTerm(50)).toBeCloseTo(REPUTATION_WEIGHT / 2, 9);
    expect(reputationTerm(-10)).toBe(0);
    expect(reputationTerm(1000)).toBeCloseTo(REPUTATION_WEIGHT, 9);
  });

  it("personal recall is never weighted by the entity's own standing", () => {
    db.createNote("Bob", "Amber deploys on port 7419 behind the blue relay", "r_1", {
      importance: 6,
    });
    // Recency is time-dependent (the two calls are microseconds to
    // milliseconds apart under load); zero it so the comparison isolates the
    // standing term, which must be absent from personal recall.
    const opts = { weightRecency: 0 };
    const before = db.recallNotes("Bob", "amber deploy port relay", opts)[0]!.score;
    db.setStandingCache("u_bob", 100, Date.now());
    const after = db.recallNotes("Bob", "amber deploy port relay", opts)[0]!.score;
    expect(after).toBe(before);
  });

  it("durable shared search re-sorts records by OTHER principals' standing and reports the ranking", async () => {
    const service = new MemoryService(db);
    const client = (principalId: string) => {
      const credential = db.issueMemoryCredential(principalId);
      return new MarinaMemoryClient("http://test", credential.token, 35000, (r) =>
        handleMemoryServiceApi(r, service),
      );
    };
    const alice = client("u_alice");
    const bob = client("u_bob");
    const space = (await alice.createSpace("shared-notes")).id;
    await alice.grant(space, "u_bob", "writer");
    const own = await alice.remember(space, {
      content: "Amber deploys on port 7419 per the runbook",
      type: "fact",
    });
    const theirs = await bob.remember(space, {
      content: "Amber deploys on port 7419 per the manifest",
      type: "fact",
    });
    const raw = new Database(TEST_DB, { readonly: true });
    try {
      expect(recordAuthors(raw, [own.id, theirs.id, "missing"])).toEqual(
        new Map([
          [own.id, "u_alice"],
          [theirs.id, "u_bob"],
          ["missing", null],
        ]),
      );
      const actor = { principalId: "u_alice", credentialId: "c", scopes: [] };

      // Real page from the service: Bob has no standing yet → nothing applied.
      const page = await alice.search(space, { query: "amber port 7419" });
      expect(page.results.map((r) => r.id).sort()).toEqual([own.id, theirs.id].sort());
      const untouched = applyReputationRerank(raw, actor, page.results);
      expect(untouched.ranking).toMatchObject({ weight: REPUTATION_WEIGHT, applied: 0 });
      expect(untouched.ranking.authors[theirs.id]).toEqual({
        author: "u_bob",
        standing: 0,
        term: 0,
      });

      // Bob at standing 100: an equal-score tie flips to Bob's record; Alice's
      // own record is never weighted by Alice's standing.
      db.setStandingCache("u_bob", 100, Date.now());
      db.setStandingCache("u_alice", 100, Date.now());
      const tied = [
        { id: own.id, score: 0.02 },
        { id: theirs.id, score: 0.02 },
      ];
      const reranked = applyReputationRerank(raw, actor, tied);
      expect(reranked.results.map((r) => r.id)).toEqual([theirs.id, own.id]);
      expect(reranked.ranking.applied).toBe(1);
      expect(reranked.ranking.authors[own.id]).toEqual({ author: "u_alice", standing: 0, term: 0 });
      const bobTerm = reranked.ranking.authors[theirs.id]!;
      expect(bobTerm.standing).toBe(100);
      expect(bobTerm.term).toBeCloseTo(REPUTATION_WEIGHT / 61, 9);
      expect(reranked.results[0]!.score).toBeCloseTo(0.02 + REPUTATION_WEIGHT / 61, 9);

      // Bounded: the term cannot overturn a whole rank tier (1/61 ≈ 0.0164).
      const clear = applyReputationRerank(raw, actor, [
        { id: own.id, score: 0.03 },
        { id: theirs.id, score: 0.02 },
      ]);
      expect(clear.results.map((r) => r.id)).toEqual([own.id, theirs.id]);

      // Searching AS Bob: his own record gets nothing, Alice's gets her term.
      const asBob = applyReputationRerank(raw, { ...actor, principalId: "u_bob" }, tied);
      expect(asBob.results.map((r) => r.id)).toEqual([own.id, theirs.id]);
      expect(asBob.ranking.authors[theirs.id]!.term).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("calibrateMemoryConfidence corroborates on independent writers, not rows", () => {
    // Two external URLs captured by the author: independent origins → corroborated.
    const urls = db.createNote("Alice", "The relay firmware is 4.2", "r_1", {
      noteType: "fact",
      confidence: 0.4,
    });
    db.addNoteSource(urls, { url: "https://vendor.example/relay/4.2", capturedBy: "Alice" });
    db.addNoteSource(urls, { url: "https://mirror.example/changelog", capturedBy: "Alice" });

    // Two derivations from the SAME writer's notes: one independent source.
    const sameWriter = db.createNote("Alice", "The relay firmware is 4.3", "r_1", {
      noteType: "fact",
      confidence: 0.4,
    });
    const carol1 = db.createNote("Carol", "Firmware 4.3 shipped", "r_1");
    const carol2 = db.createNote("Carol", "4.3 fixed the relay", "r_1");
    for (const src of [carol1, carol2]) {
      db.addNoteSource(sameWriter, {
        url: `note:${src}`,
        sourceType: "note",
        sourceNoteId: src,
        sourceEntity: "Carol",
        capturedBy: "Alice",
      });
    }

    // One URL plus a durable twin: the twin is a mirror, never evidence.
    const twinned = db.createNote("Alice", "The relay firmware is 4.4", "r_1", {
      noteType: "fact",
      confidence: 0.4,
    });
    db.addNoteSource(twinned, { url: "https://vendor.example/relay/4.4", capturedBy: "Alice" });
    db.addNoteSource(twinned, { url: "marina-memory://record/r_twin", credibility: 0 });

    // Two different writers' notes: two independent sources.
    const twoWriters = db.createNote("Alice", "The relay firmware is 4.5", "r_1", {
      noteType: "fact",
      confidence: 0.4,
    });
    const dave = db.createNote("Dave", "Saw 4.5 on the relay", "r_1");
    for (const [src, who] of [
      [carol1, "Carol"],
      [dave, "Dave"],
    ] as const) {
      db.addNoteSource(twoWriters, {
        url: `note:${src}`,
        sourceType: "note",
        sourceNoteId: src,
        sourceEntity: who,
        capturedBy: "Alice",
      });
    }

    const raw = new Database(TEST_DB, { readonly: true });
    try {
      expect(countIndependentSources(raw, urls)).toBe(2);
      expect(countIndependentSources(raw, sameWriter)).toBe(1);
      expect(countIndependentSources(raw, twinned)).toBe(1);
      expect(countIndependentSources(raw, twoWriters)).toBe(2);
    } finally {
      raw.close();
    }
    db.calibrateMemoryConfidence();
    expect(db.getNote(urls)!.confidence).toBeCloseTo(0.6, 9);
    expect(db.getNote(sameWriter)!.confidence).toBeCloseTo(0.4, 9);
    expect(db.getNote(twinned)!.confidence).toBeCloseTo(0.4, 9);
    expect(db.getNote(twoWriters)!.confidence).toBeCloseTo(0.6, 9);
  });

  it("inheritedAuthority is the LOWEST authority of the inputs (TMA-NM non-laundering)", () => {
    expect(inheritedAuthority([])).toEqual({
      confidence: null,
      verification: "unverified",
      inputs: 0,
    });
    expect(
      inheritedAuthority([
        { confidence: 0.9, verification_status: "verified" },
        { confidence: 0.3, verification_status: "verified" },
      ]),
    ).toEqual({ confidence: 0.3, verification: "verified", inputs: 2 });
    expect(
      inheritedAuthority([
        { confidence: 0.9, verification_status: "verified" },
        { confidence: undefined, verification_status: "unverified" },
      ]),
    ).toEqual({ confidence: 0.5, verification: "unverified", inputs: 2 });
  });
});

describe("generational credit on the read paths", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;

  const run = async (conn: MockConnection, text: string) => {
    conn.clear();
    await engine.processCommand(conn.entity as EntityId, text);
    return stripAnsi(conn.allTextJoined());
  };
  const aliceCredits = () =>
    ledgerFor(db, "u_alice").filter((row) => row.kind === "reflection_recalled");

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("alice");
    bob = new MockConnection("bob");
    for (const [conn, name, id] of [
      [alice, "Alice", "u_alice"],
      [bob, "Bob", "u_bob"],
    ] as const) {
      db.createUser({ id, name });
      engine.addConnection(conn);
      engine.spawnEntity(conn.id, name);
    }
    db.createMemoryPool("pool_wisdom", "wisdom", "Alice");
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("recap pays the author of a shared reflection once — never the reader, never for own notes", async () => {
    const lesson = db.addPoolNote(
      "pool_wisdom",
      "Alice",
      "Lesson: pin Amber rollbacks to the previous manifest before cutting over",
      8,
      "episode",
      { tier: "reflection" },
    );
    const plain = db.addPoolNote(
      "pool_wisdom",
      "Alice",
      "Amber rollbacks were slow on Tuesday",
      5,
      "observation",
    );
    expect(db.getNote(lesson)!.tier).toBe("reflection");
    expect(db.getNote(plain)!.tier).toBe("fact");

    const reply = await run(bob, "recap amber rollbacks manifest");
    expect(reply).toContain("Recap");
    expect(reply).toContain("pin Amber rollbacks");
    const credits = aliceCredits();
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ ref: `reflection:${lesson}`, amount: 0.5 });

    // Idempotent per reflection id; the plain fact-tier note earns nothing.
    await run(bob, "recap amber rollbacks manifest");
    expect(aliceCredits()).toHaveLength(1);

    // Alice recapping her own lesson is not generational hand-off.
    await run(alice, "recap amber rollbacks manifest");
    expect(aliceCredits()).toHaveLength(1);
    expect(ledgerFor(db, "u_bob")).toEqual([]);
  });

  it("creditUnifiedReflections pays cross-author reflection hits in the legacy tiers only", () => {
    const lesson = db.createNote("Alice", "Lesson: verify before scaling", "r_1", {
      noteType: "episode",
      tier: "reflection",
    });
    const own = db.createNote("Bob", "My own reflection", "r_1", {
      noteType: "episode",
      tier: "reflection",
    });
    const item = (tier: "trusted" | "unverified" | "skill", id: number, author: string) => ({
      tier,
      id: String(id),
      content: "x",
      provenance: "",
      bytes: 1,
      score: 1,
      meta: { author, noteTier: "reflection" },
    });
    const result: UnifiedContextResult = {
      schema: UNIFIED_CONTEXT_SCHEMA,
      entity: "Bob",
      query: "q",
      scope: "all",
      budgetBytes: 2048,
      usedBytes: 3,
      truncated: false,
      degraded: [],
      tiers: [
        { tier: "skill", label: "", omitted: 0, items: [item("skill", lesson, "Alice")] },
        { tier: "trusted", label: "", omitted: 0, items: [item("trusted", lesson, "Alice")] },
        { tier: "unverified", label: "", omitted: 0, items: [item("unverified", own, "Bob")] },
      ],
    };
    expect(creditUnifiedReflections(db, result)).toBe(1);
    expect(aliceCredits()).toEqual([
      expect.objectContaining({ ref: `reflection:${lesson}`, amount: 0.5 }),
    ]);
    expect(ledgerFor(db, "u_bob")).toEqual([]);
    // Second render: idempotent.
    creditUnifiedReflections(db, result);
    expect(aliceCredits()).toHaveLength(1);
  });
});
