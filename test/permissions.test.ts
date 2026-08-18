// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { getRank, setRank } from "../src/engine/permissions";
import { MarinaDB } from "../src/persistence/database";
import type { EntityRank } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, grantAllGates, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_permissions.db";

describe("Command Permissions", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn1 = new MockConnection("c1");
    engine.addConnection(conn1);
    engine.spawnEntity("c1", "Alice");
    conn1.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  // ─── Rank Gating ──────────────────────────────────────────────────────────

  describe("Rank Gating", () => {
    it("should block guest from admin command", () => {
      const entity = engine.entities.get(conn1.entity!);
      expect(getRank(entity!)).toBe(0);

      engine.processCommand(conn1.entity!, "admin stats");
      // P3: high-tier commands gate at rank 5 (safety threshold) + a
      // per-operation competence proof. The rank check fires first.
      expect(conn1.lastText()).toContain("rank 5");
      expect(conn1.lastText()).toContain("admin");
      // Verify no state change — rank unchanged
      expect(getRank(entity!)).toBe(0);
    });

    it("should block guest from build command", () => {
      engine.processCommand(conn1.entity!, "build room test/new");
      expect(conn1.lastText()).toContain("rank 4");
      expect(conn1.lastText()).toContain("build");
      // Verify the room was NOT created
      expect(engine.rooms.get(roomId("test/new"))).toBeUndefined();
    });

    it("should allow builder to use build command", () => {
      const entity = engine.entities.get(conn1.entity!)!;
      setRank(entity, 4 as EntityRank);

      engine.processCommand(conn1.entity!, "build room test/new A new room");
      expect(conn1.lastText()).toContain('Created room "test/new"');
    });

    it("should block builder from admin command", () => {
      const entity = engine.entities.get(conn1.entity!)!;
      setRank(entity, 4 as EntityRank);

      engine.processCommand(conn1.entity!, "admin stats");
      // P3: rank 4 still blocks because admin gates at rank 5 (safety threshold).
      expect(conn1.lastText()).toContain("rank 5");
      // Verify rank was not changed by the failed command
      expect(getRank(entity)).toBe(4);
    });

    it("should allow admin to use admin command", () => {
      const entity = engine.entities.get(conn1.entity!)!;
      setRank(entity, 9 as EntityRank);
      grantAllGates(db, conn1.entity!);

      engine.processCommand(conn1.entity!, "admin stats");
      expect(conn1.lastText()).toContain("Server Stats");
    });

    it("should allow admin to use build command", () => {
      const entity = engine.entities.get(conn1.entity!)!;
      setRank(entity, 9 as EntityRank);

      engine.processCommand(conn1.entity!, "build room test/admin A new room");
      expect(conn1.lastText()).toContain('Created room "test/admin"');
    });
  });

  // ─── Collaboration commands remain open ───────────────────────────────────

  describe("Open Commands", () => {
    it("should allow guest to use shout", () => {
      engine.processCommand(conn1.entity!, "shout hello everyone!");
      // shout should work — doesn't produce an error about rank
      expect(conn1.lastText()).not.toContain("rank");
    });

    it("should allow guest to use task commands", () => {
      engine.processCommand(conn1.entity!, "task list");
      expect(conn1.lastText()).toContain("No open tasks");
    });

    it("should allow guest to use channel commands", () => {
      engine.processCommand(conn1.entity!, "channel list");
      // Should get channel output, not a rank error
      expect(conn1.lastText()).not.toContain("rank");
    });

    it("should allow guest to use group commands", () => {
      engine.processCommand(conn1.entity!, "group list");
      expect(conn1.lastText()).not.toContain("rank");
    });

    it("should allow guest to use pool commands", () => {
      engine.processCommand(conn1.entity!, "pool list");
      expect(conn1.lastText()).not.toContain("rank");
    });

    it("should allow guest to use say", () => {
      engine.processCommand(conn1.entity!, "say hello");
      expect(conn1.lastText()).not.toContain("rank");
    });
  });

  // ─── Activity-driven Promotion ────────────────────────────────────────────

  describe("Activity-driven Promotion", () => {
    it("should promote newcomer to coordinator on task create", () => {
      const entity = engine.entities.get(conn1.entity!)!;
      expect(getRank(entity)).toBe(0);

      engine.processCommand(conn1.entity!, "task create Test task | A test");
      expect(getRank(entity)).toBe(2);

      // Should see promotion message
      const all = conn1.allTextJoined();
      expect(all).toContain("coordinator");
      expect(all).toContain("rank is now");
    });

    it("should promote newcomer to coordinator on task claim", () => {
      // First create a task as a second entity
      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);
      engine.spawnEntity("c2", "Bob");
      conn2.clear();

      engine.processCommand(conn2.entity!, "task create Claimable task | Do this");
      const taskText = conn2.lastText();
      const taskId = taskText.match(/#(\d+)/)?.[1];

      // Now claim as Alice (guest)
      const entity = engine.entities.get(conn1.entity!)!;
      expect(getRank(entity)).toBe(0);

      engine.processCommand(conn1.entity!, `task claim ${taskId}`);
      expect(getRank(entity)).toBe(2);
    });

    it("should promote newcomer to coordinator on project create", () => {
      const entity = engine.entities.get(conn1.entity!)!;
      expect(getRank(entity)).toBe(0);

      engine.processCommand(conn1.entity!, "project create MyProject | A test project");
      expect(getRank(entity)).toBe(2);
    });

    it("should not re-promote already-promoted entity", () => {
      const entity = engine.entities.get(conn1.entity!)!;
      setRank(entity, 3 as EntityRank); // organizer

      engine.processCommand(conn1.entity!, "task create Another task | Test");

      // Should still be architect, not downgraded to builder
      expect(getRank(entity)).toBe(3);

      // Should not have a promotion message
      const all = conn1.allTextJoined();
      expect(all).not.toContain("rank is now");
    });

    it("should persist promotion to database", () => {
      // Use login() so a user record is created in the DB
      const conn2 = new MockConnection("c_persist");
      engine.addConnection(conn2);
      const result = engine.login("c_persist", "Persister");
      expect("entityId" in result).toBe(true);
      if (!("entityId" in result)) return;
      conn2.clear();

      engine.processCommand(result.entityId, "task create Persist test | Test");

      const user = db.getUserByName("Persister");
      expect(user).toBeTruthy();
      expect(user!.rank).toBe(2);
    });
  });

  // ─── Admin Bootstrap ──────────────────────────────────────────────────────

  describe("Admin Bootstrap (MARINA_ADMINS)", () => {
    it("should auto-promote on login when name is in MARINA_ADMINS", () => {
      const originalEnv = process.env.MARINA_ADMINS;
      process.env.MARINA_ADMINS = "Charlie,Dave";

      try {
        const conn3 = new MockConnection("c3");
        engine.addConnection(conn3);
        const result = engine.login("c3", "Charlie");
        expect("entityId" in result).toBe(true);

        if ("entityId" in result) {
          const entity = engine.entities.get(result.entityId)!;
          expect(getRank(entity)).toBe(9);
          // Sovereign bootstrap must grant the full safety-gate set so
          // operators can actually use admin/shell/key commands. Without
          // this, MARINA_ADMINS would promote in name only.
          for (const gateId of ["shell.exec", "agent.run", "key.manage", "admin.destructive"]) {
            const comp = db.getCompetence(result.entityId, gateId);
            expect(comp).toBeDefined();
            expect(comp?.supervised_only).toBe(0);
          }
        }
      } finally {
        if (originalEnv === undefined) {
          process.env.MARINA_ADMINS = undefined;
        } else {
          process.env.MARINA_ADMINS = originalEnv;
        }
      }
    });

    it("should not promote when name is not in MARINA_ADMINS", () => {
      const originalEnv = process.env.MARINA_ADMINS;
      process.env.MARINA_ADMINS = "Charlie,Dave";

      try {
        const conn3 = new MockConnection("c3");
        engine.addConnection(conn3);
        const result = engine.login("c3", "NotAdmin");
        expect("entityId" in result).toBe(true);

        if ("entityId" in result) {
          const entity = engine.entities.get(result.entityId)!;
          expect(getRank(entity)).toBe(0);
        }
      } finally {
        if (originalEnv === undefined) {
          process.env.MARINA_ADMINS = undefined;
        } else {
          process.env.MARINA_ADMINS = originalEnv;
        }
      }
    });

    it("should auto-promote on reconnect when name is in MARINA_ADMINS", () => {
      const originalEnv = process.env.MARINA_ADMINS;
      process.env.MARINA_ADMINS = "ReconAdmin";

      try {
        // First login to create session
        const conn3 = new MockConnection("c3");
        engine.addConnection(conn3);
        const loginResult = engine.login("c3", "ReconAdmin");
        expect("token" in loginResult).toBe(true);

        if ("token" in loginResult && loginResult.token) {
          // Disconnect
          engine.removeConnection("c3");

          // Reconnect
          const conn4 = new MockConnection("c4");
          engine.addConnection(conn4);
          const reconResult = engine.reconnect("c4", loginResult.token);
          expect("entityId" in reconResult).toBe(true);

          if ("entityId" in reconResult) {
            const entity = engine.entities.get(reconResult.entityId)!;
            expect(getRank(entity)).toBe(9);
          }
        }
      } finally {
        if (originalEnv === undefined) {
          process.env.MARINA_ADMINS = undefined;
        } else {
          process.env.MARINA_ADMINS = originalEnv;
        }
      }
    });
  });

  // ─── Help Rank Tags ──────────────────────────────────────────────────────

  describe("Help Rank Tags", () => {
    it("should show rank tags for gated commands in help", () => {
      engine.processCommand(conn1.entity!, "help all");
      const output = conn1.allTextJoined();
      // P3: high-tier commands collapsed onto the rank-5 (Architect)
      // safety threshold; per-operation gating is now via competence
      // proofs, not tier labels.
      expect(output).toContain("[Architect]");
      expect(output).toContain("[Builder]");
    });

    it("should filter commands by entity rank when no args", () => {
      engine.processCommand(conn1.entity!, "help");
      const output = conn1.allTextJoined();
      // Rank 0 entity should not see architect-gated commands
      expect(output).not.toContain("[Architect]");
      expect(output).toContain("help all");
    });
  });

  // ─── Connect Command Gating ───────────────────────────────────────────────

  describe("Connect Command Gating", () => {
    it("should block newcomer from connect command", () => {
      const entity = engine.entities.get(conn1.entity!);
      expect(getRank(entity!)).toBe(0);

      engine.processCommand(conn1.entity!, "connect list");
      // P3: connect now gates at rank 5 + connect.manage gate.
      expect(conn1.lastText()).toContain("rank 5");
      expect(conn1.lastText()).toContain("connect");
      expect(getRank(entity!)).toBe(0);
    });

    it("should allow steward to use connect command when granted", () => {
      const entity = engine.entities.get(conn1.entity!)!;
      setRank(entity, 7 as EntityRank);
      grantAllGates(db, conn1.entity!);

      engine.processCommand(conn1.entity!, "connect list");
      expect(conn1.lastText()).not.toContain("rank 5");
      expect(conn1.lastText()).not.toContain("Not enough standing");
    });
  });

  // ─── Build Subcommand Gating ──────────────────────────────────────────────

  describe("Build Subcommand Gating", () => {
    it("should allow builder to create spaces but not set code", () => {
      const entity = engine.entities.get(conn1.entity!)!;
      setRank(entity, 4 as EntityRank);

      // Builder can create spaces
      engine.processCommand(conn1.entity!, "build room test/sub A test");
      expect(conn1.lastText()).toContain('Created room "test/sub"');
      // Verify room was actually created
      expect(engine.rooms.get(roomId("test/sub"))).toBeDefined();

      // Builder cannot set code (requires architect, rank 5)
      conn1.clear();
      engine.processCommand(conn1.entity!, "build code test/sub export default {}");
      expect(conn1.lastText()).toContain("architect");
      // Verify rank wasn't changed by the denied sub-command
      expect(getRank(entity)).toBe(4);
    });

    it("should allow architect to set code", () => {
      const entity = engine.entities.get(conn1.entity!)!;
      setRank(entity, 5 as EntityRank);

      engine.processCommand(conn1.entity!, "build room test/arch A test");
      conn1.clear();
      engine.processCommand(conn1.entity!, "build code test/arch export default {}");
      // Should not get a rank error (may get a validation error, that's fine)
      expect(conn1.lastText()).not.toContain("architect");
    });
  });

  // ─── Supervised demonstration recording ──────────────────────────────────

  describe("Safety gate demonstration", () => {
    it("records a demonstration after a successful supervised run", async () => {
      const entity = engine.entities.get(conn1.entity!)!;
      setRank(entity, 9 as EntityRank);
      // Seed enough standing to pass admin.destructive (>= 250). Granting
      // gates here would skip the supervised path entirely, so we seed
      // standing only — the gate check returns supervisedOnly: true.
      const taskId = db.createTask({
        title: "seed",
        creatorId: conn1.entity!,
        creatorName: "Alice",
      });
      db.recordStandingEarned(conn1.entity!, "Alice", taskId, 300);

      // No competence row yet — first run is supervised.
      expect(db.getCompetence(conn1.entity!, "admin.destructive")).toBeUndefined();

      await engine.processCommand(conn1.entity!, "admin stats");
      expect(conn1.lastText()).toContain("Server Stats");

      // admin.destructive.demoThreshold === 1, so a single successful run
      // both records the demo and flips supervised_only to 0.
      const comp = db.getCompetence(conn1.entity!, "admin.destructive");
      expect(comp).toBeDefined();
      expect(comp?.demonstrations).toBe(1);
      expect(comp?.supervised_only).toBe(0);
    });

    it("does not record a demonstration when the entity is already unsupervised", async () => {
      const entity = engine.entities.get(conn1.entity!)!;
      setRank(entity, 9 as EntityRank);
      grantAllGates(db, conn1.entity!);

      const before = db.getCompetence(conn1.entity!, "admin.destructive");
      expect(before?.supervised_only).toBe(0);
      const beforeDemos = before?.demonstrations ?? 0;

      await engine.processCommand(conn1.entity!, "admin stats");

      // Grant already pinned demonstrations at 999; further unsupervised
      // runs should not increment a counter that's no longer used to gate.
      const after = db.getCompetence(conn1.entity!, "admin.destructive");
      expect(after?.supervised_only).toBe(0);
      expect(after?.demonstrations).toBe(beforeDemos);
    });
  });
});
