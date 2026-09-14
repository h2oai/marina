// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standing, competence and witness ledgers are keyed by the durable world
 * account (users.id), not by the transient entity id. Before migration 109
 * a passwordless re-login after the 60s reconnect grace minted a fresh entity
 * id and silently orphaned the entity's whole reputation (live-reproduced in
 * the 2026-09-11 memory probe: `standing show alice` → "Unknown entity",
 * leaderboard listing dead ids).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getStanding,
  leaderboard,
  ledgerFor,
  POOL_NOTE_DAILY_CAP,
  record,
  recordFromEvent,
  STANDING_AMOUNTS,
} from "../src/agent/standing";
import { MarinaDB } from "../src/persistence/database";
import { MIGRATIONS } from "../src/persistence/schema";
import { type EngineEvent, type Entity, entityId, roomId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_standing_durable.db";

function entity(id: string, name: string): Entity {
  return {
    id: entityId(id),
    kind: "agent",
    name,
    short: name,
    long: name,
    room: roomId("test/start"),
    properties: {},
    inventory: [],
    createdAt: Date.now(),
  };
}

describe("Standing — durable identity key", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("standing survives eviction + re-login under a new entity id", () => {
    db.saveEntity(entity("e_1", "alice"));
    db.createUser({ id: "user-alice", name: "alice" });
    record(db, "e_1", "alice", "task_complete", "task:1", 3);
    expect(getStanding(db, "e_1")).toBeCloseTo(3, 5);

    // Grace period expires: the entity row is hard-deleted; a name-login
    // spawns a fresh entity id for the same account.
    db.deleteEntity(entityId("e_1"));
    db.saveEntity(entity("e_2", "alice"));

    expect(getStanding(db, "e_2")).toBeCloseTo(3, 5);
    expect(ledgerFor(db, "e_2", 10)).toHaveLength(1);
    // The ledger row itself is keyed by the account, not either entity id.
    expect(leaderboard(db, 5)[0]).toEqual({ entityId: "user-alice", standing: expect.any(Number) });
    // Querying by the account id directly works too (offline `standing show`).
    expect(getStanding(db, "user-alice")).toBeCloseTo(3, 5);
  });

  it("ids without a world account pass through unchanged (test fixtures, service principals)", () => {
    record(db, "e_9", "ghost", "task_complete", "task:9", 2);
    expect(getStanding(db, "e_9")).toBeCloseTo(2, 5);
    expect(leaderboard(db, 5)[0]?.entityId).toBe("e_9");
  });

  it("gate competence follows the account across re-login", () => {
    db.saveEntity(entity("e_1", "bob"));
    db.createUser({ id: "user-bob", name: "bob" });
    db.grantCompetence("e_1", "shell.exec");
    db.deleteEntity(entityId("e_1"));
    db.saveEntity(entity("e_7", "bob"));
    expect(db.getCompetence("e_7", "shell.exec")).toBeDefined();
    expect(db.listCompetenceForEntity("e_7")).toHaveLength(1);
  });

  it("migration 109 backfills legacy rows onto the account and merges duplicates", () => {
    db.createUser({ id: "user-carol", name: "carol" });
    // Two dead entity ids for the same account, one duplicated event.
    // Seed legacy rows through a second raw connection (same file, WAL-safe).
    const raw = new Database(TEST_DB);
    for (const [eid, ref] of [
      ["e_10", "task:1"],
      ["e_11", "task:2"],
      ["e_11", "task:1"],
    ] as const) {
      raw.run(
        `INSERT INTO entity_standing (entity_id, entity_name, kind, ref, task_id, amount, decay_class, earned_at)
         VALUES (?, 'carol', 'task_complete', ?, NULL, 1, 'standard', ?)`,
        [eid, ref, Date.now()],
      );
    }
    db.saveEntity(entity("e_11", "carol"));
    raw.run(
      "INSERT INTO entity_competence (entity_id, gate, demonstrations, supervised_only) VALUES ('e_11', 'code.exec', 5, 0)",
    );
    const migration = MIGRATIONS.find((m) => m.version === 109);
    expect(migration).toBeDefined();
    raw.exec(migration!.sql);

    const rows = raw.query("SELECT entity_id, ref FROM entity_standing ORDER BY ref").all() as {
      entity_id: string;
      ref: string;
    }[];
    raw.close();
    expect(rows).toEqual([
      { entity_id: "user-carol", ref: "task:1" },
      { entity_id: "user-carol", ref: "task:2" },
    ]);
    expect(db.getCompetence("user-carol", "code.exec")?.demonstrations).toBe(5);
    expect(getStanding(db, "e_11")).toBeCloseTo(2, 5);
  });

  it("pool_note credit is content-keyed and capped per UTC day", () => {
    const base = Date.UTC(2026, 8, 13, 12, 0, 0);
    const post = (content: string, i: number): EngineEvent => ({
      type: "pool_note",
      entity: entityId("e_1"),
      noteId: 100 + i,
      poolName: "scratch",
      content,
      importance: 5,
      timestamp: base + i,
    });
    const lookup = () => "alice";
    // Re-posting identical text under new note ids earns exactly once.
    recordFromEvent(db, post("Same text", 0), lookup);
    recordFromEvent(db, post("  same   TEXT ", 1), lookup);
    expect(ledgerFor(db, "e_1", 50)).toHaveLength(1);
    expect(getStanding(db, "e_1")).toBeCloseTo(STANDING_AMOUNTS.pool_note, 5);
    // Distinct content is credited only up to the daily cap.
    for (let i = 2; i < POOL_NOTE_DAILY_CAP + 5; i++)
      recordFromEvent(db, post(`note ${i}`, i), lookup);
    expect(ledgerFor(db, "e_1", 50)).toHaveLength(POOL_NOTE_DAILY_CAP);
    // ~100 quick pool writes can no longer reach the rank-4 threshold (100).
    expect(getStanding(db, "e_1")).toBeLessThan(5);
  });
});
