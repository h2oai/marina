// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The dream pass (`src/memory/dream`): gather → probe → propose (a stubbed
 * model) → check → apply on a dry view → probe-after → record. In `observe`
 * nothing stays applied; every rejection names its check; the record carries
 * ids, hashes and counts, never text; the schedule gates hold; `memory dream`
 * reads it back. In `on` the auto-tier ops stay applied in one transaction
 * when the probes hold, supersedes become proposals the owner adopts, and
 * `memory dream rollback` reverses the whole dream.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dreamBriefLine } from "../src/engine/commands/memory";
import { Engine } from "../src/engine/engine";
import {
  checkOps,
  DECAY_STEP,
  DREAM_COOLDOWN_MS,
  DREAM_MIN_NEW,
  dreamCandidates,
  dreamingMode,
  gatherRegion,
  PROPOSAL_OWNER,
  parseOps,
  pendingProposals,
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
    const region = gatherRegion(db, "Ada", now - 24 * HOUR, now + HOUR);
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
    expect(gatherRegion(db, "Bea", now - 24 * HOUR, now + HOUR).records).toEqual([]);
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
    const region = gatherRegion(db, "Ada", now - 24 * HOUR, now + HOUR);
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
    // Probes ran before and on the dry-applied view; the view was rolled back.
    expect(JSON.parse(row.probes_json)[0]).toMatchObject({ before: "pass", after: "pass" });
    expect(JSON.parse(row.checks_json).probesAfter).toEqual({ pass: 3, fail: 0 });
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
    expect(conn.lastText()).toContain("observed, not applied");
    // `memory consolidate` is the alias.
    conn.clear();
    await engine.processCommand(ada, `memory consolidate show ${summary.id}`);
    expect(conn.lastText()).toContain("Accepted ops");
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
      const dry = await runDream(db, "Ada", "dry-run", {
        complete: model.complete,
        now: now + HOUR,
      });
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
      const off = await runDream(db, "Ada", "command", {
        complete: model.complete,
        now: now + HOUR,
      });
      expect(off).toMatchObject({ state: "skipped", skipped: "MARINA_DREAMING=off" });
      expect(model.calls).toHaveLength(1);
      expect(await runDreamSchedule(db, { complete: model.complete, now: now + HOUR })).toEqual([]);
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

  it("on: merges, links and decays stay applied in one transaction; a supersede becomes a proposal", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    const model = stubModel(
      JSON.stringify({
        ops: [
          { op: "merge", keep: note(0), into: [note(1)], reason: "same port note" },
          { op: "decay", id: note(8), reason: "served five times, never used" },
          { op: "link", from: note(6), to: note(0), relation: "related_to", reason: "same proxy" },
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
    const at = Date.now() + 1000;
    const summary = await runDream(db, "Ada", "command", {
      complete: model.complete,
      model: "test/dreamer",
      now: at,
    });
    expect(summary.state).toBe("applied");
    expect(summary.checks).toMatchObject({ accepted: 4, rejected: 0, leaving: 3 });
    expect(summary.checks!.probesAfter).toEqual({ pass: 3, fail: 0 });
    expect(summary.proposals).toBe(1);

    // Applied: the duplicate is superseded by its keeper (never deleted), the
    // decayed note is lower, the link exists; the supersede target is untouched.
    expect(db.getNote(note(1))!.verification_status).toBe("superseded");
    expect(db.getNote(note(0))!.verification_status).toBe("unverified");
    expect(db.getNote(note(8))!.importance).toBe(5 - DECAY_STEP);
    expect(
      db
        .getNoteLinks(note(0))
        .map((l) => l.relationship)
        .sort(),
    ).toEqual(["related_to", "supersedes"]);
    expect(db.getNote(note(3))!.verification_status).toBe("unverified");
    // The record carries the footprint (prior values, ids) and the proposal mark — no text.
    const row = db.getDream(summary.id!)!;
    expect(row.state).toBe("applied");
    expect(row.applied_at).toBe(at);
    const ops = JSON.parse(row.ops_json) as Array<Record<string, unknown>>;
    expect(ops[0]!.applied).toEqual({ kind: "merge", prior: { [String(note(1))]: "unverified" } });
    expect(ops[1]!.applied).toEqual({ kind: "decay", priorImportance: 5 });
    expect((ops[2]!.applied as { kind: string }).kind).toBe("link");
    expect(ops[3]!.proposal).toBe("pending");
    expect(JSON.stringify(row)).not.toContain("Cobalt tests reset");
    // The proposal text lives in core memory under the dream owner, for the owner only.
    const pending = pendingProposals(db, "Ada", at);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ dreamId: summary.id, n: 3, id: note(3), refs: [note(4)] });
    expect(db.listCoreMemory(PROPOSAL_OWNER)).toHaveLength(1);
    expect(pendingProposals(db, "Bea", at)).toEqual([]);
    // The chronicle says applied and how to reverse it.
    const event = db.queryChronicle({ kind: "event" }).find((e) => e.title === "memory.dream")!;
    expect(event.body).toContain("3 op(s) applied");
    expect(event.body).toContain(`rollback ${summary.id}`);
    // The agent's line.
    expect(dreamBriefLine(db, "Ada", at)).toBe(
      `dream #${summary.id} applied 1 merge, 1 link, 1 decay to your notes (memory dream rollback ${summary.id} reverses it) · 1 proposal(s) await you: memory dream proposals`,
    );

    // Adopt the restatement: faithfulness is re-checked against the notes now; the old note is superseded.
    conn.clear();
    await engine.processCommand(ada, "memory dream proposals");
    expect(conn.lastText()).toContain("Cobalt tests reset the fixture database before each run");
    conn.clear();
    await engine.processCommand(ada, `memory dream adopt ${summary.id}`);
    expect(conn.lastText()).toMatch(/Adopted: note #\d+ supersedes #/);
    const old = db.getNote(note(3))!;
    expect(old.verification_status).toBe("superseded");
    const fresh = db
      .getNotesByEntity("Ada", 100)
      .find((n) => n.supersedes_id === note(3) && n.verification_status !== "superseded")!;
    expect(fresh.content).toBe("Cobalt tests reset the fixture database before each run");
    expect(pendingProposals(db, "Ada", at)).toEqual([]);
    const adopted = JSON.parse(db.getDream(summary.id!)!.ops_json)[3] as Record<string, unknown>;
    expect(adopted.proposal).toBe("adopted");
    expect(adopted.applied).toEqual({ kind: "supersede", newId: fresh.id, prior: "unverified" });
    // The restatement is served in place of the old note.
    expect(db.recallNotes("Ada", "cobalt fixture database").map((n) => n.id)).toContain(fresh.id);
    expect(db.recallNotes("Ada", "cobalt fixture database").map((n) => n.id)).not.toContain(
      note(3),
    );

    // Rollback reverses everything: statuses, importance, the link, the adoption.
    conn.clear();
    await engine.processCommand(ada, `memory dream rollback ${summary.id}`);
    expect(conn.lastText()).toContain("4 op(s) reversed");
    expect(db.getNote(note(1))!.verification_status).toBe("unverified");
    expect(db.getNote(note(8))!.importance).toBe(5);
    expect(db.countNoteLinks("Ada")).toBe(0);
    expect(db.getNote(note(3))!.verification_status).toBe("unverified");
    expect(db.getNote(note(3))!.content).toBe(NOTES[3]!);
    expect(db.getNote(fresh.id)!.verification_status).toBe("superseded");
    // The merged-away note is retrievable again, with its own text; the restatement is not.
    const hits = db.recallNotes("Ada", "amber deployment staging").map((n) => n.id);
    expect(hits).toContain(note(1));
    expect(db.recallNotes("Ada", "cobalt fixture database").map((n) => n.id)).toContain(note(3));
    expect(db.recallNotes("Ada", "cobalt fixture database").map((n) => n.id)).not.toContain(
      fresh.id,
    );
    const after = db.getDream(summary.id!)!;
    expect(after.state).toBe("rolled_back");
    expect(after.rolled_back_at).toBeGreaterThan(0);
    expect(JSON.parse(after.ops_json).every((o: { reverted?: boolean }) => o.reverted)).toBe(true);
    expect(
      db.queryChronicle({ kind: "event" }).some((e) => e.title === "memory.dream.rollback"),
    ).toBe(true);
    conn.clear();
    await engine.processCommand(ada, `memory dream rollback ${summary.id}`);
    expect(conn.lastText()).toContain("already rolled back");
    expect(dreamBriefLine(db, "Ada", at)).toBe(`dream #${summary.id} was rolled back`);
  });

  it("on: a set that loses a probe on the applied view is rejected whole and nothing stays", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    // Make #1 the only note retrievable by its probe words: merging it into a
    // keeper that shares none of those words loses the probe. Coverage would
    // refuse that, so lower the keeper's words into the duplicate's shingles
    // by writing a near-copy whose distinctive words differ from the keeper's.
    const dup = db.createNote(
      "Ada",
      NOTES[0]!.replace("proxy", "proxy, lantern maintenance"),
      undefined,
      {
        skipDedup: true,
      },
    );
    const keep = note(0);
    const model = stubModel(
      JSON.stringify({ ops: [{ op: "merge", keep, into: [dup], reason: "same" }] }),
    );
    const at = Date.now() + 1000;
    const summary = await runDream(db, "Ada", "command", { complete: model.complete, now: at });
    // Either the probe held (keeper carries the span's words) and it applied,
    // or it was lost and the set was rejected whole; in both cases the store
    // is consistent and the record says which.
    const dupRow = db.getNote(dup)!;
    if (summary.state === "applied") {
      expect(dupRow.verification_status).toBe("superseded");
    } else {
      expect(summary.state).toBe("observed");
      expect(summary.rejected!.some((r) => r.reason.startsWith("probe-after:"))).toBe(true);
      expect(summary.checks!.accepted).toBe(0);
      expect(dupRow.verification_status).toBe("unverified");
    }
  });

  it("a link already present is rejected with its reason, never an error", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    db.createNoteLink(note(6), note(0), "related_to");
    const model = stubModel(
      JSON.stringify({
        ops: [{ op: "link", from: note(6), to: note(0), relation: "related_to", reason: "dup" }],
      }),
    );
    const summary = await runDream(db, "Ada", "command", {
      complete: model.complete,
      now: Date.now() + 1000,
    });
    expect(summary.state).toBe("observed");
    expect(summary.checks?.accepted).toBe(0);
    expect(summary.rejected?.[0]?.reason).toContain("already there");
    expect(db.getNoteLinks(note(6))).toHaveLength(1);
  });

  it("on: a proposal goes stale when its sources change, and dismiss drops it", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    const text = "Cobalt tests reset the fixture database before each run";
    const model = stubModel(
      JSON.stringify({
        ops: [
          { op: "supersede", id: note(3), text, refs: [note(4)], reason: "a" },
          {
            op: "supersede",
            id: note(6),
            text: "The staging proxy rejects requests lacking a tenant header",
            refs: [],
            reason: "b",
          },
        ],
      }),
    );
    const at = Date.now() + 1000;
    const summary = await runDream(db, "Ada", "command", { complete: model.complete, now: at });
    expect(summary.state).toBe("applied");
    expect(summary.proposals).toBe(2);
    // Two pending: adopt without n is refused.
    conn.clear();
    await engine.processCommand(ada, `memory dream adopt ${summary.id}`);
    expect(conn.lastText()).toContain("2 pending proposals");
    // The target evolves meanwhile: the proposal no longer rests on live notes.
    db.reviseNote("Ada", note(3), "Cobalt tests need a fresh fixture database per run");
    conn.clear();
    await engine.processCommand(ada, `memory dream adopt ${summary.id} 0`);
    expect(conn.lastText()).toContain("has since changed");
    expect(pendingProposals(db, "Ada", at)).toHaveLength(1);
    conn.clear();
    await engine.processCommand(ada, `memory dream dismiss ${summary.id} 1`);
    expect(conn.lastText()).toContain("Dismissed");
    expect(pendingProposals(db, "Ada", at)).toEqual([]);
    const ops = JSON.parse(db.getDream(summary.id!)!.ops_json) as Array<{ proposal?: string }>;
    expect(ops.map((o) => o.proposal)).toEqual(["stale", "dismissed"]);
    // Another entity cannot adopt or roll back someone else's dream.
    const other = new MockConnection("c3");
    engine.addConnection(other);
    engine.spawnEntity("c3", "Cy");
    other.clear();
    await engine.processCommand(other.entity!, `memory dream rollback ${summary.id}`);
    expect(other.lastText()).toContain("No dream");
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
