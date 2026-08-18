// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_tasks.db";

describe("Tasks", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    conn1.clear();
    conn2.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should create a task", () => {
    engine.processCommand(conn1.entity!, "task create Fix the bug | The login page is broken");
    expect(conn1.lastText()).toContain("Created task #");
    expect(conn1.lastText()).toContain("Fix the bug");
  });

  it("should list tasks", () => {
    engine.processCommand(conn1.entity!, "task create Task One | Desc one");
    engine.processCommand(conn1.entity!, "task create Task Two | Desc two");
    conn1.clear();
    engine.processCommand(conn1.entity!, "task list");
    const text = conn1.lastText();
    expect(text).toContain("Task One");
    expect(text).toContain("Task Two");
  });

  it("should show task info", () => {
    engine.processCommand(conn1.entity!, "task create Detailed Task | This has details");
    conn1.clear();
    engine.processCommand(conn1.entity!, "task info 1");
    const text = conn1.lastText();
    expect(text).toContain("Detailed Task");
    expect(text).toContain("This has details");
    expect(text).toContain("Alice");
  });

  it("should claim a task", () => {
    engine.processCommand(conn1.entity!, "task create Fix it | Fix the thing");
    conn2.clear();
    engine.processCommand(conn2.entity!, "task claim 1");
    expect(conn2.lastText()).toContain("Claimed task #1");
  });

  it("should submit work for a task", () => {
    engine.processCommand(conn1.entity!, "task create Fix it | Fix the thing");
    engine.processCommand(conn2.entity!, "task claim 1");
    conn2.clear();
    engine.processCommand(conn2.entity!, "task submit 1 I fixed the thing");
    expect(conn2.lastText()).toContain("Submitted work for task #1");
  });

  it("should approve a submission", () => {
    engine.processCommand(conn1.entity!, "task create Fix it | Fix the thing");
    engine.processCommand(conn2.entity!, "task claim 1");
    engine.processCommand(conn2.entity!, "task submit 1 Done");
    conn1.clear();
    conn2.clear();
    engine.processCommand(conn1.entity!, "task approve 1 Bob");
    expect(conn1.lastText()).toContain("Approved Bob's submission");
    expect(conn2.lastText()).toContain("approved");
  });

  it("should reject a submission", () => {
    engine.processCommand(conn1.entity!, "task create Fix it | Fix the thing");
    engine.processCommand(conn2.entity!, "task claim 1");
    engine.processCommand(conn2.entity!, "task submit 1 Bad fix");
    conn1.clear();
    conn2.clear();
    engine.processCommand(conn1.entity!, "task reject 1 Bob");
    expect(conn1.lastText()).toContain("Rejected Bob's submission");
    expect(conn2.lastText()).toContain("rejected");
  });

  it("should cancel a task", () => {
    engine.processCommand(conn1.entity!, "task create Cancel me | To be cancelled");
    conn1.clear();
    engine.processCommand(conn1.entity!, "task cancel 1");
    expect(conn1.lastText()).toContain("Cancelled task #1");
  });

  it("should prevent non-creator from cancelling", () => {
    engine.processCommand(conn1.entity!, "task create No cancel | Not yours");
    conn2.clear();
    engine.processCommand(conn2.entity!, "task cancel 1");
    expect(conn2.lastText()).toContain("Cannot cancel");
  });

  it("should prevent double claiming", () => {
    engine.processCommand(conn1.entity!, "task create Unique | Only one claim");
    engine.processCommand(conn2.entity!, "task claim 1");
    conn2.clear();
    engine.processCommand(conn2.entity!, "task claim 1");
    expect(conn2.lastText()).toContain("Cannot claim");
  });

  it("task manager should work directly", () => {
    const tm = engine.taskManager!;
    const task = tm.create({
      title: "Direct Task",
      description: "Created directly",
      creatorId: conn1.entity!,
      creatorName: "Alice",
    });
    expect(task.title).toBe("Direct Task");
    expect(task.status).toBe("open");

    const claim = tm.claim(task.id, conn2.entity!, "Bob");
    expect(claim).not.toBeNull();
    expect(claim!.status).toBe("claimed");

    expect(tm.submit(task.id, conn2.entity!, "My work")).toBe(true);
    expect(tm.approveSubmission(task.id, conn2.entity!, conn1.entity!)).toBe(true);

    const completed = tm.get(task.id);
    expect(completed!.status).toBe("completed");
  });

  it("should show claims in task info", () => {
    engine.processCommand(conn1.entity!, "task create Viewable | View claims");
    engine.processCommand(conn2.entity!, "task claim 1");
    engine.processCommand(conn2.entity!, "task submit 1 My submission text");
    conn1.clear();
    engine.processCommand(conn1.entity!, "task info 1");
    const text = conn1.lastText();
    expect(text).toContain("Claims:");
    expect(text).toContain("Bob");
    expect(text).toContain("My submission text");
  });

  it("should create a bounty task with standing", () => {
    engine.processCommand(conn1.entity!, "task create Fix the bridge | Repair it !10 bounty");
    const text = conn1.lastText();
    expect(text).toContain("Created task #1");
    expect(text).toContain("[bounty !10]");

    conn1.clear();
    engine.processCommand(conn1.entity!, "task info 1");
    const info = stripAnsi(conn1.lastText());
    expect(info).toContain("bounty");
    expect(info).toContain("Standing: !10");
  });

  it("should allow multiple agents to claim a bounty task", () => {
    engine.processCommand(conn1.entity!, "task create Bounty task | Do something !5 bounty");

    // Add a third connection
    const conn3 = new MockConnection("c3");
    engine.addConnection(conn3);
    engine.spawnEntity("c3", "Charlie");

    const claim1 = engine.taskManager!.claim(1, conn2.entity!, "Bob");
    expect(claim1).not.toBeNull();

    const claim2 = engine.taskManager!.claim(1, conn3.entity!, "Charlie");
    expect(claim2).not.toBeNull();

    const claims = engine.taskManager!.getClaims(1);
    expect(claims.length).toBe(2);
  });

  it("should reject other claims when approving bounty winner", () => {
    engine.processCommand(conn1.entity!, "task create Bounty race | First wins !15 bounty");

    const conn3 = new MockConnection("c3");
    engine.addConnection(conn3);
    engine.spawnEntity("c3", "Charlie");

    engine.taskManager!.claim(1, conn2.entity!, "Bob");
    engine.taskManager!.claim(1, conn3.entity!, "Charlie");

    engine.taskManager!.submit(1, conn2.entity!, "Bob's work");
    engine.taskManager!.submit(1, conn3.entity!, "Charlie's work");

    // Approve Bob
    const approved = engine.taskManager!.approveSubmission(1, conn2.entity!, conn1.entity!);
    expect(approved).toBe(true);

    // Charlie's claim should be rejected
    const charlieClaim = engine.taskManager!.getClaim(1, conn3.entity!);
    expect(charlieClaim).not.toBeNull();
    expect(charlieClaim?.status).toBe("rejected");

    // Bob's claim should be approved
    const bobClaim = engine.taskManager!.getClaim(1, conn2.entity!);
    expect(bobClaim).not.toBeNull();
    expect(bobClaim?.status).toBe("approved");
  });

  it("should record standing and show leaderboard", () => {
    engine.processCommand(conn1.entity!, "task create Win standing | Prize !20 bounty");
    engine.taskManager!.claim(1, conn2.entity!, "Bob");
    engine.taskManager!.submit(1, conn2.entity!, "Done");
    engine.taskManager!.approveSubmission(1, conn2.entity!, conn1.entity!);

    // Bob should have 20 standing
    const standing = engine.taskManager!.getEntityStanding(conn2.entity!);
    expect(standing).toBe(20);

    // Leaderboard
    const lb = engine.taskManager!.getStandingLeaderboard();
    expect(lb.length).toBe(1);
    expect(lb[0]!.entityName).toBe("Bob");
    expect(lb[0]!.total).toBe(20);
    expect(lb[0]!.taskCount).toBe(1);

    // Command-level standing display
    conn2.clear();
    engine.processCommand(conn2.entity!, "task standing");
    const text = stripAnsi(conn2.lastText());
    expect(text).toContain("Bob");
    expect(text).toContain("20 standing");
  });

  it("should search tasks via FTS", () => {
    engine.processCommand(
      conn1.entity!,
      "task create Attention mechanisms | Deep learning research",
    );
    engine.processCommand(conn1.entity!, "task create Fix database | Repair the connection pool");

    const results = engine.taskManager!.searchTasks("attention");
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Attention mechanisms");
  });

  it("should show tasks in recall results", () => {
    engine.processCommand(
      conn1.entity!,
      "task create Neural architecture | Build transformer model !5 bounty",
    );
    conn1.clear();
    engine.processCommand(conn1.entity!, "recall neural");
    const text = stripAnsi(conn1.lastText());
    expect(text).toContain("Related Tasks");
    expect(text).toContain("Neural architecture");
  });

  it("should list tasks with status filter", () => {
    engine.processCommand(conn1.entity!, "task create Task A | First task");
    engine.processCommand(conn1.entity!, "task create Task B | Second task");
    engine.processCommand(conn2.entity!, "task claim 1");
    engine.processCommand(conn2.entity!, "task submit 1 Done");
    engine.processCommand(conn1.entity!, "task approve 1 Bob");

    conn1.clear();
    engine.processCommand(conn1.entity!, "task list completed");
    const text = conn1.lastText();
    expect(text).toContain("Task A");
    expect(text).not.toContain("Task B");
  });

  it("should show bounty markers in task list", () => {
    engine.processCommand(conn1.entity!, "task create Regular task | Normal");
    engine.processCommand(conn1.entity!, "task create Bounty task | Special !10 bounty");
    conn1.clear();
    engine.processCommand(conn1.entity!, "task list");
    const text = conn1.lastText();
    expect(text).toContain("[bounty !10]");
    expect(text).toContain("Bounty task");
  });
});
