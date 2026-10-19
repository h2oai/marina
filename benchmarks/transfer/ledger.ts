// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only access to a Marina benchmark ledger (`benchmark_runs` +
 * `benchmark_items`, any world or ledger DB) for the transfer report.
 *
 * Never writes to the DB it reads, not even SQLite's sidecar files: a DB
 * without a write-ahead log is opened through an `immutable=1` URI (no locks,
 * no -shm/-wal created); a DB WITH a non-empty -wal is copied with its log to
 * a temporary directory and the copy is opened, so rows still in the log are
 * read. A DB whose copy would exceed `maxCopyBytes` is read immutably and the
 * handle says the log was not read.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ItemScore } from "./core";

const SQLITE_OPEN_READONLY = 0x01;
const SQLITE_OPEN_URI = 0x40;
export const DEFAULT_MAX_COPY_BYTES = 1024 * 1024 * 1024;

export interface LedgerHandle {
  db: Database;
  path: string;
  /** Set when the DB had a write-ahead log that was not read. */
  note?: string;
  close(): void;
}

const uriPath = (p: string) => p.replace(/%/g, "%25").replace(/\?/g, "%3f").replace(/#/g, "%23");

export function openReadOnly(
  path: string,
  opts: { maxCopyBytes?: number; tmpRoot?: string } = {},
): LedgerHandle {
  const wal = `${path}-wal`;
  const walBytes = existsSync(wal) ? statSync(wal).size : 0;
  const immutable = (note?: string): LedgerHandle => {
    const db = new Database(
      `file:${uriPath(path)}?immutable=1`,
      SQLITE_OPEN_READONLY | SQLITE_OPEN_URI,
    );
    return { db, path, ...(note ? { note } : {}), close: () => db.close() };
  };
  if (walBytes === 0) return immutable();
  const total = statSync(path).size + walBytes;
  if (total > (opts.maxCopyBytes ?? DEFAULT_MAX_COPY_BYTES))
    return immutable(`write-ahead log (${walBytes} bytes) not read: too large to copy`);
  const dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "transfer-ledger-"));
  const copy = join(dir, basename(path));
  copyFileSync(path, copy);
  copyFileSync(wal, `${copy}-wal`);
  const db = new Database(copy, { readonly: true });
  return {
    db,
    path,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function tables(db: Database): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  );
}

export function hasLedger(db: Database): boolean {
  const t = tables(db);
  return t.has("benchmark_runs") && t.has("benchmark_items");
}

export interface LedgerRun {
  id: string;
  benchmark: string;
  label?: string;
  model?: string;
  /** Effective replicate group (the latest regroup wins). */
  group?: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  source: string;
  /** The latest validity action was `invalidate`. */
  invalid: boolean;
  items: number;
}

interface RunRow {
  id: string;
  benchmark: string;
  label: string | null;
  config_json: string;
  replicate_group: string | null;
  status: string;
  started_at: number;
  completed_at: number | null;
  source: string | null;
  items: number;
}

