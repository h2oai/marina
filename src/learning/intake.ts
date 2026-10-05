// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Outcome builders for producers whose verdict is a ledger row. Kept here so
 * each producer adds one call, and so the rule "general fields only, never the
 * case text" lives in one place.
 */

import { benchmarkExecution } from "../engine/benchmark-execution";
import { getErrorMessage } from "../engine/errors";
import type { MarinaDB } from "../persistence/database";
import { type LessonSink, OUTCOME_DOMAINS, type Outcome } from "./outcomes";
import {
  findLessons,
  lessonRetireSink,
  noteOutcome,
  type RetireResult,
  retireLessons,
} from "./service";

interface RunLike {
  id: string;
  benchmark: string;
  score: number | null;
  n?: number | null;
  slice_hash?: string | null;
  target_kind?: string | null;
  target_json?: string | null;
  label?: string | null;
  cost_usd?: number | null;
  judge?: string | null;
  completed_at?: number | null;
}

/** A short, general description of a ledger target (model / crew + formation / population). */
export function describeTarget(run: RunLike): string {
  let target: unknown;
  try {
    target = run.target_json ? JSON.parse(run.target_json) : undefined;
  } catch {
    target = run.target_json;
  }
  if (typeof target === "string") return `${run.target_kind ?? "model"} ${target}`;
  if (target && typeof target === "object") {
    const t = target as Record<string, unknown>;
    const formation = typeof t.formation === "string" ? ` in the ${t.formation} formation` : "";
    const models =
      t.models && typeof t.models === "object"
        ? ` (${[...new Set(Object.values(t.models as Record<string, unknown>).map(String))]
            .map((m) => m.split("/").pop())
            .slice(0, 6)
            .join(", ")})`
        : "";
    return `${run.target_kind ?? "crew"}${formation}${models}`;
  }
  return run.label ?? run.target_kind ?? "target";
}

/** Per-category tallies of a run (a category label and counts, never item text). */
export interface CategoryTally {
  category: string;
  n: number;
  correct: number;
}

/** At most this many categories are named in an outcome: the weakest ones. */
const MAX_OUTCOME_CATEGORIES = 4;

/** The weakest categories with at least two items, as `label k/n` phrases. */
function categorySignal(categories: CategoryTally[] | undefined): string[] {
  const ranked = (categories ?? [])
    .filter((c) => c.n >= 2)
    .sort((a, b) => a.correct / a.n - b.correct / b.n || b.n - a.n);
  if (ranked.length < 2) return [];
  return [
    `weakest categories: ${ranked
      .slice(0, MAX_OUTCOME_CATEGORIES)
      .map((c) => `${c.category} ${c.correct}/${c.n}`)
      .join(", ")}`,
  ];
}

/**
 * The outcome of one scored benchmark run: success means it matched or beat
 * the best other completed run on the same benchmark and item slice (so a
 * lesson says which configurations win, and which lose, on that kind of work).
 * `categories` adds the run's weakest categories. Nothing here reads, or can
 * carry, an item's question or answer: the outcome holds ids, scores, counts
 * and category labels only.
 */
export function benchmarkRunOutcome(
  db: MarinaDB,
  run: RunLike,
  opts: { categories?: CategoryTally[] } = {},
): Outcome | undefined {
  if (run.score === null || run.score === undefined) return undefined;
  const others = db
    .leaderboardBenchmark(run.benchmark, 50)
    .filter(
      (r) =>
        r.id !== run.id &&
        !!run.slice_hash &&
        r.slice_hash === run.slice_hash &&
        r.judge === run.judge,
    );
  const best = others[0];
  const execution = benchmarkExecution(db.getBenchmarkItems(run.id));
  const succeeded = !best || run.score >= (best.score ?? 0);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return {
    domain: "benchmark",
    source: `benchmark:${run.benchmark}`,
    succeeded,
    score: run.score,
    resolvedAt: new Date(run.completed_at ?? Date.now()).toISOString(),
    attempted: `${run.benchmark}; declared target: ${describeTarget(run)}`,
    signals: [
      `execution: ${execution.tracedItems}/${execution.items} items trace-linked, ${execution.unknownItems} unknown, ${execution.windowOnlyItems} window-only, ${execution.unverifiedItems} unverified`,
      `observed residents: ${execution.agents.length}; multiple residents on ${execution.multipleResidentItems} items; participation is not causal benefit`,
      ...(run.n ? [`n=${run.n}`] : []),
      ...(run.cost_usd !== null && run.cost_usd !== undefined && run.n
        ? [`$${(run.cost_usd / run.n).toFixed(4)}/item`]
        : []),
      ...(run.judge ? [`judge ${run.judge}`] : []),
      ...categorySignal(opts.categories),
    ],
    detail: best
      ? `${pct(run.score)} vs best other ${pct(best.score ?? 0)} (${describeTarget(best)})`
      : `${pct(run.score)}; no comparable baseline; superiority untested`,
    refs: [`bench:${run.id}`, ...(best ? [`bench:${best.id}`] : [])],
  };
}

/** Feed a just-recorded benchmark run to the learning loop (no-op unless armed). */
export function noteBenchmarkRun(
  db: MarinaDB,
  run: RunLike,
  opts: { categories?: CategoryTally[] } = {},
): void {
  // An invalid run measured the infrastructure, not the target: no lesson.
  if (db.getBenchmarkRun(run.id)?.status === "invalid") return;
  const outcome = benchmarkRunOutcome(db, run, opts);
  if (outcome) noteOutcome(db, outcome);
}

/**
 * A ledger run was invalidated (`benchmark invalidate`, `benchmark:import
 * --invalidate`): retire every current lesson that cites it (`bench:<id>` in
 * its refs — lessons learned from the run, and lessons that compared another
 * run against it). Retirement is the audited `revise` path: the lesson stops
 * being served, its history and the reason stay readable. Revalidating the
 * run does not bring them back (a new outcome teaches again). Never throws.
 */
export async function retireLessonsForRun(
  db: MarinaDB,
  runId: string,
  retirement: { reason: string; by: string },
  opts: { sink?: LessonSink } = {},
): Promise<RetireResult & { error?: string }> {
  try {
    const sink = opts.sink ?? lessonRetireSink(db);
    const found = await findLessons(
      db,
      OUTCOME_DOMAINS,
      { ref: `bench:${runId}` },
      {
        sink,
        limit: 1_000,
      },
    );
    if (!found.length) return { retired: [], failed: [] };
    return await retireLessons(
      db,
      found,
      { reason: `benchmark run ${runId} invalidated: ${retirement.reason}`, by: retirement.by },
      { sink },
    );
  } catch (err) {
    return { retired: [], failed: [], error: getErrorMessage(err) };
  }
}
