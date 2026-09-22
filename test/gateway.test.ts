// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { validateGatewayUrl } from "../src/engine/gateway-runtime";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { __setDnsResolverForTest } from "../src/net/url-guard";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, grantAllGates, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_gateway.db";

describe("Gateway Command", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;

  beforeEach(() => {
    // Loopback peers (ws://localhost) are only accepted under the LOCAL trust
    // profile; the in-process default is `shared`, which refuses them.
    setTrustProfile("local");
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn1 = new MockConnection("c1");
    engine.addConnection(conn1);
    engine.spawnEntity("c1", "Alice");

    // Give Alice steward rank (7) and grant safety gates for gateway access.
    const entity = engine.entities.get(conn1.entity!);
    if (entity) entity.properties.rank = 7;
    grantAllGates(db, conn1.entity!);

    conn1.clear();
  });

  afterEach(() => {
    engine.gatewayRuntime?.close().catch(() => {});
    resetTrustProfileForTests();
    __setDnsResolverForTest(null);
    db.close();
    cleanupDb(TEST_DB);
  });

  // ─── Gateway Add ──────────────────────────────────────────────────────

  describe("Gateway Add", () => {
    it("should persist a gateway to the database", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      // Connection will fail (no remote server) but DB entry should exist
      const gw = db.getGatewayByName("lab");
      expect(gw).toBeDefined();
      expect(gw!.name).toBe("lab");
      expect(gw!.url).toBe("ws://localhost:3301");
      expect(gw!.created_by).toBe("Alice");
    });

    it("should reject duplicate gateway names", async () => {
      await engine.processCommand(conn1.entity!, "gateway add dup ws://localhost:3301");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway add dup ws://localhost:3302");
      expect(conn1.lastText()).toContain("already exists");
    });

    it("should reject non-websocket URLs", async () => {
      await engine.processCommand(conn1.entity!, "gateway add bad https://example.com");
      expect(conn1.lastText()).toContain("ws://");
    });

    it("should reject short names", async () => {
      await engine.processCommand(conn1.entity!, "gateway add x ws://localhost:3301");
      expect(conn1.lastText()).toContain("2-40 characters");
    });

    it("should reject names with special characters", async () => {
      await engine.processCommand(conn1.entity!, "gateway add my/lab ws://localhost:3301");
      expect(conn1.lastText()).toContain("alphanumeric");
    });

    it("should accept names with hyphens and underscores", async () => {
      await engine.processCommand(conn1.entity!, "gateway add my-lab_01 ws://localhost:3301");
      const gw = db.getGatewayByName("my-lab_01");
      expect(gw).toBeDefined();
    });

    it("should reject invalid WebSocket URLs", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://:::bad");
      expect(conn1.lastText()).toContain("Invalid");
    });

    it("should show usage when missing args", async () => {
      await engine.processCommand(conn1.entity!, "gateway add");
      expect(conn1.lastText()).toContain("Usage");
    });

    // ─── SSRF guard on peer URLs ─────────────────────────────────────────

    it("refuses a loopback peer outside the local trust profile (nothing persisted)", async () => {
      setTrustProfile("shared");
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      expect(conn1.lastText()).toContain("Refused gateway URL");
      expect(conn1.lastText()).toContain("local trust profile");
      expect(db.getGatewayByName("lab")).toBeUndefined();
    });

    it("refuses private-range and cloud-metadata peers outside the local profile", async () => {
      setTrustProfile("shared");
      for (const url of [
        "ws://10.0.0.5:3301",
        "wss://192.168.1.9",
        "ws://169.254.169.254/latest",
        "ws://[fd12::1]:3301",
      ]) {
        conn1.clear();
        await engine.processCommand(conn1.entity!, `gateway add priv ${url}`);
        expect(conn1.lastText()).toContain("Refused gateway URL");
        expect(db.getGatewayByName("priv")).toBeUndefined();
      }
    });

    it("refuses cloud-metadata peers even under the local profile", async () => {
      setTrustProfile("local");
      await engine.processCommand(conn1.entity!, "gateway add meta ws://169.254.169.254/latest");
      expect(conn1.lastText()).toContain("Refused gateway URL");
      expect(db.getGatewayByName("meta")).toBeUndefined();
    });

    it("refuses a public-looking peer that resolves to a private IP (DNS rebinding)", async () => {
      setTrustProfile("shared");
      __setDnsResolverForTest(async () => ["127.0.0.1"]);
      await engine.processCommand(conn1.entity!, "gateway add rebind wss://peer.example.com");
      expect(conn1.lastText()).toContain("Refused gateway URL");
      expect(db.getGatewayByName("rebind")).toBeUndefined();
    });

    it("persists a public peer that resolves to a public IP", async () => {
      __setDnsResolverForTest(async () => ["93.184.216.34"]);
      await engine.processCommand(conn1.entity!, "gateway add pub wss://peer.example.com/ws");
      expect(db.getGatewayByName("pub")).toBeDefined();
    });
  });

  // ─── Gateway Remove ───────────────────────────────────────────────────

  describe("Gateway Remove", () => {
    it("should remove a gateway from the database", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      await Bun.sleep(100); // let async handler settle
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway remove lab");
      await Bun.sleep(100);
      expect(conn1.lastText()).toContain("removed");
      expect(db.getGatewayByName("lab")).toBeUndefined();
    });

    it("should reject removing nonexistent gateway", async () => {
      await engine.processCommand(conn1.entity!, "gateway remove nonexistent");
      expect(conn1.lastText()).toContain("not found");
    });

    it("should prevent non-owner non-admin from removing", async () => {
      // Alice creates it
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");

      // Bob tries to remove it
      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);
      engine.spawnEntity("c2", "Bob");
      const bob = engine.entities.get(conn2.entity!);
      if (bob) bob.properties.rank = 7;
      grantAllGates(db, conn2.entity!);
      conn2.clear();

      await engine.processCommand(conn2.entity!, "gateway remove lab");
      expect(conn2.lastText()).toContain("only remove gateways you created");

      // Verify it still exists
      expect(db.getGatewayByName("lab")).toBeDefined();
    });

    it("should allow admin to remove any gateway", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      await Bun.sleep(100);

      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);
      engine.spawnEntity("c2", "Admin");
      const admin = engine.entities.get(conn2.entity!);
      if (admin) admin.properties.rank = 9;
      grantAllGates(db, conn2.entity!);
      conn2.clear();

      await engine.processCommand(conn2.entity!, "gateway remove lab");
      await Bun.sleep(100);
      expect(conn2.lastText()).toContain("removed");
      expect(db.getGatewayByName("lab")).toBeUndefined();
    });
  });

  // ─── Gateway List ─────────────────────────────────────────────────────

  describe("Gateway List", () => {
    it("should list all gateways", async () => {
      await engine.processCommand(conn1.entity!, "gateway add alpha ws://localhost:3301");
      await engine.processCommand(conn1.entity!, "gateway add beta ws://localhost:3302");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway list");
      const text = conn1.lastText();
      expect(text).toContain("Gateways");
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
    });

    it("should show empty message when no gateways", async () => {
      await engine.processCommand(conn1.entity!, "gateway list");
      expect(conn1.lastText()).toContain("No gateways");
    });
  });

  // ─── Gateway Status ───────────────────────────────────────────────────

  describe("Gateway Status", () => {
    it("should show gateway details", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway status lab");
      const text = stripAnsi(conn1.lastText());
      expect(text).toContain("Gateway: lab");
      expect(text).toContain("ws://localhost:3301");
      expect(text).toContain("Created by: Alice");
    });

    it("should reject nonexistent gateway", async () => {
      await engine.processCommand(conn1.entity!, "gateway status nonexistent");
      expect(conn1.lastText()).toContain("not found");
    });
  });

  // ─── Gateway Bridge / Unbridge ────────────────────────────────────────

  describe("Gateway Bridge", () => {
    it("should persist bridge to database", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway bridge lab general");
      // Bridge saved even if runtime can't connect
      const gw = db.getGatewayByName("lab");
      const bridges = db.listGatewayBridges(gw!.id);
      expect(bridges).toContain("general");
    });

    it("should remove bridge from database", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      await Bun.sleep(100);
      await engine.processCommand(conn1.entity!, "gateway bridge lab general");
      await Bun.sleep(100);
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway unbridge lab general");
      await Bun.sleep(100);
      expect(conn1.lastText()).toContain("unbridged");

      const gw = db.getGatewayByName("lab");
      const bridges = db.listGatewayBridges(gw!.id);
      expect(bridges).not.toContain("general");
    });

    it("should reject bridge on nonexistent gateway", async () => {
      await engine.processCommand(conn1.entity!, "gateway bridge nonexistent general");
      expect(conn1.lastText()).toContain("not found");
    });
  });

  // ─── Gateway Send ─────────────────────────────────────────────────────

  describe("Gateway Send", () => {
    it("should show usage when missing args", async () => {
      await engine.processCommand(conn1.entity!, "gateway send");
      expect(conn1.lastText()).toContain("Usage");
    });

    it("should show usage when missing message", async () => {
      await engine.processCommand(conn1.entity!, "gateway send lab Bob");
      expect(conn1.lastText()).toContain("Usage");
    });
  });

  // ─── Permission Checks ────────────────────────────────────────────────

  describe("Permissions", async () => {
    it("should require steward rank", async () => {
      // Rank floors are enforced only under a gated profile (local is ungated).
      setTrustProfile("shared");
      const entity = engine.entities.get(conn1.entity!);
      if (entity) entity.properties.rank = 0; // newcomer
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway list");
      expect(conn1.lastText()).toContain("rank");
    });

    it("should allow steward rank", async () => {
      await engine.processCommand(conn1.entity!, "gateway list");
      // Should not get a rank error
      expect(conn1.lastText()).not.toContain("rank");
    });
  });

  // ─── Alias ────────────────────────────────────────────────────────────

  describe("Alias", async () => {
    it("should work with gw alias", async () => {
      await engine.processCommand(conn1.entity!, "gw list");
      expect(conn1.lastText()).toContain("No gateways");
    });
  });

  // ─── Gateway Bridge Validation ─────────────────────────────────────

  describe("Gateway Bridge Validation", () => {
    it("should reject channel name with special characters", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway bridge lab gen/eral");
      expect(conn1.lastText()).toContain("alphanumeric");
    });

    it("should reject channel name with dots", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway bridge lab chan.nel");
      expect(conn1.lastText()).toContain("alphanumeric");
    });

    it("should reject channel name longer than 40 chars", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      conn1.clear();
      const longName = "a".repeat(41);
      await engine.processCommand(conn1.entity!, `gateway bridge lab ${longName}`);
      expect(conn1.lastText()).toContain("max 40");
    });

    it("should accept channel name at exactly 40 chars", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      conn1.clear();
      const exactName = "a".repeat(40);
      await engine.processCommand(conn1.entity!, `gateway bridge lab ${exactName}`);
      // Should not get the validation error
      expect(conn1.lastText()).not.toContain("max 40");
    });

    it("should accept channel name with hyphens and underscores", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway bridge lab my-chan_01");
      expect(conn1.lastText()).not.toContain("alphanumeric");
    });
  });

  // ─── Gateway Send Validation ─────────────────────────────────────────

  describe("Gateway Send Validation", () => {
    it("should show usage when only gateway name provided", async () => {
      await engine.processCommand(conn1.entity!, "gateway send lab");
      expect(conn1.lastText()).toContain("Usage");
    });

    it("should show usage when only gateway name and target provided", async () => {
      await engine.processCommand(conn1.entity!, "gateway send lab Bob");
      expect(conn1.lastText()).toContain("Usage");
    });
  });

  // ─── Gateway Status Output ─────────────────────────────────────────

  describe("Gateway Status Output", () => {
    it("should include all expected fields", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gateway status lab");
      const text = stripAnsi(conn1.lastText());
      expect(text).toContain("Gateway: lab");
      expect(text).toContain("URL: ws://localhost:3301");
      expect(text).toContain("Status:");
      expect(text).toContain("Created by: Alice");
      expect(text).toContain("Messages relayed:");
      expect(text).toContain("Bridged channels:");
    });

    it("should show usage when name is missing", async () => {
      await engine.processCommand(conn1.entity!, "gateway status");
      expect(conn1.lastText()).toContain("Usage");
    });
  });

  // ─── Alias Coverage ─────────────────────────────────────────────────

  describe("Alias Coverage", () => {
    it("gw alias works for add subcommand", async () => {
      await engine.processCommand(conn1.entity!, "gw add aliaslab ws://localhost:3301");
      const gw = db.getGatewayByName("aliaslab");
      expect(gw).toBeDefined();
    });

    it("gw alias works for status subcommand", async () => {
      await engine.processCommand(conn1.entity!, "gw add lab2 ws://localhost:3301");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gw status lab2");
      expect(stripAnsi(conn1.lastText())).toContain("Gateway: lab2");
    });

    it("gw alias works for bridge subcommand", async () => {
      await engine.processCommand(conn1.entity!, "gw add lab3 ws://localhost:3301");
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gw bridge lab3 general");
      const gw = db.getGatewayByName("lab3");
      const bridges = db.listGatewayBridges(gw!.id);
      expect(bridges).toContain("general");
    });

    it("gw alias works for remove subcommand", async () => {
      await engine.processCommand(conn1.entity!, "gw add lab4 ws://localhost:3301");
      await Bun.sleep(100);
      conn1.clear();
      await engine.processCommand(conn1.entity!, "gw remove lab4");
      await Bun.sleep(100);
      expect(conn1.lastText()).toContain("removed");
    });
  });

  // ─── Unknown Subcommand ──────────────────────────────────────────────

  describe("Unknown Subcommand", () => {
    it("should show error for unknown subcommand", async () => {
      await engine.processCommand(conn1.entity!, "gateway foobar");
      expect(conn1.lastText()).toContain("Unknown gateway action");
    });

    it("should show error for unknown subcommand via alias", async () => {
      await engine.processCommand(conn1.entity!, "gw blah");
      expect(conn1.lastText()).toContain("Unknown gateway action");
    });
  });

  // ─── Database Persistence (Extended) ─────────────────────────────────

  describe("Database Persistence", () => {
    it("should support multiple bridges on same gateway", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      const gw = db.getGatewayByName("lab")!;
      db.addGatewayBridge(gw.id, "general");
      db.addGatewayBridge(gw.id, "research");
      db.addGatewayBridge(gw.id, "ops");
      const bridges = db.listGatewayBridges(gw.id);
      expect(bridges).toHaveLength(3);
      expect(bridges).toContain("general");
      expect(bridges).toContain("research");
      expect(bridges).toContain("ops");
    });

    it("should return correct channels from listGatewayBridges", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      await engine.processCommand(conn1.entity!, "gateway add lab2 ws://localhost:3302");
      const gw1 = db.getGatewayByName("lab")!;
      const gw2 = db.getGatewayByName("lab2")!;
      db.addGatewayBridge(gw1.id, "alpha");
      db.addGatewayBridge(gw1.id, "beta");
      db.addGatewayBridge(gw2.id, "gamma");

      // Each gateway should only see its own bridges
      expect(db.listGatewayBridges(gw1.id)).toHaveLength(2);
      expect(db.listGatewayBridges(gw1.id)).toContain("alpha");
      expect(db.listGatewayBridges(gw1.id)).toContain("beta");
      expect(db.listGatewayBridges(gw2.id)).toHaveLength(1);
      expect(db.listGatewayBridges(gw2.id)).toContain("gamma");
    });

    it("should list gateways without status filter", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      await engine.processCommand(conn1.entity!, "gateway add lab2 ws://localhost:3302");
      const gw2 = db.getGatewayByName("lab2")!;
      db.updateGatewayStatus(gw2.id, "error");

      // Without filter, should return all
      const all = db.listGateways();
      expect(all).toHaveLength(2);
    });

    it("should cascade delete bridges when gateway is deleted", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      const gw = db.getGatewayByName("lab")!;
      db.addGatewayBridge(gw.id, "general");
      db.addGatewayBridge(gw.id, "research");
      expect(db.listGatewayBridges(gw.id)).toHaveLength(2);

      db.deleteGateway(gw.id);
      expect(db.listGatewayBridges(gw.id)).toHaveLength(0);
    });

    it("should handle duplicate bridge inserts idempotently", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      const gw = db.getGatewayByName("lab")!;
      db.addGatewayBridge(gw.id, "general");
      db.addGatewayBridge(gw.id, "general"); // duplicate
      expect(db.listGatewayBridges(gw.id)).toHaveLength(1);
    });

    it("should filter gateways by status", async () => {
      await engine.processCommand(conn1.entity!, "gateway add lab ws://localhost:3301");
      const gw = db.getGatewayByName("lab")!;
      expect(db.listGateways("active")).toHaveLength(1);

      db.updateGatewayStatus(gw.id, "error");
      expect(db.listGateways("active")).toHaveLength(0);
      expect(db.listGateways("error")).toHaveLength(1);
    });
  });

  // ─── validateGatewayUrl (shared by the command and the runtime) ─────────

  describe("validateGatewayUrl", () => {
    it("rejects non-WebSocket schemes and unparseable URLs", async () => {
      expect(await validateGatewayUrl("https://peer.example.com")).toContain("ws://");
      expect(await validateGatewayUrl("ws://:::bad")).toContain("Invalid");
    });

    it("allows loopback only under the local profile", async () => {
      setTrustProfile("local");
      expect(await validateGatewayUrl("ws://localhost:3301")).toBeNull();
      expect(await validateGatewayUrl("ws://127.0.0.1:3301")).toBeNull();
      expect(await validateGatewayUrl("ws://[::1]:3301")).toBeNull();
      setTrustProfile("public");
      expect(await validateGatewayUrl("ws://localhost:3301")).toContain("Blocked host");
      expect(await validateGatewayUrl("ws://127.0.0.1:3301")).toContain("Blocked host");
    });

    it("runtime refuses to dial (and never sends the secret to) a blocked peer", async () => {
      setTrustProfile("shared");
      const runtime = engine.gatewayRuntime!;
      await expect(runtime.addGateway("bad", "ws://169.254.169.254")).rejects.toThrow(
        /Refused gateway URL/,
      );
      expect(runtime.getStatus("bad")).toBeUndefined();
      await expect(runtime.addGateway("loop", "ws://localhost:3301")).rejects.toThrow(
        /local trust profile/,
      );
      expect(runtime.getStatus("loop")).toBeUndefined();
    });
  });
});
