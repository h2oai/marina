// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory dispatch (Phase 3.2): the accumulation → reflector trigger, the
 * low-standing shared-write → evaluator trigger, and the versioned re-seed
 * of the three helper roles (Phase 3.1). Two durable users per scenario —
 * the owner/writer whose space receives the job and the helper whose
 * principal becomes the worker. Fake clocks throughout; no model calls.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isOperatorEditedRole,
  MEMORY_HELPER_CURATOR_DUTIES,
  MEMORY_HELPER_GUIDELINES_VERSION,
  MEMORY_HELPER_PROTOCOL_GUIDELINES,
  memoryHelperRoleDefinition,
  readGuidelinesVersion,
  seedMemoryHelperRoles,
  stampGuidelinesVersion,
} from "../src/agent/memory-helper-roles";
import { Engine } from "../src/engine/engine";
import {
  ACCUMULATION_NOTE_PREFIX,
  ACCUMULATION_NOTIFY_COOLDOWN_MS,
  ACCUMULATION_TASK_MARKER,
  ACCUMULATION_TRIGGER_NOTES,
  ACCUMULATION_WINDOW_MS,
  accumulationNotifyKey,
  clusterNotesByTopic,
  createDispatchState,
  DISPATCH_STATE_OWNER,
  dispatchSharedWriteReview,
  engineSharedWriteHook,
  formatAccumulationReceipt,
  helperSpawnCommand,
  isMemoryAccumulationTick,
  LOW_STANDING_WRITE_THRESHOLD,
  MEMORY_ACCUMULATION_PHASE,
  type MemoryDispatchDeps,
  type MemoryDispatchState,
  parseAccumulationReceipt,
  runAccumulationDispatch,
  SHARED_WRITE_DEBOUNCE_MS,
  SHARED_WRITE_REVIEW_MARKER,
  sharedWriteDebounceKey,
} from "../src/engine/memory-dispatch";
import { MEMORY_HYGIENE_PHASE } from "../src/engine/memory-hygiene";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB, type NoteRow } from "../src/persistence/database";
import { MEMORY_HELPER_INSTRUCTIONS } from "../src/sdk/memory-assistance";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";
import { type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const OWNER = "Owner";
const OWNER_ID = "e_owner" as EntityId;
const REFLECTOR = "Reflector";
const EVALUATOR = "Evaluator";
const POOL = "commons";
const HOUR = 3_600_000;

let directory: string;
let db: MarinaDB;
let reflectorPrincipal: string;
let evaluatorPrincipal: string;
let tells: { entity: EntityId; text: string }[];
let standings: Map<string, number>;
let state: MemoryDispatchState;
let prevProfile: string | undefined;
let prevAutonomy: string | undefined;

const op = (name: string, request: MemoryOperationRequest) =>
  residentMemoryOperation(db, name, request);

function deps(overrides: Partial<MemoryDispatchDeps> = {}): MemoryDispatchDeps {
  return {
    onlineEntities: () => [
      { id: OWNER_ID, name: OWNER },
      { id: "e_ghost" as EntityId, name: "Ghost" }, // online, no world account
    ],
    residentMemoryOperation: op,
    tell: (entity, text) => tells.push({ entity, text }),
    findRunningHelper: (role) => {
      if (role === "memory-reflector") return { name: REFLECTOR, principalId: reflectorPrincipal };
      if (role === "memory-evaluator") return { name: EVALUATOR, principalId: evaluatorPrincipal };
      return undefined;
    },
    standing: (entity) => standings.get(entity) ?? 0,
    ...overrides,
  };
}

/** `memory jobs {"open":true}` as the owner sees it. */
const openJobs = async (name = OWNER) =>
  (
    (await op(name, { operation: "assist_jobs", input: { open: true } })).result as {
      jobs: { id: string; role: string; worker_id: string; requester_id: string }[];
    }
  ).jobs;

const jobTask = async (id: string) =>
  ((await op(OWNER, { operation: "assist_get", id })).result as { task: string }).task;

const receipts = () =>
  db.getNotesByEntity(OWNER, 200).filter((n) => n.content.startsWith(ACCUMULATION_NOTE_PREFIX));

/** N fact-tier notes that share the topic terms "amber" + "deploy". */
function seedAccumulation(n: number, topic = "amber deploy") {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      db.createNote(
        OWNER,
        `${topic} observation ${i}: the rollout touched service-${i}`,
        undefined,
        {
          skipDedup: true,
        },
      ),
    );
  }
  return ids;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-dispatch-"));
  db = new MarinaDB(join(directory, "world.db"));
  db.createUser({ id: crypto.randomUUID(), name: OWNER });
  reflectorPrincipal = crypto.randomUUID();
  db.createUser({ id: reflectorPrincipal, name: REFLECTOR });
  evaluatorPrincipal = crypto.randomUUID();
  db.createUser({ id: evaluatorPrincipal, name: EVALUATOR });
  db.createMemoryPool(crypto.randomUUID(), POOL, OWNER);
  tells = [];
  standings = new Map();
  state = createDispatchState();
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

