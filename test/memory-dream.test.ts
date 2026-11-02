// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The dream pass in `observe` (`src/memory/dream`): gather → probe → propose
 * (a stubbed model) → check → record. Nothing is applied; every rejection
 * names its check; the record carries ids, hashes and counts, never text;
 * the schedule gates hold; `memory dream` reads it back.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import {
  checkOps,
  DREAM_COOLDOWN_MS,
  DREAM_MIN_NEW,
  dreamCandidates,
  dreamingMode,
  gatherRegion,
  parseOps,
  probeQuery,
  regionPrompt,
  runDream,
  runDreamSchedule,
  scheduleGate,
} from "../src/memory/dream";
import { faithfulTo, MERGE_MIN_OVERLAP, PRESERVATION_MAX_LOSS } from "../src/memory/dream/check";
import type { DreamOp } from "../src/memory/dream/types";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = tempDbPath("test_memory_dream.db");
const HOUR = 60 * 60 * 1000;

const NOTES = [
  "The amber deployment listens on port 8443 behind the staging proxy",
  "The amber deployment listens on port 8443 behind the staging gateway",
  "The quartz build takes eleven minutes on the shared runner",
  "Cobalt tests need the fixture database reset before each run",
  "Cobalt tests need the fixture database reset before every run",
  "Lantern maintenance is scheduled for the first Monday of each month",
  "The staging proxy rejects requests without a tenant header",
  "Verified fact: the production port is 443 and must never change",
  "A note that was served many times and never used by anyone",
  "Indigo alerts page the on-call engineer after three failures",
  "The quartz runner caches dependencies between builds",
  "Amber health checks poll every thirty seconds",
];

function stubModel(reply: string) {
  const calls: string[] = [];
  return {
    calls,
    complete: async (_system: string, user: string) => {
      calls.push(user);
      return reply;
    },
  };
}

