// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Declarative row retention for the append-heavy tables.
 *
 * Every table Marina writes on a hot path (a row per command, per agent tool
 * call, per memory operation, per direct message, …) is listed here with a
 * class and a keep window. `runRetentionPass` runs hourly from the engine
 * tick and deletes past-window rows in bounded batches. Tables whose value is
 * the record itself (`chronicle`, `entity_standing`, `memory_resolutions`,
 * `economic_events`) are listed as `append-only` so the policy is explicit
 * and never pruned.
 *
 * Operators override any window with ONE env var:
 *   MARINA_RETENTION_OVERRIDES="primitive_usage=30d,feed_events=0,event_log=250000"
 * A duration (`30d`, `12h`, `2w`, `90m`, `45s`) replaces a time window, a bare
 * integer replaces a row count (`event_log` keeps the newest N rows), and `0`
 * disables pruning for that table. Unknown tables and malformed entries are
 * ignored with a warning.
 *
 * Constants live here (not in `constants.ts`) so the policy table and its
 * defaults read as one unit.
 */

import type { MarinaDB } from "../persistence/database";
import { EVENT_LOG_DB_RETENTION } from "./constants";

export type RetentionKind = "telemetry" | "ledger" | "audit" | "append-only";

export interface RetentionPolicy {
  /** Table name (trusted; validated against the live schema at run time). */
  table: string;
  /**
   * Column (or SQL expression when it contains anything but an identifier)
   * holding the epoch-ms timestamp the keep window is measured from. Required
   * for `keepMs` policies; ignored for `keepRows` and `append-only`.
   */
  timeColumn?: string;
  /** Delete rows whose `timeColumn` is older than `now - keepMs`. */
  keepMs?: number;
  /** Keep only the newest N rows (by INTEGER PRIMARY KEY `id`). */
  keepRows?: number;
  /** Extra predicate ANDed onto the delete (e.g. only terminal statuses). */
  where?: string;
  kind: RetentionKind;
  /** Why this window — surfaces in `describeRetentionPolicies()`. */
  note?: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Class defaults. A policy may pin its own `keepMs`; most inherit these. */
export const RETENTION_DEFAULTS: Record<Exclude<RetentionKind, "append-only">, number> = {
  telemetry: 14 * DAY_MS,
  ledger: 90 * DAY_MS,
  audit: 365 * DAY_MS,
};

/** Rows deleted per DELETE statement — keeps each statement's lock short. */
export const RETENTION_BATCH_ROWS = 5_000;
/** Batches per table per pass; the remainder is picked up next hour. */
export const RETENTION_MAX_BATCHES_PER_TABLE = 20;
/** Hourly tick phase (`tickCount % NOTE_IMPORTANCE_INTERVAL`), distinct from the others. */
export const RETENTION_TICK_PHASE = 2100;

export const RETENTION_OVERRIDES_ENV = "MARINA_RETENTION_OVERRIDES";

/** Join-derived timestamp for a table with no time column of its own. */
const ASSISTANCE_ACTION_TIME =
  "(SELECT j.created_at FROM memory_assistance_jobs j WHERE j.id = memory_assistance_actions.job_id)";

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  // ── telemetry: high-volume, derivable, nobody reads it after two weeks ──
  {
    table: "primitive_usage",
    timeColumn: "created_at",
    kind: "telemetry",
    note: "one row per command and per agent tool call",
  },
  {
    table: "feed_events",
    timeColumn: "created_at",
    kind: "telemetry",
    keepMs: 7 * DAY_MS,
    note: "7-day ephemeral timeline (was trimmed only at startup)",
  },
  {
    table: "memory_service_events",
    timeColumn: "created_at",
    kind: "telemetry",
    keepMs: 30 * DAY_MS,
    note: "observability + watch cursors; a watch idle > 30 d re-primes from the live seq",
  },
  {
    table: "coding_events",
    timeColumn: "created_at",
    kind: "telemetry",
    keepMs: 30 * DAY_MS,
    note: "Code Mode session event stream",
  },
  {
    table: "event_log",
    keepRows: EVENT_LOG_DB_RETENTION,
    kind: "telemetry",
    note: "engine event log; row-bounded (MARINA_EVENT_RETENTION), backs traces",
  },
  // ── ledgers: operational history worth a quarter ──
  {
    table: "direct_messages",
    timeColumn: "created_at",
    kind: "ledger",
    where:
      "(status IN ('acknowledged', 'expired') OR (status = 'delivered' AND deadline_at IS NULL))",
    note: "settled or deadline-less messages; live deadline rows are left for expireDirectMessages",
  },
  {
    table: "cognitive_events",
    timeColumn: "created_at",
    kind: "ledger",
    note: "per-turn cognitive provenance; hash-chained, pruned oldest-first so the surviving chain stays contiguous",
  },
  {
    table: "productivity_sessions",
    timeColumn: "started_at",
    kind: "ledger",
    note: "per-task focus sessions feeding the learning signal",
  },
  {
    table: "core_memory_history",
    timeColumn: "changed_at",
    kind: "ledger",
    note: "core-memory KV change trail",
  },
  {
    table: "media_jobs",
    timeColumn: "updated_at",
    kind: "ledger",
    note: "media generation jobs; a job untouched for the window is dead regardless of status",
  },
  {
    table: "memory_assistance_actions",
    timeColumn: ASSISTANCE_ACTION_TIME,
    kind: "ledger",
    note: "idempotency receipts for assistance-job actions; dated by the owning job",
  },
  // ── audit: keep a year ──
  { table: "witness_attestations", timeColumn: "created_at", kind: "audit" },
  { table: "trace_judgments", timeColumn: "created_at", kind: "audit" },
  { table: "note_verifications", timeColumn: "created_at", kind: "audit" },
  {
    table: "evidence_receipts",
    timeColumn: "created_at",
    kind: "audit",
    note: "hash chain; oldest-first pruning keeps the newest window verifiable",
  },
  { table: "association_events", timeColumn: "created_at", kind: "audit" },
  {
    table: "benchmark_runs",
    timeColumn: "started_at",
    kind: "audit",
    note: "qualification history",
  },
  {
    table: "shell_log",
    timeColumn: "created_at",
    kind: "audit",
    keepMs: 90 * DAY_MS,
    note: "gated-exec audit trail (mirrors the 90 d startup trim)",
  },
  // ── append-only: the record IS the value; never pruned ──
  { table: "chronicle", kind: "append-only", note: "canonical civic history" },
  { table: "entity_standing", kind: "append-only", note: "reputation ledger (decay is computed)" },
  { table: "memory_resolutions", kind: "append-only", note: "contradiction-resolution audit" },
  {
    table: "economic_events",
    kind: "append-only",
    note: "contract / settlement ledger — financial history is not aged out by default",
  },
];