export function listLedgerRuns(db: Database): LedgerRun[] {
  const t = tables(db);
  const cols = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(benchmark_runs)")
      .all()
      .map((c) => c.name),
  );
  const opt = (c: string, alias = c) => (cols.has(c) ? `r.${c} AS ${alias}` : `NULL AS ${alias}`);
  const rows = db
    .query<RunRow, []>(
      `SELECT r.id, r.benchmark, ${opt("label")}, r.config_json, ${opt("replicate_group")},
              r.status, r.started_at, r.completed_at, ${opt("source")},
              (SELECT COUNT(*) FROM benchmark_items i WHERE i.run_id = r.id) AS items
         FROM benchmark_runs r ORDER BY r.started_at, r.id`,
    )
    .all();
  const regroup = new Map<string, string>();
  if (t.has("benchmark_run_regroups")) {
    for (const r of db
      .query<{ run_id: string; to_group: string }, []>(
        "SELECT run_id, to_group FROM benchmark_run_regroups ORDER BY created_at, id",
      )
      .all())
      regroup.set(r.run_id, r.to_group);
  }
  const invalid = new Map<string, boolean>();
  if (t.has("benchmark_run_validity")) {
    for (const r of db
      .query<{ run_id: string; action: string }, []>(
        "SELECT run_id, action FROM benchmark_run_validity ORDER BY created_at, id",
      )
      .all())
      invalid.set(r.run_id, r.action === "invalidate");
  }
  return rows.map((r) => {
    let model: string | undefined;
    try {
      const c = JSON.parse(r.config_json) as { model?: unknown };
      if (typeof c.model === "string") model = c.model;
    } catch {
      // allow-empty-catch: a malformed config only loses the model label
    }
    const group = regroup.get(r.id) ?? r.replicate_group ?? undefined;
    return {
      id: r.id,
      benchmark: r.benchmark,
      ...(r.label ? { label: r.label } : {}),
      ...(model ? { model } : {}),
      ...(group ? { group } : {}),
      status: r.status,
      startedAt: r.started_at,
      ...(r.completed_at ? { completedAt: r.completed_at } : {}),
      source: r.source ?? "in-world",
      invalid: invalid.get(r.id) ?? false,
      items: r.items,
    };
  });
}

/** One run's per-item scores: `score` when recorded, else `correct` as 1/0. */
export function ledgerItems(db: Database, runId: string): ItemScore[] {
  return db
    .query<{ item_id: string; correct: number; score: number | null }, [string]>(
      "SELECT item_id, correct, score FROM benchmark_items WHERE run_id = ? ORDER BY item_id",
    )
    .all(runId)
    .map((r) => ({ id: r.item_id, score: r.score ?? (r.correct ? 1 : 0) }));
}

/** The arm a run belongs to: its label without a trailing replicate (` r2`, `-r2`), else model. */
export function runVariant(run: Pick<LedgerRun, "label" | "model" | "id">): string {
  const label = run.label?.replace(/[\s_-]+r(?:ep)?\d+$/i, "").trim();
  return label || run.model || run.id;
}

export interface RunFilter {
  /** Comma-separated run ids. */
  run?: string;
  /** Glob (`*`) on the run's variant (label without replicate suffix) or full label. */
  label?: string;
  /** Glob on the effective replicate group. */
  group?: string;
  /** Glob on the benchmark name. */
  benchmark?: string;
  /** ISO date/time: runs started at or after. */
  since?: string;
  /** ISO date/time: runs started before. */
  until?: string;
  /** Include runs whose latest validity action is `invalidate` (default no). */
  includeInvalid?: boolean;
  /** Run status to keep (default `completed`; `any` keeps all). */
  status?: string;
}

const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

export function selectRuns(runs: readonly LedgerRun[], f: RunFilter): LedgerRun[] {
  const ids = f.run ? new Set(f.run.split(",").map((s) => s.trim())) : undefined;
  const label = f.label ? glob(f.label) : undefined;
  const group = f.group ? glob(f.group) : undefined;
  const bench = f.benchmark ? glob(f.benchmark) : undefined;
  const since = f.since ? Date.parse(f.since) : undefined;
  const until = f.until ? Date.parse(f.until) : undefined;
  if (since !== undefined && Number.isNaN(since)) throw new Error(`bad since: ${f.since}`);
  if (until !== undefined && Number.isNaN(until)) throw new Error(`bad until: ${f.until}`);
  const status = f.status ?? "completed";
  return runs.filter(
    (r) =>
      (!ids || ids.has(r.id)) &&
      (!label || label.test(runVariant(r)) || (r.label !== undefined && label.test(r.label))) &&
      (!group || (r.group !== undefined && group.test(r.group))) &&
      (!bench || bench.test(r.benchmark)) &&
      (since === undefined || r.startedAt >= since) &&
      (until === undefined || r.startedAt < until) &&
      (f.includeInvalid || !r.invalid) &&
      (status === "any" || r.status === status),
  );
}
