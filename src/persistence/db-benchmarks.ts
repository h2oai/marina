// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHmac, randomBytes } from "node:crypto";
import { canonicalJson } from "../engine/benchmark-ledger";
import {
  type BenchmarkSourceEvidence,
  normalizeSourceEvidence,
  sourceEvidenceHash,
  sourceParticipants,
} from "./benchmark-source-evidence";

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
  /**
   * A second hash that also identifies this content (the raw-bytes hash runs
   * were filed under before the stable hash); matched on write, never stored.
   */
  legacy_content_hash?: string | null;
  /** Replicate group key (migration 148); null ⇒ grouped by target/slice/judge when read. */
  replicate_group?: string | null;
  /**
   * Set ⇒ the run is recorded `invalid` (migration 153) with this reason and an
   * automatic audit row — e.g. too many items were fallbacks, not answers.
   */
  invalid_reason?: string | null;
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
  /**
   * Unkeyed digest of the normalised answer (`answerDigest` in
   * `src/engine/benchmark-ledger.ts`); the ledger stores only a keyed hash of
   * it (`answer_hash`, migration 157). Omitted = no answer reported.
   */
  answer_digest?: string | null;
  /** The answer was forced at a turn, step or time budget (migration 157). */
  budget_forced?: boolean | 0 | 1 | null;
  /** Verification outcome: checks passed, ran and failed, or never ran (migration 157). */
  verification?: BenchmarkVerification | null;
  /**
   * Judged lesson ids the item was served (`x-marina-lessons`), and the run's
   * lesson regime (migration 160). Ids only — never lesson or item text.
   */
  lessons?: BenchmarkItemLessons | null;
}

export interface BenchmarkItemLessons {
  served: readonly string[];
  observed: readonly string[];
  regime?: BenchmarkLessonRegime | null;
}

/** `measure`: lessons learned from the same board were excluded; `live`: every lesson. */
export type BenchmarkLessonRegime = "measure" | "live";

/** One served (or observed) lesson of one ledger item (migration 160). */
export interface BenchmarkItemLessonRow {
  run_id: string;
  item_id: string;
  lesson_id: string;
  use: "served" | "observed";
  regime: BenchmarkLessonRegime | null;
}

/** Most lesson ids recorded per item (a recall serves a handful). */
export const MAX_ITEM_LESSONS = 16;
const LESSON_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Verification states the ledger keeps apart: a check that never ran is not a failed check. */
export type BenchmarkVerification = "passed" | "failed" | "not_run";
export const BENCHMARK_VERIFICATION_STATES: readonly BenchmarkVerification[] = [
  "passed",
  "failed",
  "not_run",
];

/** `app_settings` key of the per-ledger answer-hash key (created on first use). */
export const ANSWER_HASH_KEY_SETTING = "benchmark.answer_hash_key";

/**
 * The ledger's answer-hash key: random, per database, created on first use.
 * Hashes compare within one ledger (and its exports, which carry
 * `app_settings`), but a short answer such as a choice letter cannot be
 * recovered by hashing guesses.
 */
export function benchmarkAnswerHashKey(db: Database): string {
  const read = () =>
    (
      db.query("SELECT value FROM app_settings WHERE key = ?").get(ANSWER_HASH_KEY_SETTING) as {
        value: string;
      } | null
    )?.value;
  const existing = read();
  if (existing) return existing;
  db.run("INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)", [
    ANSWER_HASH_KEY_SETTING,
    randomBytes(32).toString("hex"),
    Date.now(),
  ]);
  return read() as string;
}

/** The stored answer hash of one item's digest: keyed by the ledger, bound to the item id. */
export function keyedAnswerHash(key: string, itemId: string, digest: string): string {
  return createHmac("sha256", key).update(`${itemId}\u0000${digest}`).digest("hex").slice(0, 32);
}

/**
 * Record a completed run and its items in one transaction. A run whose
 * `content_hash` (or `legacy_content_hash`) is already recorded is not written
 * again: the existing id is returned with `created: false`.
 */
