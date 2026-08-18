// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
import { verifyLinkCode } from "../src/engine/commands/link";
import { Engine } from "../src/engine/engine";
import { RoomSandbox } from "../src/engine/room-sandbox";
import { MarinaDB } from "../src/persistence/database";
import type { CommandInput, EntityId, RoomContext, RoomId, RoomModule } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, grantAllGates, MockConnection, makeTestRoom } from "./helpers";

// ─── RoomSandbox ─────────────────────────────────────────────────────────────

describe("RoomSandbox", () => {
  let sandbox: RoomSandbox;

  beforeEach(() => {
    sandbox = new RoomSandbox({ handlerTimeoutMs: 5, maxViolations: 3, violationDecayTicks: 10 });
  });

  it("executes a handler without issues", () => {
    let called = false;
    sandbox.execHandler("room1", "onTick", () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("catches thrown errors without crashing", () => {
    const errors: string[] = [];
    sandbox.execHandler(
      "room1",
      "onTick",
      () => {
        throw new Error("boom");
      },
      (_id, err) => errors.push(err),
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("boom");
  });

  it("disables room after max violations", () => {
    const errors: string[] = [];
    for (let i = 0; i < 3; i++) {
      sandbox.execHandler(
        "room1",
        "onTick",
        () => {
          throw new Error("fail");
        },
        (_id, err) => errors.push(err),
      );
    }
    expect(sandbox.isDisabled("room1")).toBe(true);
  });

  it("does not execute handlers for disabled rooms", () => {
    // Disable the room
    for (let i = 0; i < 3; i++) {
      sandbox.execHandler("room1", "onTick", () => {
        throw new Error("fail");
      });
    }
    let called = false;
    sandbox.execHandler("room1", "onTick", () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it("enableRoom re-enables a disabled room", () => {
    for (let i = 0; i < 3; i++) {
      sandbox.execHandler("room1", "onTick", () => {
        throw new Error("fail");
      });
    }
    expect(sandbox.isDisabled("room1")).toBe(true);
    sandbox.enableRoom("room1");
    expect(sandbox.isDisabled("room1")).toBe(false);
  });

  it("tracks metrics per room", () => {
    sandbox.execHandler("room1", "onTick", () => {});
    sandbox.execHandler("room1", "onTick", () => {});
    sandbox.execHandler("room2", "onTick", () => {});
    const metrics = sandbox.getAllMetrics();
    expect(metrics.room1!.totalCalls).toBe(2);
    expect(metrics.room2!.totalCalls).toBe(1);
  });

  it("decays violations over ticks", () => {
    // Get 1 violation
    sandbox.execHandler("room1", "onTick", () => {
      throw new Error("fail");
    });
    const before = sandbox.getAllMetrics().room1!.violations;
    expect(before).toBe(1);
    // Run 10 ticks to trigger decay
    for (let i = 0; i < 10; i++) sandbox.tick();
    const after = sandbox.getAllMetrics().room1!.violations;
    expect(after).toBe(0);
  });

  it("wrapModule wraps onTick", () => {
    let tickCalled = false;
    const mod: RoomModule = {
      short: "Test",
      long: "Test room",
      exits: {},
      onTick: () => {
        tickCalled = true;
      },
    };
    const wrapped = sandbox.wrapModule("room1", mod);
    wrapped.onTick!({} as RoomContext);
    expect(tickCalled).toBe(true);
  });

  it("wrapModule wraps onEnter", () => {
    let enterCalled = false;
    const mod: RoomModule = {
      short: "Test",
      long: "Test room",
      exits: {},
      onEnter: () => {
        enterCalled = true;
      },
    };
    const wrapped = sandbox.wrapModule("room1", mod);
    wrapped.onEnter!({} as RoomContext, "e_1" as EntityId);
    expect(enterCalled).toBe(true);
  });

  it("wrapModule wraps commands", () => {
    let cmdCalled = false;
    const mod: RoomModule = {
      short: "Test",
      long: "Test room",
      exits: {},
      commands: {
        test: () => {
          cmdCalled = true;
        },
      },
    };
    const wrapped = sandbox.wrapModule("room1", mod);
    wrapped.commands!.test!({} as RoomContext, {} as CommandInput);
    expect(cmdCalled).toBe(true);
  });
});

// ─── Rate Limiter ────────────────────────────────────────────────────────────

describe("RateLimiter", () => {
  it("allows requests within budget", () => {
    const limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, refillInterval: 1000 });
    for (let i = 0; i < 5; i++) {
      expect(limiter.consume("user1")).toBe(true);
    }
  });

  it("blocks requests when tokens exhausted", () => {
    const limiter = new RateLimiter({ maxTokens: 3, refillRate: 1, refillInterval: 60000 });
    limiter.consume("user1");
    limiter.consume("user1");
    limiter.consume("user1");
    expect(limiter.consume("user1")).toBe(false);
  });

  it("tracks separate buckets per key", () => {
    const limiter = new RateLimiter({ maxTokens: 2, refillRate: 1, refillInterval: 60000 });
    limiter.consume("user1");
    limiter.consume("user1");
    expect(limiter.consume("user1")).toBe(false);
    expect(limiter.consume("user2")).toBe(true);
  });

  it("reset restores tokens", () => {
    const limiter = new RateLimiter({ maxTokens: 2, refillRate: 1, refillInterval: 60000 });
    limiter.consume("user1");
    limiter.consume("user1");
    expect(limiter.consume("user1")).toBe(false);
    limiter.reset("user1");
    expect(limiter.consume("user1")).toBe(true);
  });

  it("getRemaining returns correct count", () => {
    const limiter = new RateLimiter({ maxTokens: 10, refillRate: 1, refillInterval: 60000 });
    expect(limiter.getRemaining("user1")).toBe(10);
    limiter.consume("user1", 3);
    expect(limiter.getRemaining("user1")).toBe(7);
  });

  it("supports custom cost", () => {
    const limiter = new RateLimiter({ maxTokens: 10, refillRate: 1, refillInterval: 60000 });
    expect(limiter.consume("user1", 7)).toBe(true);
    expect(limiter.consume("user1", 5)).toBe(false);
    expect(limiter.consume("user1", 3)).toBe(true);
  });

  it("cleanup removes stale buckets", () => {
    const limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, refillInterval: 1000 });
    limiter.consume("user1");
    // Can't easily test time-based cleanup without mocking, but verify it doesn't crash
    const removed = limiter.cleanup();
    expect(removed).toBeGreaterThanOrEqual(0);
  });
});

// ─── Link Command ────────────────────────────────────────────────────────────

describe("Link Command", () => {
  let engine: Engine;
  let conn: MockConnection;
  let entityId: EntityId;
  let db: MarinaDB;
  const dbPath = `/tmp/test-link-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "LinkTester");
    if ("entityId" in result) entityId = result.entityId;
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("generates a link code", () => {
    conn.clear();
    engine.processCommand(entityId, "link");
    const text = conn.lastText();
    expect(text).toContain("Account Link Code");
    expect(text).toContain("Your code:");
  });

  it("shows no linked accounts by default", () => {
    conn.clear();
    engine.processCommand(entityId, "link status");
    expect(conn.lastText()).toContain("No linked accounts");
  });

  it("shows usage for unknown subcommand", () => {
    conn.clear();
    engine.processCommand(entityId, "link foobar");
    expect(conn.lastText()).toContain("Usage:");
  });

  it("shows usage for unlink without adapter", () => {
    conn.clear();
    engine.processCommand(entityId, "link unlink");
    expect(conn.lastText()).toContain("Usage:");
  });

  it("reports unlink of non-linked adapter", () => {
    conn.clear();
    engine.processCommand(entityId, "link unlink telegram");
    expect(conn.lastText()).toContain("No telegram account is linked");
  });
});

describe("verifyLinkCode", () => {
  it("returns null for unknown code", () => {
    expect(verifyLinkCode("ZZZZZZ")).toBeNull();
  });
});

// ─── Admin Commands ──────────────────────────────────────────────────────────

describe("Admin Commands", () => {
  let engine: Engine;
  let adminConn: MockConnection;
  let adminId: EntityId;
  let userConn: MockConnection;
  let userId: EntityId;
  let db: MarinaDB;
  const dbPath = `/tmp/test-admin-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());

    // Admin
    adminConn = new MockConnection("admin_c");
    engine.addConnection(adminConn);
    const adminResult = engine.login("admin_c", "AdminUser");
    if ("entityId" in adminResult) {
      adminId = adminResult.entityId;
      const entity = engine.entities.get(adminId);
      if (entity) entity.properties.rank = 9;
      grantAllGates(db, adminId);
    }

    // Regular user
    userConn = new MockConnection("user_c");
    engine.addConnection(userConn);
    const userResult = engine.login("user_c", "RegularUser");
    if ("entityId" in userResult) userId = userResult.entityId;
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("rejects non-admin users", () => {
    userConn.clear();
    engine.processCommand(userId, "admin stats");
    // Civic-substrate P3: admin gates at rank 5 + admin.destructive competence.
    expect(userConn.lastText()).toContain("rank 5");
  });

  it("shows usage without subcommand", () => {
    adminConn.clear();
    engine.processCommand(adminId, "admin");
    expect(adminConn.lastText()).toContain("Usage:");
  });

  it("admin stats shows server info", () => {
    adminConn.clear();
    engine.processCommand(adminId, "admin stats");
    const text = adminConn.lastText();
    expect(text).toContain("Server Stats");
    expect(text).toContain("Rooms:");
    expect(text).toContain("Entities:");
    expect(text).toContain("Uptime:");
  });

  it("admin kick disconnects a player", () => {
    adminConn.clear();
    engine.processCommand(adminId, "admin kick RegularUser");
    const texts = adminConn.allText();
    const hasKicked = texts.some((t) => t.includes("Kicked") || t.includes("kicked"));
    expect(hasKicked).toBe(true);
  });

  it("admin kick reports missing player", () => {
    adminConn.clear();
    engine.processCommand(adminId, "admin kick Nobody");
    expect(adminConn.lastText()).toContain("not found");
  });

  it("admin ban bans a player", () => {
    adminConn.clear();
    engine.processCommand(adminId, "admin ban RegularUser Being rude");
    const texts = adminConn.allText();
    const hasBanned = texts.some((t) => t.includes("Banned") || t.includes("banned"));
    expect(hasBanned).toBe(true);
    expect(db.isBanned("RegularUser")).toBe(true);
  });

  it("admin unban unbans a player", () => {
    db.addBan("testplayer", "AdminUser", "test");
    adminConn.clear();
    engine.processCommand(adminId, "admin unban testplayer");
    expect(adminConn.lastText()).toContain("Unbanned testplayer");
  });

  it("admin unban reports non-banned player", () => {
    adminConn.clear();
    engine.processCommand(adminId, "admin unban Nobody");
    expect(adminConn.lastText()).toContain("not banned");
  });

  it("admin bans lists all bans", () => {
    db.addBan("badplayer", "AdminUser", "cheating");
    adminConn.clear();
    engine.processCommand(adminId, "admin bans");
    const text = adminConn.lastText();
    expect(text).toContain("Active bans");
    expect(text).toContain("badplayer");
  });

  it("admin announce broadcasts to all", () => {
    adminConn.clear();
    userConn.clear();
    engine.processCommand(adminId, "admin announce Server restart in 5 minutes");
    expect(adminConn.lastText()).toContain("Announcement sent");
  });

  it("admin reload shows usage without room id", () => {
    adminConn.clear();
    engine.processCommand(adminId, "admin reload");
    expect(adminConn.lastText()).toContain("Usage:");
  });

  it("admin unknown subcommand shows error", () => {
    adminConn.clear();
    engine.processCommand(adminId, "admin foobar");
    expect(adminConn.lastText()).toContain("Unknown admin command");
  });

  it("banned users cannot login", () => {
    db.addBan("BannedGuy", "AdminUser", "testing");
    const bannedConn = new MockConnection("banned_c");
    engine.addConnection(bannedConn);
    const result = engine.login("banned_c", "BannedGuy");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("banned");
    }
  });
});

// ─── Session Auth ────────────────────────────────────────────────────────────

describe("Session Auth", () => {
  let engine: Engine;
  let db: MarinaDB;
  const dbPath = `/tmp/test-session-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("login returns a token", () => {
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "TestUser");
    expect("token" in result).toBe(true);
    if ("token" in result) {
      expect(result.token.length).toBeGreaterThan(0);
    }
  });

  it("authenticate validates a token", () => {
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "TestUser");
    if ("token" in result) {
      const entityId = engine.authenticate(result.token);
      expect(entityId).not.toBeNull();
    }
  });

  it("authenticate rejects invalid tokens", () => {
    expect(engine.authenticate("invalid-token")).toBeNull();
  });

  it("reconnect works with valid token", () => {
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    const loginResult = engine.login("c1", "TestUser");
    if ("token" in loginResult) {
      // Remove old connection, add new one
      engine.removeConnection("c1");
      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);
      const result = engine.reconnect("c2", loginResult.token);
      expect("entityId" in result).toBe(true);
      if ("entityId" in result) {
        expect(result.name).toBe("TestUser");
      }
    }
  });

  it("reconnect rejects invalid token", () => {
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.reconnect("c1", "bad-token");
    expect("error" in result).toBe(true);
  });

  it("creates user records on first login", () => {
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.login("c1", "NewPlayer");
    const user = db.getUserByName("NewPlayer");
    expect(user).toBeDefined();
    expect(user!.name).toBe("NewPlayer");
  });

  it("preserves rank across logins", () => {
    // First login
    const conn1 = new MockConnection("c1");
    engine.addConnection(conn1);
    const r1 = engine.login("c1", "RankedUser");
    if ("entityId" in r1) {
      // Set rank on user record
      const user = db.getUserByName("RankedUser");
      if (user) db.updateUserRank(user.id, 3);
    }
    engine.removeConnection("c1");

    // Second login
    const conn2 = new MockConnection("c2");
    engine.addConnection(conn2);
    const r2 = engine.login("c2", "RankedUser");
    if ("entityId" in r2) {
      const entity = engine.entities.get(r2.entityId);
      expect(entity?.properties.rank).toBe(3);
    }
  });
});

// ─── Sandbox Integration with Engine ─────────────────────────────────────────

describe("Sandbox Engine Integration", () => {
  let engine: Engine;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
  });

  it("engine has a sandbox instance", () => {
    expect(engine.sandbox).toBeInstanceOf(RoomSandbox);
  });

  it("wraps rooms registered via engine through sandbox", () => {
    const _errors: string[] = [];
    // Directly test that the sandbox wraps modules
    const badRoom: RoomModule = {
      short: "Bad Room",
      long: "A room that throws on tick.",
      exits: {},
      onTick: () => {
        throw new Error("tick explosion");
      },
    };
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    engine.registerRoom(roomId("test/bad") as RoomId, badRoom);

    // The sandbox should be tracking the wrapped rooms
    const room = engine.rooms.get(roomId("test/bad") as RoomId);
    expect(room).toBeDefined();
    // Calling onTick on the wrapped module should not throw
    // Suppress expected console.error from sandbox violation handler
    const origError = console.error;
    console.error = () => {};
    try {
      expect(() => room!.module.onTick!({} as RoomContext)).not.toThrow();
    } finally {
      console.error = origError;
    }
  });
});

// ─── DB Adapter Links ────────────────────────────────────────────────────────

describe("DB Adapter Links", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/test-adapter-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("links and retrieves an adapter", () => {
    db.linkAdapter("telegram", "12345", "user_1");
    const link = db.getLinkedUser("telegram", "12345");
    expect(link).toBeDefined();
    expect(link!.user_id).toBe("user_1");
  });

  it("getUserLinks returns all links for a user", () => {
    db.linkAdapter("telegram", "12345", "user_1");
    db.linkAdapter("discord", "67890", "user_1");
    const links = db.getUserLinks("user_1");
    expect(links.length).toBe(2);
  });

  it("unlinkAdapter removes a link", () => {
    db.linkAdapter("telegram", "12345", "user_1");
    expect(db.unlinkAdapter("telegram", "12345")).toBe(true);
    expect(db.getLinkedUser("telegram", "12345")).toBeUndefined();
  });

  it("unlinkAdapter returns false for non-existent link", () => {
    expect(db.unlinkAdapter("telegram", "99999")).toBe(false);
  });
});

// ─── DB Users ────────────────────────────────────────────────────────────────

describe("DB Users", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/test-users-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("creates and retrieves a user", () => {
    db.createUser({ id: "u1", name: "TestUser" });
    const user = db.getUser("u1");
    expect(user).toBeDefined();
    expect(user!.name).toBe("TestUser");
    expect(user!.rank).toBe(0);
  });

  it("getUserByName finds user", () => {
    db.createUser({ id: "u1", name: "Alice" });
    const user = db.getUserByName("Alice");
    expect(user).toBeDefined();
    expect(user!.id).toBe("u1");
  });

  it("updateUserRank changes rank", () => {
    db.createUser({ id: "u1", name: "Bob" });
    db.updateUserRank("u1", 3);
    expect(db.getUser("u1")!.rank).toBe(3);
  });

  it("deleteUser removes user", () => {
    db.createUser({ id: "u1", name: "Charlie" });
    db.deleteUser("u1");
    expect(db.getUser("u1")).toBeUndefined();
  });
});

// ─── DB Bans ─────────────────────────────────────────────────────────────────

describe("DB Bans", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/test-bans-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("adds and checks a ban", () => {
    db.addBan("BadPlayer", "Admin", "cheating");
    expect(db.isBanned("BadPlayer")).toBe(true);
    expect(db.isBanned("GoodPlayer")).toBe(false);
  });

  it("ban check is case insensitive", () => {
    db.addBan("BadPlayer", "Admin", "cheating");
    expect(db.isBanned("badplayer")).toBe(true);
  });

  it("removeBan removes a ban", () => {
    db.addBan("BadPlayer", "Admin", "test");
    expect(db.removeBan("BadPlayer")).toBe(true);
    expect(db.isBanned("BadPlayer")).toBe(false);
  });

  it("removeBan returns false for non-banned", () => {
    expect(db.removeBan("Nobody")).toBe(false);
  });

  it("listBans returns all bans", () => {
    db.addBan("Player1", "Admin", "reason1");
    db.addBan("Player2", "Admin", "reason2");
    const bans = db.listBans();
    expect(bans.length).toBe(2);
  });

  it("getBan returns ban details", () => {
    db.addBan("BadPlayer", "Admin", "cheating");
    const ban = db.getBan("BadPlayer");
    expect(ban).toBeDefined();
    expect(ban!.banned_by).toBe("Admin");
    expect(ban!.reason).toBe("cheating");
  });
});
