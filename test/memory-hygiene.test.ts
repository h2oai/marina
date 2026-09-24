// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Scheduled memory hygiene (Phase 1.6): consumes the durable review queue,
 * audits legacy notes, writes one process-tier line, and — on a LOCAL profile
 * only — files the first automatic evaluator job through the assistance
 * substrate. Two durable users: the owner whose space is reviewed and the
 * evaluator helper whose principal becomes the job's worker.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import {
  formatHygieneLine,
  HYGIENE_DISPATCH_THRESHOLD,
  HYGIENE_NOTE_PREFIX,
  HYGIENE_SPAWN_COMMAND,
  HYGIENE_TASK,
  HYGIENE_TASK_MARKER,
  hygieneAssistCommand,
  MEMORY_HYGIENE_PHASE,
  type MemoryHygieneDeps,
  runMemoryHygiene,
} from "../src/engine/memory-hygiene";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";
import { type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const OWNER = "Owner";
const HELPER = "Evaluator";
const OWNER_ID = "e_owner" as EntityId;
const T0 = 1_800_000_000_000; // fake clock — passed explicitly, no Date.now spying needed

let directory: string;
let db: MarinaDB;
let helperPrincipal: string;
let tells: { entity: EntityId; text: string }[];
let prevProfile: string | undefined;
let prevAutonomy: string | undefined;

const op = (name: string, request: MemoryOperationRequest) =>
  residentMemoryOperation(db, name, request);

async function remember(content: string, extra: Record<string, unknown> = {}) {
  const r = await op(OWNER, { operation: "remember", input: { content, ...extra } });
  return r.result as { id: string; version: number };
}

/** Seed `dependents` conclusions on one premise, then revise the premise so
 *  every dependent goes stale; plus two competing claims on one subject. */
async function seedReviewQueue(dependents: number) {
  const premise = await remember("premise: Amber deploys on port 7419");
  for (let i = 0; i < dependents; i++) {
    await remember(`conclusion ${i}: the health probe targets port 7419`, {
      depends_on: [premise.id],
    });
  }
  await op(OWNER, {
    operation: "revise",
    id: premise.id,
    input: { content: "premise: Amber deploys on port 7420", expected_version: 1 },
  });
  const claim = (value: string) => ({
    claim: { subject: "project:amber", predicate: "status", object: { kind: "literal", value } },
  });
  await remember("project:amber status active", claim("active"));
  await remember("project:amber status retired", claim("retired"));
}

function seedLegacyFindings() {
  // duplicate group (exact text twice — bypass write-path dedup on purpose)
  db.createNote(OWNER, "the deploy script lives in ops/deploy.sh", undefined, { skipDedup: true });
  db.createNote(OWNER, "the deploy script lives in ops/deploy.sh", undefined, { skipDedup: true });
  // overlong (> 700 chars)
  db.createNote(OWNER, `long ${"evidence ".repeat(100)}`, undefined, {});
  // unsupported empirical claim (percentage, no citation)
  db.createNote(OWNER, "Studies show the new cache is 40% faster", undefined, {});
  // a process-tier compaction note must be ignored by the auditor
  db.createNote(OWNER, `[compaction] ${"x".repeat(900)}`, undefined, { tier: "process" });
}

function deps(overrides: Partial<MemoryHygieneDeps> = {}): MemoryHygieneDeps {
  return {
    onlineEntities: () => [
      { id: OWNER_ID, name: OWNER },
      { id: "e_ghost" as EntityId, name: "Ghost" }, // online but no world account
    ],
    residentMemoryOperation: op,
    tell: (entity, text) => tells.push({ entity, text }),
    findRunningHelper: (role) =>
      role === "memory-evaluator" ? { name: HELPER, principalId: helperPrincipal } : undefined,
    ...overrides,
  };
}

const hygieneNotes = () =>
  db.getNotesByEntity(OWNER, 200).filter((n) => n.content.startsWith(HYGIENE_NOTE_PREFIX));

const ownerOpenJobs = async () =>
  (
    (await op(OWNER, { operation: "assist_jobs", input: { open: true } })).result as {
      jobs: { id: string; role: string; worker_id: string; requester_id: string }[];
    }
  ).jobs;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-hygiene-"));
  db = new MarinaDB(join(directory, "world.db"));
  db.createUser({ id: crypto.randomUUID(), name: OWNER });
  helperPrincipal = crypto.randomUUID();
  db.createUser({ id: helperPrincipal, name: HELPER });
  tells = [];
  prevProfile = process.env.MARINA_PROFILE;
  prevAutonomy = process.env.MARINA_AUTONOMY;
  delete process.env.MARINA_PROFILE;
  delete process.env.MARINA_AUTONOMY;
  resetTrustProfileForTests();
});

