// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Benchmark runs ────────────────────────────────────────────────────────

export function insertBenchmarkRun(
  db: Database,
  row: {
    id: string;
    benchmark: string;
    config_hash: string;
    config_json: string;
    status: string;
    agent_id?: string;
    started_at: number;
  },
): void {
  db.run(
    "INSERT INTO benchmark_runs (id, benchmark, config_hash, config_json, status, agent_id, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      row.id,
      row.benchmark,
      row.config_hash,
      row.config_json,
      row.status,
      row.agent_id ?? null,
      row.started_at,
    ],
  );
}

export function completeBenchmarkRun(
  db: Database,
  id: string,
  data: {
    score: number | null;
    breakdown_json: string | null;
    answered: number;
    total: number;
    status: string;
    completed_at: number;
    duration_ms: number;
  },
): void {
  db.run(
    "UPDATE benchmark_runs SET score = ?, breakdown_json = ?, answered = ?, total = ?, status = ?, completed_at = ?, duration_ms = ? WHERE id = ?",
    [
      data.score,
      data.breakdown_json,
      data.answered,
      data.total,
      data.status,
      data.completed_at,
      data.duration_ms,
      id,
    ],
  );
}

export function getBenchmarkRun(reader: Database, id: string): BenchmarkRunRow | undefined {
  return reader.query("SELECT * FROM benchmark_runs WHERE id = ?").get(id) as
    | BenchmarkRunRow
    | undefined;
}

