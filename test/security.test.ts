import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
import { Engine } from "../src/engine/engine";
import { validateRoomSource } from "../src/engine/sandbox";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

describe("Security: Sandbox escape attempts", () => {
  it("should block process access", () => {
    const result = validateRoomSource(`
      export default {
        short: "Test",
        long: "Test",
        onTick: () => { process.exit(1); }
      };
    `);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("process"))).toBe(true);
  });

  it("should block require", () => {
    const result = validateRoomSource(`
      const fs = require("fs");
      export default { short: "Test", long: "Test" };
    `);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("require"))).toBe(true);
  });

  it("should block dynamic import", () => {
    const result = validateRoomSource(`
      export default {
        short: "Test",
        long: "Test",
        onTick: async () => { await import("fs"); }
      };
    `);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("import"))).toBe(true);
  });

  it("should block eval", () => {
    const result = validateRoomSource(`
      export default {
        short: "Test",
        long: "Test",
        onTick: () => { eval("console.log('pwned')"); }
      };
    `);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("eval"))).toBe(true);
  });

  it("should block new Function", () => {
    const result = validateRoomSource(`
      export default {
        short: "Test",
        long: "Test",
        onTick: () => { new Function("return 1")(); }
      };
    `);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Function"))).toBe(true);
  });

  it("should block fetch", () => {
    const result = validateRoomSource(`
      export default {
        short: "Test",
        long: "Test",
        onTick: async () => { await fetch("http://evil.com"); }
      };
    `);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fetch"))).toBe(true);
  });

  it("should block Bun access", () => {
    const result = validateRoomSource(`
      export default {
        short: "Test",
        long: "Test",
        onTick: () => { Bun.write("/etc/passwd", "pwned"); }
      };
    `);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Bun"))).toBe(true);
  });

  it("should block child_process", () => {
    const result = validateRoomSource(`
      export default {
        short: "Test",
        long: "Test",
        onTick: () => { child_process.execSync("rm -rf /"); }
      };
    `);
    expect(result.valid).toBe(false);
  });

  it("should allow safe room modules", () => {
    const result = validateRoomSource(`
      export default {
        short: "Safe Room",
        long: "A perfectly safe room.",
        items: { lamp: "A warm lamp." },
        exits: {},
      };
    `);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("should not false-positive on string literals containing forbidden words", () => {
    const result = validateRoomSource(`
      export default {
        short: "The Process Chamber",
        long: "You see a sign that reads: 'Do not eval-uate the situation.'",
      };
    `);
    expect(result.valid).toBe(true);
  });
});

describe("Security: Input sanitization", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  const dbPath = `/tmp/marina-security-test-${Date.now()}.db`;

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

  it("should sanitize entity names (strip special chars)", () => {
    const entity = engine.spawnEntity("c1", '<script>alert("xss")</script>');
    // Name should be sanitized to alphanumeric only
    if (entity) {
      expect(entity.name).not.toContain("<");
      expect(entity.name).not.toContain(">");
    }
  });

  it("should reject names that are too short after sanitization", () => {
    const entity = engine.spawnEntity("c1", "!@#$"); // all special chars
    expect(entity).toBeUndefined();
  });

  it("should truncate long names", () => {
    const entity = engine.spawnEntity("c1", "A".repeat(100));
    expect(entity).toBeDefined();
    expect(entity!.name.length).toBeLessThanOrEqual(20);
  });
});

describe("Security: Rate limiting", () => {
  it("should enforce rate limits", () => {
    const limiter = new RateLimiter({ maxTokens: 3, refillRate: 1, refillInterval: 1000 });
    expect(limiter.consume("user1")).toBe(true);
    expect(limiter.consume("user1")).toBe(true);
    expect(limiter.consume("user1")).toBe(true);
    expect(limiter.consume("user1")).toBe(false); // exhausted
  });

  it("should isolate rate limits between users", () => {
    const limiter = new RateLimiter({ maxTokens: 1, refillRate: 1, refillInterval: 1000 });
    expect(limiter.consume("user1")).toBe(true);
    expect(limiter.consume("user1")).toBe(false);
    expect(limiter.consume("user2")).toBe(true); // different bucket
  });
});

describe("Security: Ban enforcement", () => {
  let db: MarinaDB;
  let engine: Engine;
  const dbPath = `/tmp/marina-ban-security-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should prevent banned users from logging in", () => {
    db.addBan("BadUser", "admin", "Testing");
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "BadUser");
    expect("error" in result).toBe(true);
  });

  it("should be case-insensitive on ban checks", () => {
    db.addBan("BadUser", "admin");
    expect(db.isBanned("baduser")).toBe(true);
    expect(db.isBanned("BADUSER")).toBe(true);
    expect(db.isBanned("BadUser")).toBe(true);
  });
});
