// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_organization.db";

describe("Organization Primitives", () => {
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

  // ─── Task Bundles ────────────────────────────────────────────────────────

  describe("Task Bundles", () => {
    it("should create a bundle", () => {
      engine.processCommand(conn1.entity!, "task bundle Sprint 1 | First sprint tasks");
      expect(conn1.lastText()).toContain("Created bundle #");
    });

    it("should create children and assign to bundle", () => {
      engine.processCommand(conn1.entity!, "task bundle Sprint 1 | First sprint");
      const bundleText = conn1.lastText();
      const bundleId = bundleText.match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, "task create Fix login | Login is broken");
      const taskText = conn1.lastText();
      const taskId = taskText.match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, `task assign ${taskId} ${bundleId}`);
      expect(conn1.lastText()).toContain(`Assigned task #${taskId} to bundle #${bundleId}`);
    });

    it("should list children of a bundle", () => {
      engine.processCommand(conn1.entity!, "task bundle Sprint 1 | First sprint");
      const bundleId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, "task create Sub task A | Desc A");
      const idA = conn1.lastText().match(/#(\d+)/)?.[1];
      engine.processCommand(conn1.entity!, "task create Sub task B | Desc B");
      const idB = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, `task assign ${idA} ${bundleId}`);
      engine.processCommand(conn1.entity!, `task assign ${idB} ${bundleId}`);
      conn1.clear();

      engine.processCommand(conn1.entity!, `task children ${bundleId}`);
      const text = stripAnsi(conn1.lastText());
      expect(text).toContain("Sub task A");
      expect(text).toContain("Sub task B");
      expect(text).toContain("0/2");
    });

    it("should show bundle status via task info", () => {
      engine.processCommand(conn1.entity!, "task bundle My Bundle");
      const bundleId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, "task create Child 1");
      const childId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, `task assign ${childId} ${bundleId}`);
      conn1.clear();

      engine.processCommand(conn1.entity!, `task info ${bundleId}`);
      expect(conn1.lastText()).toContain("Children: 0/1 completed");
    });

    it("should show parent in task info for child tasks", () => {
      engine.processCommand(conn1.entity!, "task bundle Parent");
      const bundleId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, "task create Child task");
      const childId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, `task assign ${childId} ${bundleId}`);
      conn1.clear();

      engine.processCommand(conn1.entity!, `task info ${childId}`);
      expect(conn1.lastText()).toContain(`Parent bundle: #${bundleId}`);
    });

    it("should reject assign if not creator", () => {
      engine.processCommand(conn1.entity!, "task bundle Owner Bundle");
      const bundleId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, "task create My task");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      // Bob tries to assign Alice's task
      engine.processCommand(conn2.entity!, `task assign ${taskId} ${bundleId}`);
      expect(conn2.lastText()).toContain("Cannot assign");
    });
  });

  // ─── Numeric Scoring ────────────────────────────────────────────────────

  describe("Numeric Scoring", () => {
    it("should vote with a score", () => {
      engine.processCommand(conn1.entity!, "board create proposals");
      conn1.clear();
      engine.processCommand(conn1.entity!, "board post proposals Test Proposal | A good idea");
      const postId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, `board vote ${postId} up 8`);
      expect(conn1.lastText()).toContain("score: 8");
      expect(conn1.lastText()).toContain("Total: 1");
    });

    it("should reject invalid scores", () => {
      engine.processCommand(conn1.entity!, "board create scoring");
      engine.processCommand(conn1.entity!, "board post scoring Item | Body");
      const postId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, `board vote ${postId} up 11`);
      expect(conn1.lastText()).toContain("Score must be between 1 and 10");
    });

    it("should show scores breakdown", () => {
      engine.processCommand(conn1.entity!, "board create rated");
      engine.processCommand(conn1.entity!, "board post rated Proposal | Body text");
      const postId = conn1.lastText().match(/#(\d+)/)?.[1];

      engine.processCommand(conn1.entity!, `board vote ${postId} up 7`);
      engine.processCommand(conn2.entity!, `board vote ${postId} up 9`);
      conn1.clear();

      engine.processCommand(conn1.entity!, `board scores ${postId}`);
      const text = conn1.lastText();
      expect(text).toContain("score: 7");
      expect(text).toContain("score: 9");
    });

    it("should show average score in board read", () => {
      engine.processCommand(conn1.entity!, "board create avgs");
      engine.processCommand(conn1.entity!, "board post avgs Average Test | Body");
      const postId = conn1.lastText().match(/#(\d+)/)?.[1];

      engine.processCommand(conn1.entity!, `board vote ${postId} up 6`);
      engine.processCommand(conn2.entity!, `board vote ${postId} up 8`);
      conn1.clear();

      engine.processCommand(conn1.entity!, `board read avgs ${postId}`);
      expect(conn1.lastText()).toContain("Avg Score: 7.0");
    });

    it("should work with plain votes (no score)", () => {
      engine.processCommand(conn1.entity!, "board create plain");
      engine.processCommand(conn1.entity!, "board post plain Plain Vote | Body");
      const postId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, `board vote ${postId} up`);
      expect(conn1.lastText()).toContain("Total: 1");
      expect(conn1.lastText()).not.toContain("score:");
    });
  });

  // ─── Room Entry Guards ──────────────────────────────────────────────────

  describe("Room Entry Guards", () => {
    it("should allow entry when canEnter returns true", () => {
      engine.registerRoom(
        roomId("test/open"),
        makeTestRoom({
          short: "Open Room",
          canEnter: () => true,
        }),
      );
      engine.registerRoom(
        roomId("test/start"),
        makeTestRoom({
          short: "Start",
          exits: { north: roomId("test/open") },
        }),
      );

      engine.processCommand(conn1.entity!, "north");
      const text = conn1.allTextJoined();
      expect(text).toContain("Open Room");
    });

    it("should deny entry when canEnter returns a string", () => {
      engine.registerRoom(
        roomId("test/locked"),
        makeTestRoom({
          short: "Locked Room",
          canEnter: () => "The door is locked. You need a key.",
        }),
      );
      engine.registerRoom(
        roomId("test/start"),
        makeTestRoom({
          short: "Start",
          exits: { north: roomId("test/locked") },
        }),
      );

      engine.processCommand(conn1.entity!, "north");
      expect(conn1.lastText()).toContain("The door is locked. You need a key.");
    });

    it("should pass entity to canEnter for conditional guards", () => {
      engine.registerRoom(
        roomId("test/vip"),
        makeTestRoom({
          short: "VIP Room",
          canEnter: (_ctx, entity) => {
            // Only Alice can enter
            return entity === conn1.entity ? true : "VIP access only.";
          },
        }),
      );
      engine.registerRoom(
        roomId("test/start"),
        makeTestRoom({
          short: "Start",
          exits: { north: roomId("test/vip") },
        }),
      );

      // Alice should be allowed
      engine.processCommand(conn1.entity!, "north");
      const aliceText = conn1.allTextJoined();
      expect(aliceText).toContain("VIP Room");

      // Bob should be denied
      engine.processCommand(conn2.entity!, "north");
      expect(conn2.lastText()).toContain("VIP access only.");
    });
  });

  // ─── Agent Activity Tracking ─────────────────────────────────────────────

  describe("Agent Activity Tracking", () => {
    it("should return last activity for an entity", () => {
      engine.processCommand(conn1.entity!, "look");
      const activity = db.getLastActivity(conn1.entity!);
      expect(activity).toBeDefined();
      expect(activity!.type).toBe("command");
      expect(activity!.input).toBe("look");
    });

    it("should return undefined for entity with no activity", () => {
      const activity = db.getLastActivity("e_nonexistent" as EntityId);
      expect(activity).toBeUndefined();
    });

    it("should return active entities", () => {
      engine.processCommand(conn1.entity!, "look");
      engine.processCommand(conn1.entity!, "help");
      engine.processCommand(conn2.entity!, "look");

      const active = db.getActiveEntities(60_000);
      expect(active.length).toBeGreaterThanOrEqual(2);

      const alice = active.find((a) => a.entityId === conn1.entity);
      expect(alice).toBeDefined();
      expect(alice!.commandCount).toBe(2);

      const bob = active.find((a) => a.entityId === conn2.entity);
      expect(bob).toBeDefined();
      expect(bob!.commandCount).toBe(1);
    });
  });

  // ─── Task Event Triggers ─────────────────────────────────────────────────

  describe("Task Event Triggers", () => {
    it("should fire task_claimed event when claiming a task", () => {
      engine.processCommand(conn1.entity!, "task create Fix it | Fix the thing");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      const _eventsBefore = engine.getEventLog().length;
      engine.processCommand(conn2.entity!, `task claim ${taskId}`);

      const events = engine.getEventLog();
      const claimEvent = events.find(
        (e) => e.type === "task_claimed" && "taskId" in e && e.taskId === Number(taskId),
      );
      expect(claimEvent).toBeDefined();
      expect("entity" in claimEvent! && claimEvent.entity).toBe(conn2.entity!);
    });

    it("should fire task_submitted event when submitting work", () => {
      engine.processCommand(conn1.entity!, "task create Fixable | Fix it");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      engine.processCommand(conn2.entity!, `task claim ${taskId}`);

      engine.processCommand(conn2.entity!, `task submit ${taskId} Done fixing`);

      const events = engine.getEventLog();
      const submitEvent = events.find(
        (e) => e.type === "task_submitted" && "taskId" in e && e.taskId === Number(taskId),
      );
      expect(submitEvent).toBeDefined();
    });

    it("should fire task_approved event when approving", () => {
      engine.processCommand(conn1.entity!, "task create Approvable | Approve me");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      engine.processCommand(conn2.entity!, `task claim ${taskId}`);
      engine.processCommand(conn2.entity!, `task submit ${taskId} My work`);

      engine.processCommand(conn1.entity!, `task approve ${taskId} Bob`);

      const events = engine.getEventLog();
      const approveEvent = events.find(
        (e) => e.type === "task_approved" && "taskId" in e && e.taskId === Number(taskId),
      );
      expect(approveEvent).toBeDefined();
    });

    it("should fire task_rejected event when rejecting", () => {
      engine.processCommand(conn1.entity!, "task create Rejectable | Reject me");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      engine.processCommand(conn2.entity!, `task claim ${taskId}`);
      engine.processCommand(conn2.entity!, `task submit ${taskId} Bad work`);

      engine.processCommand(conn1.entity!, `task reject ${taskId} Bob`);

      const events = engine.getEventLog();
      const rejectEvent = events.find(
        (e) => e.type === "task_rejected" && "taskId" in e && e.taskId === Number(taskId),
      );
      expect(rejectEvent).toBeDefined();
    });

    it("should make task events available for macro triggers", () => {
      // Create a task and have Bob claim it
      engine.processCommand(conn1.entity!, "task create Trigger test");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn2.entity!, `task claim ${taskId}`);

      // Verify the task_claimed event was logged and visible
      const events = engine.getEventLog();
      const claimEvents = events.filter((e) => e.type === "task_claimed");
      expect(claimEvents.length).toBe(1);

      // Verify it has the right shape for macro trigger matching
      const evt = claimEvents[0]!;
      expect("entity" in evt).toBe(true);
      expect("taskId" in evt).toBe(true);
    });
  });

  // ─── Task Invalid State Transitions ──────────────────────────────────────

  describe("Task Invalid State Transitions", () => {
    it("should remove non-bounty claimed tasks from open work", () => {
      engine.processCommand(conn1.entity!, "task create Single owner task | Desc");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn2.entity!, `task claim ${taskId}`);

      const task = db.getTask(Number(taskId));
      expect(task?.status).toBe("claimed");
      expect(
        engine.taskManager?.list({ status: "open" }).some((t) => t.id === Number(taskId)),
      ).toBe(false);
    });

    it("should reject submit without claiming first", () => {
      engine.processCommand(conn1.entity!, "task create Unclaimed task | Desc");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn2.entity!, `task submit ${taskId} My work`);
      expect(conn2.lastText()).toContain("Cannot submit");
    });

    it("should reject claiming a task twice by the same entity", () => {
      engine.processCommand(conn1.entity!, "task create Double claim | Desc");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn2.entity!, `task claim ${taskId}`);
      expect(conn2.lastText()).toContain("Claimed");
      conn2.clear();

      engine.processCommand(conn2.entity!, `task claim ${taskId}`);
      expect(conn2.lastText()).toContain("Cannot claim");
    });

    it("should reject approval by non-creator", () => {
      engine.processCommand(conn1.entity!, "task create Approve test | Desc");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn2.entity!, `task claim ${taskId}`);
      engine.processCommand(conn2.entity!, `task submit ${taskId} Done`);
      conn2.clear();

      // Bob (non-creator) tries to approve his own submission
      engine.processCommand(conn2.entity!, `task approve ${taskId} Bob`);
      expect(conn2.lastText()).toContain("Cannot approve");
    });

    it("should notify the creator when a task is submitted", () => {
      engine.processCommand(conn1.entity!, "task create Review me | Desc");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn2.entity!, `task claim ${taskId}`);
      engine.processCommand(conn2.entity!, `task submit ${taskId} Done`);

      const notice = stripAnsi(conn1.lastText());
      expect(notice).toContain("Bob submitted task");
      expect(notice).toContain(`task approve ${taskId} Bob`);
      expect(notice).toContain(`task reject ${taskId} Bob`);
    });

    it("should reject cancellation by non-creator", () => {
      engine.processCommand(conn1.entity!, "task create Cancel test | Desc");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      // Bob (non-creator) tries to cancel
      engine.processCommand(conn2.entity!, `task cancel ${taskId}`);
      expect(conn2.lastText()).toContain("Cannot cancel");

      // Task should still exist and be open
      conn1.clear();
      engine.processCommand(conn1.entity!, `task info ${taskId}`);
      expect(conn1.lastText()).toContain("open");
    });

    it("should reject claiming a cancelled task", () => {
      engine.processCommand(conn1.entity!, "task create Will cancel | Desc");
      const taskId = conn1.lastText().match(/#(\d+)/)?.[1];
      conn1.clear();

      engine.processCommand(conn1.entity!, `task cancel ${taskId}`);
      conn2.clear();

      engine.processCommand(conn2.entity!, `task claim ${taskId}`);
      expect(conn2.lastText()).toContain("Cannot claim");
    });
  });

  // ─── DB Methods ─────────────────────────────────────────────────────────

  describe("DB Bundle Methods", () => {
    it("should create task with parent_task_id", () => {
      const parentId = db.createTask({
        title: "Parent",
        creatorId: "e_1",
        creatorName: "Alice",
      });
      const childId = db.createTask({
        title: "Child",
        creatorId: "e_1",
        creatorName: "Alice",
        parentTaskId: parentId,
      });
      const child = db.getTask(childId);
      expect(child).toBeDefined();
      expect(child!.parent_task_id).toBe(parentId);
    });

    it("should list tasks by parentId", () => {
      const parentId = db.createTask({
        title: "Parent",
        creatorId: "e_1",
        creatorName: "Alice",
      });
      db.createTask({
        title: "Child 1",
        creatorId: "e_1",
        creatorName: "Alice",
        parentTaskId: parentId,
      });
      db.createTask({
        title: "Child 2",
        creatorId: "e_1",
        creatorName: "Alice",
        parentTaskId: parentId,
      });
      db.createTask({
        title: "Unrelated",
        creatorId: "e_1",
        creatorName: "Alice",
      });

      const children = db.listTasks({ parentId });
      expect(children.length).toBe(2);
    });

    it("should get child task count", () => {
      const parentId = db.createTask({
        title: "Parent",
        creatorId: "e_1",
        creatorName: "Alice",
      });
      const childId = db.createTask({
        title: "Child",
        creatorId: "e_1",
        creatorName: "Alice",
        parentTaskId: parentId,
      });
      db.createTask({
        title: "Child 2",
        creatorId: "e_1",
        creatorName: "Alice",
        parentTaskId: parentId,
      });
      db.updateTaskStatus(childId, "completed");

      const counts = db.getChildTaskCount(parentId);
      expect(counts.total).toBe(2);
      expect(counts.completed).toBe(1);
    });

    it("should set task parent", () => {
      const parentId = db.createTask({
        title: "Parent",
        creatorId: "e_1",
        creatorName: "Alice",
      });
      const childId = db.createTask({
        title: "Child",
        creatorId: "e_1",
        creatorName: "Alice",
      });
      expect(db.getTask(childId)!.parent_task_id).toBeNull();

      db.setTaskParent(childId, parentId);
      expect(db.getTask(childId)!.parent_task_id).toBe(parentId);
    });
  });

  describe("DB Scoring Methods", () => {
    it("should store and retrieve scores", () => {
      db.createBoard({ id: "b1", name: "test" });
      const postId = db.createBoardPost({
        boardId: "b1",
        authorId: "e_1",
        authorName: "Alice",
        body: "Test post",
      });

      db.voteBoardPost(postId, "e_1", 1, 8);
      db.voteBoardPost(postId, "e_2", 1, 6);

      const scores = db.getBoardPostScores(postId);
      expect(scores.length).toBe(2);
      expect(scores.find((s) => s.entity_id === "e_1")?.score).toBe(8);
      expect(scores.find((s) => s.entity_id === "e_2")?.score).toBe(6);
    });

    it("should return score matrix", () => {
      db.createBoard({ id: "b2", name: "matrix" });
      const p1 = db.createBoardPost({
        boardId: "b2",
        authorId: "e_1",
        authorName: "Alice",
        body: "Post 1",
      });
      const p2 = db.createBoardPost({
        boardId: "b2",
        authorId: "e_1",
        authorName: "Alice",
        body: "Post 2",
      });

      db.voteBoardPost(p1, "e_1", 1, 7);
      db.voteBoardPost(p1, "e_2", 1, 9);
      db.voteBoardPost(p2, "e_1", 1, 5);

      const matrix = db.getScoreMatrix("b2");
      expect(matrix.length).toBe(3);

      const p1Scores = matrix.filter((r) => r.post_id === p1);
      expect(p1Scores.length).toBe(2);
    });
  });
});
