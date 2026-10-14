// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Seeded knowledge stays current in worlds seeded by an earlier release:
 * guide and pool notes reconcile by key (edited or removed seed text is
 * retired through the canonical path, never hard-deleted), seeded tasks get a
 * reviewer who can approve them, and the Workbench kickoff posts once.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { findDurableTwin } from "../src/memory/legacy-projection";
import type { MarinaDB } from "../src/persistence/database";
import { isGrantedCompetence } from "../src/persistence/db-competence";
import {
  describeRequirement,
  expandGuideContent,
  GUIDE_SEED_OWNER,
  HUMAN_ONBOARDING_TAG,
  isHumanOnboardingNote,
  PLATFORM_GUIDE_NOTES,
  rankLabel,
  renderGuideNote,
  seedGuidePool,
} from "../src/world/seed-guide";
import defaultWorld from "../worlds/default";
import demosWorld from "../worlds/demos";
import { assignSeededTaskReviewer, seedPoolWithNotes, seedProject } from "../worlds/seed";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

/** Text an earlier release seeded and has since edited or removed. */
const OLD_ARENA =
  "arena — improve, do better, climb the leaderboard in the Social Simulation Arena (a live " +
  "forecasting benchmark). Operator loop: `bun run arena submit due` files the submission.";
const OLD_POOL_RECALL =
  "pool recall — searching shared knowledge. Benchmark mistakes land in `benchmark:<name>` " +
  "pools; review them with `pool benchmark:<name> recall <topic>`.";

function guidePool(db: MarinaDB) {
  const pool = db.getMemoryPool("guide");
  if (!pool) throw new Error("guide pool missing");
  return pool;
}

function activeGuideTexts(db: MarinaDB): string[] {
  return db
    .getPoolNotes(guidePool(db).id, 1_000)
    .filter((note) => note.verification_status !== "superseded")
    .map((note) => note.content);
}

