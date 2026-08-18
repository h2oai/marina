// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { type Entity, roomId } from "../src/types";
import type { WorldDefinition } from "../src/world/world-definition";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

// ─── Test fixture ──────────────────────────────────────────────────────────
//
// The default world ships zero quests after the v0.3 onboarding cleanup —
// agents inherit predecessor wisdom from the guide pool instead. The quest
// system itself stays as infrastructure for real gated quests (evolve
// benchmarks, markets FORECASTER, demos). This fixture exercises that
// infrastructure without depending on any production world definition.

const TUTORIAL_QUEST = {
  id: "tutorial",
  name: "First Steps",
  description: "Test fixture covering the quest system primitives.",
  reward: "Test promotion",
  steps: [
    {
      id: "look",
      description: "Look around.",
      hint: 'Type "look".',
      check: (e: Entity) => (e.properties.quest_look as boolean) === true,
    },
    {
      id: "set_goal",
      description: "Set a goal.",
      hint: "memory set goal <purpose>",
      check: (e: Entity) => (e.properties.quest_memory_set as boolean) === true,
    },
    {
      id: "take_note",
      description: "Take a note.",
      hint: "note <observation>",
      check: (e: Entity) => (e.properties.quest_note as boolean) === true,
    },
  ],
  onComplete(entity: Entity) {
    const currentRank = (entity.properties.rank as number) ?? 0;
    if (currentRank < 1) entity.properties.rank = 1;
  },
} satisfies WorldDefinition["quests"][number];

function buildTestWorld(): WorldDefinition {
  return {
    name: "quest-test",
    startRoom: roomId("hub/crossroads"),
    rooms: {},
    quests: [TUTORIAL_QUEST],
    autoQuest: "tutorial",
    guideNotes: [],
  };
}

