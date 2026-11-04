// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Two things an agent can do with its own memory: `recall <query> episodes`
 * reads its own journal (never another's, never served to anyone), and
 * `memory dream restore <dream> <n>` reverses ONE applied op of a dream while
 * the rest stands — the op's judge opinion settles as a fail, and when nothing
 * applied remains the dream is as rolled back.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { DECAY_STEP, restoreDreamOp, runDream, searchEpisodes } from "../src/memory/dream";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = tempDbPath("test_memory_dream_restore.db");
const HOUR = 60 * 60 * 1000;

describe("episodes recall and per-op restore", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let ada: EntityId;
  let ids: number[];
  // Taken per test, before its notes are written: a file-level clock left the notes
  // outside the dream window once a slow shard spent more than a second between them.
  let now = 0;

  const message = (role: string, text: string) =>
    `,${JSON.stringify({ role, content: [{ type: "text", text }] })}`;
  const journal = (owner: string, part: string, at: number) => {
    const raw = db.memoryRepository().raw;
    raw.run(
      "INSERT OR IGNORE INTO memory_spaces (id, owner_id, name, created_at) VALUES (?, ?, 'resident', ?)",
      [`space_${owner}`, `u_${owner}`, at],
    );
    const id = `src_${owner}_${at}_${Math.random().toString(36).slice(2, 8)}`;
    raw.run(
      "INSERT INTO memory_sources (id, space_id, session_id, body, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, `space_${owner}`, `journal:${owner}`, JSON.stringify(part), id, at],
    );
    const seq = (
      raw.query("SELECT seq FROM memory_sources WHERE id = ?").get(id) as { seq: number }
    ).seq;
    raw.run("INSERT OR IGNORE INTO memory_source_text (seq, text) VALUES (?, ?)", [seq, part]);
  };

  beforeEach(() => {
    now = Date.now();
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Ada");
    ada = conn.entity!;
    conn.clear();
    for (const name of ["Ada", "Bob"]) {
      db.ensurePrincipal({ type: "human", displayName: name, principalId: `u_${name}` });
      if (!db.durableKeyForName(name)) db.createUser({ id: `u_${name}`, name, rank: 1 });
    }
    ids = [
      "The amber deployment listens on port 8443 behind the staging proxy",
      "The amber deployment listens on port 8443 behind the staging gateway",
      "The staging proxy rejects requests without a tenant header",
      "A note that was served many times and never used by anyone",
      "Lantern maintenance is scheduled for the first Monday of each month",
      "Indigo alerts page the on-call engineer after three failures",
      "The quartz runner caches dependencies between builds",
      "Amber health checks poll every thirty seconds",
    ].map((text) => db.createNote("Ada", text, undefined, { skipDedup: true }));
    for (let i = 0; i < 5; i++)
      db.recordMemoryServed([
        {
          entityName: "Ada",
          surface: "prompt",
          arm: "lexical",
          tier: "unverified",
          itemId: String(ids[3]!),
          rank: 1,
          queryHash: `q${i}`,
          servedAt: now - (i + 1) * HOUR,
        },
      ]);
    db.applyUsefulness({ itemId: String(ids[3]!), rater: "unused", raterEntity: "Ada", beta: 2 });
    journal("Ada", "[", now - 3 * HOUR);
    journal("Ada", message("user", "How long does the quartz build take?"), now - 3 * HOUR + 1);
    journal(
      "Ada",
      message("assistant", "The quartz build took eleven minutes on the shared runner today."),
      now - 3 * HOUR + 2,
    );
    journal("Ada", message("assistant", "Lantern maintenance moved to Tuesday."), now - 2 * HOUR);
    journal("Bob", message("assistant", "Bob's quartz build took two minutes."), now - HOUR);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("recall … episodes searches the owner's own journal only, newest first, every term", async () => {
    const hits = searchEpisodes(db, "Ada", "quartz build");
    expect(hits.map((h) => h.role)).toEqual(["assistant", "user"]);
    expect(hits[0]!.excerpt).toContain("eleven minutes");
    expect(JSON.stringify(hits)).not.toContain("Bob's");
    expect(searchEpisodes(db, "Ada", "quartz tuesday")).toEqual([]);
    expect(searchEpisodes(db, "Ada", "lantern")).toHaveLength(1);
    expect(searchEpisodes(db, "Bob", "quartz")).toHaveLength(1);
    expect(searchEpisodes(db, "Nobody", "quartz")).toEqual([]);
    // Under a cutoff only parts captured by then are read.
    expect(searchEpisodes(db, "Ada", "lantern", { asOf: now - 2.5 * HOUR })).toEqual([]);
    expect(searchEpisodes(db, "Ada", "x")).toEqual([]);

    await engine.processCommand(ada, "memory recall quartz build episodes");
    const text = conn.lastText();
    expect(text).toContain('Recall (episodes): "quartz build"');
    expect(text).toContain("assistant: The quartz build took eleven minutes");
    expect(text).toContain("user: How long does the quartz build take?");
    expect(text).not.toContain("Bob");
    conn.clear();
    await engine.processCommand(ada, "memory recall vault episodes");
    expect(conn.lastText()).toContain('No episode of yours mentions "vault"');
  });

  it("restore reverses one applied op; the rest stands; the last one makes the dream as rolled back", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    const at = now + 1000;
    const summary = await runDream(db, "Ada", "command", {
      now: at,
      model: "test/dreamer",
      complete: async () =>
        JSON.stringify({
          ops: [
            { op: "merge", keep: ids[0], into: [ids[1]], reason: "same" },
            { op: "decay", id: ids[3], reason: "unused" },
            { op: "link", from: ids[2], to: ids[0], relation: "related_to", reason: "proxy" },
          ],
        }),
    });
    expect(summary.state).toBe("applied");
    expect(db.getNote(ids[1]!)!.verification_status).toBe("superseded");
    expect(db.getNote(ids[3]!)!.importance).toBe(5 - DECAY_STEP);

    // Restore the decay only.
    conn.clear();
    await engine.processCommand(ada, `memory dream restore ${summary.id} 1`);
    expect(conn.lastText()).toContain("Restored op 1 (decay)");
    expect(conn.lastText()).toContain("2 applied op(s) still stand");
    expect(db.getNote(ids[3]!)!.importance).toBe(5);
    expect(db.getNote(ids[1]!)!.verification_status).toBe("superseded");
    const related = () =>
      db.getNoteLinks(ids[2]!).filter((l) => l.relationship === "related_to").length;
    expect(related()).toBe(1);
    const row = db.getDream(summary.id!)!;
    expect(row.state).toBe("applied");
    const ops = JSON.parse(row.ops_json) as Array<{ reverted?: boolean }>;
    expect(ops.map((o) => o.reverted ?? false)).toEqual([false, true, false]);
    expect(
      db
        .listJudgeLedger({ surface: "dream", limit: 10 })
        .find((r) => r.subject === `dream:${summary.id}:1`)?.truth,
    ).toBe("fail");
    expect(
      db.queryChronicle({ kind: "event" }).some((e) => e.title === "memory.dream.restore"),
    ).toBe(true);
    // Again is a no-op with a reason; a bad index too.
    expect(restoreDreamOp(db, db.getDream(summary.id!)!, 1)).toEqual({
      ok: false,
      reason: "op 1 is already restored",
    });
    expect(restoreDreamOp(db, db.getDream(summary.id!)!, 7).ok).toBe(false);

    // Restoring the rest leaves nothing applied: the dream is as rolled back.
    expect(restoreDreamOp(db, db.getDream(summary.id!)!, 2)).toMatchObject({
      ok: true,
      op: "link",
      remaining: 1,
      rolledBack: false,
    });
    expect(related()).toBe(0);
    conn.clear();
    await engine.processCommand(ada, `memory dream restore ${summary.id} 0`);
    expect(conn.lastText()).toContain("the dream is as rolled back");
    expect(db.getNote(ids[1]!)!.verification_status).toBe("unverified");
    expect(db.getDream(summary.id!)!.state).toBe("rolled_back");
    conn.clear();
    await engine.processCommand(ada, `memory dream rollback ${summary.id}`);
    expect(conn.lastText()).toContain("already rolled back");
  });

  it("an observed dream has nothing to restore", async () => {
    const summary = await runDream(db, "Ada", "command", {
      now: now + 1000,
      complete: async () =>
        JSON.stringify({ ops: [{ op: "merge", keep: ids[0], into: [ids[1]], reason: "same" }] }),
    });
    expect(restoreDreamOp(db, db.getDream(summary.id!)!, 0)).toEqual({
      ok: false,
      reason: "observed, not applied: nothing to undo",
    });
  });
});