describe("guide pool reconciliation", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  let db: MarinaDB;

  beforeEach(() => {
    fixture = createTestEngine();
    db = fixture.db;
  });
  afterEach(() => fixture.dispose());

  it("retires earlier seed text in an old-content database and keeps other authors' notes", () => {
    // A world seeded by an earlier release: two stale platform notes, one
    // still-current one, and a note a resident added to the guide pool.
    db.createMemoryPool("pool_guide_old", "guide", "Guide");
    const pool = guidePool(db);
    const staleArena = db.addPoolNote(pool.id, "Guide", OLD_ARENA, 8, "skill");
    const staleRecall = db.addPoolNote(pool.id, "Guide", OLD_POOL_RECALL, 7, "fact");
    const current = PLATFORM_GUIDE_NOTES[0]!;
    const kept = db.addPoolNote(pool.id, "Guide", current.content, current.importance, "skill");
    const resident = db.addPoolNote(pool.id, "Alice", "Alice's own guide tip", 5, "fact");
    const twin = findDurableTwin(db, staleArena);

    const result = seedGuidePool(db, []);

    expect(result.retired).toBe(2);
    expect(result.kept).toBe(1);
    expect(result.added).toBe(PLATFORM_GUIDE_NOTES.length - 1);
    const texts = activeGuideTexts(db);
    expect(texts).not.toContain(OLD_ARENA);
    expect(texts).not.toContain(OLD_POOL_RECALL);
    expect(texts).toContain("Alice's own guide tip");
    for (const note of PLATFORM_GUIDE_NOTES) {
      expect(texts.filter((text) => text === note.content)).toHaveLength(1);
    }
    expect(db.getNote(staleArena)).toBeUndefined();
    expect(db.getNote(staleRecall)).toBeUndefined();
    expect(db.getNote(kept)?.content).toBe(current.content);
    expect(db.getNote(resident)).toBeDefined();

    // Retired, not erased: the canonical record keeps its history and its
    // current version is the retirement tombstone.
    expect(twin).toBeDefined();
    const raw = db.memoryRepository().raw;
    const versions = raw
      .query("SELECT COUNT(*) AS n FROM memory_record_versions WHERE record_id = ?")
      .get(twin!.recordId) as { n: number };
    expect(versions.n).toBeGreaterThanOrEqual(2);
    const currentText = raw
      .query(
        "SELECT n.content AS content FROM memory_records r JOIN notes n ON n.id = r.current_note_id WHERE r.id = ?",
      )
      .get(twin!.recordId) as { content: string } | null;
    expect(currentText?.content).toBe(`[deleted legacy note #${staleArena}]`);
    // Every platform note has a stable key → note mapping.
    expect(db.getCoreMemory(GUIDE_SEED_OWNER, "platform:arena")?.value).toMatch(/^\d+$/);
  });

  it("is idempotent across boots", () => {
    seedGuidePool(db, defaultWorld.guideNotes);
    const first = db.getPoolNotes(guidePool(db).id, 1_000).map((note) => note.id);
    const again = seedGuidePool(db, defaultWorld.guideNotes);
    expect(again).toEqual({ added: 0, kept: first.length, retired: 0 });
    expect(db.getPoolNotes(guidePool(db).id, 1_000).map((note) => note.id)).toEqual(first);
  });

  it("supersedes an edited note by key and retires a removed one", () => {
    seedGuidePool(db, [
      { key: "world:edited", content: "Edited note, first text.", importance: 7, type: "fact" },
      {
        key: "world:removed",
        content: "A note a later release drops.",
        importance: 7,
        type: "fact",
      },
    ]);
    const firstId = db.getCoreMemory(GUIDE_SEED_OWNER, "world:edited")?.value;

    const result = seedGuidePool(db, [
      { key: "world:edited", content: "Edited note, second text.", importance: 7, type: "fact" },
    ]);

    expect(result.retired).toBe(2);
    const texts = activeGuideTexts(db);
    expect(texts).toContain("Edited note, second text.");
    expect(texts).not.toContain("Edited note, first text.");
    expect(texts).not.toContain("A note a later release drops.");
    const history = db.getCoreMemoryHistory(GUIDE_SEED_OWNER, "world:edited");
    expect(history.map((row) => row.old_value)).toContain(firstId ?? "missing");
    expect(db.getCoreMemory(GUIDE_SEED_OWNER, "world:removed")?.value ?? "").toStartWith(
      "retired:",
    );
  });

  it("tags onboarding written for people so agent recall can skip it", () => {
    seedGuidePool(db, defaultWorld.guideNotes);
    const welcome = activeGuideTexts(db).find((text) => text.includes("Welcome to the Workbench"));
    expect(welcome).toStartWith(`${HUMAN_ONBOARDING_TAG} `);
    expect(isHumanOnboardingNote(welcome ?? "")).toBe(true);
    for (const note of PLATFORM_GUIDE_NOTES)
      expect(isHumanOnboardingNote(note.content)).toBe(false);
  });

  it("phrases requirements from the live command definitions", () => {
    const build = fixture.engine.commands.allBuiltins().find((def) => def.name === "build");
    expect(build?.minRank).toBeGreaterThan(0);
    const commands = fixture.engine.commands.allBuiltins();
    expect(expandGuideContent("needs {{requires:build}}", commands)).toBe(
      `needs ${rankLabel(build?.minRank ?? 0)}`,
    );
    expect(describeRequirement("connect", commands)).toBe(
      "the connect.manage gate (see `standing`)",
    );
    expect(describeRequirement("look", commands)).toBe("no rank");
    expect(expandGuideContent("needs {{requires:build}}")).toBe("needs what `help build` lists");
    expect(rankLabel(4)).toBe("rank 4 (builder)");
    expect(renderGuideNote({ content: "x", importance: 1, type: "fact", audience: "people" })).toBe(
      `${HUMAN_ONBOARDING_TAG} x`,
    );
  });

  it("no platform note gives operator shell commands or ranks arena first", () => {
    for (const note of PLATFORM_GUIDE_NOTES) expect(note.content).not.toContain("bun run");
    const arena = PLATFORM_GUIDE_NOTES.find((note) => note.key === "platform:arena");
    expect(arena?.importance).toBeLessThan(5);
  });
});