/** Append an item's served / observed lesson ids (deduplicated, capped, ids validated). */
function insertItemLessons(
  db: Database,
  runId: string,
  itemId: string,
  lessons: BenchmarkItemLessons,
): void {
  const regime = lessons.regime === "measure" || lessons.regime === "live" ? lessons.regime : null;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO benchmark_item_lessons (run_id, item_id, lesson_id, use, regime) VALUES (?, ?, ?, ?, ?)",
  );
  let n = 0;
  for (const [use, ids] of [
    ["served", lessons.served],
    ["observed", lessons.observed],
  ] as const) {
    for (const id of ids) {
      if (n >= MAX_ITEM_LESSONS) return;
      if (!LESSON_ID.test(id)) continue;
      if (insert.run(runId, itemId, id, use, regime).changes > 0) n++;
    }
  }
}

/** The lessons a run's items were served, in item order (migration 160). */
export function getBenchmarkItemLessons(reader: Database, runId: string): BenchmarkItemLessonRow[] {
  return reader
    .query(
      `SELECT l.run_id, l.item_id, l.lesson_id, l.use, l.regime FROM benchmark_item_lessons l
       JOIN benchmark_items i ON i.run_id = l.run_id AND i.item_id = l.item_id
       WHERE l.run_id = ? ORDER BY i.id, l.rowid`,
    )
    .all(runId) as BenchmarkItemLessonRow[];
}

export function recordBenchmarkLedgerRun(
  db: Database,
  run: BenchmarkLedgerRunInput,
  items: readonly BenchmarkItemInput[],
  evidence?: BenchmarkSourceEvidence,
): { id: string; created: boolean } {
  return db.transaction(() => {
    const hashes = [run.content_hash, run.legacy_content_hash].filter((h): h is string =>
      Boolean(h),
    );
    if (hashes.length > 0) {
      const existing = db
        .query(
          `SELECT id FROM benchmark_runs WHERE content_hash IN (${hashes.map(() => "?").join(", ")}) ORDER BY started_at, id LIMIT 1`,
        )
        .get(...hashes) as { id: string } | null;
      if (existing) {
        if (evidence) attachBenchmarkSourceEvidence(db, existing.id, evidence);
        return { id: existing.id, created: false };
      }
    }
    db.run(
      `INSERT INTO benchmark_runs (id, benchmark, config_hash, config_json, score, answered, total,
         status, agent_id, started_at, completed_at, duration_ms, cost_usd, n, ci_low, ci_high, seed,
         slice_hash, judge, target_kind, target_json, label, source, content_hash, replicate_group)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.benchmark,
        run.config_hash,
        run.config_json,
        run.score,
        run.answered,
        run.total,
        run.invalid_reason ? "invalid" : "completed",
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
        run.replicate_group ?? null,
      ],
    );
    const insert = db.prepare(
      `INSERT INTO benchmark_items (run_id, item_id, correct, score, latency_ms, cost_usd, trace_id,
         participants_json, judge_verdict, answer_hash, budget_forced, verification)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const key = items.some((it) => it.answer_digest) ? benchmarkAnswerHashKey(db) : "";
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
        it.answer_digest ? keyedAnswerHash(key, it.item_id, it.answer_digest) : null,
        it.budget_forced === null || it.budget_forced === undefined
          ? null
          : it.budget_forced
            ? 1
            : 0,
        it.verification && BENCHMARK_VERIFICATION_STATES.includes(it.verification)
          ? it.verification
          : null,
      );
      if (it.lessons) insertItemLessons(db, run.id, it.item_id, it.lessons);
    }
    if (run.invalid_reason) {
      insertValidityRow(db, {
        run_id: run.id,
        action: "invalidate",
        reason: run.invalid_reason,
        actor: null,
        source: "auto",
        created_at: run.completed_at,
      });
    }
    if (evidence) attachBenchmarkSourceEvidence(db, run.id, evidence);
    return { id: run.id, created: true };
  })();
}

// ─── Run validity (migration 153) ──────────────────────────────────────────
//
// A run that measured the infrastructure rather than the target (spend cap,
// provider outage, mostly fallbacks) is retired by setting its status to
// `invalid`; every reader of the ledger ranks only `completed` runs. Nothing
// is deleted: item rows stay, and every invalidate / revalidate is an
// append-only audit row with who, when and why.

export type BenchmarkValidityAction = "invalidate" | "revalidate";
/** `in-world` = the `benchmark` command; `operator` = the import script; `auto` = a harness threshold. */
export type BenchmarkValiditySource = "in-world" | "operator" | "auto";

