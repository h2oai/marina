// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-agent dreaming over a shared pool (phase 5): the region is the pool's
 * records from every member; a pool dream proposes merge/link/decay only and
 * applies NOTHING — every op waits for a ratifier who holds the institutional
 * standing and wrote none of the notes it touches; ratification re-checks and
 * applies (a cross-author merge included), dismiss is the ratifier's no,
 * rollback reverses the whole dream; the schedule lists pools too.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { setTrustProfile } from "../src/engine/trust-profile";
import {
  checkOps,
  gatherRegion,
  pendingProposals,
  poolDreamCandidates,
  poolScopeName,
  runDream,
  scheduleGate,
  scopeOf,
} from "../src/memory/dream";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = tempDbPath("test_memory_dream_pool.db");
const HOUR = 60 * 60 * 1000;
const POOL = poolScopeName("team");

describe("pool dreams", () => {
  let db: MarinaDB;
  let engine: Engine;
  const conns: Record<string, MockConnection> = {};
  const ids: Record<string, EntityId> = {};
  let notes: number[];
  const now = Date.now();

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    for (const [i, name] of ["Ada", "Bob", "Cy"].entries()) {
      const conn = new MockConnection(`c${i + 1}`);
      engine.addConnection(conn);
      engine.spawnEntity(`c${i + 1}`, name);
      conns[name] = conn;
      ids[name] = conn.entity!;
      conn.clear();
      if (!db.durableKeyForName(name)) db.createUser({ id: `u_${name}`, name, rank: 1 });
    }
    db.createMemoryPool("pool_team", "team", "Ada");
    const add = (author: string, text: string) =>
      db.addPoolNote("pool_team", author, text, 5, "observation", { skipDedup: true });
    notes = [
      add("Ada", "The amber deployment listens on port 8443 behind the staging proxy"),
      add("Bob", "The amber deployment listens on port 8443 behind the staging gateway"),
      add("Bob", "The staging proxy rejects requests without a tenant header"),
      add("Cy", "A shared note that was served many times and never used by anyone"),
      add("Ada", "Verified fact: the production port is 443 and must never change"),
      // Filler, so the preservation bound (a quarter of the region) allows two records to leave.
      add("Cy", "Lantern maintenance is scheduled for the first Monday of each month"),
      add("Cy", "Indigo alerts page the on-call engineer after three failures"),
      add("Bob", "The quartz runner caches dependencies between builds"),
      add("Ada", "Amber health checks poll every thirty seconds"),
    ];
    db.memoryRepository().raw.run(
      "UPDATE notes SET verification_status = 'verified' WHERE id = ?",
      [notes[4]!],
    );
    // Cy's note was served to Bob five times and rated unused.
    for (let i = 0; i < 5; i++)
      db.recordMemoryServed([
        {
          entityName: "Bob",
          surface: "prompt",
          arm: "lexical",
          tier: "unverified",
          itemId: String(notes[3]!),
          rank: 1,
          queryHash: `q${i}`,
          servedAt: now - (i + 1) * HOUR,
        },
      ]);
    db.applyUsefulness({ itemId: String(notes[3]!), rater: "unused", raterEntity: "Bob", beta: 2 });
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const say = async (who: string, command: string) => {
    conns[who]!.clear();
    await engine.processCommand(ids[who]!, command);
    return conns[who]!.lastText();
  };
  const ops = () =>
    JSON.stringify({
      ops: [
        { op: "merge", keep: notes[0]!, into: [notes[1]!], reason: "same note, two authors" },
        {
          op: "link",
          from: notes[2]!,
          to: notes[0]!,
          relation: "related_to",
          reason: "same proxy",
        },
        { op: "decay", id: notes[3]!, reason: "served five times, never used" },
        {
          op: "supersede",
          id: notes[2]!,
          text: "The staging proxy rejects requests without a tenant header",
          refs: [],
          reason: "x",
        },
        { op: "decay", id: notes[4]!, reason: "verified, should be refused" },
      ],
    });

  it("the pool region holds every member's live records with pooled use evidence; no procedures", () => {
    expect(scopeOf(db, POOL)).toEqual({ kind: "pool", name: "team", poolId: "pool_team" });
    expect(scopeOf(db, poolScopeName("nope"))).toBeUndefined();
    const region = gatherRegion(db, POOL, now - 24 * HOUR, now + HOUR);
    expect(region.pool).toEqual({ id: "pool_team", name: "team" });
    expect(region.records.map((r) => r.id).sort()).toEqual([...notes].sort());
    expect(region.records.find((r) => r.id === notes[3]!)!.serves).toBe(5);
    expect(region.records.find((r) => r.id === notes[4]!)!.verified).toBe(true);
    expect(region.procedures).toEqual([]);
    // A member's own region never includes pool notes.
    expect(gatherRegion(db, "Ada", now - 24 * HOUR, now + HOUR).records).toEqual([]);
    // Checks: a restatement over a pool is refused; the verified note stays.
    const out = checkOps(JSON.parse(ops()).ops, region);
    expect(out.accepted.map((o) => o.op)).toEqual(["merge", "link", "decay"]);
    expect(out.rejected.map((r) => r.reason.split(":")[0])).toEqual(["pool", "taint"]);
  });

  it("on: a pool dream files every op for ratification and applies nothing; a member who wrote a touched note cannot ratify; an independent ratifier applies, dismisses and rolls back", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    const summary = await runDream(db, POOL, "command", {
      now: now + HOUR,
      model: "test/dreamer",
      complete: async () => ops(),
    });
    expect(summary.state).toBe("applied");
    expect(summary.proposals).toBe(3);
    expect(summary.ops!.map((o) => [o.op, o.proposal, o.applied === undefined])).toEqual([
      ["merge", "pending", true],
      ["link", "pending", true],
      ["decay", "pending", true],
    ]);
    // The dry view was probed, and nothing stayed.
    expect(summary.checks!.probesAfter).toEqual({ pass: 2, fail: 0 });
    expect(db.getNote(notes[1]!)!.verification_status).toBe("unverified");
    expect(db.getNote(notes[3]!)!.importance).toBe(5);
    expect(db.countNoteLinks("Bob")).toBe(0);
    expect(pendingProposals(db, POOL, now + HOUR)).toHaveLength(3);
    expect(
      db.queryChronicle({ kind: "event" }).find((e) => e.title === "memory.dream")!.body,
    ).toContain("nothing applied until ratified");

    expect(await say("Ada", "pool team dream proposals")).toContain(
      `merge #${notes[1]!} into #${notes[0]!}`,
    );
    // Standing rule first: nobody here has standing 15.
    expect(await say("Cy", `pool team dream ratify ${summary.id} 0`)).toMatch(/standing/);
    // The party rule: Ada wrote the keeper, Bob the duplicate — neither ratifies the merge.
    setTrustProfile("local");
    expect(await say("Ada", `pool team dream ratify ${summary.id} 0`)).toContain(
      "an independent member ratifies",
    );
    expect(await say("Bob", `pool team dream ratify ${summary.id} 0`)).toContain(
      "an independent member ratifies",
    );
    // Cy wrote none of them: the cross-author merge applies.
    expect(await say("Cy", `pool team dream ratify ${summary.id} 0`)).toContain("Ratified: merge");
    expect(db.getNote(notes[1]!)!.verification_status).toBe("superseded");
    expect(db.getNote(notes[0]!)!.verification_status).toBe("unverified");
    const stored = JSON.parse(db.getDream(summary.id!)!.ops_json) as Array<Record<string, unknown>>;
    expect(stored[0]!.proposal).toBe("adopted");
    expect(stored[0]!.applied).toEqual({
      kind: "merge",
      prior: { [String(notes[1]!)]: "unverified" },
    });
    // The merged-away note is retrievable through its keeper, pool-wide.
    expect(db.recallPoolNotes("pool_team", "amber deployment staging").map((n) => n.id)).toContain(
      notes[0]!,
    );
    // The decay touches Cy's own note: Cy may not ratify it; Ada may.
    expect(await say("Cy", `pool team dream ratify ${summary.id} 2`)).toContain(
      "an independent member ratifies",
    );
    expect(await say("Ada", `pool team dream ratify ${summary.id} 2`)).toContain("Ratified: decay");
    expect(db.getNote(notes[3]!)!.importance).toBe(3);
    // Dismiss the link: the ledger records the ratifier's no.
    expect(await say("Cy", `pool team dream dismiss ${summary.id} 1`)).toContain("Dismissed");
    const ledger = db.listJudgeLedger({ surface: "dream", limit: 10 });
    expect(ledger.find((r) => r.subject === `dream:${summary.id}:0`)!.truth).toBe("pass");
    expect(ledger.find((r) => r.subject === `dream:${summary.id}:1`)!.truth).toBe("fail");
    expect(ledger.find((r) => r.subject === `dream:${summary.id}:2`)!.truth).toBe("pass");
    expect(pendingProposals(db, POOL, now + HOUR)).toEqual([]);

    // Rollback restores the merged-away note as its author and the decay.
    expect(await say("Cy", `pool team dream rollback ${summary.id}`)).toContain("2 op(s) reversed");
    expect(db.getNote(notes[1]!)!.verification_status).toBe("unverified");
    expect(db.getNote(notes[3]!)!.importance).toBe(5);
    expect(db.getDream(summary.id!)!.state).toBe("rolled_back");
    expect(
      db.recallPoolNotes("pool_team", "amber deployment staging gateway").map((n) => n.id),
    ).toContain(notes[1]!);
  });

  it("observe: a pool dream records and files nothing; the schedule lists written-to pools under the same gates", async () => {
    const summary = await runDream(db, POOL, "command", {
      now: now + HOUR,
      complete: async () => ops(),
    });
    expect(summary.state).toBe("observed");
    expect(summary.proposals).toBeFalsy();
    expect(pendingProposals(db, POOL, now + HOUR)).toEqual([]);
    expect(poolDreamCandidates(db, now + HOUR)).toEqual([POOL]);
    expect(scheduleGate(db, POOL, now + HOUR)).toMatch(/^cooldown:/);
    expect(scheduleGate(db, poolScopeName("team"), now + 9 * HOUR)).toMatch(/^material:/);
    expect(await say("Ada", "pool team dream log")).toContain(`#${summary.id}`);
    expect(await say("Ada", `pool team dream show ${summary.id}`)).toContain("observed");
    expect(await say("Ada", "pool team dream ratify 999")).toContain("No dream #999");
    expect(await say("Ada", "pool nowhere dream")).toContain("not found");
  });
});
