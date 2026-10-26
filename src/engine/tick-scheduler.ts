// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage, tryLogAsync } from "./errors";
import type { Logger } from "./logger";

/**
 * Declarative periodic tick work.
 *
 * Extracted from `Engine.tickInner()` to reduce god-object surface area —
 * the same pattern as `ConnectionManager` / `EventLog` / `BriefManager`.
 * The engine still owns everything that runs on EVERY tick (command phase,
 * room `onTick`, sandbox tick, direct-message expiry, crew GC, brief
 * heartbeat); the scheduler owns the jobs that fire on `tick % every === phase`.
 *
 * Phases exist so hourly jobs never all land on the same tick — historically
 * board-archive + note-importance + alerts + standing + rank progression fired
 * together on tick 3600, outside the tick budget. `register()` enforces that
 * two jobs sharing an interval never share a phase.
 *
 * Durable jobs: the tick counter restarts at 0 on every boot, so under the
 * plain modulo rule a job waits `phase` ticks after each restart and a job
 * whose interval exceeds typical uptime rarely or never runs. A job with
 * `every >= DURABLE_MIN_EVERY` ticks is therefore scheduled on WALL CLOCK once
 * a `TickScheduleClock` is attached: each run's start time is persisted, and
 * on boot (the first `runDue`, the "arm" tick) a job whose interval
 * (`every × tickMs`) has elapsed since that time — or that never ran — is due
 * at `armTick + durableOffset(job)`; one that ran recently waits the remainder,
 * rounded up to the same offset on a `DURABLE_SPREAD`-tick grid. The offset
 * is the phase scaled into the spread window, so jobs that hold distinct
 * phases on one interval still land on distinct ticks after a restart. After
 * a run the next due tick is `tick + every`. Shorter jobs keep the modulo rule.
 */
export interface TickJob {
  /** Stable identifier — unique across the schedule; shown by `describe()`. */
  name: string;
  /** Interval in ticks. Must be a positive integer. */
  every: number;
  /** Offset within the interval: the job fires when `tick % every === phase`. */
  phase: number;
  /**
   * The work. A returned Promise is never awaited by the tick (`tryLogAsync`),
   * but it is tracked: the job is not started again while it is in flight,
   * and `drain()` settles it before shutdown closes the database. A sync
   * return runs inside the tick budget (`tryLog`).
   */
  run: (tick: number) => void | Promise<void>;
  /**
   * `true` = a synchronous throw is NOT swallowed: it is recorded on the job
   * and rethrown so the engine's tick loop counts it (`recordTickError`) —
   * this mirrors the pre-extraction jobs that ran without a `tryLog` wrapper.
   * Default `false` = failures are logged as warnings and never stop the tick
   * or the remaining due jobs.
   */
  critical?: boolean;
  /** Logger category for the failure warning. Default `"tick"`. */
  logCategory?: string;
  /** Warning message on failure. Default `"<name> failed"`. */
  failureMessage?: string;
}

/**
 * Jobs with an interval of at least this many ticks (10 min at the default
 * 1 s tick) are durable on wall clock when a clock is attached; shorter jobs
 * keep `tick % every === phase`.
 */
export const DURABLE_MIN_EVERY = 600;

/** Window (ticks) over which overdue durable jobs are spread after a boot. */
export const DURABLE_SPREAD = 300;

/** Ticks after the arm tick at which an overdue durable job first runs. */
export function durableOffset(job: Pick<TickJob, "every" | "phase">): number {
  return Math.floor((job.phase * DURABLE_SPREAD) / job.every);
}

/** True when `job` is scheduled on wall clock (given an attached clock). */
export function isDurableJob(job: Pick<TickJob, "every">): boolean {
  return job.every >= DURABLE_MIN_EVERY;
}

/**
 * Persistence + wall clock for durable jobs. `load`/`save` keep each job's
 * last run start (wall-clock ms) by job name; both are best-effort (a failure
 * is logged and the job falls back to "never ran"/unsaved).
 */
export interface TickScheduleClock {
  /** Milliseconds between ticks, for converting `every` into wall time. */
  tickMs: number;
  now(): number;
  load(name: string): number | undefined;
  save(name: string, atMs: number): void;
}

