// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Skills from dreams (phase 4): the gather stage finds a command sequence
 * repeated across the owner's successful tasks (names from the usage ledger,
 * never arguments); a dream may `propose-skill` over it; the owner adopts it
 * as a DRAFT that is listed but never served until a `skill trial` wins or a
 * person verifies it; `skill compose` makes a draft too; rollback retires an
 * adopted draft; the trial promotes on a win and not otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import type { TrialDeps } from "../src/engine/evolution-trial";
import { resetGateContextForTests, setPrincipalResolver } from "../src/engine/gate-context";
import {
  createSkillTrialRole,
  renderSkillTrial,
  runSkillTrial,
  SKILL_TRIAL_VERIFIER,
  skillTrialRoleName,
  storedSkillTrial,
} from "../src/engine/skill-trial";
import {
  checkOps,
  createSkillDraft,
  gatherProcedures,
  gatherRegion,
  pendingProposals,
  procedureKey,
  runDream,
} from "../src/memory/dream";
import { coversProcedure, isSkillDraft, skillSlug } from "../src/memory/skill-draft";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = tempDbPath("test_memory_dream_skills.db");
const HOUR = 60 * 60 * 1000;
const FANOUT = ["recall", "pool recall", "note"];

describe("skills from dreams", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let ada: EntityId;
  // Taken per test, before its notes are written: a file-level clock left the notes
  // outside the dream window once a slow shard spent more than a second between them.
  let now = 0;

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
    for (const text of [
      "The amber deployment listens on port 8443 behind the staging proxy",
      "Cobalt tests need the fixture database reset before each run",
      "Lantern maintenance is scheduled for the first Monday of each month",
    ])
      db.createNote("Ada", text, undefined, { skipDedup: true });
  });

  afterEach(() => {
    resetGateContextForTests();
    db.close();
    cleanupDb(TEST_DB);
  });

  /** One task Ada claimed at `at`, ran `steps` in, and resolved (by default as a success). */
  const task = (steps: readonly string[], at: number, succeeded = true): number => {
    const id = db.createTask({ title: `task at ${at}`, creatorId: "c_x", creatorName: "Creator" });
    db.createTaskClaim(id, String(ada), "Ada");
    db.memoryRepository().raw.run("UPDATE task_claims SET claimed_at = ? WHERE task_id = ?", [
      at,
      id,
    ]);
    for (const [i, step] of steps.entries())
      db.recordPrimitiveUsage({
        actorName: "Ada",
        actorKind: "player",
        source: "command",
        primitive: "memory",
        action: step,
        safeLabel: step,
        success: true,
        meaningful: true,
        worldAction: true,
        createdAt: at + 1000 * (i + 1),
      });
    db.recordOutcomeRow(
      {
        subject: `task:${id}:Ada`,
        kind: "task",
        source: "task:verdict",
        domain: "task",
        owner: "Ada",
        succeeded,
        basis: "mechanical",
        refs: [`task:${id}`],
        resolvedAt: at + 60_000,
        now: at + 60_000,
      },
      [],
    );
    return id;
  };

  it("gathers a sequence repeated across two successful tasks; once, failed or covered does not count", () => {
    const t1 = task(FANOUT, now - 5 * HOUR);
    const t2 = task(FANOUT, now - 4 * HOUR);
    task(["web search", "note"], now - 3 * HOUR); // once
    task(["task claim", "code do"], now - 2 * HOUR, false); // a failure
    task(["task claim", "code do"], now - 1 * HOUR); // … so only one success
    const found = gatherProcedures(db, "Ada", now - 24 * HOUR, now);
    expect(found).toEqual([
      { key: procedureKey(FANOUT), steps: FANOUT, tasks: [t1, t2], outcomes: expect.any(Array) },
    ]);
    // Arguments never enter: only the ledger's labels.
    expect(JSON.stringify(found)).not.toContain("amber");
    // A skill that already covers the procedure takes it off the list.
    db.createNote(
      "Ada",
      "[Skill: fanout] when one keyword misses || Actions: recall <topic> ; pool recall <synonym> ; note the hit",
      undefined,
      { noteType: "skill" },
    );
    expect(gatherProcedures(db, "Ada", now - 24 * HOUR, now)).toEqual([]);
    expect(coversProcedure("recall x ; pool recall y ; note z", FANOUT)).toBe(true);
    expect(coversProcedure("note z ; recall x", FANOUT)).toBe(false);
  });

  it("checks: an unknown procedure, an empty name or an over-long description is rejected", () => {
    task(FANOUT, now - 5 * HOUR);
    task(FANOUT, now - 4 * HOUR);
    const region = gatherRegion(db, "Ada", now - 24 * HOUR, now);
    expect(region.procedures).toHaveLength(1);
    const key = region.procedures[0]!.key;
    const out = checkOps(
      [
        { op: "propose-skill", procedure: "0000", name: "x", description: "y", reason: "r" },
        { op: "propose-skill", procedure: key, name: "!!!", description: "y", reason: "r" },
        {
          op: "propose-skill",
          procedure: key,
          name: "ok",
          description: "y".repeat(201),
          reason: "r",
        },
        {
          op: "propose-skill",
          procedure: key,
          name: "Recall Fanout",
          description: "y",
          reason: "r",
        },
      ],
      region,
    );
    expect(out.accepted).toHaveLength(1);
    expect(out.rejected.map((r) => r.reason.split(":")[0])).toEqual([
      "procedure",
      "propose-skill",
      "propose-skill",
    ]);
    expect(out.leaving).toBe(0);
    expect(skillSlug("Recall Fanout")).toBe("recall-fanout");
  });

  it("on: a dream files a skill draft; adopt stores it unserved; a person's verify promotes it", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    task(FANOUT, now - 5 * HOUR);
    task(FANOUT, now - 4 * HOUR);
    const key = procedureKey(FANOUT);
    const at = now + 1000;
    const summary = await runDream(db, "Ada", "command", {
      now: at,
      model: "test/dreamer",
      complete: async () =>
        JSON.stringify({
          ops: [
            {
              op: "propose-skill",
              procedure: key,
              name: "Recall Fanout",
              description: "When one keyword misses, widen the recall before writing.",
              reason: "ran in two successful tasks",
            },
          ],
        }),
    });
    expect(summary.state).toBe("applied");
    expect(summary.proposals).toBe(1);
    const op = summary.ops![0]!;
    expect(op.op).toBe("propose-skill");
    expect(op).toMatchObject({ procedure: key, steps: 3, proposal: "pending" });
    // The row keeps ids, counts and hashes — never the drafted text.
    expect(JSON.stringify(summary.ops)).not.toContain("Recall Fanout");
    expect(db.getDream(summary.id!)!.ops_json).not.toContain("widen the recall");

    await engine.processCommand(ada, "memory dream proposals");
    expect(conn.lastText()).toContain('skill draft "recall-fanout"');
    expect(conn.lastText()).toContain("Actions: recall ; pool recall ; note");
    conn.clear();
    await engine.processCommand(ada, `memory dream adopt ${summary.id}`);
    expect(conn.lastText()).toMatch(/Adopted: skill draft #\d+ stored/);
    const draft = db.getNotesByType("Ada", "skill").find((n) => isSkillDraft(n.content))!;
    expect(draft.content).toBe(
      "[Skill draft: recall-fanout] When one keyword misses, widen the recall before writing. || Actions: recall ; pool recall ; note",
    );
    expect(pendingProposals(db, "Ada", at)).toEqual([]);
    const stored = JSON.parse(db.getDream(summary.id!)!.ops_json)[0] as Record<string, unknown>;
    expect(stored.proposal).toBe("adopted");
    expect(stored.applied).toEqual({ kind: "propose-skill", newId: draft.id });
    // The adoption settled the dreamer's opinion on this op kind.
    const ledger = db.listJudgeLedger({ surface: "dream", limit: 10 });
    expect(ledger.find((r) => r.subject === `dream:${summary.id}:0`)?.truth).not.toBeNull();

    // Listed as a draft; never served.
    conn.clear();
    await engine.processCommand(ada, "skill list");
    expect(conn.lastText()).toContain("[draft");
    conn.clear();
    await engine.processCommand(ada, "skill top recall fanout widen");
    expect(conn.lastText()).not.toContain("recall-fanout");

    // An agent cannot verify its own draft; a person can, and it becomes servable.
    setPrincipalResolver(() => "agent");
    conn.clear();
    await engine.processCommand(ada, `skill verify ${draft.id}`);
    expect(conn.lastText()).toContain("an agent cannot verify it");
    expect(db.getNote(draft.id)!.content).toStartWith("[Skill draft:");
    setPrincipalResolver(() => "person");
    conn.clear();
    await engine.processCommand(ada, `skill verify ${draft.id}`);
    const m = /verified as skill #(\d+)/.exec(conn.lastText());
    expect(m).not.toBeNull();
    const promoted = db.getNote(Number(m![1]))!;
    expect(promoted.content).toStartWith("[Skill: recall-fanout]");
    expect(promoted.verification_status).toBe("verified");
    expect(db.getNote(draft.id)!.verification_status).toBe("superseded");
    conn.clear();
    await engine.processCommand(ada, "skill top recall fanout widen");
    expect(conn.lastText()).toContain("[Skill: recall-fanout]");
    // A verified skill is never a dream's to touch, and the procedure is covered now.
    expect(gatherProcedures(db, "Ada", now - 24 * HOUR, now)).toEqual([]);
  });

  it("on: rollback retires an adopted draft; a dismissal is the owner's no", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    task(FANOUT, now - 5 * HOUR);
    task(FANOUT, now - 4 * HOUR);
    const key = procedureKey(FANOUT);
    const complete = async () =>
      JSON.stringify({
        ops: [
          { op: "propose-skill", procedure: key, name: "fanout", description: "d", reason: "r" },
        ],
      });
    const first = await runDream(db, "Ada", "command", { now: now + 1000, complete });
    await engine.processCommand(ada, `memory dream adopt ${first.id}`);
    const draft = db.getNotesByType("Ada", "skill").find((n) => isSkillDraft(n.content))!;
    conn.clear();
    await engine.processCommand(ada, `memory dream rollback ${first.id}`);
    expect(conn.lastText()).toContain("1 op(s) reversed");
    expect(db.getNote(draft.id)).toBeUndefined();
    expect(db.getNotesByType("Ada", "skill")).toEqual([]);
    expect(JSON.parse(db.getDream(first.id!)!.ops_json)[0].reverted).toBe(true);

    // Dismiss: the proposal goes, the ledger records a fail. (A dream's window
    // starts at the last dream, so the second needs fresh work and a fresh record.)
    task(FANOUT, now + 1 * HOUR);
    task(FANOUT, now + 2 * HOUR);
    const fresh = db.createNote("Ada", "Indigo alerts page the on-call engineer", undefined, {
      skipDedup: true,
    });
    db.memoryRepository().raw.run("UPDATE notes SET created_at = ? WHERE id = ?", [
      now + 2 * HOUR,
      fresh,
    ]);
    const second = await runDream(db, "Ada", "command", { now: now + 3 * HOUR, complete });
    expect(second.proposals).toBe(1);
    conn.clear();
    await engine.processCommand(ada, `memory dream dismiss ${second.id}`);
    expect(conn.lastText()).toContain("Dismissed proposal");
    expect(pendingProposals(db, "Ada", now + 3 * HOUR)).toEqual([]);
    const row = db
      .listJudgeLedger({ surface: "dream", limit: 10 })
      .find((r) => r.subject === `dream:${second.id}:0`)!;
    expect(row.truth).toBe("fail");
    expect(row.question).toBe("propose-skill");
  });

  it("skill compose makes a draft", async () => {
    await engine.processCommand(ada, "skill store one | first | recall <topic>");
    await engine.processCommand(ada, "skill store two | second | note the hit");
    const [a, b] = db
      .getNotesByType("Ada", "skill")
      .map((n) => n.id)
      .sort((x, y) => x - y);
    conn.clear();
    await engine.processCommand(ada, `skill compose ${a} ${b}`);
    expect(conn.lastText()).toMatch(/Composed skill draft #\d+ "one-two"/);
    expect(conn.lastText()).toContain("not served until validated");
    const draft = db.getNotesByType("Ada", "skill").find((n) => isSkillDraft(n.content))!;
    expect(draft.content).toBe(
      `[Skill draft: one-two] Composed from skills #${a}, #${b} || Actions: recall <topic> ; note the hit`,
    );
    conn.clear();
    await engine.processCommand(ada, "skill trial 999");
    expect(conn.lastText()).toContain("not found");
    conn.clear();
    await engine.processCommand(ada, `skill trial ${draft.id}`);
    expect(conn.lastText()).toContain("child or parallel world");
  });

  it("skill trial: the candidate carries the skill; a win promotes a draft, a loss leaves it", async () => {
    db.saveRole({
      name: "scout",
      description: "finds things",
      traits: [],
      guidelines: ["look before you leap"],
      focus: [],
      createdBy: "test",
    });
    const skillId = createSkillDraft(db, "Ada", { name: "fanout", description: "d" }, FANOUT)!;
    const spawned: Array<{ name: string; role: string; guidelines: string }> = [];
    const fakeDeps = (candidateScore: number, incumbentScore: number): TrialDeps => ({
      spawn: async (name, role) => {
        spawned.push({ name, role, guidelines: db.getRole(role)!.guidelines });
      },
      entityIdOf: (name) => `e_${name}`,
      subjectOf: (name) => ({ agent: name }),
      createModelChannel: () => {},
      deleteModelChannel: () => {},
      startBenchmark: (_model, subjects) => `run-${subjects[0]!.agent}`,
      runStatus: (id) => ({
        status: "completed",
        score: id.endsWith("c") ? candidateScore : incumbentScore,
        answered: 100,
        total: 100,
      }),
      stop: async () => {},
      sleep: async () => {},
      now: () => Date.now(),
    });
    const spec = {
      skillId,
      entityName: "Ada",
      incumbentRole: "scout",
      createdBy: "Ada",
      benchmark: "smoke",
      timeoutMs: 60_000,
    };
    const lost = await runSkillTrial(db, fakeDeps(0.4, 0.6), spec);
    expect(lost.verdict).toBe("loses");
    expect(lost.promoted).toBeUndefined();
    expect(db.getNote(skillId)!.content).toStartWith("[Skill draft:");
    expect(renderSkillTrial(lost)).toContain("still a draft");
    // The candidate ran on a copy of the role with the skill as a guideline; the copy is gone after.
    const cand = spawned.find((s) => s.name.endsWith("c"))!;
    expect(cand.role).toBe(skillTrialRoleName(skillId));
    expect(cand.guidelines).toContain("look before you leap");
    expect(cand.guidelines).toContain("[Skill draft: fanout]");
    expect(spawned.find((s) => s.name.endsWith("i"))!.role).toBe("scout");
    expect(db.getRole(skillTrialRoleName(skillId))).toBeUndefined();
    expect(storedSkillTrial(db, "Ada", skillId)?.verdict).toBe("loses");

    const won = await runSkillTrial(db, fakeDeps(0.9, 0.5), spec);
    expect(won.verdict).toBe("wins");
    const promoted = db.getNote(won.promoted!)!;
    expect(promoted.content).toBe("[Skill: fanout] d || Actions: recall ; pool recall ; note");
    expect(promoted.verification_status).toBe("verified");
    expect(db.getNoteVerifications(promoted.id)[0]?.verifier).toBe(SKILL_TRIAL_VERIFIER);
    expect(storedSkillTrial(db, "Ada", skillId)?.promoted).toBe(promoted.id);
    expect(renderSkillTrial(won)).toContain(`promoted: skill #${promoted.id}`);
    // Only roles that exist can be trialled.
    expect(() => createSkillTrialRole(db, 1, "x", db.getRole("scout")!, "Ada")).not.toThrow();
    db.deleteRole(skillTrialRoleName(1));
    await expect(
      runSkillTrial(db, fakeDeps(1, 0), { ...spec, incumbentRole: "nobody" }),
    ).rejects.toThrow("does not exist");
  });
});
