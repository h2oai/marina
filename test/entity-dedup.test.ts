import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { type Entity, type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const START = roomId("test/start");

function mkCreator(id: string, rank = 4, createdAt = 1_000): Entity {
  return {
    id: id as EntityId,
    kind: "agent",
    name: "creator",
    short: "creator is here.",
    long: "You see creator.",
    room: START,
    properties: { rank },
    inventory: [],
    createdAt,
  };
}

function boot(dbPath: string): { db: MarinaDB; engine: Engine } {
  const db = new MarinaDB(dbPath);
  const engine = new Engine({ startRoom: START, tickInterval: 60_000, db });
  engine.registerRoom(START, makeTestRoom({ short: "Start" }));
  engine.loadWorldState();
  return { db, engine };
}

const creators = (engine: Engine) =>
  engine.entities.all().filter((e) => e.name.toLowerCase() === "creator");

describe("duplicate same-named agent entities", () => {
  const dbPath = `/tmp/marina-entity-dedup-${Date.now()}.db`;

  beforeEach(() => {
    cleanupDb(dbPath);
  });
  afterEach(() => {
    cleanupDb(dbPath);
  });

  it("collapses pre-existing duplicate rows to one on restore", () => {
    // Seed three legacy "creator" rows (as older respawn-on-reconnect could leave).
    const db = new MarinaDB(dbPath);
    db.saveEntity(mkCreator("e_1", 4, 1_000));
    db.saveEntity(mkCreator("e_2", 4, 3_000)); // newest at equal rank → survivor
    db.saveEntity(mkCreator("e_3", 4, 2_000));
    db.close();

    const { db: db2, engine } = boot(dbPath);
    const remaining = creators(engine);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe("e_2" as EntityId);
    // The DB row is gone too, so the duplicate doesn't return on the next boot.
    expect(db2.loadAllEntities().filter((e) => e.name === "creator")).toHaveLength(1);
    db2.close();
  });

  it("prefers the highest-rank survivor", () => {
    const db = new MarinaDB(dbPath);
    db.saveEntity(mkCreator("e_1", 0, 9_000)); // newest but rank 0
    db.saveEntity(mkCreator("e_2", 4, 1_000)); // admin → should win
    db.close();

    const { db: db2, engine } = boot(dbPath);
    const remaining = creators(engine);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe("e_2" as EntityId);
    expect(remaining[0]!.properties.rank).toBe(4);
    db2.close();
  });

  it("login after a collapse binds the surviving entity (no new duplicate)", () => {
    const db = new MarinaDB(dbPath);
    db.saveEntity(mkCreator("e_1", 4, 1_000));
    db.saveEntity(mkCreator("e_2", 4, 2_000));
    db.close();

    const { db: db2, engine } = boot(dbPath);
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "creator");
    expect("entityId" in result).toBe(true);
    expect(creators(engine)).toHaveLength(1);
    db2.close();
  });

  it("leaves a single login untouched", () => {
    const { db, engine } = boot(dbPath);
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.login("c1", "creator");
    expect(creators(engine)).toHaveLength(1);
    db.close();

    // Restart: the one entity is restored, still single.
    const { db: db2, engine: engine2 } = boot(dbPath);
    expect(creators(engine2)).toHaveLength(1);
    db2.close();
  });
});
