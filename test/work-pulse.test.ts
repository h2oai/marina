// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * The work pulse opens ONE reviewable task per pass from one knowledge-hygiene
 * finding when agents are running and fewer than MARINA_WORK_PULSE_OPEN live
 * pulse tasks are open; a task its reviewer claimed or one idle 3 days holds
 * no place; a finding is worked once; nothing happens with no agent, no
 * project, no reviewer, or `off`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  openWorkPulseTask,
  WORK_PULSE_IDLE_MS,
  WORK_PULSE_TITLE_PREFIX,
  workPulseEnabled,
  workPulseMarker,
  workPulseOpenCap,
} from "../src/engine/work-pulse";
import { MarinaDB } from "../src/persistence/database";
import { assignSeededTaskReviewer, seedProject } from "../worlds/seed";

const dbs: MarinaDB[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

const GUIDE = "guide";

function world(opts: { notes: string[]; reviewer?: boolean } = { notes: [] }) {
  const db = new MarinaDB(":memory:");
  dbs.push(db);
  seedProject(db, {
    name: "Demo Pulse",
    description: "the queue",
    orchestration: "pipeline",
    tasks: [],
    poolNotes: [],
  });
  if (opts.reviewer !== false) {
    db.createUser({ id: "critic-account", name: "Critic" });
    assignSeededTaskReviewer(db, "Demo Pulse", "Critic");
  }
  if (!db.getMemoryPool(GUIDE)) db.createMemoryPool("pool-guide", GUIDE, "system");
  const pool = db.getMemoryPool(GUIDE)!;
  for (const content of opts.notes)
    db.createNote("system", content, undefined, {
      noteType: "guide",
      poolId: pool.id,
      importance: 5,
    });
  return db;
}

const vocabulary = { commands: [{ name: "look" }, { name: "help" }], knownCommands: [] };
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...over });