/** One row of `TickScheduler.describe()` — for `readiness` / the dashboard. */
export interface TickJobStatus {
  name: string;
  every: number;
  phase: number;
  critical: boolean;
  /** `true` when `run` returned a Promise on its last invocation. */
  async: boolean;
  /** Number of invocations so far. */
  runs: number;
  /** Tick of the most recent invocation, or `undefined` when never run. */
  lastRunTick?: number;
  /** Wall-clock duration of the most recent invocation (settlement for async jobs). */
  lastDurationMs?: number;
  /** Message of the most recent failure; cleared by the next successful run. */
  lastError?: string;
  /** `true` while the job's last async run has not settled yet. */
  inFlight?: boolean;
  /** Times the job came due while its previous async run was still in flight (skipped). */
  skippedOverlaps?: number;
  /** `true` when the job is scheduled on wall clock (see `DURABLE_MIN_EVERY`). */
  durable: boolean;
  /** Wall-clock start (ms) of the last run — persisted across restarts for durable jobs. */
  lastRunAt?: number;
  /** Tick at which a durable job is next due, once armed. */
  nextDueTick?: number;
}

interface JobState {
  job: TickJob;
  async: boolean;
  runs: number;
  lastRunTick?: number;
  lastDurationMs?: number;
  lastError?: string;
  /** The unsettled async run, if any: the job never overlaps itself. */
  inFlight?: Promise<void>;
  skippedOverlaps: number;
  lastRunAt?: number;
  /** Durable jobs only: the tick the job is next due at, set when armed. */
  nextDueTick?: number;
}