// ─── Overrides ──────────────────────────────────────────────────────────────

export type RetentionOverride = { keepMs: number } | { keepRows: number } | { disabled: true };

/** Parse `30d` / `12h` / `2w` / `90m` / `45s` to ms; a bare integer is a row count. */
export function parseRetentionValue(raw: string): RetentionOverride | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "0" || value === "off" || value === "never") return { disabled: true };
  const match = /^(\d+)([smhdw])?$/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  const unit = match[2];
  if (!unit) return { keepRows: n };
  const mult = { s: 1_000, m: 60_000, h: HOUR_MS, d: DAY_MS, w: 7 * DAY_MS }[unit];
  return { keepMs: n * (mult as number) };
}

/**
 * Parse the override env value. Returns the map plus any entries that were
 * rejected (unknown table, bad value) so the caller can warn once.
 */
export function parseRetentionOverrides(
  raw: string | undefined,
  known: Iterable<string> = RETENTION_POLICIES.map((p) => p.table),
): { overrides: Map<string, RetentionOverride>; rejected: string[] } {
  const overrides = new Map<string, RetentionOverride>();
  const rejected: string[] = [];
  if (!raw?.trim()) return { overrides, rejected };
  const knownSet = new Set(known);
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      rejected.push(entry);
      continue;
    }
    const table = entry.slice(0, eq).trim();
    const parsed = parseRetentionValue(entry.slice(eq + 1));
    if (!knownSet.has(table) || !parsed) {
      rejected.push(entry);
      continue;
    }
    overrides.set(table, parsed);
  }
  return { overrides, rejected };
}

