import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { PLATFORM_GUIDE_NOTES, seedGuidePool } from "../src/world/seed-guide";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("evolve command (self-improvement coach)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-evolve-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/lobby"),
      makeTestRoom({ short: "Lobby", long: "Test lobby." }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("registers the evolve command at rank 0 with a coach alias", () => {
    const cmd = engine.commands.allBuiltins().find((c) => c.name === "evolve");
    expect(cmd).toBeDefined();
    expect(cmd?.minRank ?? 0).toBe(0);
    expect(cmd?.aliases).toContain("coach");
  });

  it("`evolve loop` explains the cycle and disambiguates the two benchmark systems", () => {
    engine.login("c1", "Alice");
    conn.clear();
    engine.processCommand(conn.entity!, "evolve loop");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("evolution loop");
    expect(text).toContain("Baseline");
    expect(text).toContain("skill store");
    // Two-systems disambiguation
    expect(text).toContain("quest start");
    expect(text).toContain("benchmark run");
  });

  it("status: no goal → next step is to set a goal", () => {
    engine.login("c1", "Bob");
    conn.clear();
    engine.processCommand(conn.entity!, "evolve");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("Bob");
    expect(text).toContain("memory set goal");
  });

  it("status: goal set, no benchmarks → next step is to set a baseline", () => {
    engine.login("c1", "Cara");
    engine.processCommand(conn.entity!, "memory set goal master retrieval");
    conn.clear();
    engine.processCommand(conn.entity!, "evolve");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("master retrieval");
    expect(text.toLowerCase()).toContain("baseline");
  });

  it("status: with a benchmark score, shows it and nudges to bank a skill", () => {
    engine.login("c1", "Dora");
    const entity = engine.entities.get(conn.entity!)!;
    engine.processCommand(conn.entity!, "memory set goal improve");
    // Simulate having attempted a benchmark + accumulated notes.
    entity.properties.bench_retrieval_best = 60;
    engine.processCommand(conn.entity!, "note retrieval is about pool recall");
    engine.processCommand(conn.entity!, "note try synonyms when a keyword misses");
    engine.processCommand(conn.entity!, "note core memory helps for repeated facts");
    conn.clear();
    engine.processCommand(conn.entity!, "evolve");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("Retrieval");
    expect(text).toContain("60");
    expect(text).toContain("skill store");
  });
});

describe("evolve discoverability surfaces", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-evolve-surf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/lobby"),
      makeTestRoom({ short: "Lobby", long: "Test lobby." }),
    );
    conn = new MockConnection("c1");
    engine.addConnection(conn);
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("first-login bootstrap mentions evolve", () => {
    engine.login("c1", "Newcomer");
    // Bootstrap fires on first brief/compass.
    engine.processCommand(conn.entity!, "brief");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("evolve");
  });

  it("help lists evolve under a Growth grouping", () => {
    engine.login("c1", "Helper");
    conn.clear();
    engine.processCommand(conn.entity!, "help");
    const text = stripAnsi(conn.allTextJoined());
    expect(text).toContain("Growth");
    expect(text).toContain("evolve");
  });
});

describe("platform guide notes", () => {
  let db: MarinaDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-guide-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("seeds the evolve-loop notes into every world's guide pool, even with no world notes", () => {
    seedGuidePool(db, []);
    const pool = db.getMemoryPool("guide");
    expect(pool).toBeDefined();
    const notes = db.getPoolNotes(pool!.id, 50);
    const joined = notes.map((n) => n.content).join("\n");
    expect(joined).toContain("self-improvement loop");
    expect(joined).toContain("skill store");
    expect(joined).toContain("Two benchmark systems");
    expect(joined).toContain("behavior surfaces");
    expect(joined).toContain("real-time communication");
    expect(joined).toContain("faster loop");
    expect(joined).toContain("brief social");
    expect(notes.length).toBeGreaterThanOrEqual(PLATFORM_GUIDE_NOTES.length);
  });

  it("is idempotent — re-seeding does not duplicate notes", () => {
    seedGuidePool(db, []);
    const pool = db.getMemoryPool("guide");
    const first = db.getPoolNotes(pool!.id, 50).length;
    seedGuidePool(db, []);
    const second = db.getPoolNotes(pool!.id, 50).length;
    expect(second).toBe(first);
  });
});
