// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A benchmark run on the one outcome path: every completed, valid run with a
 * score becomes ONE durable `outcomes` row (kind `benchmark`, subject
 * `bench:<run id>`), whichever way it entered the ledger — an in-world run or
 * an imported harness result. Ids and numbers only, never an item's question
 * or answer: the score, the item count and the configuration that produced it.
 *
 * Every row names its family (the benchmark) and its method (the measured
 * configuration: target kind plus model, stack or formation), the same
 * `family:` / `method:` tagging the arena entry uses (`src/arena/settle.ts`),
 * so evidence can be read per (family, method) across every producer.
 *
 * A run is a measurement (`eval_mode = measure`): it never counts as live
 * evidence (`src/outcomes/evidence.ts`). It has no delivery consumers — its
 * lesson goes through the benchmark learner (`noteBenchmarkRun`), which owns
 * the leak guard; this row is the durable record that the run happened and
 * how it scored. Idempotent: one run, one row. An invalid run records nothing;
 * a run invalidated later keeps its row (outcomes are append-only) and readers
 * honour the ledger's validity through the `bench:<id>` ref.
 */

import type { MarinaDB } from "../persistence/database";
import type { BenchmarkRunRow } from "../persistence/db-benchmarks";
import { recordResolved } from "./record";

/** The subject of a benchmark run's outcome. */
export function benchmarkSubject(runId: string): string {
  return `bench:${runId}`;
}

type RunLike = Pick<
  BenchmarkRunRow,
  "id" | "benchmark" | "score" | "status" | "total" | "answered" | "completed_at" | "agent_id"
> &
  Partial<Pick<BenchmarkRunRow, "n" | "target_kind" | "target_json" | "label" | "cost_usd">>;

function parsedTarget(run: Pick<RunLike, "target_json">): unknown {
  try {
    return run.target_json ? JSON.parse(run.target_json) : undefined;
  } catch {
    return run.target_json;
  }
}

function targetObject(target: unknown): Record<string, unknown> | undefined {
  return target && typeof target === "object" && !Array.isArray(target)
    ? (target as Record<string, unknown>)
    : undefined;
}

/**
 * The measured configuration as one compact evidence key: `<target kind>:<target>`
 * — a model id (with any passthru stack prefixes), `<model>+<stack>` for an
 * in-world arm, or the crew/population formation. Configuration only. A crew
 * is always `crew:<formation>` (`crew:unknown` when no formation was
 * recorded) — never a model id; the model goes in `method:model:`
 * (`benchmarkModelMethod`).
 */
export function benchmarkMethod(
  run: Pick<RunLike, "target_kind" | "target_json" | "label">,
): string {
  const kind = run.target_kind ?? "model";
  const target = parsedTarget(run);
  const t = targetObject(target);
  const formation = !t
    ? ""
    : typeof t.formation === "string"
      ? t.formation
      : t.formation && typeof t.formation === "object"
        ? String((t.formation as Record<string, unknown>).kind ?? "")
        : "";
  if (kind === "crew") return `crew:${formation || "unknown"}`;
  if (typeof target === "string" && target) return `${kind}:${target}`;
  if (t) {
    if (formation) return `${kind}:${formation}`;
    if (typeof t.model === "string")
      return `${kind}:${t.model}${typeof t.stack === "string" ? `+${t.stack}` : ""}`;
  }
  return `${kind}:${run.label ?? "unknown"}`;
}

/**
 * `model:<id>` for a crew run whose target names the upstream model its
 * residents ran on (not the `marina:<crew>` endpoint), else undefined.
 */
export function benchmarkModelMethod(
  run: Pick<RunLike, "target_kind" | "target_json">,
): string | undefined {
  if (run.target_kind !== "crew") return undefined;
  const model = targetObject(parsedTarget(run))?.model;
  return typeof model === "string" && model && !model.startsWith("marina:")
    ? `model:${model}`
    : undefined;
}

/** Whether a run can be recorded: completed, valid and scored. */
function recordable(run: RunLike): run is RunLike & { score: number } {
  return run.status === "completed" && typeof run.score === "number" && Number.isFinite(run.score);
}

/**
 * Record one benchmark run's outcome (idempotent per run). Returns undefined
 * when the run is not recordable (not completed, invalid or unscored).
 */
export function recordBenchmarkRun(
  db: MarinaDB,
  run: RunLike,
  now = Date.now(),
): { id: number; created: boolean } | undefined {
  if (!recordable(run)) return undefined;
  const quality = Math.min(1, Math.max(0, run.score));
  const method = benchmarkMethod(run);
  const modelMethod = benchmarkModelMethod(run);
  const n = run.n ?? run.total;
  return recordResolved(db, {
    subject: benchmarkSubject(run.id),
    kind: "benchmark",
    source: `benchmark:${run.benchmark}`,
    domain: "benchmark",
    ...(run.agent_id ? { owner: run.agent_id } : {}),
    // A measurement that completed with a valid score; how well it went is `quality`.
    succeeded: true,
    quality,
    loss: 1 - quality,
    metric: "score",
    truth: { score: run.score, n, answered: run.answered },
    detail: `${run.benchmark} ${(run.score * 100).toFixed(1)}% (n ${n}); family ${run.benchmark}; method ${method}${typeof run.cost_usd === "number" ? `; cost $${run.cost_usd.toFixed(2)}` : ""}`,
    basis: "mechanical",
    evalMode: "measure",
    refs: [
      benchmarkSubject(run.id),
      `family:${run.benchmark}`,
      `method:${method}`,
      ...(modelMethod ? [`method:${modelMethod}`] : []),
    ],
    resolvedAt: Math.min(run.completed_at ?? now, now),
  });
}

/**
 * Backfill: record every completed, scored run already in the ledger that has
 * no outcome yet (oldest first). The ledger query returns at most the newest
 * 500 runs; live runs are recorded as they complete, so a pass only ever has
 * the backlog to catch up. Idempotent; returns how many were new.
 */
export function settleBenchmarkRuns(
  db: MarinaDB,
  opts: { limit?: number; now?: number } = {},
): { recorded: number; skipped: number; total: number } {
  const runs = db.queryBenchmarkRuns({ status: "completed", limit: opts.limit ?? 500 });
  let recorded = 0;
  let skipped = 0;
  for (const run of [...runs].reverse()) {
    const r = recordBenchmarkRun(db, run, opts.now);
    if (r?.created) recorded++;
    else skipped++;
  }
  return { recorded, skipped, total: runs.length };
}
