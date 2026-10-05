// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot backfill: every valid scored ledger run that has no lesson yet goes
 * through the judged outcome loop once (`bun run lessons backfill`).
 *
 *   - The outcome is `benchmarkRunOutcome`: run and baseline ids, scores, counts,
 *     cost per item, judge label, families and target subjects — never an
 *     item's question, answer or response text (the ledger holds none).
 *   - `resolvedAt` is the run's own `completed_at`, and the baseline is chosen
 *     only among runs completed by then, so the leakage rule holds as if the
 *     lesson had been learned when the run was filed.
 *   - Idempotent: a run whose own lesson (first ref `bench:<id>`, any trust,
 *     current) already exists is skipped, so a second pass writes nothing.
 *   - `relearnRejected`: a run whose current lessons are ALL rejected and were
 *     all written by an earlier learner (`provenance.learner` ≠
 *     `BENCHMARK_LEARNER`) is learned again. The rejected lessons stay as audit
 *     records; the new lesson carries the current learner, so a second pass
 *     skips the run whatever the new verdict was.
 *   - Invalid, failed, unscored and empty runs are skipped: they measured the
 *     infrastructure, not the target.
 *   - A run the judge could not decide (outage, spend cap) is deferred, not
 *     written `unverified`; `refuse` (the daily spend cap) stops the pass
 *     before the next run. Either way a later pass learns what was left.
 *   - Trusted, transferable lessons are mirrored into `lessons:meta` as on any
 *     other write (`MARINA_LESSONS_META` ≠ off).
 */

import type { MarinaDB } from "../persistence/database";
import { BENCHMARK_LEARNER, benchmarkRunOutcome } from "./intake";
import {
  type Lesson,
  type LessonTrust,
  type OutcomeLearnerDeps,
  type OutcomeRecord,
  recordOutcome,
} from "./outcomes";

export interface BackfillReport {
  /** Ledger runs looked at. */
  runs: number;
  /** Runs that already had a lesson (idempotency). */
  existing: number;
  /** Of `learned`, runs re-learned because an earlier learner's lessons were all rejected. */
  relearned: number;
  /** Invalid, failed, unscored or empty runs: nothing to learn. */
  skipped: number;
  /** Runs fed through the loop (or that would be, on a dry run). */
  learned: number;
  trust: Record<LessonTrust, number>;
  /** Lessons mirrored into `lessons:meta`. */
  mirrored: number;
  /** Runs fed but not written: the judge reached no verdict (left for a later pass). */
  deferred: number;
  /** Why the pass stopped early (`refuse`), if it did. */
  stopped?: string;
  /** Outcomes merged into an existing lesson at admission (`MARINA_MEMORY_RANKING=on`). */
  merged: number;
  failed: number;
  /** The ids of runs fed (or that would be fed). */
  runIds: string[];
}

/** Most runs one pass reads from the ledger. */
export const BACKFILL_MAX_RUNS = 500;

/** The run a benchmark lesson was learned FROM: its first `bench:` ref. */
function ownRun(l: Lesson): string | undefined {
  const first = l.refs?.[0];
  return first?.startsWith("bench:") ? first.slice("bench:".length) : undefined;
}

/**
 * Feed every valid ledger run without a lesson through the loop, oldest first.
 * `deps.sink` must support `find` (to see which runs already taught). Runs one
 * at a time: a backfill is bounded by the ledger, not by the hourly budget of
 * the background queue.
 */
export async function backfillLedgerLessons(
  db: MarinaDB,
  deps: OutcomeLearnerDeps,
  opts: {
    dryRun?: boolean;
    limit?: number;
    relearnRejected?: boolean;
    /** Checked before each run; a reason stops the pass (e.g. `dailyCapRefusal`). */
    refuse?: () => string | undefined;
    onRecord?: (r: OutcomeRecord) => void;
  } = {},
): Promise<BackfillReport> {
  if (!deps.sink.find) throw new Error("this lesson store cannot list lessons");
  const report: BackfillReport = {
    runs: 0,
    existing: 0,
    relearned: 0,
    skipped: 0,
    learned: 0,
    trust: { trusted: 0, unverified: 0, rejected: 0 },
    mirrored: 0,
    deferred: 0,
    merged: 0,
    failed: 0,
    runIds: [],
  };
  // A run taught a lesson, or was merged into one at admission (its run is
  // the first ref of a `merged` entry): either way it is not learned again.
  // Of the runs it taught, those every lesson of which an earlier learner
  // wrote and the judge rejected are re-learnable on request.
  const taught = new Set<string>();
  const stale = new Map<string, boolean>();
  for (const l of await deps.sink.find("benchmark", {}, 100_000)) {
    for (const m of l.merged ?? []) {
      const id = ownRun({ refs: m.refs } as Lesson);
      if (id) taught.add(id);
    }
    const id = ownRun(l);
    if (!id) continue;
    taught.add(id);
    const old = l.trust === "rejected" && l.provenance?.learner !== BENCHMARK_LEARNER;
    stale.set(id, (stale.get(id) ?? true) && old);
  }
  const runs = db
    .queryBenchmarkRuns({ limit: BACKFILL_MAX_RUNS })
    .sort((a, b) => (a.completed_at ?? 0) - (b.completed_at ?? 0) || a.id.localeCompare(b.id));
  for (const run of runs) {
    report.runs++;
    const relearn = !!opts.relearnRejected && stale.get(run.id) === true;
    if (taught.has(run.id) && !relearn) {
      report.existing++;
      continue;
    }
    if (
      run.status !== "completed" ||
      run.score === null ||
      run.score === undefined ||
      !(run.answered > 0)
    ) {
      report.skipped++;
      continue;
    }
    const outcome = benchmarkRunOutcome(db, run);
    if (!outcome) {
      report.skipped++;
      continue;
    }
    if (opts.limit !== undefined && report.learned >= opts.limit) break;
    report.learned++;
    if (relearn) report.relearned++;
    report.runIds.push(run.id);
    if (opts.dryRun) continue;
    const refused = opts.refuse?.();
    if (refused) {
      report.learned--;
      if (relearn) report.relearned--;
      report.runIds.pop();
      report.stopped = refused;
      break;
    }
    try {
      const record = await recordOutcome({ ...deps, deferUnjudged: true }, outcome);
      if (record.deferred) {
        report.deferred++;
        opts.onRecord?.(record);
        continue;
      }
      report.trust[record.trust]++;
      if (record.metaId) report.mirrored++;
      if (record.mergedInto) report.merged++;
      taught.add(run.id);
      stale.set(run.id, false);
      opts.onRecord?.(record);
    } catch {
      report.failed++;
    }
  }
  return report;
}
