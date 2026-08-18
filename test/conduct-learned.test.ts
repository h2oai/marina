// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadScoreOutcomes, recordScoreOutcome } from "../src/coordination/score-outcome";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const CHAIN = JSON.stringify({
  goal: "ship a feature",
  steps: [
    { id: "plan", instruction: "draft a plan", assignee: "planner", access: [] },
    { id: "build", instruction: "implement it", assignee: "builder", access: ["plan"] },
  ],
});

describe("conduct learning loop (integration)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  const dbPath = `/tmp/marina-conduct-learn-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c-alice");
    engine.addConnection(alice);
    engine.spawnEntity("c-alice", "alice");
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  function out(): string {
    return stripAnsi(alice.allTextJoined());
  }

  it("records a run outcome and recalls it as a learned prior", async () => {
    await engine.processCommand(alice.entity!, `conduct create ship -- ${CHAIN}`);
    alice.clear();
    await engine.processCommand(
      alice.entity!,
      "conduct outcome ship 0.9 category=codegen -- passed 9/10 tests",
    );
    expect(out()).toContain("Recorded outcome");

    alice.clear();
    await engine.processCommand(alice.entity!, "conduct learned codegen");
    const shown = out();
    expect(shown).toContain("chain"); // the Score's topology
    expect(shown).toContain("score=0.90");
    expect(shown).toContain("passed 9/10 tests");
  });

  it("learned with no data nudges toward recording", async () => {
    alice.clear();
    await engine.processCommand(alice.entity!, "conduct learned");
    expect(out()).toContain("No recorded outcomes");
  });

  it("rejects recording an outcome for an unknown Score", async () => {
    alice.clear();
    await engine.processCommand(alice.entity!, "conduct outcome ghost 0.5");
    expect(out()).toContain("not found");
  });
});

describe("score-outcome store (unit)", () => {
  const dbPath = `/tmp/marina-score-outcome-${Date.now()}.db`;
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  const chain = {
    id: "x",
    goal: "g",
    author: "a",
    steps: [
      { id: "a", instruction: "x", assignee: "bob", access: [] },
      { id: "b", instruction: "y", assignee: "carol", access: ["a"] },
    ],
  };

  it("records and reads back outcomes, filtered by category and sorted by score", () => {
    recordScoreOutcome(db, chain, {
      scoreName: "s1",
      score: 0.3,
      category: "math",
      recordedBy: "a",
    });
    recordScoreOutcome(db, chain, {
      scoreName: "s2",
      score: 0.95,
      category: "math",
      recordedBy: "a",
    });
    recordScoreOutcome(db, chain, {
      scoreName: "s3",
      score: 0.5,
      category: "code",
      recordedBy: "a",
    });

    const math = loadScoreOutcomes(db, { category: "math" });
    expect(math).toHaveLength(2);
    expect(math.every((r) => r.category === "math")).toBe(true);

    const all = loadScoreOutcomes(db);
    expect(all).toHaveLength(3);
    // parsed score is recoverable for ranking
    expect(Math.max(...all.map((r) => r.score))).toBeCloseTo(0.95);
  });

  it("clamps out-of-range scores", () => {
    recordScoreOutcome(db, chain, { scoreName: "s", score: 1.7, category: "x", recordedBy: "a" });
    const [rec] = loadScoreOutcomes(db, { category: "x" });
    expect(rec!.score).toBe(1);
  });
});
