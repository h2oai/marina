// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Outcome builders for producers whose verdict is a ledger row. Kept here so
 * each producer adds one call, and so the rule "general fields only, never the
 * case text" lives in one place.
 */

import type { MarinaDB } from "../persistence/database";
import type { Outcome } from "./outcomes";
import { noteOutcome } from "./service";

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

/**
 * The outcome of one scored benchmark run: success means it matched or beat
 * the best other completed run on the same benchmark and item slice (so a
 * lesson says which configurations win, and which lose, on that kind of work).
 */
export function benchmarkRunOutcome(db: MarinaDB, run: RunLike): Outcome | undefined {
  if (run.score === null || run.score === undefined) return undefined;
  const others = db
    .leaderboardBenchmark(run.benchmark, 50)
    .filter((r) => r.id !== run.id && (!run.slice_hash || r.slice_hash === run.slice_hash));
  const best = others[0];
  const succeeded = !best || run.score >= (best.score ?? 0);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return {
    domain: "benchmark",
    source: `benchmark:${run.benchmark}`,
    succeeded,
    score: run.score,
    resolvedAt: new Date(run.completed_at ?? Date.now()).toISOString(),
    attempted: `${run.benchmark} with ${describeTarget(run)}`,
    signals: [
      ...(run.n ? [`n=${run.n}`] : []),
      ...(run.cost_usd && run.n ? [`$${(run.cost_usd / run.n).toFixed(4)}/item`] : []),
      ...(run.judge ? [`judge ${run.judge}`] : []),
    ],
    detail: best
      ? `${pct(run.score)} vs best other ${pct(best.score ?? 0)} (${describeTarget(best)})`
      : `${pct(run.score)}; first run on this slice`,
    refs: [`bench:${run.id}`, ...(best ? [`bench:${best.id}`] : [])],
  };
}

/** Feed a just-recorded benchmark run to the learning loop (no-op unless armed). */
export function noteBenchmarkRun(db: MarinaDB, run: RunLike): void {
  // An invalid run measured the infrastructure, not the target: no lesson.
  if (db.getBenchmarkRun(run.id)?.status === "invalid") return;
  const outcome = benchmarkRunOutcome(db, run);
  if (outcome) noteOutcome(db, outcome);
}