export interface BenchmarkValidityInput {
  run_id: string;
  action: BenchmarkValidityAction;
  reason: string;
  /** Durable account key (in-world), `operator`, or null for an automatic check. */
  actor: string | null;
  source: BenchmarkValiditySource;
  created_at: number;
}

export interface BenchmarkValidityRow extends BenchmarkValidityInput {
  id: number;
}

function insertValidityRow(db: Database, row: BenchmarkValidityInput): number {
  const res = db.run(
    `INSERT INTO benchmark_run_validity (run_id, action, reason, actor, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.run_id, row.action, row.reason, row.actor, row.source, row.created_at],
  );
  return Number(res.lastInsertRowid);
}

export type BenchmarkValidityResult =
  | { ok: true; id: number; status: "invalid" | "completed" }
  | { ok: false; error: string };

/**
 * Invalidate a completed run, or revalidate an invalid one: the status change
 * and its audit row commit together. Any other starting status is refused.
 */
export function setBenchmarkRunValidity(
  db: Database,
  row: BenchmarkValidityInput,
): BenchmarkValidityResult {
  return db.transaction((): BenchmarkValidityResult => {
    const run = db.query("SELECT status FROM benchmark_runs WHERE id = ?").get(row.run_id) as {
      status: string;
    } | null;
    if (!run) return { ok: false, error: `No run ${row.run_id}.` };
    const [from, to] =
      row.action === "invalidate"
        ? (["completed", "invalid"] as const)
        : (["invalid", "completed"] as const);
    if (run.status !== from) {
      return {
        ok: false,
        error:
          row.action === "invalidate"
            ? `Run ${row.run_id} is ${run.status}; only a completed run can be invalidated.`
            : `Run ${row.run_id} is ${run.status}, not invalid — nothing to revalidate.`,
      };
    }
    db.run("UPDATE benchmark_runs SET status = ? WHERE id = ?", [to, row.run_id]);
    return { ok: true, id: insertValidityRow(db, row), status: to };
  })();
}

/** A run's validity history, oldest first. */
export function listBenchmarkRunValidity(reader: Database, runId: string): BenchmarkValidityRow[] {
  return reader
    .query("SELECT * FROM benchmark_run_validity WHERE run_id = ? ORDER BY id")
    .all(runId) as BenchmarkValidityRow[];
}

// ─── Replicate regrouping (migration 155) ──────────────────────────────────
//
// Moving a run between replicate groups changes what pools and promotes, so a
// regroup never rewrites a run silently: each move commits with an append-only
// audit row naming the old and new group, the actor and the reason.

/** `in-world` = a world command; `operator` = the import script on the operator's database. */
export type BenchmarkRegroupSource = "in-world" | "operator";

export interface BenchmarkRegroupAudit {
  reason: string;
  /** Durable account key (in-world) or `operator`. */
  actor: string | null;
  source: BenchmarkRegroupSource;
  created_at: number;
}

export interface BenchmarkRegroupRow extends BenchmarkRegroupAudit {
  id: number;
  run_id: string;
  from_group: string | null;
  to_group: string;
}

/**
 * Put runs into one replicate group (operator regrouping, e.g. replicates
 * recorded before groups existed or with slightly different target labels).
 * Item outcomes are untouched — only the run's group key changes — and every
 * run that actually moves gets an audit row in the same transaction.
 */
export function setBenchmarkReplicateGroup(
  db: Database,
  runIds: readonly string[],
  group: string,
  audit: BenchmarkRegroupAudit,
): number {
  if (runIds.length === 0) return 0;
  return db.transaction(() => {
    let changed = 0;
    for (const id of runIds) {
      const row = db.query("SELECT replicate_group FROM benchmark_runs WHERE id = ?").get(id) as {
        replicate_group: string | null;
      } | null;
      if (!row || row.replicate_group === group) continue;
      changed += db.run("UPDATE benchmark_runs SET replicate_group = ? WHERE id = ?", [
        group,
        id,
      ]).changes;
      db.run(
        `INSERT INTO benchmark_run_regroups (run_id, from_group, to_group, reason, actor, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, row.replicate_group, group, audit.reason, audit.actor, audit.source, audit.created_at],
      );
    }
    return changed;
  })();
}

