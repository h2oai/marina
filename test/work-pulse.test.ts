// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * The work pulse opens ONE reviewable task from one knowledge-hygiene finding
 * when agents are running and no pulse task is open; a finding is worked
 * once; nothing happens with no agent, no project, no reviewer, or `off`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  openWorkPulseTask,
  WORK_PULSE_TITLE_PREFIX,
  workPulseEnabled,
  workPulseMarker,
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
    const first = openWorkPulseTask({
      db,
      vocabulary,
      runningAgents: () => ["Builder"],
      env: env(),
    });
    expect(first.opened).toBeDefined();
    expect(first.opened!.kind).toBe("stale-command");
    expect(first.opened!.title.startsWith(WORK_PULSE_TITLE_PREFIX)).toBe(true);
    const task = db.getTask(first.opened!.id)!;
    expect(task.creator_name).toBe("Critic");
    expect(task.group_id).toBe(db.getProjectByName("Demo Pulse")!.group_id);
    expect(task.description).toContain("frobnicate");
    expect(task.description).toContain("[work-pulse stale-command #");
    expect(task.description).toContain("Critic reviews");

    // One open pulse task at a time.
    const again = openWorkPulseTask({
      db,
      vocabulary,
      runningAgents: () => ["Builder"],
      env: env(),
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

  it("marker and switch are stable", () => {
    expect(workPulseMarker({ kind: "duplicate", noteIds: [9, 3] })).toBe(
      "[work-pulse duplicate #3,#9]",
    );
    expect(workPulseEnabled({})).toBe(true);
    expect(workPulseEnabled({ MARINA_WORK_PULSE: "off" })).toBe(false);
    expect(workPulseEnabled({ MARINA_WORK_PULSE: "on" })).toBe(true);
  });
});
