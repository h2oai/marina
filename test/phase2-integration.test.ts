// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { getRank, setRank } from "../src/engine/permissions";
import { MarinaDB } from "../src/persistence/database";
import type { EntityRank } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_phase2_integration.db";

describe("Phase 2 Integration", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;
  let conn3: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Starting Room",
        long: "The starting room.",
        exits: { north: roomId("test/north") },
      }),
    );
    engine.registerRoom(
      roomId("test/north"),
      makeTestRoom({
        short: "Northern Room",
        long: "The northern room.",
        exits: { south: roomId("test/start") },
      }),
    );

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    conn3 = new MockConnection("c3");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.addConnection(conn3);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    engine.spawnEntity("c3", "Charlie");
    conn1.clear();
    conn2.clear();
    conn3.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("end-to-end: group creation → channel + board → messaging → tasks → macros", () => {
    // 1. Alice creates a group
    engine.processCommand(conn1.entity!, "group create devs Developers");
    expect(conn1.lastText()).toContain('Created group "Developers"');

    // 2. Bob joins the group
    engine.processCommand(conn2.entity!, "group join Developers");
    expect(conn2.lastText()).toContain("Joined group");

    // 3. Alice sends a message on the group channel
    const group = engine.groupManager!.getByName("Developers")!;
    const channel = engine.channelManager!.getChannel(group.channelId!)!;
    engine.processCommand(conn1.entity!, `channel send ${channel.name} Welcome to the team!`);
    // Bob should receive it
    expect(conn2.lastText()).toContain("Welcome to the team!");

    // 4. Alice posts on the group board
    const board = engine.boardManager!.getBoard(group.boardId!)!;
    engine.processCommand(
      conn1.entity!,
      `board post ${board.name} Project Kickoff | We're starting a new project`,
    );
    expect(stripAnsi(conn1.lastText())).toContain("Posted #");

    // 5. Bob reads the board
    conn2.clear();
    engine.processCommand(conn2.entity!, `board read ${board.name}`);
    expect(conn2.lastText()).toContain("Project Kickoff");

    // 6. Alice creates a task
    engine.processCommand(conn1.entity!, "task create Build the widget | Implement widget feature");
    expect(conn1.lastText()).toContain("Created task");

    // 7. Bob claims and submits
    engine.processCommand(conn2.entity!, "task claim 1");
    expect(conn2.lastText()).toContain("Claimed task");

    engine.processCommand(conn2.entity!, "task submit 1 Widget is built and tested");
    expect(conn2.lastText()).toContain("Submitted work");

    // 8. Alice approves
    conn1.clear();
    conn2.clear();
    engine.processCommand(conn1.entity!, "task approve 1 Bob");
    expect(conn1.lastText()).toContain("Approved");
    expect(conn2.lastText()).toContain("approved");

    // 9. Alice creates a macro
    engine.processCommand(conn1.entity!, "macro create greet say Hello everyone!");
    expect(conn1.lastText()).toContain("Created macro");

    // 10. Run the macro (direct dispatch — no "macro" prefix needed)
    conn1.clear();
    engine.processCommand(conn1.entity!, "greet");
    const texts = conn1.allText();
    expect(texts.some((t) => t.includes("Hello everyone!"))).toBe(true);
  });

  it("rank system: check, set, and permissions", () => {
    // Default rank is newcomer (0)
    engine.processCommand(conn1.entity!, "rank");
    expect(stripAnsi(conn1.lastText())).toContain("Newcomer");

    // Non-sovereign can't set ranks
    conn1.clear();
    engine.processCommand(conn1.entity!, "rank Bob 2");
    expect(conn1.lastText()).toContain("Only sovereigns");

    // Make Alice sovereign
    const alice = engine.entities.get(conn1.entity!)!;
    setRank(alice, 9 as EntityRank);

    // Now Alice can set ranks
    conn1.clear();
    engine.processCommand(conn1.entity!, "rank Bob 2");
    expect(stripAnsi(conn1.lastText())).toContain("Coordinator");
    expect(stripAnsi(conn2.lastText())).toContain("Coordinator");

    // Verify Bob's rank
    const bob = engine.entities.get(conn2.entity!)!;
    expect(getRank(bob)).toBe(2);
  });

  it("all managers exist when db is provided", () => {
    expect(engine.channelManager).toBeDefined();
    expect(engine.boardManager).toBeDefined();
    expect(engine.groupManager).toBeDefined();
    expect(engine.taskManager).toBeDefined();
    expect(engine.macroManager).toBeDefined();
  });

  it("managers are undefined when no db is provided", () => {
    const noDB = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    expect(noDB.channelManager).toBeUndefined();
    expect(noDB.boardManager).toBeUndefined();
    expect(noDB.groupManager).toBeUndefined();
    expect(noDB.taskManager).toBeUndefined();
    expect(noDB.macroManager).toBeUndefined();
  });

  it("DB migration system works correctly", () => {
    // The DB already has migrations applied in beforeEach
    // Verify by creating a new DB pointing to same file — should not error
    const db2 = new MarinaDB(TEST_DB);
    // Should be able to use all tables
    db2.createChannel({ id: "test:ch", type: "custom", name: "test" });
    const ch = db2.getChannel("test:ch");
    expect(ch).toBeDefined();
    expect(ch!.name).toBe("test");
    db2.close();
  });

  it("help command includes new Phase 2 commands", () => {
    conn1.clear();
    engine.processCommand(conn1.entity!, "help");
    const text = conn1.lastText();
    expect(text).toContain("rank");
    expect(text).toContain("channel");
    expect(text).toContain("board");
    expect(text).toContain("group");
    expect(text).toContain("task");
    expect(text).toContain("macro");
  });

  it("channel alias 'ch' works", () => {
    engine.processCommand(conn1.entity!, "channel create test");
    conn1.clear();
    engine.processCommand(conn1.entity!, "ch list");
    expect(conn1.lastText()).toContain("test");
  });

  it("group alias 'team' works", () => {
    engine.processCommand(conn1.entity!, "team create test TestTeam");
    expect(conn1.lastText()).toContain("Created group");
  });

  it("cross-system: group members can use group channel and board", () => {
    // Create group
    engine.processCommand(conn1.entity!, "group create team TeamAlpha");
    engine.processCommand(conn2.entity!, "group join TeamAlpha");

    const group = engine.groupManager!.getByName("TeamAlpha")!;
    const channelName = engine.channelManager!.getChannel(group.channelId!)!.name;
    const boardName = engine.boardManager!.getBoard(group.boardId!)!.name;

    // Both can send channel messages
    conn2.clear();
    engine.processCommand(conn1.entity!, `channel send ${channelName} Hello team`);
    expect(conn2.lastText()).toContain("Hello team");

    // Both can post to group board
    engine.processCommand(conn2.entity!, `board post ${boardName} Bob's Idea | A great idea`);
    expect(conn2.lastText()).toContain("Posted");

    // Non-member can't send to group channel
    conn3.clear();
    engine.processCommand(conn3.entity!, `channel send ${channelName} Intruder`);
    expect(conn3.lastText()).toContain("not in channel");
  });

  it("channel history persists messages", () => {
    engine.processCommand(conn1.entity!, "channel create persist");
    engine.processCommand(conn2.entity!, "channel join persist");

    engine.processCommand(conn1.entity!, "channel send persist Message 1");
    engine.processCommand(conn2.entity!, "channel send persist Message 2");
    engine.processCommand(conn1.entity!, "channel send persist Message 3");

    conn1.clear();
    engine.processCommand(conn1.entity!, "channel history persist 10");
    const text = conn1.lastText();
    expect(text).toContain("Message 1");
    expect(text).toContain("Message 2");
    expect(text).toContain("Message 3");
  });

  it("board posts support voting by multiple users", () => {
    engine.processCommand(conn1.entity!, "board create votes");
    engine.processCommand(conn1.entity!, "board post votes Popular | A popular post");

    engine.processCommand(conn1.entity!, "board vote 1 up");
    engine.processCommand(conn2.entity!, "board vote 1 up");
    engine.processCommand(conn3.entity!, "board vote 1 up");

    conn1.clear();
    engine.processCommand(conn1.entity!, "board read votes 1");
    expect(conn1.lastText()).toContain("Votes: 3");
  });

  it("task lifecycle: open → claimed → submitted → approved → completed", () => {
    const tm = engine.taskManager!;
    const task = tm.create({
      title: "Lifecycle",
      creatorId: conn1.entity!,
      creatorName: "Alice",
    });
    expect(task.status).toBe("open");

    tm.claim(task.id, conn2.entity!, "Bob");
    const claimed = tm.getClaim(task.id, conn2.entity!);
    expect(claimed!.status).toBe("claimed");

    tm.submit(task.id, conn2.entity!, "Done");
    const submitted = tm.getClaim(task.id, conn2.entity!);
    expect(submitted!.status).toBe("submitted");

    tm.approveSubmission(task.id, conn2.entity!, conn1.entity!);
    const approved = tm.getClaim(task.id, conn2.entity!);
    expect(approved!.status).toBe("approved");

    const completed = tm.get(task.id);
    expect(completed!.status).toBe("completed");
  });
});