/** A run's append-only regroup history, oldest first. */
export function listBenchmarkRunRegroups(reader: Database, runId: string): BenchmarkRegroupRow[] {
  return reader
    .query("SELECT * FROM benchmark_run_regroups WHERE run_id = ? ORDER BY id")
    .all(runId) as BenchmarkRegroupRow[];
}

/** Every recorded item outcome of one run, in insertion order. */
const ITEM_EVIDENCE_COLUMNS = `i.id, i.run_id, i.item_id, i.correct, i.score,
  i.latency_ms, i.cost_usd, i.trace_id, i.judge_verdict, i.answer_hash, i.budget_forced, i.verification,
  COALESCE(e.participants_json, i.participants_json) AS participants_json`;

export function getBenchmarkItems(reader: Database, runId: string): BenchmarkItemRow[] {
  return reader
    .query(`SELECT ${ITEM_EVIDENCE_COLUMNS} FROM benchmark_items i
      LEFT JOIN benchmark_item_evidence e ON e.run_id = i.run_id AND e.item_id = i.item_id
      WHERE i.run_id = ? ORDER BY i.id`)
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
      `SELECT ${ITEM_EVIDENCE_COLUMNS} FROM benchmark_items i JOIN benchmark_runs r ON r.id = i.run_id
       LEFT JOIN benchmark_item_evidence e ON e.run_id = i.run_id AND e.item_id = i.item_id
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
  /** Replicate group (migration 148) — null on runs that named none. */
  replicate_group?: string | null;
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
  /** Keyed hash of the normalised answer (migration 157); null = not reported. */
  answer_hash?: string | null;
  /** 1 = the answer was forced at a budget, 0 = not; null = not reported. */
  budget_forced?: 0 | 1 | null;
  /** Checks passed, ran and failed, or never ran; null = not reported. */
  verification?: BenchmarkVerification | null;
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

// ─── External submissions (migration 152) ──────────────────────────────────

export interface ExternalSubmissionInput {
  benchmark: string;
  /** The batch the submission answers (e.g. a dataset commit sha). */
  batch_ref: string;
  variant: string;
  identity_json: string;
  file_name: string;
  file_sha256: string;
  items: number;
  answered: number;
  cost_usd: number | null;
  meta_json: string | null;
  created_at: number;
}

export interface ExternalSubmissionRow extends ExternalSubmissionInput {
  id: number;
}

/** Append one submission; the same file (by hash) is recorded once. */
export function recordExternalSubmission(
  db: Database,
  row: ExternalSubmissionInput,
): { id: number; created: boolean } {
  const existing = db
    .query("SELECT id FROM external_submissions WHERE benchmark = ? AND file_sha256 = ?")
    .get(row.benchmark, row.file_sha256) as { id: number } | null;
  if (existing) return { id: existing.id, created: false };
  const r = db.run(
    `INSERT INTO external_submissions (benchmark, batch_ref, variant, identity_json, file_name,
       file_sha256, items, answered, cost_usd, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.benchmark,
      row.batch_ref,
      row.variant,
      row.identity_json,
      row.file_name,
      row.file_sha256,
      row.items,
      row.answered,
      row.cost_usd,
      row.meta_json,
      row.created_at,
    ],
  );
  return { id: Number(r.lastInsertRowid), created: true };
}

