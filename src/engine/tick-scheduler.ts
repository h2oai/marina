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
 */
export interface TickJob {
  /** Stable identifier — unique across the schedule; shown by `describe()`. */
  name: string;
  /** Interval in ticks. Must be a positive integer. */
  every: number;
  /** Offset within the interval: the job fires when `tick % every === phase`. */
  phase: number;
  /**
   * The work. A returned Promise is fire-and-forget (`tryLogAsync`, never
   * awaited by the tick); a sync return runs inside the tick budget (`tryLog`).
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
}

interface JobState {
  job: TickJob;
  async: boolean;
  runs: number;
  lastRunTick?: number;
  lastDurationMs?: number;
  lastError?: string;
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

  constructor(private readonly logger: Logger) {}

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
    const state: JobState = { job, async: false, runs: 0 };
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
    return this.jobs.filter((s) => TickScheduler.isDue(s.job, tick)).map((s) => s.job.name);
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
      if (!TickScheduler.isDue(state.job, tick)) continue;
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
    }));
  }

  /** Number of registered jobs. */
  get size(): number {
    return this.jobs.length;
  }

  private execute(state: JobState, tick: number): void {
    const { job } = state;
    const category = job.logCategory ?? "tick";
    const message = job.failureMessage ?? `${job.name} failed`;
    const started = performance.now();
    state.runs++;
    state.lastRunTick = tick;
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
      void tryLogAsync(this.logger, category, message, async () => {
        try {
          await pending;
        } catch (err) {
          finish(err);
          throw err;
        }
        finish();
      });
      return;
    }
    state.async = false;
    finish();
  }
}
