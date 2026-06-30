import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("next command fast-loop guidance", () => {
  const dbPath = `/tmp/marina-next-command-test-${Date.now()}.db`;
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn = new MockConnection("c-agent");
    engine.addConnection(conn);
    engine.spawnEntity("c-agent", "Agent");
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("routes agents to pending canvas intents before generic solo work", () => {
    engine.processCommand(conn.entity!, "memory set goal respond to human work requests");
    conn.clear();

    db.createCanvas({ id: "canvas-1", name: "requests", creatorName: "Human" });
    db.createNode({
      id: "node-intent-1",
      canvasId: "canvas-1",
      type: "text",
      creatorName: "Human",
      data: {
        body: "Please summarize this.",
        intent: {
          status: "pending",
          prompt: "Summarize the attached notes for the team.",
        },
      },
    });

    engine.processCommand(conn.entity!, "next");

    const out = stripAnsi(conn.lastText());
    expect(out).toContain("Pending canvas intent on requests");
    expect(out).toContain("canvas intent claim node-int");
    expect(out).toContain("canvas intent list");
  });

  it("treats stale active canvas intents as pending work", () => {
    engine.processCommand(conn.entity!, "memory set goal respond to human work requests");
    conn.clear();

    db.createCanvas({ id: "canvas-stale", name: "requests", creatorName: "Human" });
    db.createNode({
      id: "node-intent-stale",
      canvasId: "canvas-stale",
      type: "text",
      creatorName: "Human",
      data: {
        intent: {
          status: "active",
          prompt: "Resume this abandoned intent.",
          claimedBy: "Other",
          claimedAt: Date.now() - 10 * 60 * 1000,
        },
      },
    });

    engine.processCommand(conn.entity!, "next");

    const out = stripAnsi(conn.lastText());
    expect(out).toContain("Pending canvas intent on requests");
    expect(out).toContain("canvas intent claim node-int");
    expect(JSON.parse(db.getNode("node-intent-stale")!.data).intent.status).toBe("pending");
  });

  it("work command shows the prioritized work inbox", () => {
    engine.processCommand(conn.entity!, "memory set goal respond to human work requests");
    conn.clear();

    db.createCanvas({ id: "canvas-work", name: "requests", creatorName: "Human" });
    db.createNode({
      id: "node-intent-work",
      canvasId: "canvas-work",
      type: "text",
      creatorName: "Human",
      data: {
        intent: {
          status: "pending",
          prompt: "Turn this into an implementation plan.",
        },
      },
    });

    engine.processCommand(conn.entity!, "work");

    const out = stripAnsi(conn.lastText());
    expect(out).toContain("Work Inbox");
    expect(out).toContain("Pending canvas intent on requests");
    expect(out).toContain("canvas intent claim node-int");
  });
});
