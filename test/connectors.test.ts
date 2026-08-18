// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, grantAllGates, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_connectors.db";

describe("Connectors", () => {
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

    // Give Alice sovereign rank (9) and grant safety gates so connect/etc work.
    const entity = engine.entities.get(conn1.entity!);
    if (entity) entity.properties.rank = 9;
    grantAllGates(db, conn1.entity!);

    conn1.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  // ─── Connect Add ──────────────────────────────────────────────────────

  describe("Connect Add", () => {
    it("should add an HTTP connector", () => {
      engine.processCommand(conn1.entity!, "connect add testserver https://example.com/mcp");
      const text = conn1.lastText();
      // Either "added" or "saved" (runtime may not be available)
      expect(text).toContain("testserver");

      const conn = db.getConnectorByName("testserver");
      expect(conn).toBeDefined();
      expect(conn!.transport).toBe("http");
      expect(conn!.url).toBe("https://example.com/mcp");
    });

    it("should reject duplicate connector names", () => {
      engine.processCommand(conn1.entity!, "connect add dup https://example.com/a");
      conn1.clear();
      engine.processCommand(conn1.entity!, "connect add dup https://example.com/b");
      expect(conn1.lastText()).toContain("already exists");
    });

    it("should reject invalid URLs", () => {
      engine.processCommand(conn1.entity!, "connect add bad not-a-url");
      expect(conn1.lastText()).toContain("Invalid URL");
    });

    it("should reject short names", () => {
      engine.processCommand(conn1.entity!, "connect add x https://example.com/mcp");
      expect(conn1.lastText()).toContain("2-40 characters");
    });

    it("should require sovereign for stdio", () => {
      const entity = engine.entities.get(conn1.entity!);
      if (entity) entity.properties.rank = 7; // steward
      conn1.clear();
      engine.processCommand(conn1.entity!, "connect add myserver stdio npx some-server");
      expect(conn1.lastText()).toContain("sovereign rank");
    });

    it("should allow admin to add stdio connector", () => {
      engine.processCommand(conn1.entity!, "connect add myserver stdio npx some-server --flag");
      const text = conn1.lastText();
      expect(text).toContain("myserver");

      const conn = db.getConnectorByName("myserver");
      expect(conn).toBeDefined();
      expect(conn!.transport).toBe("stdio");
      expect(conn!.command).toBe("npx");
    });
  });

  // ─── Connect List ─────────────────────────────────────────────────────

  describe("Connect List", () => {
    it("should list connectors", () => {
      engine.processCommand(conn1.entity!, "connect add alpha https://alpha.com/mcp");
      engine.processCommand(conn1.entity!, "connect add beta https://beta.com/mcp");
      conn1.clear();
      engine.processCommand(conn1.entity!, "connect list");
      const text = conn1.lastText();
      expect(text).toContain("Connectors");
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
    });

    it("should show empty message", () => {
      engine.processCommand(conn1.entity!, "connect list");
      expect(conn1.lastText()).toContain("No connectors");
    });
  });

  // ─── Connect Remove ───────────────────────────────────────────────────

  describe("Connect Remove", () => {
    it("should remove a connector", () => {
      engine.processCommand(conn1.entity!, "connect add toremove https://example.com/mcp");
      conn1.clear();
      engine.processCommand(conn1.entity!, "connect remove toremove");
      expect(conn1.lastText()).toContain("removed");

      expect(db.getConnectorByName("toremove")).toBeUndefined();
    });

    it("should handle not found", () => {
      engine.processCommand(conn1.entity!, "connect remove nonexistent");
      expect(conn1.lastText()).toContain("not found");
    });
  });

  // ─── Connect Auth ─────────────────────────────────────────────────────

  describe("Connect Auth", () => {
    it("should set bearer auth", () => {
      engine.processCommand(conn1.entity!, "connect add authtest https://example.com/mcp");
      conn1.clear();
      engine.processCommand(conn1.entity!, "connect auth authtest bearer sk-test123");
      expect(conn1.lastText()).toContain("Set bearer auth");

      const conn = db.getConnectorByName("authtest");
      expect(conn!.auth_type).toBe("bearer");
      expect(conn!.auth_data).toContain("Bearer sk-test123");
    });

    it("should set header auth", () => {
      engine.processCommand(conn1.entity!, "connect add hdrtest https://example.com/mcp");
      conn1.clear();
      engine.processCommand(conn1.entity!, "connect auth hdrtest header X-API-Key mykey123");
      expect(conn1.lastText()).toContain("Set header");

      const conn = db.getConnectorByName("hdrtest");
      expect(conn!.auth_type).toBe("header");
      const data = JSON.parse(conn!.auth_data!) as Record<string, string>;
      expect(data["X-API-Key"]).toBe("mykey123");
    });
  });

  // ─── Connect Tools/Call (without runtime) ──────────────────────────────

  describe("Connect Tools/Call (no runtime)", () => {
    it("should report runtime not available for tools", () => {
      engine.processCommand(conn1.entity!, "connect tools someserver");
      expect(conn1.lastText()).toContain("not available");
    });

    it("should report runtime not available for call", () => {
      engine.processCommand(conn1.entity!, "connect call someserver sometool");
      expect(conn1.lastText()).toContain("not available");
    });
  });

  // ─── Rank Requirements ────────────────────────────────────────────────

  describe("Rank Requirements", () => {
    it("should require steward rank for connect", () => {
      const entity = engine.entities.get(conn1.entity!);
      if (entity) entity.properties.rank = 1; // canvas
      conn1.clear();
      engine.processCommand(conn1.entity!, "connect list");
      // P3: connect gates at rank 5 (safety threshold) + connect.manage gate.
      expect(conn1.lastText()).toContain("rank 5");
    });
  });

  // ─── Error Cases ──────────────────────────────────────────────────────

  describe("Error Cases", () => {
    it("should show usage with no args", () => {
      engine.processCommand(conn1.entity!, "connect");
      expect(conn1.lastText()).toContain("Usage:");
    });

    it("should handle unknown subcommand", () => {
      engine.processCommand(conn1.entity!, "connect badaction");
      expect(conn1.lastText()).toContain("Unknown connect action");
    });
  });

  // ─── DB Methods ───────────────────────────────────────────────────────

  describe("DB Methods", () => {
    it("should create and retrieve connectors", () => {
      db.createConnector({
        id: "conn_test_1",
        name: "dbtest",
        transport: "http",
        url: "https://example.com/mcp",
        createdBy: "system",
      });

      const conn = db.getConnectorByName("dbtest");
      expect(conn).toBeDefined();
      expect(conn!.transport).toBe("http");
      expect(conn!.status).toBe("active");
    });

    it("should list connectors by status", () => {
      db.createConnector({ id: "c1", name: "active1", transport: "http", createdBy: "s" });
      db.createConnector({ id: "c2", name: "active2", transport: "http", createdBy: "s" });
      db.createConnector({ id: "c3", name: "err1", transport: "http", createdBy: "s" });
      db.updateConnectorStatus("c3", "error");

      expect(db.listConnectors("active").length).toBe(2);
      expect(db.listConnectors("error").length).toBe(1);
      expect(db.listConnectors().length).toBe(3);
    });

    it("should update auth", () => {
      db.createConnector({ id: "ca", name: "authconn", transport: "http", createdBy: "s" });
      db.updateConnectorAuth("ca", "bearer", '{"Authorization":"Bearer x"}');

      const conn = db.getConnector("ca");
      expect(conn!.auth_type).toBe("bearer");
    });

    it("should delete connectors", () => {
      db.createConnector({ id: "cd", name: "delme", transport: "http", createdBy: "s" });
      db.deleteConnector("cd");
      expect(db.getConnectorByName("delme")).toBeUndefined();
    });
  });

  // ─── CommandContext ────────────────────────────────────────────────────

  describe("CommandContext", () => {
    it("should build command context with all APIs", () => {
      const ctx = engine.buildCommandContext(roomId("test/start"), conn1.entity!);
      expect(ctx).toBeDefined();
      expect(ctx!.mcp).toBeDefined();
      expect(ctx!.http).toBeDefined();
      expect(ctx!.notes).toBeDefined();
      expect(ctx!.memory).toBeDefined();
      expect(ctx!.pool).toBeDefined();
      expect(ctx!.caller.name).toBe("Alice");
    });

    it("should allow notes operations through context", () => {
      const ctx = engine.buildCommandContext(roomId("test/start"), conn1.entity!);
      expect(ctx).toBeDefined();

      const noteId = ctx!.notes.add("Test note from context", 7, "fact");
      expect(noteId).toBeGreaterThan(0);

      const recalled = ctx!.notes.recall("Test note context");
      expect(recalled.length).toBeGreaterThan(0);
    });

    it("should allow memory operations through context", () => {
      const ctx = engine.buildCommandContext(roomId("test/start"), conn1.entity!);
      expect(ctx).toBeDefined();

      ctx!.memory.set("goal", "Test goal");
      expect(ctx!.memory.get("goal")).toBe("Test goal");

      const list = ctx!.memory.list();
      expect(list.length).toBe(1);
      expect(list[0]!.key).toBe("goal");
    });

    it("should return undefined for invalid room/entity", () => {
      const ctx = engine.buildCommandContext(roomId("nonexistent"), conn1.entity!);
      expect(ctx).toBeUndefined();
    });
  });
});