describe("accumulation → reflector", () => {
  it("files ONE reflector job for ≥N same-topic notes, never a second, and the job is cancellable", async () => {
    expect(ACCUMULATION_TRIGGER_NOTES).toBe(8);
    const ids = seedAccumulation(ACCUMULATION_TRIGGER_NOTES);
    const now = Date.now();
    const [report] = await runAccumulationDispatch(db, deps(), state, now);
    expect(report).toMatchObject({
      name: OWNER,
      windowNotes: 8,
      clusterSize: 8,
      dispatched: true,
      notified: false,
    });
    expect(report!.topic).toContain("amber");
    // Visible in `memory jobs` for the owner AND the helper, with the marker.
    const jobs = await openJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: report!.jobId,
      role: "reflector",
      worker_id: reflectorPrincipal,
      requester_id: db.getUserByName(OWNER)!.id,
    });
    expect((await openJobs(REFLECTOR)).map((j) => j.id)).toEqual([report!.jobId as string]);
    const task = await jobTask(report!.jobId!);
    expect(task.startsWith(ACCUMULATION_TASK_MARKER)).toBe(true);
    expect(task).toContain(`Consolidate these ${ids.length} notes about`);
    for (const id of ids) expect(task).toContain(String(id));
    expect(task).toContain("never rewrite");
    // Durable receipt, process tier, records the highest note id handed over.
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]!.tier).toBe("process");
    expect(receipts()[0]!.content).toContain(`max_note=${Math.max(...ids)}`);
    expect(receipts()[0]!.content).toContain(`job=${report!.jobId}`);

    // Second hour: same notes → not refiled (durable dedup fires first).
    const [second] = await runAccumulationDispatch(db, deps(), state, now + HOUR);
    expect(second).toMatchObject({ dispatched: false, skipped: "already-dispatched" });
    expect(await openJobs()).toHaveLength(1);

    // The owner withdraws it like any assistance request — still no refile
    // for the SAME notes afterwards.
    await op(OWNER, { operation: "assist_cancel", id: report!.jobId! });
    expect(await openJobs()).toEqual([]);
    const [third] = await runAccumulationDispatch(db, deps(), state, now + 2 * HOUR);
    expect(third).toMatchObject({ dispatched: false, skipped: "already-dispatched" });
    expect(receipts()).toHaveLength(1);
    expect(tells).toEqual([]);
    // Entities without a world account are skipped silently.
    expect(db.getNotesByEntity("Ghost", 10)).toEqual([]);
  });

  it("respects the 24h window and skips below N", async () => {
    seedAccumulation(ACCUMULATION_TRIGGER_NOTES);
    // Everything older than the window → nothing to consolidate.
    const later = Date.now() + ACCUMULATION_WINDOW_MS + 60_000;
    const [aged] = await runAccumulationDispatch(db, deps(), state, later);
    expect(aged).toMatchObject({ windowNotes: 0, dispatched: false, skipped: "below-threshold" });
    expect(await openJobs()).toEqual([]);

    // One short of N inside the window → skipped.
    db.close();
    rmSync(directory, { recursive: true });
    directory = mkdtempSync(join(tmpdir(), "marina-dispatch-"));
    db = new MarinaDB(join(directory, "world.db"));
    db.createUser({ id: crypto.randomUUID(), name: OWNER });
    db.createUser({ id: reflectorPrincipal, name: REFLECTOR });
    seedAccumulation(ACCUMULATION_TRIGGER_NOTES - 1);
    const [few] = await runAccumulationDispatch(db, deps(), state, Date.now());
    expect(few).toMatchObject({ windowNotes: 7, dispatched: false, skipped: "below-threshold" });
    expect(await openJobs()).toEqual([]);
    expect(receipts()).toEqual([]);
  });

  it("needs a shared topic — N unrelated notes do not cluster", async () => {
    // Eight notes with NO term in common (every word is unique to its note).
    const lines = [
      "alpha kettle whistles",
      "bravo garden fence",
      "charlie violin tuning",
      "delta harbour tide",
      "echo mountain cabin",
      "foxtrot bakery sourdough",
      "golf lantern battery",
      "hotel stairwell paint",
    ];
    for (const line of lines) db.createNote(OWNER, line, undefined, {});
    const [report] = await runAccumulationDispatch(db, deps(), state, Date.now());
    expect(report!.windowNotes).toBe(8);
    expect(report!.clusterSize).toBeLessThan(ACCUMULATION_TRIGGER_NOTES);
    expect(report!.dispatched).toBe(false);
    expect(await openJobs()).toEqual([]);
  });

  it("ignores pool, process-tier and superseded notes when counting the window", async () => {
    seedAccumulation(ACCUMULATION_TRIGGER_NOTES - 2);
    const pool = db.getMemoryPool(POOL)!;
    db.createNote(OWNER, "amber deploy pool remark", undefined, { poolId: pool.id });
    db.createNote(OWNER, "[compaction] amber deploy summary", undefined, { tier: "process" });
    const old = db.createNote(OWNER, "amber deploy old remark", undefined, {
      verificationStatus: "superseded",
    });
    db.createNote(OWNER, "amber deploy corrected remark", undefined, { supersedesId: old });
    const [report] = await runAccumulationDispatch(db, deps(), state, Date.now());
    // 6 seeded + 1 corrected = 7 live fact-like personal notes → below N.
    expect(report!.windowNotes).toBe(7);
    expect(report!.dispatched).toBe(false);
  });

  it("with no reflector running notifies once per day with the spawn command (files nothing)", async () => {
    setTrustProfile("shared");
    seedAccumulation(ACCUMULATION_TRIGGER_NOTES);
    const now = Date.now();
    const noHelper = deps({ findRunningHelper: () => undefined });
    const [first] = await runAccumulationDispatch(db, noHelper, state, now);
    expect(first).toMatchObject({ dispatched: false, notified: true, skipped: "no-helper" });
    expect(tells).toHaveLength(1);
    expect(tells[0]!.entity).toBe(OWNER_ID);
    expect(tells[0]!.text).toContain("No memory-reflector is running");
    expect(tells[0]!.text).toContain(helperSpawnCommand("reflector"));
    expect(helperSpawnCommand("reflector")).toBe(
      "agent spawn Reflector model marina/default role memory-reflector budget 40",
    );
    expect(await openJobs()).toEqual([]);
    expect(receipts()).toEqual([]);
    // Same day → silent (the cooldown, not the window: notes are still inside it).
    const [again] = await runAccumulationDispatch(db, noHelper, state, now + HOUR);
    expect(again!).toMatchObject({ notified: false, skipped: "no-helper", clusterSize: 8 });
    expect(tells).toHaveLength(1);
    // Cooldown elapsed (the window and the cooldown are both 24h, so age the
    // last notification rather than the clock — the notes must stay in-window).
    state.notified.set(accumulationNotifyKey(OWNER), now - ACCUMULATION_NOTIFY_COOLDOWN_MS - 1);
    const [nextDay] = await runAccumulationDispatch(db, noHelper, state, now + HOUR);
    expect(nextDay!.notified).toBe(true);
    expect(tells).toHaveLength(2);
    // Once a reflector is up, a SHARED profile files the job (not just a hint).
    const [filed] = await runAccumulationDispatch(db, deps(), state, now + 2 * HOUR);
    expect(filed!.dispatched).toBe(true);
    expect(await openJobs()).toHaveLength(1);
  });

  it("the once-a-day notification survives a restart (durable stamp, cache read-through)", async () => {
    setTrustProfile("shared");
    seedAccumulation(ACCUMULATION_TRIGGER_NOTES);
    const now = Date.now();
    const noHelper = deps({ findRunningHelper: () => undefined });
    const [first] = await runAccumulationDispatch(db, noHelper, state, now);
    expect(first).toMatchObject({ notified: true, skipped: "no-helper" });
    expect(tells).toHaveLength(1);
    // The stamp is a core-memory row owned by the system namespace, keyed by
    // the entity NAME (ids are re-minted per login) — never by anyone's login.
    const row = db.getCoreMemory(DISPATCH_STATE_OWNER, accumulationNotifyKey(OWNER));
    expect(row?.value).toBe(String(now));
    expect(db.listCoreMemory(OWNER)).toEqual([]);
    // "Restart": a brand-new in-process state against the same DB.
    const rebooted = createDispatchState();
    expect(rebooted.notified.size).toBe(0);
    const [again] = await runAccumulationDispatch(db, noHelper, rebooted, now + HOUR);
    expect(again).toMatchObject({ notified: false, skipped: "no-helper" });
    expect(tells).toHaveLength(1);
    // The miss populated the cache; subsequent reads never touch the DB.
    expect(rebooted.notified.get(accumulationNotifyKey(OWNER))).toBe(now);
    // Past the cooldown the fresh process notifies again and re-stamps. The
    // window and the cooldown are both 24h, so age the DURABLE stamp rather
    // than the clock (the notes must stay in-window) — a fresh process must
    // read the row, not a cache it does not have.
    db.setCoreMemory(
      DISPATCH_STATE_OWNER,
      accumulationNotifyKey(OWNER),
      String(now - ACCUMULATION_NOTIFY_COOLDOWN_MS - 1),
    );
    const [nextDay] = await runAccumulationDispatch(
      db,
      noHelper,
      createDispatchState(),
      now + HOUR,
    );
    expect(nextDay!.notified).toBe(true);
    expect(tells).toHaveLength(2);
    expect(db.getCoreMemory(DISPATCH_STATE_OWNER, accumulationNotifyKey(OWNER))?.value).toBe(
      String(now + HOUR),
    );
  });

  it("receipt notes round-trip through format/parse (orient reads them)", () => {
    const receipt = { jobId: "job-42", topic: "amber deploy", notes: 8, maxNote: 917 };
    const line = formatAccumulationReceipt(receipt);
    expect(line).toBe("[accumulation] job=job-42 topic=amber deploy notes=8 max_note=917");
    expect(parseAccumulationReceipt(line)).toEqual(receipt);
    expect(parseAccumulationReceipt("[accumulation] malformed")).toBeUndefined();
    expect(parseAccumulationReceipt("[hygiene] stale=1")).toBeUndefined();
  });

  it("clusters deterministically by the most shared term", () => {
    const note = (id: number, content: string): NoteRow =>
      ({
        id,
        entity_name: OWNER,
        room_id: null,
        content,
        importance: 5,
        last_accessed: null,
        note_type: "observation",
        pool_id: null,
        supersedes_id: null,
        tier: "fact",
        created_at: 0,
      }) as NoteRow;
    const notes = [
      note(1, "Amber deploy uses port 7419"),
      note(2, "the amber health probe targets the deploy"),
      note(3, "Amber rollout finished"),
      note(4, "unrelated grocery list"),
    ];
    const cluster = clusterNotesByTopic(notes)!;
    expect(cluster.topic).toBe("amber deploy");
    expect(cluster.notes.map((n) => n.id)).toEqual([1, 2, 3]);
    // Same input, same answer; reversed input, same answer.
    expect(clusterNotesByTopic([...notes].reverse())!.topic).toBe("amber deploy");
    expect(clusterNotesByTopic([note(9, "nothing shared here")])).toBeUndefined();
  });

  it("runs on its own hourly phase, distinct from hygiene and the other hourly jobs", () => {
    expect(MEMORY_ACCUMULATION_PHASE).toBe(900);
    expect(MEMORY_ACCUMULATION_PHASE).not.toBe(MEMORY_HYGIENE_PHASE);
    expect(isMemoryAccumulationTick(900)).toBe(true);
    expect(isMemoryAccumulationTick(3600 + 900)).toBe(true);
    for (const other of [0, 600, 1200, 1800, 2400, 2700, 3000, 3300, 3600]) {
      expect(isMemoryAccumulationTick(other)).toBe(false);
    }
  });
});