/** A policy with its defaults and overrides applied. */
export interface EffectivePolicy extends RetentionPolicy {
  effectiveKeepMs?: number;
  effectiveKeepRows?: number;
  /** True when the table is append-only or overridden to `0`. */
  disabled: boolean;
}

export function effectivePolicies(
  overrides: Map<string, RetentionOverride>,
  policies: readonly RetentionPolicy[] = RETENTION_POLICIES,
): EffectivePolicy[] {
  return policies.map((policy) => {
    if (policy.kind === "append-only") return { ...policy, disabled: true };
    const override = overrides.get(policy.table);
    if (override && "disabled" in override) return { ...policy, disabled: true };
    if (override && "keepRows" in override) {
      return { ...policy, effectiveKeepRows: override.keepRows, disabled: false };
    }
    if (override && "keepMs" in override) {
      return { ...policy, effectiveKeepMs: override.keepMs, disabled: false };
    }
    if (policy.keepRows !== undefined) {
      return { ...policy, effectiveKeepRows: policy.keepRows, disabled: false };
    }
    return {
      ...policy,
      effectiveKeepMs: policy.keepMs ?? RETENTION_DEFAULTS[policy.kind],
      disabled: false,
    };
  });
}

// ─── Pass ───────────────────────────────────────────────────────────────────

export interface RetentionPassResult {
  /** Rows deleted per table (only tables where something was deleted). */
  deleted: Record<string, number>;
  /** Tables skipped because they (or their time column) do not exist in this DB. */
  skipped: string[];
  /** Override entries that could not be applied. */
  rejectedOverrides: string[];
  /** Tables that still had rows past the window when the batch cap was hit. */
  truncated: string[];
  durationMs: number;
}

