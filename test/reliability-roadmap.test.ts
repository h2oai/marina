// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TaskManager } from "../src/coordination/task-manager";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_reliability_roadmap.db";

describe("reliability roadmap", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("renews task leases and reopens abandoned work for reallocation", () => {
    const tasks = new TaskManager(db, { leaseMs: 1_000 });
    const task = tasks.create({ title: "Recover me", creatorId: "creator", creatorName: "Maker" });
    const claim = tasks.claim(task.id, "worker", "Worker")!;
    expect(claim.leaseExpiresAt).not.toBeNull();

    const renewed = tasks.heartbeat(task.id, "worker")!;
    const recovered = tasks.recoverExpired(renewed.leaseExpiresAt! + 1);

    expect(recovered).toHaveLength(1);
    expect(tasks.get(task.id)?.status).toBe("open");
    expect(tasks.getClaim(task.id, "worker")?.status).toBe("released");
    expect(tasks.getClaim(task.id, "worker")?.releaseReason).toBe("lease_expired");
    expect(tasks.claim(task.id, "worker", "Worker")).not.toBeNull();
  });

  it("reports project budgets, usage, task telemetry, and overruns", () => {
    engine.processCommand(conn.entity!, "project create Telemetry | debate release safety");
    engine.processCommand(conn.entity!, "project Telemetry budget tokens 1000 cost 1 duration 1h");
    engine.processCommand(conn.entity!, "project Telemetry usage 1200 0.25");
    expect(stripAnsi(conn.lastText())).toContain("budget exceeded");

    engine.processCommand(conn.entity!, "project Telemetry status");
    const status = stripAnsi(conn.lastText());
    expect(status).toContain("1200/1000 tokens");
    expect(status).toContain("$0.250/$1.000");
    expect(status).toContain("Time budget:");
  });

  it("ranks fitting orchestrations with evidence from outcome traditions", () => {
    engine.processCommand(conn.entity!, "project create Choice | debate competing database plans");
    db.createMemoryPool("pool_test_debate", "orchestration:debate", "system");
    db.addPoolNote(
      "pool_test_debate",
      "Reviewer",
      "[project-outcome:prior orchestration:debate] score=0.90 evidence-backed result",
      9,
      "reflection",
    );

    engine.processCommand(conn.entity!, "project Choice recommend");
    const text = stripAnsi(conn.lastText());
    expect(text).toContain("Orchestration Recommendation");
    expect(text).toContain("debate");
    expect(text).toContain("1 outcomes, mean 0.90");
  });

  it("exposes a measured demo preflight without mutating the world", () => {
    engine.processCommand(conn.entity!, "demo preflight");
    const text = stripAnsi(conn.lastText());
    expect(text).toContain("Demo Preflight");
    expect(text).toContain("Score:");
    expect(text).toContain("Response:");
    expect(text).toContain("Controls: demo warm · demo recover · demo reset");
  });
});