afterEach(() => {
  resetTrustProfileForTests();
  if (prevProfile === undefined) delete process.env.MARINA_PROFILE;
  else process.env.MARINA_PROFILE = prevProfile;
  if (prevAutonomy === undefined) delete process.env.MARINA_AUTONOMY;
  else process.env.MARINA_AUTONOMY = prevAutonomy;
  db.close();
  rmSync(directory, { recursive: true });
});

describe("runMemoryHygiene", () => {
  it("writes one process-tier hygiene line with durable + legacy counts and dedups it", async () => {
    await seedReviewQueue(2); // 2 stale + 2 competing = 4 < threshold → observe only
    seedLegacyFindings();
    const [report] = await runMemoryHygiene(db, deps(), T0);
    expect(report).toMatchObject({
      name: OWNER,
      stale: 2,
      competing: 2,
      duplicates: 1,
      overlong: 1,
      unsupported: 1,
      dispatched: false,
      notified: false,
    });
    const notes = hygieneNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.tier).toBe("process");
    expect(notes[0]!.content).toBe(
      "[hygiene] stale=2 competing=2 duplicates=1 overlong=1 unsupported=1",
    );
    expect(notes[0]!.id).toBe(report!.noteId!);
    // Unchanged state an hour later → no second note, no job, no tell.
    const [again] = await runMemoryHygiene(db, deps(), T0 + 3_600_000);
    expect(again!.noteId).toBeUndefined();
    expect(hygieneNotes()).toHaveLength(1);
    expect(await ownerOpenJobs()).toEqual([]);
    expect(tells).toEqual([]);
    // Entities without a world account are skipped silently.
    expect(db.getNotesByEntity("Ghost", 10)).toEqual([]);
  });

  it("on a LOCAL profile files exactly one evaluator job and records its id", async () => {
    setTrustProfile("local");
    await seedReviewQueue(4); // 4 stale + 2 competing = 6 ≥ threshold
    expect(HYGIENE_DISPATCH_THRESHOLD).toBe(5);

    const [first] = await runMemoryHygiene(db, deps(), T0);
    expect(first!.dispatched).toBe(true);
    expect(first!.notified).toBe(false);
    expect(first!.jobId).toBeDefined();
    const jobs = await ownerOpenJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: first!.jobId,
      role: "evaluator",
      worker_id: helperPrincipal,
      requester_id: db.getUserByName(OWNER)!.id,
    });
    const full = (await op(OWNER, { operation: "assist_get", id: first!.jobId! })).result as {
      task: string;
      remaining_operations: number;
      deadline: number;
    };
    expect(full.task).toBe(HYGIENE_TASK);
    expect(full.task.startsWith(HYGIENE_TASK_MARKER)).toBe(true);
    expect(full.remaining_operations).toBe(32);
    expect(full.deadline - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(hygieneNotes()[0]!.content).toBe(
      formatHygieneLine({
        stale: 4,
        competing: 2,
        duplicates: 0,
        overlong: 0,
        unsupported: 0,
        jobId: first!.jobId,
      }),
    );
    // The helper sees the work in its own open queue.
    const helperJobs = (
      (await op(HELPER, { operation: "assist_jobs", input: { open: true } })).result as {
        jobs: { id: string }[];
      }
    ).jobs;
    expect(helperJobs.map((j) => j.id)).toEqual([first!.jobId as string]);

    // Second run: the open hygiene job is found, NOT duplicated; the line is
    // identical (same counts, same job id) so no second note either.
    const [second] = await runMemoryHygiene(db, deps(), T0 + 3_600_000);
    expect(second!.dispatched).toBe(false);
    expect(second!.jobId).toBe(first!.jobId);
    expect(second!.noteId).toBeUndefined();
    expect(await ownerOpenJobs()).toHaveLength(1);
    expect(hygieneNotes()).toHaveLength(1);
    expect(tells).toEqual([]);
  });

  it("counts contradictions parked under await_confirmation (pending) toward the threshold", async () => {
    setTrustProfile("local");
    await seedReviewQueue(2); // 2 stale + 2 competing = 4 < threshold on their own
    const [before] = await runMemoryHygiene(db, deps(), T0);
    expect(before).toMatchObject({ stale: 2, competing: 2, pending: 0, dispatched: false });
    expect(await ownerOpenJobs()).toEqual([]);

    // Park the competing pair: it stays competing AND becomes pending → 6 ≥ 5.
    const competing = (
      (await op(OWNER, { operation: "review", input: { kind: "competing", limit: 10 } }))
        .result as {
        items: { record: { id: string } }[];
      }
    ).items.map((i) => i.record.id);
    expect(competing).toHaveLength(2);
    await op(OWNER, {
      operation: "resolve",
      id: competing[0]!,
      input: {
        policy: "await_confirmation",
        competing: [competing[1]!],
        rationale: "ask the deploy owner",
        deadline_ms: 3_600_000,
      },
    });
    const [after] = await runMemoryHygiene(db, deps(), T0 + 3_600_000);
    expect(after).toMatchObject({ stale: 2, competing: 2, pending: 2, dispatched: true });
    expect(after!.jobId).toBeDefined();
    expect(await ownerOpenJobs()).toHaveLength(1);
    expect(hygieneNotes()[0]!.content).toBe(
      formatHygieneLine({
        stale: 2,
        competing: 2,
        pending: 2,
        duplicates: 0,
        overlong: 0,
        unsupported: 0,
        jobId: after!.jobId,
      }),
    );
    expect(hygieneNotes()[0]!.content).toContain("pending=2");
    // The shared-profile notice names the parked count too.
    setTrustProfile("shared");
    await op(OWNER, { operation: "assist_cancel", id: after!.jobId! });
    await runMemoryHygiene(db, deps(), T0 + 7_200_000);
    expect(tells.at(-1)!.text).toContain("(2 pending confirmation)");
  });

  it("on a SHARED profile never files the job — it tells the owner the exact command", async () => {
    // Process default is `shared`; make it explicit for the reader.
    setTrustProfile("shared");
    await seedReviewQueue(4);
    const [report] = await runMemoryHygiene(db, deps(), T0);
    expect(report!.dispatched).toBe(false);
    expect(report!.jobId).toBeUndefined();
    expect(report!.notified).toBe(true);
    expect(await ownerOpenJobs()).toEqual([]);
    expect(tells).toHaveLength(1);
    expect(tells[0]!.entity).toBe(OWNER_ID);
    expect(tells[0]!.text).toContain("4 stale and 2 competing");
    expect(tells[0]!.text).toContain(hygieneAssistCommand(HELPER));
    expect(tells[0]!.text).toContain(`memory assist evaluator ${HELPER} ${HYGIENE_TASK}`);
    expect(hygieneNotes()[0]!.content).toBe(
      "[hygiene] stale=4 competing=2 duplicates=0 overlong=0 unsupported=0",
    );
    // Same state next hour → not re-announced.
    await runMemoryHygiene(db, deps(), T0 + 3_600_000);
    expect(tells).toHaveLength(1);
    // PUBLIC behaves like SHARED.
    setTrustProfile("public");
    await remember("conclusion extra: yet another stale dependent", {
      depends_on: [(await remember("another premise")).id],
    });
    const [pub] = await runMemoryHygiene(db, deps(), T0 + 7_200_000);
    expect(pub!.dispatched).toBe(false);
    expect(await ownerOpenJobs()).toEqual([]);
  });

  it("with no evaluator running, notifies with the spawn command instead (any profile)", async () => {
    setTrustProfile("local");
    await seedReviewQueue(4);
    const [report] = await runMemoryHygiene(db, deps({ findRunningHelper: () => undefined }), T0);
    expect(report!.dispatched).toBe(false);
    expect(report!.notified).toBe(true);
    expect(await ownerOpenJobs()).toEqual([]);
    expect(tells).toHaveLength(1);
    expect(tells[0]!.text).toContain("No memory-evaluator is running");
    expect(tells[0]!.text).toContain(HYGIENE_SPAWN_COMMAND);
    expect(HYGIENE_SPAWN_COMMAND).toBe(
      "agent spawn Evaluator model marina/default role memory-evaluator budget 40",
    );
  });

  it("survives a failing durable operation for one entity without aborting the pass", async () => {
    const warnings: string[] = [];
    const [report] = await runMemoryHygiene(
      db,
      deps({
        residentMemoryOperation: async () => {
          throw new Error("service offline");
        },
        warn: (m) => warnings.push(m),
      }),
      T0,
    );
    // Review counts degrade to 0; the legacy audit and the note still happen.
    expect(report).toMatchObject({ stale: 0, competing: 0, dispatched: false });
    expect(hygieneNotes()).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("runs on its own hourly phase, distinct from the other hourly jobs", () => {
    expect(MEMORY_HYGIENE_PHASE).toBe(2700);
  });
});

describe("orient shows the latest hygiene line", () => {
  it("renders the most recent [hygiene] note with its age", async () => {
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", OWNER);
    await seedReviewQueue(1);
    await runMemoryHygiene(db, deps({ onlineEntities: () => [{ id: conn.entity!, name: OWNER }] }));
    conn.clear();
    engine.processCommand(conn.entity!, "orient");
    const out = stripAnsi(conn.allTextJoined());
    expect(out).toContain("Hygiene: stale=1 competing=2 duplicates=0 overlong=0 unsupported=0");
    expect(out).toMatch(/Hygiene: .*\d+m ago/);
  });
});