export function queryBenchmarkRuns(
  reader: Database,
  q: { benchmark?: string; status?: string; agentId?: string; limit?: number },
): BenchmarkRunRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (q.benchmark) {
    clauses.push("benchmark = ?");
    params.push(q.benchmark);
  }
  if (q.status) {
    clauses.push("status = ?");
    params.push(q.status);
  }
  if (q.agentId) {
    clauses.push("agent_id = ?");
    params.push(q.agentId);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(q.limit ?? 50, 500);
  params.push(limit);
  return reader
    .query(`SELECT * FROM benchmark_runs${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params) as BenchmarkRunRow[];
}

export function leaderboardBenchmark(
  reader: Database,
  benchmark: string,
  limit = 20,
): BenchmarkRunRow[] {
  // answered > 0: runs recorded before the runner treated an all-error harness
  // run as a failure are "completed" at 0% — they measured nothing.
  return reader
    .query(
      "SELECT * FROM benchmark_runs WHERE benchmark = ? AND status = 'completed' AND score IS NOT NULL AND answered > 0 ORDER BY score DESC, started_at DESC LIMIT ?",
    )
    .all(benchmark, Math.min(limit, 100)) as BenchmarkRunRow[];
}

// ─── Ledger (migration 146) ─────────────────────────────────────────────────
//
// A ledger run carries its cost, n, Wilson interval, item slice, judge and
// target, and every item outcome by id (never case content). Writes are one
// transaction; `content_hash` makes an import idempotent.

export interface BenchmarkLedgerRunInput {
  id: string;
  benchmark: string;
  config_hash: string;
  config_json: string;
  agent_id?: string | null;
  started_at: number;
  completed_at: number;
  duration_ms: number | null;
  score: number;
  answered: number;
  total: number;
  cost_usd: number | null;
  n: number;
  ci_low: number;
  ci_high: number;
  seed: number | null;
  slice_hash: string;
  judge: string | null;
  target_kind: BenchmarkTargetKind;
  target_json: string;
  label: string | null;
  source: "in-world" | "import";
  content_hash: string | null;
}

export type BenchmarkTargetKind = "model" | "crew" | "population";

export interface BenchmarkItemInput {
  item_id: string;
  correct: boolean;
  score: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  trace_id: string | null;
  participants_json: string | null;
  judge_verdict: string | null;
}

/**
 * Record a completed run and its items in one transaction. A run whose
 * `content_hash` is already recorded is not written again: the existing id is
 * returned with `created: false`.
 */
export function recordBenchmarkLedgerRun(
  db: Database,
  run: BenchmarkLedgerRunInput,
  items: readonly BenchmarkItemInput[],
): { id: string; created: boolean } {
  return db.transaction(() => {
    if (run.content_hash) {
      const existing = db
        .query("SELECT id FROM benchmark_runs WHERE content_hash = ?")
        .get(run.content_hash) as { id: string } | null;
      if (existing) return { id: existing.id, created: false };
    }
    db.run(
      `INSERT INTO benchmark_runs (id, benchmark, config_hash, config_json, score, answered, total,
         status, agent_id, started_at, completed_at, duration_ms, cost_usd, n, ci_low, ci_high, seed,
         slice_hash, judge, target_kind, target_json, label, source, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.benchmark,
        run.config_hash,
        run.config_json,
        run.score,
        run.answered,
        run.total,
        run.agent_id ?? null,
        run.started_at,
        run.completed_at,
        run.duration_ms,
        run.cost_usd,
        run.n,
        run.ci_low,
        run.ci_high,
        run.seed,
        run.slice_hash,
        run.judge,
        run.target_kind,
        run.target_json,
        run.label,
        run.source,
        run.content_hash,
      ],
    );
    const insert = db.prepare(
      `INSERT INTO benchmark_items (run_id, item_id, correct, score, latency_ms, cost_usd, trace_id,
         participants_json, judge_verdict) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const it of items) {
      insert.run(
        run.id,
        it.item_id,
        it.correct ? 1 : 0,
        it.score,
        it.latency_ms,
        it.cost_usd,
        it.trace_id,
        it.participants_json,
        it.judge_verdict,
      );
    }
    return { id: run.id, created: true };
  })();
}

/** Every recorded item outcome of one run, in insertion order. */
export function getBenchmarkItems(reader: Database, runId: string): BenchmarkItemRow[] {
  return reader
    .query("SELECT * FROM benchmark_items WHERE run_id = ? ORDER BY id")
    .all(runId) as BenchmarkItemRow[];
}

/** Item outcomes of every completed run of a benchmark (for participant credit). */
export function getBenchmarkItemsForBenchmark(
  reader: Database,
  benchmark: string,
  limit = 20_000,
): BenchmarkItemRow[] {
  return reader
    .query(
      `SELECT i.* FROM benchmark_items i JOIN benchmark_runs r ON r.id = i.run_id
       WHERE r.benchmark = ? AND r.status = 'completed' ORDER BY i.id LIMIT ?`,
    )
    .all(benchmark, Math.min(limit, 100_000)) as BenchmarkItemRow[];
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface BenchmarkRunRow {
  id: string;
  benchmark: string;
  config_hash: string;
  config_json: string;
  score: number | null;
  breakdown_json: string | null;
  answered: number;
  total: number;
  status: string;
  agent_id: string | null;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  // Ledger columns (migration 146) — null on runs recorded before it.
  cost_usd?: number | null;
  n?: number | null;
  ci_low?: number | null;
  ci_high?: number | null;
  seed?: number | null;
  slice_hash?: string | null;
  judge?: string | null;
  target_kind?: BenchmarkTargetKind | null;
  target_json?: string | null;
  label?: string | null;
  source?: "in-world" | "import";
  content_hash?: string | null;
}

export interface BenchmarkItemRow {
  id: number;
  run_id: string;
  item_id: string;
  correct: 0 | 1;
  score: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  trace_id: string | null;
  participants_json: string | null;
  judge_verdict: string | null;
}

// ─── Promoted defaults (migration 147) ────────────────────────────────────

export interface BenchmarkDefaultRow {
  slot: string;
  value_json: string;
  incumbent_run_id: string | null;
  holdout_fraction: number;
  updated_at: number;
  updated_by: string | null;
}

export interface BenchmarkPromotionRow {
  id: number;
  slot: string;
  outcome: "seeded" | "promoted" | "refused";
  challenger_run_id: string | null;
  incumbent_run_id: string | null;
  value_json: string | null;
  actor: string | null;
  stats_json: string | null;
  reason: string | null;
  created_at: number;
}

export interface BenchmarkPromotionInput {
  slot: string;
  outcome: BenchmarkPromotionRow["outcome"];
  challenger_run_id: string | null;
  incumbent_run_id: string | null;
  value_json: string | null;
  actor: string | null;
  stats_json: string | null;
  reason: string | null;
  /** Fixed on the slot's first row; ignored afterwards. */
  holdout_fraction?: number;
  created_at: number;
}

export function getBenchmarkDefault(
  reader: Database,
  slot: string,
): BenchmarkDefaultRow | undefined {
  return (reader.query("SELECT * FROM benchmark_defaults WHERE slot = ?").get(slot) ?? undefined) as
    | BenchmarkDefaultRow
    | undefined;
}

export function listBenchmarkDefaults(reader: Database): BenchmarkDefaultRow[] {
  return reader
    .query("SELECT * FROM benchmark_defaults ORDER BY slot")
    .all() as BenchmarkDefaultRow[];
}

export function listBenchmarkPromotions(reader: Database, slot: string): BenchmarkPromotionRow[] {
  return reader
    .query("SELECT * FROM benchmark_promotions WHERE slot = ? ORDER BY id")
    .all(slot) as BenchmarkPromotionRow[];
}

/**
 * Append one history row; a `seeded` or `promoted` outcome also makes its
 * challenger the slot's incumbent — in the same transaction, so the current
 * value never moves without its evidence row.
 */
export function recordBenchmarkPromotion(db: Database, row: BenchmarkPromotionInput): number {
  return db.transaction(() => {
    const res = db.run(
      `INSERT INTO benchmark_promotions (slot, outcome, challenger_run_id, incumbent_run_id,
         value_json, actor, stats_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.slot,
        row.outcome,
        row.challenger_run_id,
        row.incumbent_run_id,
        row.value_json,
        row.actor,
        row.stats_json,
        row.reason,
        row.created_at,
      ],
    );
    if (row.outcome !== "refused") {
      if (row.value_json === null) throw new Error("a promoted default needs a value");
      db.run(
        `INSERT INTO benchmark_defaults (slot, value_json, incumbent_run_id, holdout_fraction,
           updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET value_json = excluded.value_json,
           incumbent_run_id = excluded.incumbent_run_id, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
        [
          row.slot,
          row.value_json,
          row.challenger_run_id,
          row.holdout_fraction ?? 0.5,
          row.created_at,
          row.actor,
        ],
      );
    }
    return Number(res.lastInsertRowid);
  })();
}