describe("low-standing shared write → evaluator", () => {
  const write = (noteId = 1, content = "Studies show the cache is 40% faster now") => ({
    entity: OWNER_ID,
    name: OWNER,
    poolName: POOL,
    noteId,
    content,
  });

  it("files ONE silent evaluator job against the writer's own space; visible and cancellable", async () => {
    setTrustProfile("shared");
    expect(LOW_STANDING_WRITE_THRESHOLD).toBe(5);
    standings.set(OWNER_ID, 2); // below rank 1
    const now = Date.now();
    const report = await dispatchSharedWriteReview(db, deps(), state, write(41), now);
    expect(report.dispatched).toBe(true);
    const jobs = await openJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: report.jobId,
      role: "evaluator",
      worker_id: evaluatorPrincipal,
      requester_id: db.getUserByName(OWNER)!.id,
    });
    expect((await openJobs(EVALUATOR)).map((j) => j.id)).toEqual([report.jobId as string]);
    const task = await jobTask(report.jobId!);
    expect(task.startsWith(SHARED_WRITE_REVIEW_MARKER)).toBe(true);
    expect(task).toContain(`shared pool "${POOL}"`);
    expect(task).toContain("#41");
    expect(task).toContain("untrusted data");
    expect(task).toContain("Studies show the cache is 40% faster now");
    // Silent review: the writer is never told.
    expect(tells).toEqual([]);
    // Cancellable like any request.
    await op(OWNER, { operation: "assist_cancel", id: report.jobId! });
    expect(await openJobs()).toEqual([]);
  });

  it("skips a writer with sufficient standing", async () => {
    setTrustProfile("shared");
    standings.set(OWNER_ID, LOW_STANDING_WRITE_THRESHOLD);
    const report = await dispatchSharedWriteReview(db, deps(), state, write(), Date.now());
    expect(report).toMatchObject({ dispatched: false, skipped: "sufficient-standing" });
    expect(await openJobs()).toEqual([]);
  });

  it("debounces to one review per writer per hour, then re-files for a new deposit", async () => {
    setTrustProfile("shared");
    standings.set(OWNER_ID, 0);
    const now = Date.now();
    const first = await dispatchSharedWriteReview(db, deps(), state, write(1), now);
    expect(first.dispatched).toBe(true);
    const second = await dispatchSharedWriteReview(db, deps(), state, write(2), now + 60_000);
    expect(second).toMatchObject({ dispatched: false, skipped: "debounced" });
    expect(await openJobs()).toHaveLength(1);
    // An hour later, with the first review still open → the open-job guard
    // (never two open reviews for one writer) — and it refreshes the debounce.
    const later = now + SHARED_WRITE_DEBOUNCE_MS;
    const third = await dispatchSharedWriteReview(db, deps(), state, write(3), later);
    expect(third).toMatchObject({ dispatched: false, skipped: "open-job", jobId: first.jobId });
    // Once the first is finished/withdrawn and the hour has passed → new review.
    await op(OWNER, { operation: "assist_cancel", id: first.jobId! });
    const fourth = await dispatchSharedWriteReview(
      db,
      deps(),
      state,
      write(4),
      later + SHARED_WRITE_DEBOUNCE_MS,
    );
    expect(fourth.dispatched).toBe(true);
    expect(fourth.jobId).not.toBe(first.jobId);
    expect(await openJobs()).toHaveLength(1);
    expect(tells).toEqual([]);
  });

  it("the per-writer hour debounce survives a restart (durable stamp, cache read-through)", async () => {
    setTrustProfile("shared");
    standings.set(OWNER_ID, 0);
    const now = Date.now();
    const first = await dispatchSharedWriteReview(db, deps(), state, write(1), now);
    expect(first.dispatched).toBe(true);
    const key = sharedWriteDebounceKey(OWNER);
    expect(db.getCoreMemory(DISPATCH_STATE_OWNER, key)?.value).toBe(String(now));
    expect(db.listCoreMemory(OWNER)).toEqual([]); // nothing leaks into the writer's own core memory
    // The first review is withdrawn so the open-job guard cannot mask the
    // debounce; then "restart" with a fresh in-process state.
    await op(OWNER, { operation: "assist_cancel", id: first.jobId! });
    expect(await openJobs()).toEqual([]);
    const rebooted = createDispatchState();
    const second = await dispatchSharedWriteReview(db, deps(), rebooted, write(2), now + 60_000);
    expect(second).toMatchObject({ dispatched: false, skipped: "debounced" });
    expect(await openJobs()).toEqual([]);
    expect(rebooted.sharedWriteFiled.get(key)).toBe(now); // populated by the read-through
    // Same fresh process, hour elapsed → files, and the durable stamp advances.
    const later = now + SHARED_WRITE_DEBOUNCE_MS;
    const third = await dispatchSharedWriteReview(db, deps(), rebooted, write(3), later);
    expect(third.dispatched).toBe(true);
    expect(db.getCoreMemory(DISPATCH_STATE_OWNER, key)?.value).toBe(String(later));
    // A corrupt stamp behaves like a missing one (the guard degrades open, never wedges).
    db.setCoreMemory(DISPATCH_STATE_OWNER, key, "not-a-time");
    await op(OWNER, { operation: "assist_cancel", id: third.jobId! });
    const fourth = await dispatchSharedWriteReview(
      db,
      deps(),
      createDispatchState(),
      write(4),
      later + 60_000,
    );
    expect(fourth.dispatched).toBe(true);
    expect(tells).toEqual([]);
  });

  it("is skipped entirely under the local profile; public behaves like shared", async () => {
    standings.set(OWNER_ID, 0);
    setTrustProfile("local");
    const local = await dispatchSharedWriteReview(db, deps(), state, write(), Date.now());
    expect(local).toMatchObject({ dispatched: false, skipped: "local-profile" });
    expect(await openJobs()).toEqual([]);
    setTrustProfile("public");
    const pub = await dispatchSharedWriteReview(db, deps(), state, write(), Date.now());
    expect(pub.dispatched).toBe(true);
    expect(await openJobs()).toHaveLength(1);
  });

  it("stays silent with no evaluator, an unknown pool, or a writer without a world account", async () => {
    setTrustProfile("shared");
    standings.set(OWNER_ID, 0);
    const noHelper = await dispatchSharedWriteReview(
      db,
      deps({ findRunningHelper: () => undefined }),
      state,
      write(),
      Date.now(),
    );
    expect(noHelper).toMatchObject({ dispatched: false, skipped: "no-helper" });
    const unknown = await dispatchSharedWriteReview(
      db,
      deps(),
      state,
      { ...write(), poolName: "nope" },
      Date.now(),
    );
    expect(unknown).toMatchObject({ dispatched: false, skipped: "unknown-pool" });
    const ghost = await dispatchSharedWriteReview(
      db,
      deps(),
      state,
      { ...write(), entity: "e_ghost" as EntityId, name: "Ghost" },
      Date.now(),
    );
    expect(ghost).toMatchObject({ dispatched: false, skipped: "no-account" });
    expect(await openJobs()).toEqual([]);
    expect(tells).toEqual([]);
  });

  it("engine hook returns synchronously from logEvent and files the job in the background", async () => {
    setTrustProfile("shared");
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", OWNER);
    const entity = conn.entity!;
    standings.set(entity, 0);
    const event = {
      type: "pool_note" as const,
      entity,
      noteId: 7,
      poolName: POOL,
      content: "shared claim without a source",
      importance: 6,
      timestamp: Date.now(),
    };
    // Default engine deps: no helper agent is running → nothing filed, no throw.
    const before = performance.now();
    engine.logEvent(event);
    expect(performance.now() - before).toBeLessThan(200);
    // Injected deps with a running evaluator: the hook itself returns
    // synchronously (void), the job lands after the durable round-trip.
    const started = engineSharedWriteHook(engine, event, deps());
    expect(started).toBeUndefined();
    let jobs = await openJobs();
    for (let i = 0; i < 50 && jobs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      jobs = await openJobs();
    }
    expect(jobs).toHaveLength(1);
    expect((await jobTask(jobs[0]!.id)).startsWith(SHARED_WRITE_REVIEW_MARKER)).toBe(true);
    expect(tells).toEqual([]);
  });
});