describe("work pulse", () => {
  it("opens one task from the first finding, created by the reviewer, marked once", () => {
    const db = world({ notes: ["Run `frobnicate now` to begin.", "Then `look` around."] });
    const announced: string[] = [];
    const first = openWorkPulseTask({
      db,
      announce: (t) => announced.push(t),
      vocabulary,
      runningAgents: () => ["Builder"],
      env: env(),
    });
    expect(first.opened).toBeDefined();
    expect(first.opened!.kind).toBe("stale-command");
    expect(announced).toHaveLength(1);
    expect(announced[0]).toContain(`@Builder Work pulse task #${first.opened!.id} is open`);
    expect(announced[0]).toContain(`task claim ${first.opened!.id}`);
    expect(announced[0]).toContain("Critic reviews");
    expect(first.opened!.title.startsWith(WORK_PULSE_TITLE_PREFIX)).toBe(true);
    const task = db.getTask(first.opened!.id)!;
    expect(task.creator_name).toBe("Critic");
    expect(task.group_id).toBe(db.getProjectByName("Demo Pulse")!.group_id);
    expect(task.description).toContain("frobnicate");
    expect(task.description).toContain("[work-pulse stale-command #");
    expect(task.description).toContain("Critic reviews");

    // With a cap of one, one open pulse task at a time.
    const again = openWorkPulseTask({
      db,
      vocabulary,
      runningAgents: () => ["Builder"],
      env: env({ MARINA_WORK_PULSE_OPEN: "1" }),
    });
    expect(again.opened).toBeUndefined();
    expect(again.skipped).toContain(`#${first.opened!.id} is still open`);

    // Once it is done, the same finding is never opened again.
    db.updateTaskStatus(first.opened!.id, "completed");
    const next = openWorkPulseTask({
      db,
      vocabulary,
      runningAgents: () => ["Builder"],
      env: env(),
    });
    expect(next.opened).toBeUndefined();
    expect(next.skipped).toContain("no new finding");
  });

  it("does nothing with no running agent, no project, no reviewer, or off", () => {
    const db = world({ notes: ["Run `frobnicate now`."] });
    expect(openWorkPulseTask({ db, vocabulary, runningAgents: () => [], env: env() }).skipped).toBe(
      "no agent running",
    );
    expect(
      openWorkPulseTask({
        db,
        vocabulary,
        runningAgents: () => ["Builder"],
        env: env({ MARINA_WORK_PULSE: "off" }),
      }).skipped,
    ).toContain("off");
    expect(
      openWorkPulseTask({
        db,
        vocabulary,
        runningAgents: () => ["Builder"],
        env: env({ MARINA_WORK_PULSE_PROJECT: "Nowhere" }),
      }).skipped,
    ).toContain('no project "Nowhere"');
    const noReviewer = world({ notes: ["Run `frobnicate now`."], reviewer: false });
    expect(
      openWorkPulseTask({
        db: noReviewer,
        vocabulary,
        runningAgents: () => ["Builder"],
        env: env(),
      }).skipped,
    ).toContain("no reviewer account");
    expect(
      db.listTasks({ limit: 50 }).filter((t) => t.title.startsWith(WORK_PULSE_TITLE_PREFIX)),
    ).toEqual([]);
  });

  it("keeps up to the cap open, one per pass", () => {
    const db = world({
      notes: ["Run `frobnicate now`.", "Run `wibble twice`.", "Run `zork again`.", "Run `quux x`."],
    });
    const pass = () =>
      openWorkPulseTask({ db, vocabulary, runningAgents: () => ["Builder"], env: env() });
    const opened = [pass(), pass(), pass()].map((r) => r.opened?.id);
    expect(opened.every((id) => typeof id === "number")).toBe(true);
    expect(new Set(opened).size).toBe(3);
    const full = pass();
    expect(full.opened).toBeUndefined();
    expect(full.skipped).toContain("are still open (cap 3)");
  });

  it("a task its reviewer claimed, or one idle 3 days, holds no place", () => {
    const db = world({ notes: ["Run `frobnicate now`.", "Run `wibble twice`.", "Run `zork x`."] });
    const one = { MARINA_WORK_PULSE_OPEN: "1" };
    const first = openWorkPulseTask({
      db,
      vocabulary,
      runningAgents: () => ["Builder"],
      env: env(one),
    }).opened!;
    // The reviewer (the creator) claims its own task: it would review its own work.
    db.createTaskClaim(first.id, "critic-session-id", "Critic", Date.now() + 60_000);
    const second = openWorkPulseTask({
      db,
      vocabulary,
      runningAgents: () => ["Builder"],
      env: env(one),
    }).opened!;
    expect(second.id).not.toBe(first.id);
    // A worker's live claim holds the place...
    db.createTaskClaim(second.id, "builder-id", "Builder", Date.now() + 60_000);
    const held = openWorkPulseTask({
      db,
      vocabulary,
      runningAgents: () => ["Builder"],
      env: env(one),
    });
    expect(held.skipped).toContain(`#${second.id} is still open`);
    // ...until nothing has happened on it for WORK_PULSE_IDLE_MS.
    const later = openWorkPulseTask({
      db,
      vocabulary,
      runningAgents: () => ["Builder"],
      env: env(one),
      now: () => Date.now() + WORK_PULSE_IDLE_MS + 60_000,
    });
    expect(later.opened).toBeDefined();
    // Both earlier tasks stay on the board.
    expect(db.getTask(first.id)!.status).not.toBe("cancelled");
    expect(db.getTask(second.id)!.status).not.toBe("cancelled");
  });

  it("never files a note that quotes the auditor's own finding", () => {
    const db = world({
      notes: ['The audit printed `unknown pool action` and `unknown command "x" in "x y"`.'],
    });
    const result = openWorkPulseTask({
      db,
      vocabulary,
      runningAgents: () => ["Builder"],
      env: env(),
    });
    expect(result.opened).toBeUndefined();
    expect(result.skipped).toContain("no new finding");
  });

  it("marker and switch are stable", () => {
    expect(workPulseOpenCap({})).toBe(3);
    expect(workPulseOpenCap({ MARINA_WORK_PULSE_OPEN: "5" })).toBe(5);
    expect(workPulseOpenCap({ MARINA_WORK_PULSE_OPEN: "0" })).toBe(3);
    expect(workPulseOpenCap({ MARINA_WORK_PULSE_OPEN: "junk" })).toBe(3);
    expect(workPulseMarker({ kind: "duplicate", noteIds: [9, 3] })).toBe(
      "[work-pulse duplicate #3,#9]",
    );
    expect(workPulseEnabled({})).toBe(true);
    expect(workPulseEnabled({ MARINA_WORK_PULSE: "off" })).toBe(false);
    expect(workPulseEnabled({ MARINA_WORK_PULSE: "on" })).toBe(true);
  });
});