describe("seeded pools reconcile", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  afterEach(() => fixture.dispose());

  it("retires a dropped seed note and keeps notes other authors added", () => {
    fixture = createTestEngine();
    const { db } = fixture;
    seedPoolWithNotes(db, "tips", [
      { content: "Keep this tip.", importance: 8 },
      { content: "A claim a later release removes.", importance: 8 },
    ]);
    const pool = db.getMemoryPool("tips")!;
    db.addPoolNote(pool.id, "Alice", "Alice's tip", 5);
    seedPoolWithNotes(db, "tips", [{ content: "Keep this tip.", importance: 8 }]);
    const texts = db.getPoolNotes(pool.id, 100).map((note) => note.content);
    expect(texts.sort()).toEqual(["Alice's tip", "Keep this tip."]);
  });
});

describe("seeded tasks are reviewable", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  afterEach(() => fixture.dispose());

  it("Demo Pulse tasks are reviewed by Critic, who can approve a Builder submission", async () => {
    fixture = createTestEngine();
    const { db, engine } = fixture;
    defaultWorld.seed?.(db);
    const project = db.getProjectByName("Demo Pulse")!;
    const tasks = db.listTasks({ groupId: project.group_id!, limit: 10 });
    expect(tasks.length).toBe(3);
    for (const task of tasks) expect(task.creator_name).toBe("Critic");

    const builder = fixture.login("Builder");
    const critic = fixture.login("Critic");
    const id = tasks[tasks.length - 1]!.id;
    await engine.processCommand(builder.entityId, `task claim ${id}`);
    await engine.processCommand(builder.entityId, `task submit ${id} note:1 published`);
    critic.connection.clear();
    await engine.processCommand(critic.entityId, `task approve ${id} Builder`);
    expect(stripAnsi(critic.connection.allTextJoined())).toContain(
      `Approved Builder's submission for task #${id}`,
    );
    expect(db.getTask(id)?.status).toBe("completed");
  });

  it("repairs tasks an earlier release seeded under `system`, leaving finished ones alone", () => {
    fixture = createTestEngine();
    const { db } = fixture;
    seedProject(db, {
      name: "Old Pulse",
      description: "seeded before reviewers",
      orchestration: "pipeline",
      tasks: [
        { title: "open one", description: "x", validationMode: "single" },
        { title: "done one", description: "y", validationMode: "single" },
      ],
      poolNotes: [],
    });
    const project = db.getProjectByName("Old Pulse")!;
    const [first, second] = db.listTasks({ groupId: project.group_id!, limit: 10 });
    db.updateTaskStatus(second!.id, "completed");
    assignSeededTaskReviewer(db, "Old Pulse", "Critic");
    assignSeededTaskReviewer(db, "Old Pulse", "Critic");
    expect(db.getTask(first!.id)?.creator_name).toBe("Critic");
    expect(db.getTask(second!.id)?.creator_name).toBe("system");
    expect(db.getUserByName("Critic")?.rank ?? 0).toBe(0);
  });

  it("posts the Demo Pulse kickoff once, keyed on a stored flag", () => {
    fixture = createTestEngine();
    const { db, engine } = fixture;
    defaultWorld.seed?.(db);
    if (!engine.channelManager?.getChannelByName("general"))
      engine.channelManager?.createChannel({ type: "public", name: "general", ownerId: "system" });
    const general = () => engine.channelManager!.getChannelByName("general")!;
    const kickoffs = () =>
      engine
        .channelManager!.getHistory(general().id, 200)
        .filter((message) => message.content.startsWith("[demo-pulse]")).length;
    defaultWorld.afterAgentsReady?.(engine);
    expect(kickoffs()).toBe(1);
    // Fifty unrelated messages push the kickoff out of recent history.
    for (let i = 0; i < 60; i++)
      engine.channelManager!.send(general().id, "system", "Workbench", `chatter ${i}`);
    defaultWorld.afterAgentsReady?.(engine);
    expect(kickoffs()).toBe(1);
  });
});

describe("demos Maker can do the building it demonstrates", () => {
  let fixture: ReturnType<typeof createTestEngine>;
  afterEach(() => fixture.dispose());

  it("holds build's command floor and the world.code gate", () => {
    fixture = createTestEngine();
    const { db, engine } = fixture;
    demosWorld.seed?.(db);
    const build = engine.commands.allBuiltins().find((def) => def.name === "build")!;
    const maker = db.getUserByName("Maker")!;
    expect(maker.rank).toBeGreaterThanOrEqual(build.minRank ?? 0);
    expect(isGrantedCompetence(db.getCompetence(maker.id, "world.code"))).toBe(true);
  });
});