describe("Quest System", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  const dbPath = `/tmp/marina-quest-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: roomId("hub/crossroads"),
      tickInterval: 60_000,
      db,
      world: buildTestWorld(),
    });

    engine.registerRoom(
      roomId("hub/crossroads"),
      makeTestRoom({
        short: "Crossroads",
        items: { terminal: "A glowing terminal." },
        exits: { north: roomId("knowledge/hub") },
      }),
    );
    engine.registerRoom(
      roomId("knowledge/hub"),
      makeTestRoom({
        short: "Knowledge Hub",
        exits: { south: roomId("hub/crossroads") },
      }),
    );

    conn = new MockConnection("c1");
    engine.addConnection(conn);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should auto-start the world's autoQuest for new players", () => {
    const result = engine.login("c1", "NewPlayer");
    expect("entityId" in result).toBe(true);
    if ("entityId" in result) {
      const entity = engine.entities.get(result.entityId);
      expect(entity?.properties.active_quest).toBe("tutorial");
    }
  });

  it("should not auto-start a quest for returning ranked players", () => {
    db.createUser({ id: "u1", name: "Veteran", rank: 1 });
    const result = engine.login("c1", "Veteran");
    expect("entityId" in result).toBe(true);
    if ("entityId" in result) {
      const entity = engine.entities.get(result.entityId);
      expect(entity?.properties.active_quest).toBeUndefined();
    }
  });

  it("should show quest status", () => {
    engine.login("c1", "Player");
    conn.clear();
    engine.processCommand(conn.entity!, "quest status");
    const text = conn.lastText();
    expect(text).toContain("First Steps");
    expect(text).toContain("Look around");
  });

  it("should list available quests", () => {
    engine.login("c1", "Player");
    conn.clear();
    engine.processCommand(conn.entity!, "quest list");
    const text = conn.lastText();
    expect(text).toContain("First Steps");
    expect(text).toContain("ACTIVE");
  });

  it("should track look progress on a player with an active quest", () => {
    engine.login("c1", "Player");
    const entity = engine.entities.get(conn.entity!);
    expect(entity?.properties.quest_look).toBeUndefined();

    engine.processCommand(conn.entity!, "look");
    expect(entity?.properties.quest_look).toBe(true);
  });

  it("should track movement and sector exploration", () => {
    engine.login("c1", "Player");
    const entity = engine.entities.get(conn.entity!);

    engine.processCommand(conn.entity!, "north");
    expect(entity?.properties.quest_move).toBe(true);

    const sectors = entity?.properties.quest_sectors as string[];
    expect(sectors).toContain("knowledge/hub");
  });

  it("should track say progress", () => {
    engine.login("c1", "Player");
    const entity = engine.entities.get(conn.entity!);

    engine.processCommand(conn.entity!, "say Hello!");
    expect(entity?.properties.quest_say).toBe(true);
  });

  it("should track examine progress", () => {
    engine.login("c1", "Player");
    const entity = engine.entities.get(conn.entity!);

    engine.processCommand(conn.entity!, "examine terminal");
    expect(entity?.properties.quest_examine).toBe(true);
  });

  it("should complete a quest when all step checks pass and run onComplete", () => {
    engine.login("c1", "Player");
    const entity = engine.entities.get(conn.entity!)!;

    engine.processCommand(conn.entity!, "look");
    engine.processCommand(conn.entity!, "memory set goal explore");
    engine.processCommand(conn.entity!, "note this is interesting");

    conn.clear();
    engine.processCommand(conn.entity!, "quest complete");
    expect(conn.lastText()).toContain("Completed: First Steps");
    expect((entity.properties.rank as number) ?? 0).toBeGreaterThanOrEqual(1);
    expect(entity.properties.active_quest).toBeUndefined();
  });

  it("awards quest_complete standing on completion, idempotently", () => {
    engine.login("c1", "Player");
    const entity = engine.entities.get(conn.entity!)!;
    engine.processCommand(conn.entity!, "look");
    engine.processCommand(conn.entity!, "memory set goal explore");
    engine.processCommand(conn.entity!, "note this is interesting");
    engine.processCommand(conn.entity!, "quest complete");

    // The completion credit is wired in quest.ts via record(... "quest_complete"
    // "quest:tutorial"). The rank>=1 assertion above is satisfied by the
    // fixture's onComplete (not the credit), so assert the ledger directly.
    const ledger = db.ledgerForEntity(entity.id, 20);
    const credit = ledger.find((r) => r.kind === "quest_complete");
    expect(credit).toBeDefined();
    expect(credit?.ref).toBe("quest:tutorial");

    // Re-running on the now-inactive quest must not double-credit.
    engine.processCommand(conn.entity!, "quest complete");
    const after = db.ledgerForEntity(entity.id, 20).filter((r) => r.kind === "quest_complete");
    expect(after.length).toBe(1);
  });

  it("should not complete quest if steps are missing", () => {
    engine.login("c1", "Player");
    conn.clear();
    engine.processCommand(conn.entity!, "quest complete");
    expect(conn.lastText()).toContain("Not all steps");
  });

  it("should support quest abandon and restart", () => {
    engine.login("c1", "Player");
    const entity = engine.entities.get(conn.entity!)!;

    engine.processCommand(conn.entity!, "look");
    expect(entity.properties.quest_look).toBe(true);

    engine.processCommand(conn.entity!, "quest abandon");
    expect(entity.properties.active_quest).toBeUndefined();
    expect(entity.properties.quest_look).toBeUndefined();

    engine.processCommand(conn.entity!, "quest start First Steps");
    expect(entity.properties.active_quest).toBe("tutorial");
  });

  it("should prevent starting a completed quest again", () => {
    engine.login("c1", "Player");
    const entity = engine.entities.get(conn.entity!)!;

    entity.properties.quest_look = true;
    entity.properties.quest_memory_set = true;
    entity.properties.quest_note = true;

    engine.processCommand(conn.entity!, "quest complete");
    conn.clear();

    engine.processCommand(conn.entity!, "quest start First Steps");
    expect(conn.lastText()).toContain("already completed");
  });
});

describe("Quest: aliases", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  const dbPath = `/tmp/marina-quest-alias-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
      world: buildTestWorld(),
    });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.login("c1", "Player");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should work via checklist alias", () => {
    engine.processCommand(conn.entity!, "checklist");
    expect(conn.lastText()).toContain("First Steps");
  });

  it("should work via onboarding alias", () => {
    engine.processCommand(conn.entity!, "onboarding list");
    expect(conn.lastText()).toContain("First Steps");
  });
});
