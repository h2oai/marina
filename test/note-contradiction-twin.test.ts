// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `refreshContradictionCases` must never pair a legacy note with its own
 * durable twin. The twin is a `memory:<principal>` version note that shares
 * the legacy note's `claim_key` (and has a different `entity_name`), so before
 * the guard `note conflicts` listed every bridged pool note against its mirror.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests } from "../src/engine/trust-profile";
import { awaitPendingBridges, findDurableTwin } from "../src/memory/legacy-bridge";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("contradiction cases exclude durable twins", () => {
  let directory: string;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;

  const run = async (text: string) => {
    alice.clear();
    await engine.processCommand(alice.entity as EntityId, text);
    await awaitPendingBridges();
    return stripAnsi(alice.allTextJoined());
  };
  const latestNoteId = () => db.getNotesByEntity("Alice", 1)[0]!.id;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-contradiction-twin-"));
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

  it("pairs the two legacy pool notes exactly once and never a note with its twin", async () => {
    expect(await run("pool create relaypool")).toContain("relaypool");
    await run("pool relaypool add The relay is online");
    const online = latestNoteId();
    await run("pool relaypool add The relay is not online");
    const offline = latestNoteId();
    const onlineTwin = findDurableTwin(db, online)!;
    const offlineTwin = findDurableTwin(db, offline)!;
    expect(onlineTwin).toBeDefined();
    expect(offlineTwin).toBeDefined();

    // Both twins are claim-keyed service notes in the same `notes` table …
    const raw = db.memoryRepository().raw;
    const twinNotes = raw
      .query(
        `SELECT n.id, n.claim_key FROM notes n JOIN memory_record_versions v ON v.note_id = n.id
         WHERE v.record_id IN (?, ?)`,
      )
      .all(onlineTwin.recordId, offlineTwin.recordId) as { id: number; claim_key: string | null }[];
    expect(twinNotes.length).toBeGreaterThanOrEqual(2);
    for (const twin of twinNotes) {
      expect(db.isServiceMemoryNote(twin.id)).toBe(true);
      expect(twin.claim_key).toBe(db.getNote(online)!.claim_key ?? null);
    }

    // … yet only the legacy pair becomes a case.
    expect(db.refreshContradictionCases()).toBe(1);
    const cases = db.listContradictionCases("open", 50);
    expect(cases).toHaveLength(1);
    const [conflict] = cases;
    expect([conflict!.left_note_id, conflict!.right_note_id].sort((a, b) => a - b)).toEqual(
      [online, offline].sort((a, b) => a - b),
    );
    for (const c of cases) {
      expect(db.isServiceMemoryNote(c.left_note_id)).toBe(false);
      expect(db.isServiceMemoryNote(c.right_note_id)).toBe(false);
    }
    // Idempotent on re-run.
    expect(db.refreshContradictionCases()).toBe(0);

    const listing = await run("note conflicts");
    expect(listing).toContain(`#${online}`);
    expect(listing).toContain(`#${offline}`);
    for (const twin of twinNotes) expect(listing).not.toContain(`#${twin.id} `);
  });
});