export function listExternalSubmissions(
  db: Database,
  benchmark: string,
  limit = 50,
): ExternalSubmissionRow[] {
  return db
    .query(
      "SELECT * FROM external_submissions WHERE benchmark = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(benchmark, limit) as ExternalSubmissionRow[];
}

/** Read a source snapshot. Caller owns the readonly connection/transaction. */
export function readBenchmarkSourceEvidence(
  reader: Database,
  runId: string,
): BenchmarkSourceEvidence {
  const run = getBenchmarkRun(reader, runId);
  if (!run || !["completed", "invalid"].includes(run.status))
    throw new Error("Source run must be completed or invalid");
  // Source archives may predate migration 159. Read them without upgrading.
  const hasOverlay = reader
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'benchmark_item_evidence'")
    .get();
  const items = hasOverlay
    ? getBenchmarkItems(reader, runId)
    : (reader
        .query("SELECT * FROM benchmark_items WHERE run_id = ? ORDER BY id")
        .all(runId) as BenchmarkItemRow[]);
  return normalizeSourceEvidence({
    schema: "marina.benchmark.source-evidence.v1",
    sourceRunId: run.id,
    benchmark: run.benchmark,
    items: items.map((it) => ({
      item_id: it.item_id,
      correct: it.correct,
      score: it.score,
      trace_id: it.trace_id,
      participants: sourceParticipants(JSON.parse(it.participants_json ?? "[]")),
    })),
  });
}

/** Exact item outcomes and request IDs bind source evidence to this run, not its label. */
export function previewBenchmarkSourceEvidence(
  benchmark: string,
  items: readonly Pick<
    BenchmarkItemRow,
    "item_id" | "correct" | "score" | "trace_id" | "participants_json"
  >[],
  evidence: BenchmarkSourceEvidence,
): { item_id: string; participants_json: string }[] {
  const source = normalizeSourceEvidence(evidence);
  if (benchmark !== source.benchmark || items.length !== source.items.length)
    throw new Error("Source benchmark/item count does not match target");
  const byId = new Map(source.items.map((it) => [it.item_id, it]));
  if (new Set(items.map((it) => it.item_id)).size !== items.length)
    throw new Error("Duplicate target item ID");
  const updates: { item_id: string; participants_json: string }[] = [];
  for (const it of items) {
    const src = byId.get(it.item_id);
    if (
      !src ||
      src.correct !== it.correct ||
      src.score !== it.score ||
      src.trace_id !== it.trace_id
    )
      throw new Error(`Source identity/outcome mismatch for item ${it.item_id}`);
    if (!src.participants.length) continue;
    const existing: unknown = JSON.parse(it.participants_json ?? "[]");
    if (!Array.isArray(existing))
      throw new Error(`Invalid target participants for item ${it.item_id}`);
    if (existing.length > 0) {
      if (canonicalJson(sourceParticipants(existing)) !== canonicalJson(src.participants))
        throw new Error(`Conflicting target participants for item ${it.item_id}`);
    } else
      updates.push({ item_id: it.item_id, participants_json: canonicalJson(src.participants) });
  }
  return updates;
}

export interface BenchmarkEvidenceRow {
  id: number;
  run_id: string;
  source_run_id: string;
  source_hash: string;
  changed_items: number;
  actor: string;
  created_at: number;
}

/** Fill missing evidence only; refuse mismatches atomically and preserve every score/hash. */
export function attachBenchmarkSourceEvidence(
  db: Database,
  runId: string,
  evidence: BenchmarkSourceEvidence,
): { changed: number; sourceHash: string } {
  const normalized = normalizeSourceEvidence(evidence);
  const sourceHash = sourceEvidenceHash(normalized);
  return db.transaction(() => {
    const run = getBenchmarkRun(db, runId);
    if (!run || !["completed", "invalid"].includes(run.status))
      throw new Error("Target run must be completed or invalid");
    const updates = previewBenchmarkSourceEvidence(
      run.benchmark,
      getBenchmarkItems(db, runId),
      normalized,
    );
    const previous = db
      .query("SELECT id FROM benchmark_run_evidence WHERE run_id = ? AND source_hash = ?")
      .get(runId, sourceHash);
    if (previous) {
      if (updates.length) throw new Error("Previously attached evidence is missing from target");
      return { changed: 0, sourceHash };
    }
    if (!updates.length) return { changed: 0, sourceHash };
    const audit = db.run(
      "INSERT INTO benchmark_run_evidence (run_id, source_run_id, source_hash, changed_items, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [runId, normalized.sourceRunId, sourceHash, updates.length, "operator", Date.now()],
    );
    const insert = db.prepare(
      "INSERT INTO benchmark_item_evidence (run_id, item_id, evidence_id, participants_json) VALUES (?, ?, ?, ?)",
    );
    for (const it of updates)
      insert.run(runId, it.item_id, audit.lastInsertRowid, it.participants_json);
    return { changed: updates.length, sourceHash };
  })();
}

export function listBenchmarkRunEvidence(reader: Database, runId: string): BenchmarkEvidenceRow[] {
  return reader
    .query("SELECT * FROM benchmark_run_evidence WHERE run_id = ? ORDER BY id")
    .all(runId) as BenchmarkEvidenceRow[];
}
