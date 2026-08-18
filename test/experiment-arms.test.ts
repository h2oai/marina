// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getStanding } from "../src/agent/standing";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_experiment_arms.db";

/**
 * The sharpened `experiment` command: a controlled A/B comparison with arms,
 * ranked results, a decided winner, and a completion that records an outcome
 * note + flows standing. Un-armed behavior stays the legacy flat log
 * (covered by playground.test.ts).
 */
describe("experiment arms (A/B comparison)", () => {
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
    // Coordinator rank to create experiments.
    const e = engine.entities.get(conn.entity!)!;
    e.properties.rank = 3;
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const run = (cmd: string) => {
    engine.processCommand(conn.entity!, cmd);
    const t = stripAnsi(conn.lastText());
    conn.clear();
    return t;
  };

  it("creates an armed experiment and is startable solo", () => {
    expect(
      run("experiment create Prompt arms terse,verbose metric accuracy goal higher"),
    ).toContain("terse vs verbose");
    // Armed experiments default required_agents to 1 → creator can start alone.
    expect(run("experiment start Prompt")).toContain("started");
  });

  it("rejects a single-arm definition", () => {
    expect(run("experiment create Solo arms only")).toContain("at least two arms");
  });

  it("validates the arm on record and ranks arms with a winner", () => {
    run("experiment create Prompt arms terse,verbose metric accuracy goal higher");
    run("experiment start Prompt");
    expect(run("experiment record Prompt bogus accuracy 0.9")).toContain('Unknown arm "bogus"');

    run("experiment record Prompt terse accuracy 0.80");
    run("experiment record Prompt terse accuracy 0.84"); // mean 0.82
    run("experiment record Prompt verbose accuracy 0.71");

    const results = run("experiment results Prompt");
    expect(results).toContain("Ranked by accuracy");
    // terse (0.82) should rank above verbose (0.71) and be flagged winner.
    // Anchor on the "<arm>:" row prefix to avoid matching header text.
    expect(results.indexOf("terse:")).toBeLessThan(results.indexOf("verbose:"));
    expect(results).toContain("★");
  });

  it("honors goal:lower (smaller metric wins)", () => {
    run("experiment create Latency arms fast,slow metric ms goal lower");
    run("experiment start Latency");
    run("experiment record Latency fast ms 120");
    run("experiment record Latency slow ms 90");
    const results = run("experiment results Latency");
    // "slow" recorded the lower ms (90) → ranked first when lower is the goal.
    expect(results.indexOf("slow:")).toBeLessThan(results.indexOf("fast:"));
  });

  it("completes with a winner, writes an outcome note, and credits standing", () => {
    run("experiment create Prompt arms terse,verbose metric accuracy goal higher");
    run("experiment start Prompt");
    run("experiment record Prompt terse accuracy 0.9");
    run("experiment record Prompt verbose accuracy 0.5");

    const done = run("experiment complete Prompt");
    expect(done).toContain("winner");
    expect(done).toContain("terse");

    // Outcome note authored by the creator for the generational-memory loop.
    const outcome = db
      .getNotesByEntity("Alice")
      .filter((n) => n.note_type === "experiment-outcome");
    expect(outcome.length).toBe(1);
    expect(outcome[0]!.content).toContain("terse");

    // Standing flowed to the completer.
    expect(getStanding(db, conn.entity!)).toBeGreaterThan(0);
  });
});
