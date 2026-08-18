// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, grantAllGates, MockConnection, makeTestRoom } from "./helpers";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Admin Commands", () => {
  let db: MarinaDB;
  let engine: Engine;
  let adminConn: MockConnection;
  let adminEntity: EntityId;
  const dbPath = `/tmp/marina-admin-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db, dbPath });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    // Create admin user
    adminConn = new MockConnection("admin_conn");
    engine.addConnection(adminConn);
    const result = engine.login("admin_conn", "AdminUser");
    if ("entityId" in result) {
      adminEntity = result.entityId;
      const entity = engine.entities.get(adminEntity);
      if (entity) entity.properties.rank = 9;
      // Grant safety gates explicitly — bootstrap operator pattern.
      grantAllGates(db, adminEntity);
    }
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should reject non-admin users", () => {
    const conn = new MockConnection("user_conn");
    engine.addConnection(conn);
    const result = engine.login("user_conn", "NormalUser");
    if (!("entityId" in result)) return;

    conn.clear();
    engine.processCommand(result.entityId, "admin stats");
    // P3: admin gates at rank 5 + admin.destructive competence proof.
    expect(conn.lastText()).toContain("rank 5");
  });

  it("should show stats", () => {
    adminConn.clear();
    engine.processCommand(adminEntity, "admin stats");
    const text = adminConn.lastText();
    expect(text).toContain("Server Stats:");
    expect(text).toContain("Rooms:");
    expect(text).toContain("Entities:");
    expect(text).toContain("Online connections:");
    expect(text).toContain("Uptime:");
  });

  it("should kick players", () => {
    const userConn = new MockConnection("user_conn");
    engine.addConnection(userConn);
    const result = engine.login("user_conn", "Victim");
    if (!("entityId" in result)) return;

    adminConn.clear();
    engine.processCommand(adminEntity, "admin kick Victim");
    const kickTexts = adminConn.allText();
    expect(kickTexts.some((t) => t.includes("Kicked Victim"))).toBe(true);
  });

  it("should ban players", () => {
    adminConn.clear();
    engine.processCommand(adminEntity, "admin ban BadUser Being rude");
    const banTexts = adminConn.allText();
    expect(banTexts.some((t) => t.includes("Banned BadUser"))).toBe(true);
    expect(db.isBanned("baduser")).toBe(true);
  });

  it("should unban players", () => {
    db.addBan("baduser", "admin");
    adminConn.clear();
    engine.processCommand(adminEntity, "admin unban baduser");
    expect(adminConn.lastText()).toContain("Unbanned");
    expect(db.isBanned("baduser")).toBe(false);
  });

  it("should list bans", () => {
    db.addBan("user1", "admin", "Spam");
    db.addBan("user2", "admin", "Harassment");
    adminConn.clear();
    engine.processCommand(adminEntity, "admin bans");
    const text = adminConn.lastText();
    expect(text).toContain("Active bans");
    expect(text).toContain("user1");
    expect(text).toContain("user2");
  });

  it("should broadcast announcements", () => {
    const userConn = new MockConnection("user_conn");
    engine.addConnection(userConn);
    const result = engine.login("user_conn", "Listener");
    if (!("entityId" in result)) return;

    userConn.clear();
    adminConn.clear();
    engine.processCommand(adminEntity, "admin announce Server restart in 5 minutes");
    expect(adminConn.lastText()).toContain("Announcement sent");
    // Listener should receive the broadcast
    const listenerTexts = userConn.allText();
    expect(listenerTexts.some((t) => t.includes("[ADMIN]"))).toBe(true);
  });

  it("should show usage for missing subcommand", () => {
    adminConn.clear();
    engine.processCommand(adminEntity, "admin");
    expect(adminConn.lastText()).toContain("Usage:");
  });

  describe("snapshot", () => {
    const snapshotName = `t${Date.now().toString(36)}`;
    const snapshotDb = `seeds/${snapshotName}.db`;
    const snapshotMeta = `seeds/${snapshotName}.json`;

    afterEach(() => {
      for (const p of [snapshotDb, snapshotMeta]) {
        if (existsSync(p)) {
          try {
            rmSync(p);
          } catch {
            /* ignore */
          }
        }
      }
    });

    it("reject invalid snapshot name", () => {
      adminConn.clear();
      engine.processCommand(adminEntity, "admin snapshot ../../etc/passwd");
      expect(adminConn.lastText()).toContain("Invalid snapshot name");
    });

    it("show usage when no name given", () => {
      adminConn.clear();
      engine.processCommand(adminEntity, "admin snapshot");
      expect(adminConn.lastText()).toContain("Usage: admin snapshot");
    });

    it("write snapshot db + sidecar metadata", () => {
      adminConn.clear();
      engine.processCommand(adminEntity, `admin snapshot ${snapshotName}`);
      const text = adminConn.lastText();
      expect(text).toContain("Snapshot written");
      expect(text).toContain(snapshotDb);
      expect(existsSync(snapshotDb)).toBe(true);
      expect(existsSync(snapshotMeta)).toBe(true);
      const meta = JSON.parse(readFileSync(snapshotMeta, "utf8"));
      expect(meta.name).toBe(snapshotName);
      expect(meta.counts).toBeDefined();
      expect(typeof meta.counts.entities).toBe("number");
      expect(typeof meta.counts.benchmark_runs).toBe("number");
    });

    it("refuse to overwrite without --force", () => {
      engine.processCommand(adminEntity, `admin snapshot ${snapshotName}`);
      adminConn.clear();
      engine.processCommand(adminEntity, `admin snapshot ${snapshotName}`);
      expect(adminConn.lastText()).toContain("already exists");
    });

    it("overwrite with --force", () => {
      engine.processCommand(adminEntity, `admin snapshot ${snapshotName}`);
      adminConn.clear();
      engine.processCommand(adminEntity, `admin snapshot ${snapshotName} --force`);
      expect(adminConn.lastText()).toContain("Snapshot written");
    });

    it("list saved snapshots via `admin snapshots`", () => {
      engine.processCommand(adminEntity, `admin snapshot ${snapshotName}`);
      adminConn.clear();
      engine.processCommand(adminEntity, "admin snapshots");
      const text = adminConn.lastText();
      expect(text).toContain("Saved snapshots");
      expect(text).toContain(snapshotName);
    });
  });
});