export interface RetentionPassOptions {
  now?: number;
  /** Defaults to `process.env[MARINA_RETENTION_OVERRIDES]`. */
  overridesEnv?: string;
  policies?: readonly RetentionPolicy[];
  batchRows?: number;
  maxBatchesPerTable?: number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Delete past-window rows for every enabled policy, in bounded batches.
 * Pure SQL, synchronous, safe to call from the tick under `tryLog`. Tables
 * (or time columns) missing from this database are skipped, not failed —
 * a world that never created a table must not break the pass.
 */
export function runRetentionPass(
  db: MarinaDB,
  opts: RetentionPassOptions = {},
): RetentionPassResult {
  const result = runRetentionPassInner(db, opts);
  lastReport = {
    at: opts.now ?? Date.now(),
    deleted: { ...result.deleted },
    skipped: [...result.skipped],
    durationMs: result.durationMs,
  };
  return result;
}

function runRetentionPassInner(db: MarinaDB, opts: RetentionPassOptions): RetentionPassResult {
  const started = Date.now();
  const now = opts.now ?? started;
  const policies = opts.policies ?? RETENTION_POLICIES;
  const batchRows = Math.max(1, Math.min(opts.batchRows ?? RETENTION_BATCH_ROWS, 50_000));
  const maxBatches = Math.max(1, opts.maxBatchesPerTable ?? RETENTION_MAX_BATCHES_PER_TABLE);
  const { overrides, rejected } = parseRetentionOverrides(
    opts.overridesEnv ?? process.env[RETENTION_OVERRIDES_ENV],
    policies.map((p) => p.table),
  );
  const result: RetentionPassResult = {
    deleted: {},
    skipped: [],
    rejectedOverrides: rejected,
    truncated: [],
    durationMs: 0,
  };

  for (const policy of effectivePolicies(overrides, policies)) {
    if (policy.disabled) continue;
    if (!IDENT.test(policy.table) || !db.tableExists(policy.table)) {
      result.skipped.push(policy.table);
      continue;
    }
    const columns = db.tableColumns(policy.table);

    let whereSql: string;
    let params: (string | number)[];
    if (policy.effectiveKeepRows !== undefined) {
      if (!columns.includes("id")) {
        result.skipped.push(policy.table);
        continue;
      }
      // OFFSET-cutoff boundary (same shape as pruneLogs/pruneEvents): one
      // indexed probe, then bounded deletes below it.
      whereSql = `id < COALESCE((SELECT id FROM ${policy.table} ORDER BY id DESC LIMIT 1 OFFSET ?), 0)`;
      params = [Math.max(0, policy.effectiveKeepRows - 1)];
    } else {
      const time = policy.timeColumn;
      if (!time || policy.effectiveKeepMs === undefined) {
        result.skipped.push(policy.table);
        continue;
      }
      if (IDENT.test(time) && !columns.includes(time)) {
        result.skipped.push(policy.table);
        continue;
      }
      whereSql = `${time} < ?`;
      params = [now - policy.effectiveKeepMs];
    }
    if (policy.where) whereSql = `(${whereSql}) AND ${policy.where}`;

    let total = 0;
    let batches = 0;
    for (;;) {
      const changes = db.deleteBatch(policy.table, whereSql, params, batchRows);
      total += changes;
      batches++;
      if (changes < batchRows) break;
      if (batches >= maxBatches) {
        result.truncated.push(policy.table);
        break;
      }
    }
    if (total > 0) result.deleted[policy.table] = total;
  }

  result.durationMs = Date.now() - started;
  return result;
}

/** One-line summary for the tick log: `primitive_usage=1200 feed_events=40 (312ms)`. */
export function formatRetentionSummary(result: RetentionPassResult): string {
  const parts = Object.entries(result.deleted).map(([table, n]) => `${table}=${n}`);
  const extras: string[] = [];
  if (result.truncated.length) extras.push(`more pending: ${result.truncated.join(",")}`);
  if (result.rejectedOverrides.length) {
    extras.push(`ignored overrides: ${result.rejectedOverrides.join(",")}`);
  }
  return `${parts.join(" ")}${extras.length ? ` [${extras.join("; ")}]` : ""} (${result.durationMs}ms)`;
}

/** Snapshot of the most recent `runRetentionPass` in this process (dashboard / operator view). */
export interface RetentionReport {
  /** Epoch-ms the pass ran (`opts.now` when supplied). */
  at: number;
  deleted: Record<string, number>;
  skipped: string[];
  durationMs: number;
}

let lastReport: RetentionReport | null = null;

/** The last pass this process ran, or `null` before the first hourly pass. */
export function getLastRetentionReport(): RetentionReport | null {
  if (!lastReport) return null;
  return { ...lastReport, deleted: { ...lastReport.deleted }, skipped: [...lastReport.skipped] };
}

/** @internal test seam */
export function resetRetentionReportForTests(): void {
  lastReport = null;
}

export interface RetentionPolicyDescription {
  table: string;
  kind: RetentionKind;
  /** Human keep window: `"90d"`, `"12h"`, `"never"`, `"250000 rows"`. */
  keep: string;
  /** True when `MARINA_RETENTION_OVERRIDES` changed this table's window. */
  overridden: boolean;
  note?: string;
}

/** `90d` / `12h` / `45m` / `30s` — the largest unit that divides evenly. */
export function formatKeepWindow(ms: number): string {
  if (ms > 0 && ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms > 0 && ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms > 0 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/** Human-readable policy table (for docs / operator introspection / `GET /api/retention`). */
export function describeRetentionPolicies(
  overridesEnv = process.env[RETENTION_OVERRIDES_ENV],
): RetentionPolicyDescription[] {
  const { overrides } = parseRetentionOverrides(overridesEnv);
  return effectivePolicies(overrides).map((p) => ({
    table: p.table,
    kind: p.kind,
    keep:
      p.kind === "append-only" || p.disabled
        ? "never"
        : p.effectiveKeepRows !== undefined
          ? `${p.effectiveKeepRows} rows`
          : formatKeepWindow(p.effectiveKeepMs ?? 0),
    overridden: p.kind !== "append-only" && overrides.has(p.table),
    ...(p.note ? { note: p.note } : {}),
  }));
}
