// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { Logger } from "../src/engine/logger";
import { TickScheduler } from "../src/engine/tick-scheduler";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_tick_scheduler.db";

/**
 * The periodic half of the engine tick, extracted from `Engine.tickInner()`
 * the same way `ConnectionManager` / `EventLog` / `BriefManager` were. Two
 * things must hold: a job fires on exactly the ticks it declares, and one
 * failing job never costs the tick or the jobs behind it.
 */
describe("TickScheduler", () => {
  const logger = new Logger({ level: "error" });

  it("fires a job on exactly the ticks where tick % every === phase", () => {
    const fired: number[] = [];
    const s = new TickScheduler(logger).register({
      name: "every-5-phase-2",
      every: 5,
      phase: 2,
      run: (tick) => {
        fired.push(tick);
      },
    });

    for (let tick = 0; tick <= 20; tick++) s.runDue(tick);

    expect(fired).toEqual([2, 7, 12, 17]);
    expect(s.due(7)).toEqual(["every-5-phase-2"]);
    expect(s.due(8)).toEqual([]);
    expect(TickScheduler.isDue({ every: 5, phase: 2 }, 12)).toBe(true);
    expect(TickScheduler.isDue({ every: 5, phase: 2 }, 13)).toBe(false);
  });

  it("runs due jobs in registration order and skips the rest", () => {
    const order: string[] = [];
    const s = new TickScheduler(logger)
      .register({ name: "a", every: 2, phase: 0, run: () => void order.push("a") })
      .register({ name: "b", every: 2, phase: 1, run: () => void order.push("b") })
      .register({ name: "c", every: 4, phase: 0, run: () => void order.push("c") });

    s.runDue(4); // a (4%2===0) and c (4%4===0); b is phase 1
    expect(order).toEqual(["a", "c"]);
    expect(s.size).toBe(3);
  });

  it("a non-critical failure is logged and the jobs behind it still run", () => {
    const warnings: string[] = [];
    const capture = new Logger({ level: "error" });
    capture.warn = (_category: string, message: string) => void warnings.push(message);

    const after: string[] = [];
    const s = new TickScheduler(capture)
      .register({
        name: "explodes",
        every: 1,
        phase: 0,
        failureMessage: "explodes failed",
        run: () => {
          throw new Error("boom");
        },
      })
      .register({ name: "follows", every: 2, phase: 0, run: () => void after.push("ran") });

    expect(() => s.runDue(4)).not.toThrow(); // both due: 4%1===0 and 4%2===0
    expect(after).toEqual(["ran"]);
    expect(warnings).toEqual(["explodes failed"]);

    const [explodes] = s.describe();
    expect(explodes?.lastError).toContain("boom");
    expect(explodes?.runs).toBe(1);
  });

  it("a critical job rethrows so the engine's tick error path counts it", () => {
    const behind: string[] = [];
    const s = new TickScheduler(logger)
      .register({
        name: "critical",
        every: 1,
        phase: 0,
        critical: true,
        run: () => {
          throw new Error("fatal");
        },
      })
      .register({ name: "behind", every: 2, phase: 0, run: () => void behind.push("ran") });

    expect(() => s.runDue(4)).toThrow(/fatal/); // both due at tick 4
    // Same as an unwrapped throw inside tickInner before the extraction.
    expect(behind).toEqual([]);
    expect(s.describe()[0]?.lastError).toContain("fatal");
  });

  it("an async job is fire-and-forget: a rejection is recorded, never thrown", async () => {
    const warnings: string[] = [];
    const capture = new Logger({ level: "error" });
    capture.warn = (_category: string, message: string) => void warnings.push(message);

    const s = new TickScheduler(capture).register({
      name: "async-job",
      every: 1,
      phase: 0,
      failureMessage: "async-job failed",
      run: async () => {
        await Promise.resolve();
        throw new Error("late");
      },
    });

    expect(() => s.runDue(1)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const [job] = s.describe();
    expect(job?.async).toBe(true);
    expect(job?.lastError).toContain("late");
    expect(warnings).toEqual(["async-job failed"]);
  });

  it("describe() reports the last run tick, duration and a cleared error", () => {
    const s = new TickScheduler(logger);
    let fail = true;
    s.register({
      name: "flaky",
      every: 1,
      phase: 0,
      run: () => {
        if (fail) throw new Error("first");
      },
    });

    s.runDue(3);
    let [job] = s.describe();
    expect(job?.lastRunTick).toBe(3);
    expect(job?.lastError).toContain("first");
    expect(job?.lastDurationMs).toBeGreaterThanOrEqual(0);

    fail = false;
    s.runDue(4);
    [job] = s.describe();
    expect(job?.lastRunTick).toBe(4);
    expect(job?.runs).toBe(2);
    expect(job?.lastError).toBeUndefined();
  });

  it("refuses a duplicate name, a shared (every, phase) slot and an invalid interval", () => {
    const s = new TickScheduler(logger).register({
      name: "hourly-a",
      every: 3600,
      phase: 900,
      run: () => {},
    });

    expect(() => s.register({ name: "hourly-a", every: 60, phase: 0, run: () => {} })).toThrow(
      /already registered/,
    );
    // The phase invariant used to be a comment; the scheduler enforces it.
    expect(() => s.register({ name: "hourly-b", every: 3600, phase: 900, run: () => {} })).toThrow(
      /distinct phases/,
    );
    expect(() => s.register({ name: "bad-every", every: 0, phase: 0, run: () => {} })).toThrow(
      /positive integer/,
    );
    expect(() => s.register({ name: "bad-phase", every: 10, phase: 10, run: () => {} })).toThrow(
      /phase must be an integer/,
    );
    // A different phase on the same interval is fine.
    expect(() =>
      s.register({ name: "hourly-c", every: 3600, phase: 1800, run: () => {} }),
    ).not.toThrow();
  });
});

describe("Engine tick schedule", () => {
  let db: MarinaDB;
  let engine: Engine;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
      logger: new Logger({ level: "error" }),
    });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  /**
   * Snapshot of the schedule as it stood when the block was lifted out of
   * `tickInner()`. Phases are load-bearing: CLAUDE.md documents the hourly
   * jobs as running at distinct offsets so they never land on one tick.
   */
  it("registers the same jobs, intervals and phases the inline block ran", () => {
    const schedule = engine
      .describeTickSchedule()
      .map(({ name, every, phase }) => ({ name, every, phase }));

    expect(schedule).toEqual([
      { name: "board-archive", every: 3600, phase: 300 },
      { name: "channel-prune", every: 1800, phase: 0 },
      { name: "conversation-cleanup", every: 3600, phase: 600 },
      { name: "note-importance", every: 3600, phase: 1200 },
      { name: "operational-alerts", every: 3600, phase: 1800 },
      { name: "standing-recompute", every: 3600, phase: 2400 },
      { name: "memory-hygiene", every: 3600, phase: 2700 },
      { name: "memory-accumulation", every: 3600, phase: 900 },
      { name: "memory-observability-poll", every: 1, phase: 0 },
      { name: "retention", every: 3600, phase: 2100 },
      { name: "agent-cleanup", every: 60, phase: 0 },
      { name: "rank-progression", every: 3600, phase: 3000 },
    ]);
  });

  it("gives every hourly job its own phase", () => {
    const hourly = engine.describeTickSchedule().filter((j) => j.every === 3600);
    const phases = hourly.map((j) => j.phase);
    expect(hourly.length).toBeGreaterThan(5);
    expect(new Set(phases).size).toBe(phases.length);
  });

  it("starts with every job unrun", () => {
    for (const job of engine.describeTickSchedule()) {
      expect(job.runs).toBe(0);
      expect(job.lastRunTick).toBeUndefined();
      expect(job.lastError).toBeUndefined();
    }
  });
});
