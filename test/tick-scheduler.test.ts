// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SandboxProviders } from "../src/coding/sandbox-provider";
import { Engine } from "../src/engine/engine";
import { Logger } from "../src/engine/logger";
import {
  registerTickJobs,
  TICK_SCHEDULE_OWNER,
  type TickJobHost,
  tickScheduleClock,
} from "../src/engine/tick-jobs";
import {
  DURABLE_SPREAD,
  durableOffset,
  type TickScheduleClock,
  TickScheduler,
} from "../src/engine/tick-scheduler";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, FAKE_SANDBOX_IDENTITY, makeTestRoom, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_tick_scheduler.db");

/**
 * The periodic half of the engine tick, extracted from `Engine.tickInner()`
 * the same way `ConnectionManager` / `EventLog` / `BriefManager` were. Two
 * things must hold: a job fires on exactly the ticks it declares, and one
 * failing job never costs the tick or the jobs behind it.
 */
describe("TickScheduler", () => {
  const logger = new Logger({ level: "error" });

  it("tracks the registered sandbox maintenance pass through overlap and shutdown", async () => {
    let release!: () => void;
    let passes = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = {
      logger,
      config: { tickInterval: 1000 },
      sandboxes: new SandboxProviders([
        {
          ...FAKE_SANDBOX_IDENTITY,
          maintenance: async () => {
            passes++;
            await held;
          },
        } as import("../src/coding/sandbox-provider").SandboxProvider,
      ]),
    } as TickJobHost;
    const scheduler = new TickScheduler(logger);
    const onlyMaintenance = {
      // This case exercises overlap/drain; wall-clock scheduling is covered below.
      attachClock: () => onlyMaintenance,
      register(job: import("../src/engine/tick-scheduler").TickJob) {
        if (job.name === "channel-prune") scheduler.register(job);
        return onlyMaintenance;
      },
    } as unknown as TickScheduler;
    registerTickJobs(host, onlyMaintenance);
    scheduler.runDue(1800);
    scheduler.runDue(3600);
    expect(passes).toBe(1);
    expect(scheduler.describe()[0]).toMatchObject({ inFlight: true, skippedOverlaps: 1 });
    let drained = false;
    const draining = scheduler.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await draining;
    expect(drained).toBe(true);
  });

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

/** An in-memory clock: wall time is a variable, the store a map. */
function fakeClock(tickMs = 1000, start = 1_000_000_000) {
  const store = new Map<string, number>();
  const state = { now: start };
  const clock: TickScheduleClock = {
    tickMs,
    now: () => state.now,
    load: (name) => store.get(name),
    save: (name, at) => void store.set(name, at),
  };
  return { clock, store, state };
}

/**
 * Durable jobs: the engine's tick counter restarts at 0 on every boot, so a
 * long-interval job is placed from its persisted last run instead of waiting
 * `phase` ticks (or forever, when the interval exceeds uptime).
 */
describe("TickScheduler durable jobs", () => {
  const logger = new Logger({ level: "error" });
  const sixHours = { name: "six-hourly", every: 21600, phase: 4200 };

  function boot(clock: TickScheduleClock, fired: number[]) {
    return new TickScheduler(logger)
      .attachClock(clock)
      .register({ ...sixHours, run: (tick) => void fired.push(tick) });
  }

  it("a job never run, or overdue after a restart, runs within the spread window", () => {
    const { clock, store, state } = fakeClock();
    const fired: number[] = [];
    let s = boot(clock, fired);
    for (let tick = 1; tick <= DURABLE_SPREAD; tick++) s.runDue(tick);
    const offset = durableOffset(sixHours);
    expect(offset).toBe(58);
    expect(fired).toEqual([1 + offset]);
    expect(store.get("six-hourly")).toBe(state.now);

    // Restart 7 h later (> the 6 h interval): due early again, not at phase 4200.
    state.now += 7 * 3600_000;
    fired.length = 0;
    s = boot(clock, fired);
    for (let tick = 1; tick <= DURABLE_SPREAD; tick++) s.runDue(tick);
    expect(fired).toEqual([1 + offset]);
    expect(s.describe()[0]).toMatchObject({
      durable: true,
      lastRunAt: state.now,
      nextDueTick: 1 + offset + 21600,
    });
  });

  it("a restart shortly after a run waits the remainder, on its own slot", () => {
    const { clock, store, state } = fakeClock();
    store.set("six-hourly", state.now - 3600_000); // ran 1 h ago
    const fired: number[] = [];
    const s = boot(clock, fired);
    s.runDue(1);
    const due = s.describe()[0]?.nextDueTick ?? 0;
    // 5 h remain = 18000 ticks; snapped forward onto the job's spread slot.
    expect(due).toBeGreaterThanOrEqual(1 + 18000);
    expect(due).toBeLessThan(1 + 18000 + DURABLE_SPREAD);
    expect((due - 1) % DURABLE_SPREAD).toBe(durableOffset(sixHours));
    for (let tick = 2; tick < due; tick++) s.runDue(tick);
    expect(fired).toEqual([]);
    s.runDue(due);
    expect(fired).toEqual([due]);
    expect(s.describe()[0]?.lastRunAt).toBe(state.now);
  });

  it("overdue jobs on one interval land on distinct ticks", () => {
    const { clock } = fakeClock();
    const fired = new Map<string, number>();
    const s = new TickScheduler(logger).attachClock(clock);
    for (const phase of [300, 600, 1200, 3300]) {
      s.register({
        name: `h${phase}`,
        every: 3600,
        phase,
        run: (tick) => void fired.set(`h${phase}`, tick),
      });
    }
    for (let tick = 1; tick <= DURABLE_SPREAD; tick++) s.runDue(tick);
    const ticks = [...fired.values()];
    expect(ticks.length).toBe(4);
    expect(new Set(ticks).size).toBe(4);
    expect(fired.get("h3300")).toBe(1 + 275);
  });

  it("short jobs keep the modulo rule and persist nothing", () => {
    const { clock, store } = fakeClock();
    const fired: number[] = [];
    const s = new TickScheduler(logger)
      .attachClock(clock)
      .register({ name: "short", every: 300, phase: 150, run: (t) => void fired.push(t) });
    for (let tick = 1; tick <= 700; tick++) s.runDue(tick);
    expect(fired).toEqual([150, 450]);
    expect(store.size).toBe(0);
    expect(s.describe()[0]?.durable).toBe(false);
  });

  it("without a clock a long job keeps the modulo rule", () => {
    const fired: number[] = [];
    const s = new TickScheduler(logger).register({
      name: "hourly",
      every: 3600,
      phase: 300,
      run: (t) => void fired.push(t),
    });
    for (let tick = 1; tick <= 400; tick++) s.runDue(tick);
    expect(fired).toEqual([300]);
    expect(s.describe()[0]?.durable).toBe(false);
  });

  it("a durable async job never overlaps itself", async () => {
    const { clock } = fakeClock(1000);
    let release: () => void = () => {};
    let starts = 0;
    const s = new TickScheduler(logger).attachClock(clock).register({
      name: "slow",
      every: 600,
      phase: 0,
      run: () => {
        starts++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    s.runDue(1); // armed and due at once (offset 0)
    for (let tick = 2; tick <= 1201; tick++) s.runDue(tick);
    expect(starts).toBe(1);
    expect(s.describe()[0]?.skippedOverlaps).toBe(2);
    release();
    await s.drain();
  });

  it("still enforces the distinct-phase invariant", () => {
    const s = new TickScheduler(logger)
      .attachClock(fakeClock().clock)
      .register({ name: "a", every: 3600, phase: 900, run: () => {} });
    expect(() => s.register({ name: "b", every: 3600, phase: 900, run: () => {} })).toThrow(
      /distinct phases/,
    );
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

  it("drains startup sandbox reconciliation before persistence can close", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.sandboxes.register({
      ...FAKE_SANDBOX_IDENTITY,
      reconcile: () => pending,
    } as import("../src/coding/sandbox-provider").SandboxProvider);
    engine.start();
    engine.stop();
    let drained = false;
    const shutdown = engine.shutdown().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await shutdown;
    expect(drained).toBe(true);
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
      // ~5 min of wall clock at this engine's 60 s tick; phase 1 keeps it off phase-0 slots.
      { name: "autonomy-pulse", every: 5, phase: 1 },
      { name: "board-archive", every: 3600, phase: 300 },
      { name: "channel-prune", every: 1800, phase: 0 },
      { name: "arena-autopilot", every: 3600, phase: 1500 },
      { name: "arena-filing-watch", every: 600, phase: 420 },
      { name: "conversation-cleanup", every: 3600, phase: 600 },
      { name: "note-importance", every: 3600, phase: 1200 },
      { name: "operational-alerts", every: 3600, phase: 1800 },
      { name: "assistance-expiry", every: 3600, phase: 1950 },
      { name: "standing-recompute", every: 3600, phase: 2400 },
      { name: "memory-hygiene", every: 3600, phase: 2700 },
      { name: "memory-accumulation", every: 3600, phase: 900 },
      { name: "memory-observability-poll", every: 1, phase: 0 },
      { name: "retention", every: 3600, phase: 2100 },
      { name: "agent-cleanup", every: 60, phase: 0 },
      { name: "rank-progression", every: 3600, phase: 3000 },
      { name: "lessons-from-work", every: 3600, phase: 3300 },
      { name: "outcome-delivery", every: 300, phase: 150 },
      // ~5 s, floored at 2 ticks so it has a phase of its own (this engine ticks every 60 s).
      { name: "media-video-poll", every: 2, phase: 1 },
      { name: "schedules", every: 10, phase: 3 },
      { name: "outcome-autoresolve", every: 3600, phase: 3450 },
      { name: "outcome-judge", every: 3600, phase: 3150 },
      { name: "live-promotion", every: 21600, phase: 4200 },
      // ~30 s, floored at 2 ticks; phase 0 at this interval (clear of the video poller's 1).
      { name: "asset-backfill", every: 2, phase: 0 },
      { name: "memory-known-at-backfill", every: 10, phase: 5 },
    ]);
  });

  it("gives every hourly job its own phase", () => {
    const hourly = engine.describeTickSchedule().filter((j) => j.every === 3600);
    const phases = hourly.map((j) => j.phase);
    expect(hourly.length).toBeGreaterThan(5);
    expect(new Set(phases).size).toBe(phases.length);
  });

  it("persists durable runs in core_memory and reads them back on the next boot", () => {
    const host = { db, config: { tickInterval: 1000 } } as Parameters<typeof tickScheduleClock>[0];
    let now = 5_000_000;
    const clock = tickScheduleClock(host, () => now);
    expect(clock.load("live-promotion")).toBeUndefined();
    clock.save("live-promotion", now);
    expect(db.getCoreMemory(TICK_SCHEDULE_OWNER, "live-promotion")?.value).toBe("5000000");
    now += 60_000;
    expect(tickScheduleClock(host, () => now).load("live-promotion")).toBe(5_000_000);

    const durable = engine
      .describeTickSchedule()
      .filter((j) => j.durable)
      .map((j) => j.name);
    expect(durable).toContain("live-promotion");
    expect(durable).toContain("lessons-from-work");
    expect(durable).not.toContain("outcome-delivery");
    expect(durable).not.toContain("schedules");
  });

  it("starts with every job unrun", () => {
    for (const job of engine.describeTickSchedule()) {
      expect(job.runs).toBe(0);
      expect(job.lastRunTick).toBeUndefined();
      expect(job.lastError).toBeUndefined();
    }
  });
});