describe("memory helper role seeding (versioned, edit-preserving)", () => {
  const ROLES = ["memory-librarian", "memory-reflector", "memory-evaluator"];

  it("installs the three roles with curator duties and a version marker when absent", () => {
    const report = seedMemoryHelperRoles(db);
    expect(report.installed.sort()).toEqual([...ROLES].sort());
    expect(report.upgraded).toEqual([]);
    for (const role of ["librarian", "reflector", "evaluator"] as const) {
      const row = db.getRole(`memory-${role}`)!;
      const guidelines = JSON.parse(row.guidelines) as string[];
      expect(guidelines[0]).toBe(MEMORY_HELPER_INSTRUCTIONS[role]);
      expect(guidelines).toContain(MEMORY_HELPER_CURATOR_DUTIES[role]);
      for (const line of MEMORY_HELPER_PROTOCOL_GUIDELINES) expect(guidelines).toContain(line);
      expect(readGuidelinesVersion(row.description)).toBe(MEMORY_HELPER_GUIDELINES_VERSION);
      expect(row.description.startsWith(MEMORY_HELPER_INSTRUCTIONS[role])).toBe(true);
      expect(row.created_by).toBe("system");
    }
    // Duties carry their mandates.
    expect(MEMORY_HELPER_CURATOR_DUTIES.evaluator).toContain("last_writer_wins");
    expect(MEMORY_HELPER_CURATOR_DUTIES.evaluator).toContain("keep_both");
    expect(MEMORY_HELPER_CURATOR_DUTIES.evaluator).toContain("Never apply");
    expect(MEMORY_HELPER_CURATOR_DUTIES.librarian).toContain("Never delete");
    expect(MEMORY_HELPER_CURATOR_DUTIES.reflector).toContain("ONE consolidated lesson");
    expect(MEMORY_HELPER_CURATOR_DUTIES.reflector).toContain("Append-and-link");
    // Re-seeding the identical definition is a no-op (no history churn).
    const again = seedMemoryHelperRoles(db);
    expect(again.preserved.sort()).toEqual([...ROLES].sort());
    expect(db.getRoleHistory("memory-evaluator", 10)).toHaveLength(1);
  });

  it("upgrades an un-edited stale role (pre-version or older version) on the next seed", () => {
    // Pre-Phase-3 seed: no marker, protocol lines only, saved by system.
    const v1 = memoryHelperRoleDefinition("evaluator");
    db.saveRole({
      ...v1,
      description: MEMORY_HELPER_INSTRUCTIONS.evaluator,
      guidelines: [MEMORY_HELPER_INSTRUCTIONS.evaluator, ...MEMORY_HELPER_PROTOCOL_GUIDELINES],
    });
    expect(readGuidelinesVersion(db.getRole("memory-evaluator")!.description)).toBe(0);
    // Older explicit version, also system-only.
    db.saveRole({
      ...memoryHelperRoleDefinition("librarian"),
      description: stampGuidelinesVersion(MEMORY_HELPER_INSTRUCTIONS.librarian, 1),
    });
    const report = seedMemoryHelperRoles(db);
    expect(report.upgraded.sort()).toEqual(["memory-evaluator", "memory-librarian"]);
    expect(report.installed).toEqual(["memory-reflector"]);
    const evaluator = db.getRole("memory-evaluator")!;
    expect(JSON.parse(evaluator.guidelines)).toContain(MEMORY_HELPER_CURATOR_DUTIES.evaluator);
    expect(readGuidelinesVersion(evaluator.description)).toBe(MEMORY_HELPER_GUIDELINES_VERSION);
    expect(readGuidelinesVersion(db.getRole("memory-librarian")!.description)).toBe(
      MEMORY_HELPER_GUIDELINES_VERSION,
    );
  });

  it("never clobbers an operator-edited role — by last saver or by history", () => {
    // (a) Operator is the last saver.
    db.saveRole({
      ...memoryHelperRoleDefinition("reflector"),
      description: MEMORY_HELPER_INSTRUCTIONS.reflector, // stale (unmarked)
      guidelines: ["Only reflect on Tuesdays."],
      createdBy: "Jeff",
    });
    // (b) System saved last, but an operator edit is in the history trail.
    const v1Librarian = {
      ...memoryHelperRoleDefinition("librarian"),
      description: MEMORY_HELPER_INSTRUCTIONS.librarian,
      guidelines: [MEMORY_HELPER_INSTRUCTIONS.librarian, ...MEMORY_HELPER_PROTOCOL_GUIDELINES],
    };
    db.saveRole(v1Librarian);
    db.saveRole({ ...v1Librarian, guidelines: ["Shelve by colour."], createdBy: "Jeff" });
    db.saveRole(v1Librarian); // system restores its own text — trail still shows Jeff
    expect(isOperatorEditedRole(db, "memory-reflector")).toBe(true);
    expect(isOperatorEditedRole(db, "memory-librarian")).toBe(true);
    expect(isOperatorEditedRole(db, "memory-evaluator")).toBe(false);

    const report = seedMemoryHelperRoles(db);
    expect(report.installed).toEqual(["memory-evaluator"]);
    expect(report.upgraded).toEqual([]);
    expect(report.preserved.sort()).toEqual(["memory-librarian", "memory-reflector"]);
    expect(JSON.parse(db.getRole("memory-reflector")!.guidelines)).toEqual([
      "Only reflect on Tuesdays.",
    ]);
    expect(db.getRole("memory-reflector")!.created_by).toBe("Jeff");
    expect(JSON.parse(db.getRole("memory-librarian")!.guidelines)).not.toContain(
      MEMORY_HELPER_CURATOR_DUTIES.librarian,
    );
    expect(readGuidelinesVersion(db.getRole("memory-librarian")!.description)).toBe(0);
  });

  it("stamps and reads the version marker idempotently", () => {
    const stamped = stampGuidelinesVersion("Find evidence.", 7);
    expect(stamped).toBe("Find evidence.\n[guidelines_version=7]");
    expect(readGuidelinesVersion(stamped)).toBe(7);
    expect(stampGuidelinesVersion(stamped, 8)).toBe("Find evidence.\n[guidelines_version=8]");
    expect(readGuidelinesVersion("no marker")).toBe(0);
    expect(readGuidelinesVersion(undefined)).toBe(0);
  });
});
