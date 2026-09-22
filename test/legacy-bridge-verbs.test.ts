// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy verbs that used to diverge from the durable twin — `note verify`,
 * `note resolve`, `note consolidate`, `note link/unlink`, `note source`,
 * `note derive`, `skill store`, `pool add` — now mirror their effect onto the
 * twin. One test per verb: run the legacy command, `awaitPendingBridges()`,
 * assert the twin's state through the durable service; plus the served-evidence
 * consequence (`buildUnifiedContext` no longer serves a retired twin).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import {
  awaitPendingBridges,
  bridgeLegacyConsolidation,
  bridgeLegacyLink,
  bridgeLegacySource,
  bridgeLegacyVerification,
  durableTwinRecordIds,
  findDurableRelation,
  findDurableTwin,
  LEGACY_EXTERNAL_SOURCE_SESSION,
  LEGACY_LINK_METADATA_KIND,
  LEGACY_SOURCE_SESSION,
  SUPERSEDED_TWIN_CONTENT_PREFIX,
} from "../src/memory/legacy-bridge";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { buildUnifiedContext, servableRecord } from "../src/memory/unified-context";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryGraphResult, MemoryRecord, MemorySource } from "../src/sdk/memory-types";
import { type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("legacy verbs ↔ durable twin bridge", () => {
  let directory: string;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;

  const durable = (request: Parameters<typeof residentMemoryOperation>[2], name = "Alice") =>
    residentMemoryOperation(db, name, request);
  const record = async (id: string) =>
    (await durable({ operation: "get", id })).result as MemoryRecord;
  const run = async (connection: MockConnection, text: string) => {
    connection.clear();
    await engine.processCommand(connection.entity as EntityId, text);
    await awaitPendingBridges();
    return stripAnsi(connection.allTextJoined());
  };
  const latestNoteId = (name: string) => db.getNotesByEntity(name, 1)[0]!.id;
  const evidenceIds = async (query: string) => {
    const result = await buildUnifiedContext(db, "Alice", query);
    return result.tiers.find((t) => t.tier === "evidence")?.items.map((i) => i.id) ?? [];
  };
  const sources = async () =>
    (
      (await durable({ operation: "sources", input: { limit: 100 } })).result as {
        sources: MemorySource[];
      }
    ).sources;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-legacy-bridge-verbs-"));
    db = new MarinaDB(join(directory, "world.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("alice");
    engine.addConnection(alice);
    db.createUser({ id: crypto.randomUUID(), name: "Alice" });
    engine.spawnEntity(alice.id, "Alice");
  });

  afterEach(() => {
    resetTrustProfileForTests();
    db.close();
    rmSync(directory, { recursive: true });
  });

  it("`note consolidate` retires every loser's twin as a superseded tombstone; the keeper's twin is untouched and the loser leaves [evidence]", async () => {
    await run(alice, "note The relay key is stored in the vault type fact");
    const keeper = latestNoteId("Alice");
    await run(alice, "note The relay key lives in the vault behind the panel type fact");
    const loser = latestNoteId("Alice");
    const keeperTwin = findDurableTwin(db, keeper)!;
    const loserTwin = findDurableTwin(db, loser)!;
    expect(await evidenceIds("relay key vault")).toEqual(
      expect.arrayContaining([keeperTwin.recordId, loserTwin.recordId]),
    );

    const before = Date.now();
    const reply = await run(alice, `note consolidate ${keeper} ${loser}`);
    expect(reply).toContain("1 memory record(s) safely superseded");
    expect(db.getNote(loser)!.verification_status).toBe("superseded");

    const retired = await record(loserTwin.recordId);
    expect(retired.version).toBe(2);
    expect(retired.content).toBe(`${SUPERSEDED_TWIN_CONTENT_PREFIX}${loser}]`);
    expect(retired.metadata).toMatchObject({
      retired_legacy_note_id: loser,
      retired_reason: "consolidated",
      superseded_by_legacy_note_id: keeper,
      superseded_by_record_id: keeperTwin.recordId,
    });
    expect(retired.valid_time?.until).toBeNumber();
    expect(retired.valid_time!.until!).toBeGreaterThanOrEqual(before);
    expect(servableRecord(retired)).toBe(false);
    // History stays inspectable (retirement, not erasure).
    const historical = (
      await durable({ operation: "get", id: loserTwin.recordId, input: { version: 1 } })
    ).result as MemoryRecord;
    expect(historical.content).toContain("behind the panel");

    // Keeper untouched.
    const kept = await record(keeperTwin.recordId);
    expect(kept.version).toBe(1);
    expect(kept.content).toBe("The relay key is stored in the vault");

    // Served evidence: the keeper's twin stays, the loser's twin is gone.
    const evidence = await evidenceIds("relay key vault");
    expect(evidence).toContain(keeperTwin.recordId);
    expect(evidence).not.toContain(loserTwin.recordId);

    // Idempotent, and a second consolidate call is a no-op on the twin.
    await bridgeLegacyConsolidation(db, "Alice", keeper, [loser]);
    expect((await record(loserTwin.recordId)).version).toBe(2);
    expect(await run(alice, `note consolidate ${keeper} ${loser}`)).toContain("0 memory record(s)");
    expect((await record(loserTwin.recordId)).version).toBe(2);
  });

  it("`note verify disputed` closes the twin's validity (dropped from [evidence]); `verified` reopens it, then reaffirms", async () => {
    await run(alice, "note Heron nests on the north tower type fact");
    const noteId = latestNoteId("Alice");
    const twin = findDurableTwin(db, noteId)!;
    expect(await evidenceIds("heron north tower")).toContain(twin.recordId);

    const before = Date.now();
    const disputed = await run(alice, `note verify ${noteId} disputed 0.2 it is the south tower`);
    expect(disputed).toContain("marked disputed");
    expect(db.getNote(noteId)!.verification_status).toBe("disputed");
    let current = await record(twin.recordId);
    expect(current.version).toBe(2);
    expect(current.content).toBe("Heron nests on the north tower"); // content kept
    expect(current.valid_time?.until).toBeNumber();
    expect(current.valid_time!.until!).toBeGreaterThanOrEqual(before);
    expect(current.metadata).toMatchObject({
      legacy_note_id: noteId,
      legacy_verification: "disputed",
      legacy_verification_confidence: 0.2,
      legacy_verification_rationale: "it is the south tower",
    });
    expect(servableRecord(current)).toBe(false);
    expect(await evidenceIds("heron north tower")).not.toContain(twin.recordId);
    // Temporal reads exclude it too.
    const later = (
      await durable({ operation: "query", input: { valid_at: current.valid_time!.until! + 1 } })
    ).result as { results: MemoryRecord[] };
    expect(later.results.map((r) => r.id)).not.toContain(twin.recordId);

    // Idempotent: the same verdict again does not touch the twin.
    const verifications = db.getNoteVerifications(noteId);
    await bridgeLegacyVerification(db, "Alice", noteId, "disputed", {
      key: `legacy-note-${noteId}-verify-${verifications[0]!.id}`,
    });
    expect((await record(twin.recordId)).version).toBe(2);

    // Verified → validity reopens, metadata follows.
    await run(alice, `note verify ${noteId} verified 0.9 confirmed with binoculars`);
    current = await record(twin.recordId);
    expect(current.version).toBe(3);
    expect(current.valid_time?.until).toBeNull();
    expect(current.metadata).toMatchObject({ legacy_verification: "verified" });
    expect(current.metadata).not.toHaveProperty("disputed_at");
    expect(servableRecord(current)).toBe(true);
    expect(await evidenceIds("heron north tower")).toContain(twin.recordId);

    // Verified on an already-open twin → durable `reaffirm` (version bump, no closure).
    await run(alice, `note verify ${noteId} verified 0.95`);
    current = await record(twin.recordId);
    expect(current.version).toBe(4);
    expect(current.valid_time?.until ?? null).toBeNull();

    // Unverified on an open twin is the default state → no-op.
    await run(alice, `note verify ${noteId} unverified`);
    expect((await record(twin.recordId)).version).toBe(4);
  });

  it("`note resolve` mirrors the case verdicts: the loser's twin is closed as disputed, the winner's twin reaffirmed", async () => {
    expect(await run(alice, "pool create relaypool")).toContain("relaypool");
    await run(alice, "pool relaypool add The relay is online");
    const online = latestNoteId("Alice");
    await run(alice, "pool relaypool add The relay is not online");
    const offline = latestNoteId("Alice");
    const onlineTwin = findDurableTwin(db, online)!;
    const offlineTwin = findDurableTwin(db, offline)!;
    expect(onlineTwin).toBeDefined();
    expect(offlineTwin).toBeDefined();

    // `refreshContradictionCases` also pairs each pool note with the OTHER
    // note's durable twin row (`memory:<principal>` notes share the claim key
    // and are a different entity_name) — pick the legacy-only case.
    expect(db.refreshContradictionCases()).toBeGreaterThanOrEqual(1);
    const conflict = db
      .listContradictionCases("open", 50)
      .find(
        (c) =>
          [c.left_note_id, c.right_note_id].includes(online) &&
          [c.left_note_id, c.right_note_id].includes(offline),
      )!;
    expect(conflict).toBeDefined();
    const resolution = conflict.left_note_id === online ? "left" : "right";
    const reply = await run(
      alice,
      `note resolve ${conflict.id} ${resolution} the status page confirms it`,
    );
    expect(reply).toContain(`resolved as ${resolution}`);
    expect(db.getNote(offline)!.verification_status).toBe("disputed");
    expect(db.getNote(online)!.verification_status).toBe("verified");

    const loser = await record(offlineTwin.recordId);
    expect(loser.version).toBe(2);
    expect(loser.valid_time?.until).toBeNumber();
    expect(loser.metadata).toMatchObject({
      legacy_verification: "disputed",
      legacy_verification_case_id: conflict.id,
      legacy_verification_rationale: "the status page confirms it",
    });
    expect(servableRecord(loser)).toBe(false);

    const winner = await record(onlineTwin.recordId);
    expect(winner.version).toBe(2); // reaffirmed
    expect(winner.valid_time?.until ?? null).toBeNull();
    expect(winner.content).toBe("The relay is online");
    expect(servableRecord(winner)).toBe(true);
  });

  it("`note link` asserts a durable relation between the twins; `note unlink` closes it; re-linking reopens it; relations never leak into [evidence]", async () => {
    await run(alice, "note Fog delays the ferry type observation");
    const a = latestNoteId("Alice");
    await run(alice, "note The ferry was late this morning type observation");
    const b = latestNoteId("Alice");
    const twinA = findDurableTwin(db, a)!;
    const twinB = findDurableTwin(db, b)!;

    expect(await run(alice, `note link ${a} ${b} supports`)).toContain("Linked");
    const relation = await findDurableRelation(
      db,
      "Alice",
      twinA.recordId,
      "supports",
      twinB.recordId,
    );
    expect(relation).toBeDefined();
    expect(relation!.claim).toEqual({
      subject: twinA.recordId,
      predicate: "supports",
      object: { kind: "entity", id: twinB.recordId },
    });
    expect(relation!.metadata).toMatchObject({
      kind: LEGACY_LINK_METADATA_KIND,
      legacy_source_note_id: a,
      legacy_target_note_id: b,
      relationship: "supports",
    });
    expect(relation!.valid_time?.until ?? null).toBeNull();
    // Reachable the durable way: `graph` from the subject twin.
    const graph = (
      await durable({
        operation: "graph",
        input: { subject: twinA.recordId, valid_at: Date.now() },
      })
    ).result as MemoryGraphResult;
    expect(graph.edges.map((e) => e.record.id)).toEqual([relation!.id]);
    // Idempotent.
    expect((await bridgeLegacyLink(db, "Alice", a, b, "supports"))?.recordId).toBe(relation!.id);
    expect((await record(relation!.id)).version).toBe(1);
    // The relation is two record ids, never natural language → not evidence.
    expect(await evidenceIds("supports ferry")).not.toContain(relation!.id);

    // Unlink → validity closed, history kept.
    expect(await run(alice, `note unlink ${a} ${b} supports`)).toContain("Unlinked");
    const closed = await record(relation!.id);
    expect(closed.version).toBe(2);
    expect(closed.valid_time?.until).toBeNumber();
    expect(closed.metadata).toMatchObject({ unlinked_at: expect.any(Number) });
    const afterUnlink = (
      await durable({
        operation: "graph",
        input: { subject: twinA.recordId, valid_at: closed.valid_time!.until! + 1 },
      })
    ).result as MemoryGraphResult;
    expect(afterUnlink.edges).toEqual([]);

    // Re-link reopens the same record instead of duplicating it.
    await run(alice, `note link ${a} ${b} supports`);
    const reopened = await record(relation!.id);
    expect(reopened.version).toBe(3);
    expect(reopened.valid_time?.until).toBeNull();
    expect(reopened.metadata).toMatchObject({ relinked_at: expect.any(Number) });
    expect(reopened.metadata).not.toHaveProperty("unlinked_at");

    // A link to a note without a twin has nothing durable to point at: skipped, no error.
    const untwinned = db.createNote("Alice", "Untwinned ferry note", undefined, { importance: 5 });
    expect(await run(alice, `note link ${a} ${untwinned} related_to`)).toContain("Linked");
    const all = (
      await durable({ operation: "graph", input: { subject: twinA.recordId, include_stale: true } })
    ).result as MemoryGraphResult;
    expect(all.edges.map((e) => e.record.id)).toEqual([relation!.id]);
  });

  it("`note source` mirrors the reference onto the twin's sources as an EXTERNAL captured source; `note claim … source` does it in one step", async () => {
    await run(alice, "note The lighthouse lamp is an LED array type fact");
    const noteId = latestNoteId("Alice");
    const twin = findDurableTwin(db, noteId)!;
    expect((await record(twin.recordId)).source_ids).toEqual([twin.sourceId!]);

    const reply = await run(
      alice,
      `note source ${noteId} https://example.test/lamp credibility 0.8 observed 2026-09-01`,
    );
    expect(reply).toContain("Source attached");
    let current = await record(twin.recordId);
    expect(current.version).toBe(2);
    expect(current.source_ids).toHaveLength(2);
    const added = current.source_ids.find((id) => id !== twin.sourceId)!;
    const captured = (await sources()).find((s) => s.id === added)!;
    expect(captured.body).toBe("https://example.test/lamp");
    expect(captured.session_id).toBe(LEGACY_EXTERNAL_SOURCE_SESSION);
    expect(current.metadata).toMatchObject({
      legacy_sources: [
        {
          url: "https://example.test/lamp",
          source_id: added,
          credibility: 0.8,
          observed_at: Date.parse("2026-09-01"),
        },
      ],
    });
    // Idempotent per (note, url): same url again → same source, no new version.
    await run(alice, `note source ${noteId} https://example.test/lamp credibility 0.9`);
    expect((await record(twin.recordId)).version).toBe(2);
    expect(
      (await bridgeLegacySource(db, "Alice", noteId, { url: "https://example.test/lamp" }))
        ?.version,
    ).toBe(2);
    // A second, different url is appended.
    await run(alice, `note source ${noteId} https://example.test/manual`);
    current = await record(twin.recordId);
    expect(current.version).toBe(3);
    expect(current.source_ids).toHaveLength(3);

    // `note claim … source <url>`: twin + mirrored source in one bridge.
    await run(
      alice,
      "note claim The tide table is published weekly confidence 0.7 source https://example.test/tides",
    );
    const claimId = latestNoteId("Alice");
    const claimTwin = findDurableTwin(db, claimId)!;
    const claim = await record(claimTwin.recordId);
    expect(claim.version).toBe(2);
    expect(claim.source_ids).toHaveLength(2);
    expect(claim.metadata).toMatchObject({
      legacy_sources: [{ url: "https://example.test/tides" }],
    });
  });

  it("`note derive` adds the source note's twin as a SELF-DERIVED source and asserts `derived_from`", async () => {
    await run(alice, "note Primary reading: the gauge showed 3.2 bar type observation");
    const source = latestNoteId("Alice");
    await run(alice, "note Inference: the boiler is within tolerance type inference");
    const derived = latestNoteId("Alice");
    const sourceTwin = findDurableTwin(db, source)!;
    const derivedTwin = findDurableTwin(db, derived)!;

    expect(await run(alice, `note derive ${derived} ${source}`)).toContain("records derivation");
    const current = await record(derivedTwin.recordId);
    expect(current.source_ids).toHaveLength(2);
    const added = current.source_ids.find((id) => id !== derivedTwin.sourceId)!;
    const captured = (await sources()).find((s) => s.id === added)!;
    expect(captured.body).toBe(`note:${source}`);
    expect(captured.session_id).toBe(LEGACY_SOURCE_SESSION); // self-derived, not evidence
    expect(current.metadata).toMatchObject({
      legacy_sources: [{ url: `note:${source}`, source_note_id: source }],
    });
    const relation = await findDurableRelation(
      db,
      "Alice",
      derivedTwin.recordId,
      "derived_from",
      sourceTwin.recordId,
    );
    expect(relation).toBeDefined();
  });

  it("`skill store` gets a skill-tier twin tagged in metadata", async () => {
    const reply = await run(
      alice,
      "skill store pool-recall-fanout | find a fact when one keyword misses | recall <topic> ; pool bench-facts recall <synonym>",
    );
    expect(reply).toContain("stored");
    const noteId = latestNoteId("Alice");
    const note = db.getNote(noteId)!;
    expect(note.note_type).toBe("skill");
    const twin = findDurableTwin(db, noteId);
    expect(twin).toBeDefined();
    const current = await record(twin!.recordId);
    expect(current.content).toBe(note.content);
    expect(current.type).toBe("skill");
    expect(current.tier).toBe("skill");
    expect(current.metadata).toMatchObject({
      legacy_note_id: noteId,
      note_type: "skill",
      tier: "skill",
    });
    expect(current.source_ids).toEqual([twin!.sourceId!]);
  });

  it("`pool add` twins the deposit in the author's resident space tagged with the pool; `ratify` adds the institutional mirror beside it", async () => {
    setTrustProfile("local");
    db.createMemoryPool("pool_guide", "guide", "system");
    const reply = await run(
      alice,
      "pool guide add Prefer tellAndAwait for crew round trips importance 8",
    );
    expect(reply).toContain("Added note #");
    const noteId = latestNoteId("Alice");
    const note = db.getNote(noteId)!;
    expect(note.pool_id).toBe("pool_guide");

    const twin = findDurableTwin(db, noteId)!;
    expect(twin).toBeDefined();
    const resident = await record(twin.recordId);
    expect(resident.content).toBe("Prefer tellAndAwait for crew round trips");
    expect(resident.metadata).toMatchObject({
      legacy_note_id: noteId,
      pool_id: "pool_guide",
      pool: "guide",
      shared: true,
    });
    // Dedup'd re-deposit: no second twin.
    expect(await run(alice, "pool guide add Prefer tellAndAwait for crew round trips")).toContain(
      "Already shared",
    );
    expect(durableTwinRecordIds(db, noteId)).toEqual([twin.recordId]);

    // Ratification mirrors into the institutional space WITHOUT displacing the resident twin.
    const ratified = await run(alice, `pool guide ratify ${noteId} importance 8 checked`);
    expect(ratified).toContain("Ratified");
    const ids = durableTwinRecordIds(db, noteId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(twin.recordId);
    const mirrorId = ids.find((id) => id !== twin.recordId)!;
    expect(findDurableTwin(db, noteId)!.recordId).toBe(twin.recordId);
    const mirrorRow = db
      .getNoteSources(noteId)
      .find((s) => s.url.endsWith(encodeURIComponent(mirrorId)))!;
    expect(JSON.parse(mirrorRow.metadata!)).toMatchObject({
      kind: "durable-twin",
      mirror: "institutional",
      pool: "guide",
    });
    // The resident twin still follows the author's verbs (verification landed on the note).
    expect(db.getNote(noteId)!.verification_status).toBe("verified");
  });
});
