import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
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

describe("Auth-required mode (authRequired guard)", () => {
  let db: MarinaDB;
  let engine: Engine;
  const dbPath = `/tmp/marina-authreq-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
      authRequired: true,
      internalAuthToken: "internal-test-token",
    });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  const addConn = (id: string) => {
    const conn = new MockConnection(id);
    engine.addConnection(conn);
    return conn;
  };

  it("rejects external passwordless name-login", () => {
    addConn("c1");
    const result = engine.login("c1", "Mallory");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("requires sign-in");
  });

  it("allows internal agents (internal token) to log in by name", () => {
    addConn("c1");
    const result = engine.login("c1", "RoomGuide", "internal-test-token");
    expect("entityId" in result).toBe(true);
  });

  it("allows identity-verified logins and binds + does NOT grant admin to unverified email", () => {
    addConn("c1");
    const result = engine.login("c1", "creator", undefined, {
      subject: "auth_sub_1",
      email: "creator@h2o.ai",
      emailVerified: false,
    });
    expect("entityId" in result).toBe(true);
    if (!("entityId" in result)) return;
    // Bound to the named entity, and the users row carries the subject.
    expect(db.getUserByAuthSubject("auth_sub_1")?.name).toBe("creator");
    // Unverified email is never promoted, even if it's on the admin list.
    const entity = engine.entities.get(result.entityId);
    expect((entity?.properties.rank as number) ?? 0).toBe(0);
  });

  it("grants admin only to a VERIFIED admin-list email", () => {
    process.env.MARINA_AUTH_ADMIN_EMAILS = "boss@h2o.ai";
    try {
      addConn("c1");
      const result = engine.login("c1", "boss", undefined, {
        subject: "auth_sub_boss",
        email: "boss@h2o.ai",
        emailVerified: true,
      });
      expect("entityId" in result).toBe(true);
      if (!("entityId" in result)) return;
      expect(engine.entities.get(result.entityId)?.properties.rank).toBe(9);
    } finally {
      process.env.MARINA_AUTH_ADMIN_EMAILS = undefined;
    }
  });

  it("does not grant name-based admin under auth-required mode", () => {
    process.env.MARINA_ADMINS = "creator";
    try {
      addConn("c1");
      // Identity login as 'creator' with a non-admin email → no rank from name.
      const result = engine.login("c1", "creator", undefined, {
        subject: "auth_sub_2",
        email: "creator@h2o.ai",
        emailVerified: true,
      });
      expect("entityId" in result).toBe(true);
      if (!("entityId" in result)) return;
      expect((engine.entities.get(result.entityId)?.properties.rank as number) ?? 0).toBe(0);
    } finally {
      process.env.MARINA_ADMINS = undefined;
    }
  });

  it("lets a token-bearing client reconnect (agents are unaffected)", () => {
    // Mint a session via an identity login, then reconnect with the token.
    addConn("c1");
    const login = engine.login("c1", "creator", undefined, {
      subject: "auth_sub_3",
      email: "creator@h2o.ai",
      emailVerified: false,
    });
    if (!("token" in login) || "error" in login) throw new Error("login failed");
    engine.removeConnection("c1");

    addConn("c2");
    const reconn = engine.reconnect("c2", login.token);
    expect("entityId" in reconn).toBe(true);
  });
});

describe("Instance login cap (maxLogins)", () => {
  let db: MarinaDB;
  let engine: Engine;
  const dbPath = `/tmp/marina-logincap-test-${Date.now()}.db`;

  const addConn = (id: string) => {
    const conn = new MockConnection(id);
    engine.addConnection(conn);
    return conn;
  };

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
      maxLogins: 2,
      internalAuthToken: "internal-test-token",
    });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("rejects logins beyond the cap and frees slots on disconnect", () => {
    addConn("c1");
    addConn("c2");
    addConn("c3");
    expect("entityId" in engine.login("c1", "Alice")).toBe(true);
    expect("entityId" in engine.login("c2", "Bob")).toBe(true);

    const third = engine.login("c3", "Carol");
    expect("error" in third).toBe(true);
    if ("error" in third) {
      expect(third.error).toContain("capacity");
    }

    // Disconnect frees a slot
    engine.removeConnection("c1");
    addConn("c4");
    expect("entityId" in engine.login("c4", "Carol")).toBe(true);
  });

  it("enforces the cap on the re-attach branch (post-restart loophole)", () => {
    addConn("c1");
    addConn("c2");
    addConn("c3");
    // Alice logs in then drops — her entity lingers in memory (grace window).
    expect("entityId" in engine.login("c1", "Alice")).toBe(true);
    engine.removeConnection("c1");

    // Two others fill the cap while she's away.
    expect("entityId" in engine.login("c2", "Bob")).toBe(true);
    expect("entityId" in engine.login("c3", "Carol")).toBe(true);

    // Alice's re-attach login hits the existing-entity branch — still capped.
    addConn("c4");
    const result = engine.login("c4", "Alice");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("capacity");
    }
  });

  it("exempts internal agents from the cap and excludes them from the count", () => {
    addConn("c1");
    addConn("c2");
    addConn("c3");
    addConn("c4");
    expect("entityId" in engine.login("c1", "Alice")).toBe(true);
    expect("entityId" in engine.login("c2", "Bob")).toBe(true);

    // Internal agent logs in past the full cap…
    const agent = engine.login("c3", "RoomGuide", "internal-test-token");
    expect("entityId" in agent).toBe(true);
    expect(engine.connections.get("c3")?.internal).toBe(true);

    // …and doesn't consume a slot: external logins at cap still fail.
    const external = engine.login("c4", "Carol");
    expect("error" in external).toBe(true);
  });

  it("rejects an at-capacity login with a wrong internal token", () => {
    addConn("c1");
    addConn("c2");
    addConn("c3");
    expect("entityId" in engine.login("c1", "Alice")).toBe(true);
    expect("entityId" in engine.login("c2", "Bob")).toBe(true);

    const result = engine.login("c3", "Mallory", "wrong-token");
    expect("error" in result).toBe(true);
    expect(engine.connections.get("c3")?.internal).toBeUndefined();
  });

  it("enforces the cap on reconnect (rebind and respawn branches)", () => {
    addConn("c1");
    const loginResult = engine.login("c1", "Alice");
    if (!("token" in loginResult) || "error" in loginResult) throw new Error("login failed");
    engine.removeConnection("c1");

    // Fill the cap while Alice is disconnected.
    addConn("c2");
    addConn("c3");
    expect("entityId" in engine.login("c2", "Bob")).toBe(true);
    expect("entityId" in engine.login("c3", "Carol")).toBe(true);

    // Grace-window rebind finds the instance full → rejected (hard cap).
    addConn("c4");
    const rebind = engine.reconnect("c4", loginResult.token);
    expect("error" in rebind).toBe(true);
    if ("error" in rebind) {
      expect(rebind.error).toContain("capacity");
    }

    // Freeing a slot lets the reconnect through.
    engine.removeConnection("c2");
    addConn("c5");
    expect("entityId" in engine.reconnect("c5", loginResult.token)).toBe(true);
  });

  it("does not cap anything when maxLogins is unset", () => {
    const openEngine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    openEngine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    for (let i = 1; i <= 5; i++) {
      const conn = new MockConnection(`c${i}`);
      openEngine.addConnection(conn);
      expect("entityId" in openEngine.login(`c${i}`, `Agent${i}`)).toBe(true);
    }
  });
});

describe("Login attempt rate limiting", () => {
  let engine: Engine;
  let now: number;

  const addConn = (id: string) => {
    const conn = new MockConnection(id);
    engine.addConnection(conn);
    return conn;
  };

  beforeEach(() => {
    now = 1_000_000;
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      internalAuthToken: "internal-test-token",
      loginRateLimiter: new RateLimiter({
        maxTokens: 3,
        refillRate: 3,
        refillInterval: 60_000,
        now: () => now,
      }),
    });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  it("rejects attempts past the budget and recovers after refill", () => {
    // MockConnection has no ip — limiter keys per connId, so reuse one connection.
    addConn("c1");
    expect("entityId" in engine.login("c1", "Alice")).toBe(true);
    engine.removeConnection("c1");
    addConn("c1");
    expect("entityId" in engine.login("c1", "Alice")).toBe(true);
    engine.removeConnection("c1");
    addConn("c1");
    expect("entityId" in engine.login("c1", "Alice")).toBe(true);
    engine.removeConnection("c1");

    addConn("c1");
    const fourth = engine.login("c1", "Alice");
    expect("error" in fourth).toBe(true);
    if ("error" in fourth) {
      expect(fourth.error).toContain("Too many login attempts");
    }

    // After the refill interval the budget recovers.
    now += 60_000;
    expect("entityId" in engine.login("c1", "Alice")).toBe(true);
  });

  it("failed attempts consume budget too", () => {
    addConn("c1");
    for (let i = 0; i < 3; i++) {
      // Invalid (too short) name — fails after the rate check.
      expect("error" in engine.login("c1", "a")).toBe(true);
    }
    const result = engine.login("c1", "Alice");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Too many login attempts");
    }
  });

  it("rate-limits reconnect attempts on the same budget", () => {
    addConn("c1");
    for (let i = 0; i < 3; i++) {
      expect("error" in engine.reconnect("c1", "bogus-token")).toBe(true);
    }
    const result = engine.reconnect("c1", "bogus-token");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("Too many login attempts");
    }
  });

  it("internal agents bypass an exhausted budget", () => {
    addConn("c1");
    for (let i = 0; i < 3; i++) {
      engine.login("c1", "a"); // burn the budget with failed attempts
    }
    const agent = engine.login("c1", "RoomGuide", "internal-test-token");
    expect("entityId" in agent).toBe(true);
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
