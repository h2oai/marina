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
}
