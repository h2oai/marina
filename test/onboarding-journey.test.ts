// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The "first ten minutes" contract.
 *
 * A 2026-09 usability evaluation found the default world's onboarding rotted
 * around a fast-moving engine: `quest` suggested an objective that didn't
 * exist, `brief` hinted at a command that returned zero results, and the
 * `agent spawn` refusal gave a number that could never be satisfied. None of
 * it was caught because nothing tested the world a NEW USER actually lands in.
 *
 * This suite boots the real default world and enforces one structural rule:
 * every command the system's own output suggests must work when a fresh
 * entity runs it verbatim. If you change a hint, an empty-state message, or
 * the seeded world, this test tells you whether a newcomer's first session
 * still coheres.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";
import { roomId } from "../src/types";
import { seedGuidePool } from "../src/world/seed-guide";
import defaultWorld from "../worlds/default";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const plain = (s: string): string => stripAnsi(s);

describe("Onboarding journey (default world)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let eid: EntityId;
  const dbPath = `/tmp/marina-onboarding-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: defaultWorld.startRoom,
      tickInterval: 60_000,
      db,
      world: defaultWorld,
    });
    engine.registerWorldRooms(defaultWorld);
    seedGuidePool(db, defaultWorld.guideNotes);
    defaultWorld.seed?.(db);

    conn = new MockConnection("newcomer_conn");
    engine.addConnection(conn);
    const result = engine.login("newcomer_conn", "Newcomer");
    if (!("entityId" in result)) throw new Error(`login failed: ${JSON.stringify(result)}`);
    eid = result.entityId;
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  const run = (cmd: string): string => {
    conn.clear();
    engine.processCommand(eid, cmd);
    return plain(conn.allText().join("\n"));
  };

  // ── The self-referential contract: suggested commands must work ──────────

  it("the quest empty-state suggests an objective that actually starts", () => {
    const status = run("quest");
    const suggested = /quest start ([A-Za-z][A-Za-z ]*?)" to begin/.exec(status);
    expect(suggested).not.toBeNull();
    const started = run(`quest start ${suggested![1]}`);
    expect(started).toContain("Started:");
    expect(started).not.toContain("Objective not found");
  });

  it("every command in the brief hint line executes meaningfully", () => {
    run("brief"); // first brief is the welcome text
    const brief = run("brief"); // second is the compass, with the hint line
    const hintLine = brief.split("\n").find((l) => l.includes("Hint:"));
    expect(hintLine).toBeDefined();
    const hinted = hintLine!
      .replace(/.*Hint:\s*/, "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(hinted.length).toBeGreaterThan(0);
    for (const cmd of hinted) {
      const out = run(cmd);
      expect(out, `hint "${cmd}" should not be an unknown command`).not.toContain(
        "Unknown command",
      );
      expect(out, `hint "${cmd}" should produce output`).not.toBe("");
      expect(out, `hint "${cmd}" should not return an empty result`).not.toContain(
        "No matching notes",
      );
    }
  });

  it("quest list is not empty in the default world", () => {
    const list = run("quest list");
    expect(list).toContain("First Steps");
    expect(list).not.toContain("(none in this world");
  });

  // ── The First Steps loop end to end ───────────────────────────────────────

  it("a newcomer can complete First Steps with the five taught commands", () => {
    expect(run("quest start First Steps")).toContain("Started:");
    run("look");
    run("note the workbench turns intent into verified outcomes");
    run("recall workbench");
    run("memory set goal learn the ropes");
    run("say hello");

    const status = run("quest status");
    expect(status).toContain("All steps complete!");

    const done = run("quest complete");
    expect(done.toLowerCase()).toContain("complete");
    const entity = engine.entities.get(eid);
    expect(entity?.properties.title).toBe("Oriented");
  });

  // ── Empty states guide instead of dead-ending ─────────────────────────────

  it("guide overview works and pool recall zero-hits point somewhere useful", () => {
    const guide = run("guide");
    expect(guide).toContain("guide");
    const miss = run("pool guide recall zebra unicorn");
    expect(miss).toContain("pool guide list");
  });

  it("worlds without quests say so instead of advertising First Steps", () => {
    const bareDbPath = `/tmp/marina-onboarding-bare-${Date.now()}.db`;
    const bareDb = new MarinaDB(bareDbPath);
    try {
      const bare = new Engine({
        startRoom: roomId("test/start"),
        tickInterval: 60_000,
        db: bareDb,
      });
      bare.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
      const bareConn = new MockConnection("bare_conn");
      bare.addConnection(bareConn);
      const res = bare.login("bare_conn", "BareUser");
      if (!("entityId" in res)) throw new Error("bare login failed");
      bareConn.clear();
      bare.processCommand(res.entityId, "quest");
      const text = plain(bareConn.allText().join("\n"));
      expect(text).not.toContain("First Steps");
      expect(text).toContain("No objectives are defined in this world");
    } finally {
      bareDb.close();
      cleanupDb(bareDbPath);
    }
  });

  // ── Refusals carry a path forward ─────────────────────────────────────────

  it("the agent.spawn refusal tells a solo operator how to elevate", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-so-runtime-is-available";
    try {
      const out = run("agent spawn Scout");
      // Rank-0 newcomer: the gate refuses — but the refusal must name the
      // operator bootstrap instead of stranding them at a standing number.
      expect(out).toContain("MARINA_ADMINS");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
