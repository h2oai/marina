import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SessionManager } from "../src/auth/session-manager";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

describe("Auth & Session Integration", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  const dbPath = `/tmp/marina-auth-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  describe("login", () => {
    it("should create entity and return token", () => {
      const result = engine.login("c1", "TestAgent");
      expect("entityId" in result).toBe(true);
      if ("entityId" in result) {
        expect(result.token).toBeTruthy();
        expect(result.entityId).toBeTruthy();
      }
    });

    it("should return the sanitized name so clients can render it", () => {
      const result = engine.login("c1", "Test Agent!"); // non-alphanumeric stripped
      expect("name" in result).toBe(true);
      if ("name" in result) {
        expect(result.name).toBe("TestAgent");
      }
    });

    it("should create user record in DB", () => {
      engine.login("c1", "TestAgent");
      const user = db.getUserByName("TestAgent");
      expect(user).toBeDefined();
      expect(user!.name).toBe("TestAgent");
      expect(user!.rank).toBe(0);
    });

    it("should reject banned users", () => {
      db.addBan("TestAgent", "admin");
      const result = engine.login("c1", "TestAgent");
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("banned");
      }
    });

    it("should reject invalid names", () => {
      const result = engine.login("c1", "a"); // too short
      expect("error" in result).toBe(true);
    });

    it("should reject duplicate name on login", () => {
      const result1 = engine.login("c1", "TestAgent");
      expect("entityId" in result1).toBe(true);

      // Second client tries same name
      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);
      const result2 = engine.login("c2", "TestAgent");
      expect("error" in result2).toBe(true);
      if ("error" in result2) {
        expect(result2.error).toContain("already in use");
      }
    });

    it("should apply stored rank on login", () => {
      // First login creates user
      const result1 = engine.login("c1", "TestAgent");
      expect("entityId" in result1).toBe(true);
      if (!("entityId" in result1)) return;

      // Set rank in DB
      const user = db.getUserByName("TestAgent");
      db.updateUserRank(user!.id, 4);

      // Second login from new connection
      engine.removeConnection("c1");
      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);
      const result2 = engine.login("c2", "TestAgent");
      expect("entityId" in result2).toBe(true);
      if ("entityId" in result2) {
        const entity = engine.entities.get(result2.entityId);
        expect(entity?.properties.rank).toBe(4);
      }
    });
  });

  describe("reconnect", () => {
    it("should reconnect with valid token", () => {
      const loginResult = engine.login("c1", "TestAgent");
      expect("token" in loginResult).toBe(true);
      if (!("token" in loginResult) || "error" in loginResult) return;

      engine.removeConnection("c1");
      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);

      const reconnResult = engine.reconnect("c2", loginResult.token);
      expect("entityId" in reconnResult).toBe(true);
      if ("entityId" in reconnResult) {
        expect(reconnResult.name).toBe("TestAgent");
      }
    });

    it("should reject invalid token", () => {
      const result = engine.reconnect("c1", "invalid-token");
      expect("error" in result).toBe(true);
    });

    it("should reject banned user on reconnect", () => {
      const loginResult = engine.login("c1", "TestAgent");
      if (!("token" in loginResult) || "error" in loginResult) return;

      db.addBan("TestAgent", "admin");

      engine.removeConnection("c1");
      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);

      const result = engine.reconnect("c2", loginResult.token);
      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect(result.error).toContain("banned");
      }
    });
  });

  describe("authenticate", () => {
    it("should validate existing session", () => {
      const loginResult = engine.login("c1", "TestAgent");
      if ("error" in loginResult) return;
      const entityId = engine.authenticate(loginResult.token);
      expect(entityId).toBe(loginResult.entityId);
    });

    it("should return null for invalid token", () => {
      expect(engine.authenticate("bogus")).toBeNull();
    });
  });

  describe("rate limiting", () => {
    it("should respect rate limiter on checkRateLimit", () => {
      // Engine without rate limiter always allows
      expect(engine.checkRateLimit("test")).toBe(true);
    });
  });

  describe("logout / revocation", () => {
    it("should reject a reconnect after the token is revoked", () => {
      const loginResult = engine.login("c1", "TestAgent");
      if (!("token" in loginResult) || "error" in loginResult) throw new Error("login failed");

      // Simulate POST /api/logout — revoke just this token.
      engine.sessionManager?.revoke(loginResult.token);

      engine.removeConnection("c1");
      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);

      const reconnResult = engine.reconnect("c2", loginResult.token);
      expect("error" in reconnResult).toBe(true);
    });

    it("authenticate() returns null for a revoked token", () => {
      const loginResult = engine.login("c1", "TestAgent");
      if (!("token" in loginResult) || "error" in loginResult) throw new Error("login failed");
      engine.sessionManager?.revoke(loginResult.token);
      expect(engine.authenticate(loginResult.token)).toBeNull();
    });
  });
});

describe("SessionManager", () => {
  const dbPath = `/tmp/marina-sessionmgr-test-${Date.now()}.db`;
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("revokeByEntity drops every in-memory token for that entity, not just the newest", () => {
    const mgr = new SessionManager(db);
    const entityId = "e_test_1" as EntityId;

    // Create two sessions, then force both into the in-memory Map by revalidating
    // the first after the second overwrote entityIndex. validate() repopulates
    // sessions but doesn't touch entityIndex for the older token.
    const first = mgr.create(entityId, "Alice");
    const second = mgr.create(entityId, "Alice");
    // First was evicted by create()'s revokeByEntity. Reinsert it manually to
    // reproduce the stale-in-memory-token failure mode.
    db.saveSession(first);
    expect(mgr.validate(first.token)).toBeDefined();

    mgr.revokeByEntity(entityId);

    expect(mgr.validate(first.token)).toBeUndefined();
    expect(mgr.validate(second.token)).toBeUndefined();
  });

  it("cleanup() purges expired sessions from the in-memory Map", () => {
    const mgr = new SessionManager(db, { sessionTtlMs: 1 });
    mgr.create("e_test_2" as EntityId, "Alice");
    mgr.create("e_test_3" as EntityId, "Bob");

    // Wait past the 1ms TTL without blocking the event loop forever.
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* tight spin — cheaper than awaiting setTimeout in a sync test */
    }

    const removed = mgr.cleanup();
    expect(removed).toBeGreaterThanOrEqual(2);
  });
});

describe("User DB operations", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/marina-user-db-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should create and retrieve users", () => {
    db.createUser({ id: "u_1", name: "Alice" });
    const user = db.getUser("u_1");
    expect(user).toBeDefined();
    expect(user!.name).toBe("Alice");
    expect(user!.rank).toBe(0);
  });

  it("should find user by name", () => {
    db.createUser({ id: "u_1", name: "Alice" });
    const user = db.getUserByName("Alice");
    expect(user).toBeDefined();
    expect(user!.id).toBe("u_1");
  });

  it("should update rank", () => {
    db.createUser({ id: "u_1", name: "Alice" });
    db.updateUserRank("u_1", 3);
    expect(db.getUser("u_1")!.rank).toBe(3);
  });

  it("should delete users", () => {
    db.createUser({ id: "u_1", name: "Alice" });
    db.deleteUser("u_1");
    expect(db.getUser("u_1")).toBeUndefined();
  });
});

describe("Ban DB operations", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/marina-ban-db-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should add and check bans (case-insensitive)", () => {
    db.addBan("Troublemaker", "admin", "Being rude");
    expect(db.isBanned("troublemaker")).toBe(true);
    expect(db.isBanned("TROUBLEMAKER")).toBe(true);
    expect(db.isBanned("innocent")).toBe(false);
  });

  it("should remove bans", () => {
    db.addBan("Troublemaker", "admin");
    expect(db.removeBan("troublemaker")).toBe(true);
    expect(db.isBanned("troublemaker")).toBe(false);
  });

  it("should list bans", () => {
    db.addBan("user1", "admin", "reason1");
    db.addBan("user2", "admin", "reason2");
    const bans = db.listBans();
    expect(bans.length).toBe(2);
  });

  it("should get ban details", () => {
    db.addBan("baduser", "admin", "Spam");
    const ban = db.getBan("baduser");
    expect(ban).toBeDefined();
    expect(ban!.reason).toBe("Spam");
    expect(ban!.banned_by).toBe("admin");
  });
});

describe("Adapter Link DB operations", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/marina-links-db-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should link and retrieve adapter connections", () => {
    db.linkAdapter("telegram", "chat_123", "u_1");
    const link = db.getLinkedUser("telegram", "chat_123");
    expect(link).toBeDefined();
    expect(link!.user_id).toBe("u_1");
  });

  it("should list user links", () => {
    db.linkAdapter("telegram", "chat_123", "u_1");
    db.linkAdapter("discord", "disc_456", "u_1");
    const links = db.getUserLinks("u_1");
    expect(links.length).toBe(2);
  });

  it("should unlink adapters", () => {
    db.linkAdapter("telegram", "chat_123", "u_1");
    expect(db.unlinkAdapter("telegram", "chat_123")).toBe(true);
    expect(db.getLinkedUser("telegram", "chat_123")).toBeUndefined();
  });
});