describe("the dream pass (observe)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let ada: EntityId;
  let ids: number[];
  const now = Date.now();

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
    ids = NOTES.map((text) => db.createNote("Ada", text, undefined, { skipDedup: true }));
    // #8 is verified; #9 was served five times and never cited; everything else is plain.
    db.memoryRepository().raw.run(
      "UPDATE notes SET verification_status = 'verified' WHERE id = ?",
      [ids[7]!],
    );
    for (let i = 0; i < 5; i++)
      db.recordMemoryServed([
        {
          entityName: "Ada",
          surface: "prompt",
          arm: "lexical",
          tier: "unverified",
          itemId: String(ids[8]!),
          rank: 1,
          queryHash: `q${i}`,
          servedAt: now - (i + 1) * HOUR,
        },
      ]);
    db.applyUsefulness({ itemId: String(ids[8]!), rater: "unused", raterEntity: "Ada", beta: 2 });
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const note = (i: number) => ids[i]!;

  it("gathers the owner's own live fact-like records with use evidence, never text in the hash", () => {
    const region = gatherRegion(db, "Ada", now - 24 * HOUR, now + 1000);
    expect(region.records.map((r) => r.id).sort((a, b) => a - b)).toEqual(
      [...ids].sort((a, b) => a - b),
    );
    expect(region.newRecords).toBe(NOTES.length);
    const served = region.records.find((r) => r.id === note(8))!;
    expect(served.serves).toBe(5);
    expect(served.mean).toBeLessThan(0.5);
    expect(region.records.find((r) => r.id === note(7))!.verified).toBe(true);
    expect(region.hash).toMatch(/^[0-9a-f]{16}$/);
    const prompt = regionPrompt(region);
    expect(prompt).toContain(`#${note(0)}`);
    expect(prompt).toContain("served=5");
    expect(gatherRegion(db, "Bea", now - 24 * HOUR, now + 1000).records).toEqual([]);
  });

  it("parses ops and turns malformed ones into rejections", () => {
    const parsed = parseOps(
      `Here you go:\n${JSON.stringify({
        ops: [
          { op: "merge", keep: 1, into: [2, 2], reason: "same" },
          { op: "link", from: 1, to: 3, relation: "supports", reason: "s" },
          { op: "link", from: 1, to: 3, relation: "loves" },
          { op: "decay", id: "nine" },
          { op: "teleport", id: 4 },
          { op: "supersede", id: 5, text: "x", refs: [1] },
        ],
      })}`,
    );
    expect(parsed.ops).toHaveLength(3);
    expect(parsed.ops[0]).toEqual({ op: "merge", keep: 1, into: [2], reason: "same" });
    expect(parsed.rejected.map((r) => r.reason)).toEqual([
      "link needs from, to and a known relation",
      "decay needs an id",
      "unknown op",
    ]);
    expect(parseOps("not json").rejected[0]?.reason).toContain("no ops array");
  });

  it("checks: region, taint, coverage, faithfulness, evidence and preservation", () => {
    const region = gatherRegion(db, "Ada", now - 24 * HOUR, now + 1000);
    const ops: DreamOp[] = [
      // two genuine near-duplicates: accepted
      { op: "merge", keep: note(0), into: [note(1)], reason: "same port note" },
      // unrelated notes: coverage rejects
      { op: "merge", keep: note(2), into: [note(5)], reason: "nope" },
      // verified note: taint rejects
      { op: "decay", id: note(7), reason: "stale" },
      // decay with evidence: accepted
      { op: "decay", id: note(8), reason: "never used" },
      // decay without evidence: rejected
      { op: "decay", id: note(9), reason: "meh" },
      // supersede faithful: accepted
      {
        op: "supersede",
        id: note(3),
        text: "Cobalt tests reset the fixture database before each run",
        refs: [note(4)],
        reason: "tighter",
      },
      // supersede inventing a number: rejected
      {
        op: "supersede",
        id: note(10),
        text: "The quartz runner caches dependencies for 48 hours between builds",
        refs: [],
        reason: "added detail",
      },
      // outside the region
      { op: "link", from: note(0), to: 999_999, relation: "supports", reason: "?" },
      // self link
      { op: "link", from: note(0), to: note(0), relation: "supports", reason: "?" },
      // fine link
      { op: "link", from: note(6), to: note(0), relation: "related_to", reason: "same proxy" },
    ];
    const out = checkOps(ops, region);
    expect(out.accepted.map((o) => o.op)).toEqual(["merge", "decay", "supersede", "link"]);
    const reasons = out.rejected.map((r) => r.reason);
    expect(reasons.some((r) => r.startsWith("coverage:"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("taint:"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("evidence:"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("faithfulness:"))).toBe(true);
    expect(reasons.some((r) => r.startsWith("region:"))).toBe(true);
    expect(reasons.some((r) => r.includes("cannot link to itself"))).toBe(true);
    // Preservation: the 12-record region may lose at most 3; a fourth leaver is refused.
    const bound = Math.floor(NOTES.length * PRESERVATION_MAX_LOSS);
    expect(out.leaving).toBe(3);
    expect(bound).toBe(3);
    const greedy: DreamOp[] = [note(9), note(10), note(11), note(2)].map((id) => ({
      op: "decay" as const,
      id,
      reason: "x",
    }));
    // No evidence on any of these, so they fail the evidence check first; use merges instead.
    const merges: DreamOp[] = [
      { op: "merge", keep: note(0), into: [note(1)], reason: "a" },
      { op: "merge", keep: note(3), into: [note(4)], reason: "b" },
      { op: "decay", id: note(8), reason: "c" },
      {
        op: "supersede",
        id: note(6),
        text: "The staging proxy rejects requests without a tenant header.",
        refs: [],
        reason: "d",
      },
    ];
    const bounded = checkOps(merges, region);
    expect(bounded.accepted).toHaveLength(3);
    expect(bounded.rejected[0]?.reason).toContain("preservation:");
    expect(checkOps(greedy, region).accepted).toHaveLength(0);
    expect(MERGE_MIN_OVERLAP).toBe(0.5);
  });

  it("a dream in observe records ops, rejections and probes — no text — and applies nothing", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: undefined } });
    const model = stubModel(
      JSON.stringify({
        ops: [
          { op: "merge", keep: note(0), into: [note(1)], reason: "same port note" },
          { op: "decay", id: note(8), reason: "served five times, never used" },
          { op: "decay", id: note(7), reason: "old" },
          {
            op: "supersede",
            id: note(3),
            text: "Cobalt tests reset the fixture database before each run",
            refs: [note(4)],
            reason: "tighter",
          },
        ],
      }),
    );
    const before = db.getNotesByEntity("Ada", 100).map((n) => [n.id, n.verification_status]);
    // The fixture notes were written after `now`; dream from a moment after them.
    const at = Date.now() + 1000;
    const summary = await runDream(db, "Ada", "command", {
      complete: model.complete,
      model: "test/dreamer",
      now: at,
    });
    expect(summary.state).toBe("observed");
    expect(summary.id).toBeGreaterThan(0);
    expect(summary.checks).toMatchObject({ accepted: 3, rejected: 1, leaving: 3, regionSize: 12 });
    expect(summary.probes).toHaveLength(3);
    expect(summary.probes!.every((p) => p.before === "pass")).toBe(true);
    expect(summary.rejected![0]?.reason).toContain("taint:");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toContain("served=5");

    // Nothing applied: every note exactly as before.
    expect(db.getNotesByEntity("Ada", 100).map((n) => [n.id, n.verification_status])).toEqual(
      before,
    );
    expect(db.countNoteLinks("Ada")).toBe(0);

    // The record: ids, hashes and counts, never the supersede text or any note content.
    const row = db.getDream(summary.id!)!;
    expect(row).toMatchObject({
      entity_name: "Ada",
      trigger: "command",
      mode: "observe",
      state: "observed",
    });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("Cobalt tests reset");
    expect(stored).not.toContain("amber deployment");
    expect(stored).toContain("textHash");
    expect(JSON.parse(row.ops_json)).toHaveLength(3);
    expect(JSON.parse(row.probes_json)[0]).toMatchObject({ before: "pass", after: null });
    expect(db.lastDreamAt("Ada")).toBe(at);

    // One chronicle event, counts only.
    const events = db.queryChronicle({ kind: "event" }).filter((e) => e.title === "memory.dream");
    expect(events).toHaveLength(1);
    expect(events[0]!.refs).toEqual([`dream:${summary.id}`]);
    expect(events[0]!.body).toContain("3 op(s)");
    expect(events[0]!.body).not.toContain("Cobalt");

    // Read back.
    await engine.processCommand(ada, "memory dream log");
    expect(conn.lastText()).toContain(`#${summary.id}`);
    expect(conn.lastText()).toContain("3 ops · 1 rejected");
    conn.clear();
    await engine.processCommand(ada, `memory dream show ${summary.id}`);
    const shown = conn.lastText();
    expect(shown).toContain("Accepted ops");
    expect(shown).toContain(`merge      keep #${note(0)}`);
    expect(shown).toContain("taint:");
    expect(shown).not.toContain("Cobalt tests reset");
    conn.clear();
    await engine.processCommand(ada, `memory dream rollback ${summary.id}`);
    expect(conn.lastText()).toContain("Nothing to roll back");
    // Another entity cannot read it.
    const other = new MockConnection("c2");
    engine.addConnection(other);
    engine.spawnEntity("c2", "Bea");
    other.clear();
    await engine.processCommand(other.entity!, `memory dream show ${summary.id}`);
    expect(other.lastText()).toContain("No dream");
  });

  it("a dry run records and chronicles nothing; off runs nothing", async () => {
    const model = stubModel(JSON.stringify({ ops: [] }));
    {
      using _state = scopeProcessState({ env: { MARINA_DREAMING: undefined } });
      const dry = await runDream(db, "Ada", "dry-run", { complete: model.complete, now });
      expect(dry.state).toBe("dry-run");
      expect(dry.checks?.accepted).toBe(0);
      expect(db.listDreams("Ada")).toEqual([]);
      expect(db.queryChronicle({ kind: "event" }).some((e) => e.title === "memory.dream")).toBe(
        false,
      );
    }
    {
      using _state = scopeProcessState({ env: { MARINA_DREAMING: "off" } });
      expect(dreamingMode()).toBe("off");
      const off = await runDream(db, "Ada", "command", { complete: model.complete, now });
      expect(off).toMatchObject({ state: "skipped", skipped: "MARINA_DREAMING=off" });
      expect(model.calls).toHaveLength(1);
      expect(await runDreamSchedule(db, { complete: model.complete, now })).toEqual([]);
    }
  });

  it("the schedule gates: material, quiet and cooldown; the candidates are recent writers", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: undefined } });
    expect(dreamCandidates(db, now)).toEqual(["Ada"]);
    // Enough material (12 ≥ DREAM_MIN_NEW), never active, never dreamed: may dream.
    expect(NOTES.length).toBeGreaterThanOrEqual(DREAM_MIN_NEW);
    expect(scheduleGate(db, "Ada", now)).toBeUndefined();
    // A recent tool call: quiet gate.
    db.memoryRepository().raw.run(
      `INSERT INTO primitive_usage (actor_name, actor_kind, source, primitive, action, safe_label, created_at)
       VALUES ('Ada', 'agent', 'ws', 'note', 'create', 'note', ?)`,
      [now - 5 * 60_000],
    );
    expect(scheduleGate(db, "Ada", now)).toMatch(/^quiet:/);
    expect(scheduleGate(db, "Ada", now + HOUR)).toBeUndefined();
    // A dream now: cooldown, then material counts from the dream.
    const model = stubModel(JSON.stringify({ ops: [] }));
    const first = await runDream(db, "Ada", "schedule", {
      complete: model.complete,
      now: now + HOUR,
    });
    expect(first.state).toBe("observed");
    expect(scheduleGate(db, "Ada", now + 2 * HOUR)).toMatch(/^cooldown:/);
    expect(scheduleGate(db, "Ada", now + HOUR + DREAM_COOLDOWN_MS)).toMatch(/^material: 0 new/);
    const skipped = await runDreamSchedule(db, {
      complete: model.complete,
      now: now + HOUR + DREAM_COOLDOWN_MS,
    });
    expect(skipped.map((s) => s.state)).toEqual(["skipped"]);
    expect(model.calls).toHaveLength(1);
    // Nobody else qualifies.
    expect(scheduleGate(db, "Bea", now)).toMatch(/^material:/);
  });

  it("faithfulness holds numbers, identifiers and names, not wording", () => {
    const src = "The amber deployment listens on port 8443 behind the staging proxy at build v2.3";
    expect(faithfulTo("Amber listens on 8443 behind the staging proxy (build v2.3)", src)).toBe(
      true,
    );
    expect(faithfulTo("Amber listens on 9443 behind the staging proxy", src)).toBe(false);
    expect(faithfulTo("Amber listens on port 8443 behind the Indigo proxy", src)).toBe(false);
    expect(faithfulTo("The deployment is reachable through the proxy", src)).toBe(true);
    expect(faithfulTo("Pinned at v2.4", src)).toBe(false);
  });

  it("probe queries are the record's longest distinct words", () => {
    expect(probeQuery("The amber deployment listens on port 8443 behind the staging proxy")).toBe(
      "deployment listens staging behind",
    );
    expect(probeQuery("a an the")).toBe("");
  });
});
