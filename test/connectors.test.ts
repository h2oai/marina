// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { revoke } from "../src/engine/safety-gates";
import { __setDnsResolverForTest } from "../src/net/url-guard";
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
    // Connector URLs are checked against their resolved addresses: stub DNS.
    __setDnsResolverForTest(async (host) =>
      host === "internal.example.com" ? ["10.0.0.7"] : ["93.184.216.34"],
    );
  });

  afterEach(() => {
    __setDnsResolverForTest(null);
    db.close();
    cleanupDb(TEST_DB);
  });

  // ─── Connect Add ──────────────────────────────────────────────────────

  describe("Connect Add", () => {
    it("should add an HTTP connector", async () => {
      await engine.processCommand(conn1.entity!, "connect add testserver https://example.com/mcp");
      const text = conn1.lastText();
      // Either "added" or "saved" (runtime may not be available)
      expect(text).toContain("testserver");

      const conn = db.getConnectorByName("testserver");
      expect(conn).toBeDefined();
      expect(conn!.transport).toBe("http");
      expect(conn!.url).toBe("https://example.com/mcp");
    });

    it("should reject duplicate connector names", async () => {
      await engine.processCommand(conn1.entity!, "connect add dup https://example.com/a");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "connect add dup https://example.com/b");
      expect(conn1.lastText()).toContain("already exists");
    });

    it("should reject invalid URLs", async () => {
      await engine.processCommand(conn1.entity!, "connect add bad not-a-url");
      expect(conn1.lastText()).toContain("Invalid URL");
    });

    it("refuses a host name that resolves to a private address", async () => {
      await engine.processCommand(
        conn1.entity!,
        "connect add internal https://internal.example.com/mcp",
      );
      expect(conn1.lastText()).toContain("Blocked URL");
      expect(db.getConnectorByName("internal")).toBeFalsy();
    });

    it("should reject short names", async () => {
      await engine.processCommand(conn1.entity!, "connect add x https://example.com/mcp");
      expect(conn1.lastText()).toContain("2-40 characters");
    });

    it("should require the shell.exec gate for stdio", async () => {
      // A stdio connector spawns a local process: `shell.exec` is the authority.
      revoke(db, conn1.entity!, "shell.exec");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "connect add myserver stdio npx some-server");
      expect(conn1.lastText()).toContain("execute shell commands");
      expect(db.getConnectorByName("myserver")).toBeFalsy();
      grantAllGates(db, conn1.entity!);
    });

    it("should allow admin to add stdio connector", async () => {
      await engine.processCommand(
        conn1.entity!,
        "connect add myserver stdio npx some-server --flag",
      );
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
    it("should list connectors", async () => {
      await engine.processCommand(conn1.entity!, "connect add alpha https://alpha.com/mcp");
      await engine.processCommand(conn1.entity!, "connect add beta https://beta.com/mcp");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "connect list");
      const text = conn1.lastText();
      expect(text).toContain("Connectors");
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
    });

    it("should show empty message", async () => {
      await engine.processCommand(conn1.entity!, "connect list");
      expect(conn1.lastText()).toContain("No connectors");
    });
  });

  // ─── Connect Remove ───────────────────────────────────────────────────

  describe("Connect Remove", () => {
    it("should remove a connector", async () => {
      await engine.processCommand(conn1.entity!, "connect add toremove https://example.com/mcp");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "connect remove toremove");
      expect(conn1.lastText()).toContain("removed");

      expect(db.getConnectorByName("toremove")).toBeUndefined();
    });

    it("should handle not found", async () => {
      await engine.processCommand(conn1.entity!, "connect remove nonexistent");
      expect(conn1.lastText()).toContain("not found");
    });
  });

  // ─── Connect Auth ─────────────────────────────────────────────────────

  describe("Connect Auth", () => {
    it("should set bearer auth", async () => {
      await engine.processCommand(conn1.entity!, "connect add authtest https://example.com/mcp");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "connect auth authtest bearer sk-test123");
      expect(conn1.lastText()).toContain("Set bearer auth");

      const conn = db.getConnectorByName("authtest");
      expect(conn!.auth_type).toBe("bearer");
      expect(conn!.auth_data).toContain("Bearer sk-test123");
    });

    it("should set header auth", async () => {
      await engine.processCommand(conn1.entity!, "connect add hdrtest https://example.com/mcp");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "connect auth hdrtest header X-API-Key mykey123");
      expect(conn1.lastText()).toContain("Set header");

      const conn = db.getConnectorByName("hdrtest");
      expect(conn!.auth_type).toBe("header");
      const data = JSON.parse(conn!.auth_data!) as Record<string, string>;
      expect(data["X-API-Key"]).toBe("mykey123");
    });
  });

  // ─── Connect Tools/Call (without runtime) ──────────────────────────────

  describe("Connect Tools/Call (no runtime)", () => {
    it("should report runtime not available for tools", async () => {
      await engine.processCommand(conn1.entity!, "connect tools someserver");
      expect(conn1.lastText()).toContain("not available");
    });

    it("should report runtime not available for call", async () => {
      await engine.processCommand(conn1.entity!, "connect call someserver sometool");
      expect(conn1.lastText()).toContain("not available");
    });
  });

  // ─── Rank Requirements ────────────────────────────────────────────────

  describe("Rank Requirements", () => {
    it("the connect.manage gate decides, not the rank floor", async () => {
      const entity = engine.entities.get(conn1.entity!);
      if (entity) entity.properties.rank = 1; // canvas
      conn1.clear();
      // A rank-1 holder of the gate is not double-locked by minRank ...
      await engine.processCommand(conn1.entity!, "connect list");
      expect(conn1.lastText()).not.toContain("rank 5");
      // ... and without the gate the gate itself refuses.
      revoke(db, conn1.entity!, "connect.manage");
      await engine.processCommand(conn1.entity!, "connect list");
      expect(conn1.lastText()).toContain("Not yet");
    });
  });

  // ─── Error Cases ──────────────────────────────────────────────────────

  describe("Error Cases", () => {
    it("should show usage with no args", async () => {
      await engine.processCommand(conn1.entity!, "connect");
      expect(conn1.lastText()).toContain("Usage:");
    });

    it("should handle unknown subcommand", async () => {
      await engine.processCommand(conn1.entity!, "connect badaction");
      expect(conn1.lastText()).toContain("Unknown connect action");
    });
  });

  // ─── DB Methods ───────────────────────────────────────────────────────

  describe("DB Methods", () => {
    it("should create and retrieve connectors", async () => {
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

    it("should list connectors by status", async () => {
      db.createConnector({ id: "c1", name: "active1", transport: "http", createdBy: "s" });
      db.createConnector({ id: "c2", name: "active2", transport: "http", createdBy: "s" });
      db.createConnector({ id: "c3", name: "err1", transport: "http", createdBy: "s" });
      db.updateConnectorStatus("c3", "error");

      expect(db.listConnectors("active").length).toBe(2);
      expect(db.listConnectors("error").length).toBe(1);
      expect(db.listConnectors().length).toBe(3);
    });

    it("should update auth", async () => {
      db.createConnector({ id: "ca", name: "authconn", transport: "http", createdBy: "s" });
      db.updateConnectorAuth("ca", "bearer", '{"Authorization":"Bearer x"}');

      const conn = db.getConnector("ca");
      expect(conn!.auth_type).toBe("bearer");
    });

    it("should delete connectors", async () => {
      db.createConnector({ id: "cd", name: "delme", transport: "http", createdBy: "s" });
      db.deleteConnector("cd");
      expect(db.getConnectorByName("delme")).toBeUndefined();
    });
  });

  // ─── CommandContext ────────────────────────────────────────────────────

  describe("CommandContext", () => {
    it("should build command context with all APIs", async () => {
      const ctx = engine.buildCommandContext(roomId("test/start"), conn1.entity!);
      expect(ctx).toBeDefined();
      expect(ctx!.mcp).toBeDefined();
      expect(ctx!.http).toBeDefined();
      expect(ctx!.notes).toBeDefined();
      expect(ctx!.memory).toBeDefined();
      expect(ctx!.pool).toBeDefined();
      expect(ctx!.caller.name).toBe("Alice");
    });

    it("should allow notes operations through context", async () => {
      const ctx = engine.buildCommandContext(roomId("test/start"), conn1.entity!);
      expect(ctx).toBeDefined();

      const noteId = ctx!.notes.add("Test note from context", 7, "fact");
      expect(noteId).toBeGreaterThan(0);

      const recalled = ctx!.notes.recall("Test note context");
      expect(recalled.length).toBeGreaterThan(0);
    });

    it("should allow memory operations through context", async () => {
      const ctx = engine.buildCommandContext(roomId("test/start"), conn1.entity!);
      expect(ctx).toBeDefined();

      ctx!.memory.set("goal", "Test goal");
      expect(ctx!.memory.get("goal")).toBe("Test goal");

      const list = ctx!.memory.list();
      expect(list.length).toBe(1);
      expect(list[0]!.key).toBe("goal");
    });

    it("should return undefined for invalid room/entity", async () => {
      const ctx = engine.buildCommandContext(roomId("nonexistent"), conn1.entity!);
      expect(ctx).toBeUndefined();
    });
  });
});