function isThenable(value: unknown): value is Promise<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class TickScheduler {
  private readonly jobs: JobState[] = [];
  private readonly byName = new Map<string, JobState>();
  private clock?: TickScheduleClock;

  constructor(private readonly logger: Logger) {}

  /**
   * Schedule long-interval jobs on wall clock (see the class comment). Attach
   * before the first `runDue`; jobs are armed lazily on the first tick they
   * are checked, so `load` may read collaborators assigned after construction.
   */
  attachClock(clock: TickScheduleClock): this {
    this.clock = clock;
    return this;
  }

  /**
   * Add a job to the schedule. Throws on an invalid interval/phase, a duplicate
   * name, or a second job at the same `(every, phase)` slot — the phase
   * invariant is enforced here rather than left to a comment.
   */
  register(job: TickJob): this {
    if (!Number.isInteger(job.every) || job.every < 1) {
      throw new Error(`Tick job "${job.name}": every must be a positive integer, got ${job.every}`);
    }
    if (!Number.isInteger(job.phase) || job.phase < 0 || job.phase >= job.every) {
      throw new Error(
        `Tick job "${job.name}": phase must be an integer in [0, ${job.every}), got ${job.phase}`,
      );
    }
    if (this.byName.has(job.name)) {
      throw new Error(`Tick job "${job.name}" is already registered`);
    }
    const clash = this.jobs.find((s) => s.job.every === job.every && s.job.phase === job.phase);
    if (clash) {
      throw new Error(
        `Tick job "${job.name}" shares every=${job.every} phase=${job.phase} with "${clash.job.name}"; ` +
          "jobs on the same interval must run at distinct phases",
      );
    }
    const state: JobState = { job, async: false, runs: 0, skippedOverlaps: 0 };
    this.jobs.push(state);
    this.byName.set(job.name, state);
    return this;
  }

  /** True when `job` would fire on `tick`. */
  static isDue(job: Pick<TickJob, "every" | "phase">, tick: number): boolean {
    return tick % job.every === job.phase;
  }

  /** Names of the jobs that fire on `tick`, in registration order. */
  due(tick: number): string[] {
    return this.jobs.filter((s) => this.isStateDue(s, tick)).map((s) => s.job.name);
  }

  private durable(state: JobState): boolean {
    return this.clock !== undefined && isDurableJob(state.job);
  }

  private isStateDue(state: JobState, tick: number): boolean {
    if (!this.durable(state)) return TickScheduler.isDue(state.job, tick);
    if (state.nextDueTick === undefined) this.arm(state, tick);
    return state.nextDueTick !== undefined && tick >= state.nextDueTick;
  }

  /** First check of a durable job in this process: place it from its persisted last run. */
  private arm(state: JobState, tick: number): void {
    const clock = this.clock;
    if (!clock) return;
    const { job } = state;
    const offset = durableOffset(job);
    let last: number | undefined;
    try {
      last = clock.load(job.name);
    } catch (err) {
      this.logger.warn("tick", "Tick schedule load failed", {
        job: job.name,
        error: getErrorMessage(err),
      });
    }
    const intervalMs = job.every * Math.max(1, clock.tickMs);
    const elapsed = last === undefined ? Number.POSITIVE_INFINITY : clock.now() - last;
    if (last !== undefined) state.lastRunAt = last;
    if (!(elapsed < intervalMs)) {
      state.nextDueTick = tick + offset;
      return;
    }
    // Ran recently: wait the remainder, then snap onto this job's slot of the
    // spread grid so jobs stay on distinct ticks.
    const remaining = Math.ceil(Math.max(0, intervalMs - elapsed) / Math.max(1, clock.tickMs));
    const earliest = tick + Math.max(offset, remaining);
    const slip =
      (((offset - (earliest - tick)) % DURABLE_SPREAD) + DURABLE_SPREAD) % DURABLE_SPREAD;
    state.nextDueTick = earliest + slip;
  }

  /**
   * Run every job due on `tick`, in registration order. Non-critical failures
   * are logged and never propagate; a critical job's synchronous throw is
   * recorded, then rethrown to the caller (the engine's tick error path), and
   * the remaining due jobs on that tick are skipped — exactly as an unwrapped
   * throw inside `tickInner` behaved before the extraction.
   */
  runDue(tick: number): void {
    for (const state of this.jobs) {
      if (!this.isStateDue(state, tick)) continue;
      if (this.durable(state)) state.nextDueTick = tick + state.job.every;
      this.execute(state, tick);
    }
  }

  /** Snapshot of every registered job and its last run, in registration order. */
  describe(): TickJobStatus[] {
    return this.jobs.map((s) => ({
      name: s.job.name,
      every: s.job.every,
      phase: s.job.phase,
      critical: s.job.critical === true,
      async: s.async,
      runs: s.runs,
      lastRunTick: s.lastRunTick,
      lastDurationMs: s.lastDurationMs,
      lastError: s.lastError,
      inFlight: s.inFlight !== undefined,
      skippedOverlaps: s.skippedOverlaps,
      durable: this.durable(s),
      lastRunAt: s.lastRunAt,
      nextDueTick: s.nextDueTick,
    }));
  }

  /** Async job runs that have not settled yet. */
  get pendingCount(): number {
    return this.jobs.filter((s) => s.inFlight).length;
  }

  /**
   * Settle every in-flight async job run. The engine awaits this before the
   * database closes, so a job never writes into a closed store. Failures were
   * already logged by the run itself; this never rejects.
   */
  async drain(): Promise<void> {
    for (;;) {
      const pending = this.jobs.flatMap((s) => (s.inFlight ? [s.inFlight] : []));
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /** Number of registered jobs. */
  get size(): number {
    return this.jobs.length;
  }

  private execute(state: JobState, tick: number): void {
    const { job } = state;
    const category = job.logCategory ?? "tick";
    const message = job.failureMessage ?? `${job.name} failed`;
    // Overlap guard: a slow async run (network, model calls) is never started
    // a second time on top of itself; the due tick is skipped and counted.
    if (state.inFlight) {
      state.skippedOverlaps++;
      return;
    }
    const started = performance.now();
    state.runs++;
    state.lastRunTick = tick;
    const clock = this.clock;
    state.lastRunAt = clock ? clock.now() : Date.now();
    if (clock) {
      if (this.durable(state)) {
        try {
          clock.save(job.name, state.lastRunAt);
        } catch (err) {
          this.logger.warn("tick", "Tick schedule save failed", {
            job: job.name,
            error: getErrorMessage(err),
          });
        }
      }
    }
    const finish = (err?: unknown): void => {
      state.lastDurationMs = performance.now() - started;
      state.lastError = err === undefined ? undefined : getErrorMessage(err);
    };

    // Assigned inside the tryLog closure below, which TypeScript cannot see
    // through — initialise so the thenable check after it is well-defined.
    // The synchronous phase is inlined rather than wrapped in `tryLog` so the
    // assignment to `result` is visible to the compiler; the non-critical
    // branch logs exactly what `tryLog` would (warn, same category/message).
    let result: void | Promise<void>;
    try {
      result = job.run(tick);
    } catch (err) {
      finish(err);
      if (job.critical) throw err;
      this.logger.warn(category, message, { error: getErrorMessage(err) });
      return;
    }

    if (isThenable(result)) {
      state.async = true;
      const pending = result;
      const settled = tryLogAsync(this.logger, category, message, async () => {
        try {
          await pending;
        } catch (err) {
          finish(err);
          throw err;
        }
        finish();
      }).then(
        () => undefined,
        () => undefined,
      );
      state.inFlight = settled;
      void settled.then(() => {
        if (state.inFlight === settled) state.inFlight = undefined;
      });
      return;
    }
    state.async = false;
    finish();
  }
}
