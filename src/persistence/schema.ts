// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { upgradeNumericMemory } from "./db-memory-upgrade";
import { SCHEMA_BASELINE_VERSION } from "./schema-baseline";
import {
  MIGRATIONS as HISTORICAL_MIGRATIONS,
  type Migration as HistoricalMigration,
} from "./schema-history";
import { MEMORY_UNIFICATION_SCHEMA } from "./schema-memory-138";

export { SCHEMA_BASELINE, SCHEMA_BASELINE_VERSION } from "./schema-baseline";
/** Historical definitions stay immutable for upgrades and data-rewrite fixtures. */
export { BASE_SCHEMA, type Migration as HistoricalMigration } from "./schema-history";

/** Append new versions after the baseline here. Do not rewrite the baseline or history. */
export interface Migration extends HistoricalMigration {
  apply?: (db: Database) => void;
}
export const FORWARD_MIGRATIONS: Migration[] = [
  { version: 138, sql: MEMORY_UNIFICATION_SCHEMA, apply: upgradeNumericMemory },
  // Migration 139: answered challenges (src/engine/challenges.ts) — every
  // person's verdict on a held action, with the judge's shadow opinion, so
  // the judge's agreement per gate is measured and live labels feed the
  // decision case sets. Append-only; summaries are masked before insert.
  {
    version: 139,
    sql: `
CREATE TABLE challenge_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('gate', 'rank', 'tool')),
  class TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  creator_name TEXT,
  tool_name TEXT,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  answer TEXT NOT NULL CHECK (answer IN ('once', 'always', 'deny', 'expired')),
  answered_by TEXT,
  answered_role TEXT CHECK (answered_role IN ('creator', 'admin', 'judge')),
  judge_opinion TEXT CHECK (judge_opinion IN ('allow', 'hold', 'none')),
  judge_signals TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER NOT NULL
);
CREATE INDEX idx_challenge_outcomes_class ON challenge_outcomes(class, id);
`,
  },
  // Migration 140: two new safety gates replace hard-coded checks — the
  // `world` / `marina-descend` lineage commands moved from admin.destructive to
  // `world.lineage`, and `build` room/command code moved from an inline rank-5
  // check to `world.code`. Carry existing capability across so an upgrade
  // takes nothing away: every unsupervised admin.destructive holder keeps
  // lineage (row copied as-is, so a grant stays a grant), and every account
  // already at rank 5+ is granted world.code. Existing rows are never touched.
  {
    version: 140,
    sql: `
INSERT OR IGNORE INTO entity_competence (entity_id, gate, demonstrations, last_demo_at, supervised_only)
  SELECT entity_id, 'world.lineage', demonstrations, last_demo_at, supervised_only
  FROM entity_competence WHERE gate = 'admin.destructive' AND supervised_only = 0;
INSERT OR IGNORE INTO entity_competence (entity_id, gate, demonstrations, supervised_only)
  SELECT id, 'world.code', 999, 0 FROM users WHERE rank >= 5;
`,
  },
  // Migration 141: role-owned loop sections (operating loop / how to be / every turn) as a
  // JSON object; honored only under earned/open posture or local-ungated.
  { version: 141, sql: "ALTER TABLE roles ADD COLUMN loop TEXT NOT NULL DEFAULT '{}';" },
  // Migration 142: image/video generation joins the daily spend ledger
  // (src/engine/spend-ledger.ts, source 'media'). SQLite cannot widen a CHECK
  // in place, so the table is rebuilt with every existing row carried over.
  {
    version: 142,
    sql: `
CREATE TABLE spend_daily_v142 (
  day TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model_api', 'agent', 'decision', 'forecast', 'media')),
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, source)
);
INSERT INTO spend_daily_v142 (day, source, cost_usd, calls, updated_at)
  SELECT day, source, cost_usd, calls, updated_at FROM spend_daily;
DROP TABLE spend_daily;
ALTER TABLE spend_daily_v142 RENAME TO spend_daily;
`,
  },
  // Migration 143: memory API key secrets are stored as `sha256:<hex>` digests
  // (src/persistence/db-notes.ts hashMemApiKeySecret) and looked up by digest.
  // Every existing plaintext row is rewritten in place; already-hashed rows are
  // left alone so the rewrite is safe to replay against a partial copy.
  {
    version: 143,
    // The digest lookup keeps using the migration-28 index on `secret`.
    sql: "CREATE INDEX IF NOT EXISTS idx_mem_api_keys_secret ON mem_api_keys(secret);",
    apply: hashMemApiKeySecrets,
  },
  // Migration 144: `markets` gets a stable INTEGER PRIMARY KEY (`seq`) so
  // `markets_fts` (external content, content_rowid) survives VACUUM / VACUUM
  // INTO, which may renumber the implicit rowid of a TEXT-keyed table. `id`
  // stays the public key (UNIQUE, the FK target). Rebuilding a referenced
  // table with foreign_keys=ON would cascade-delete its children on DROP, so
  // the two child tables are rebuilt alongside it: the new children reference
  // `markets_v144` (renaming it to `markets` rewrites those references), and
  // the old children are dropped before the old parent.
  {
    version: 144,
    sql: `
DROP TRIGGER IF EXISTS markets_fts_ai;
DROP TRIGGER IF EXISTS markets_fts_ad;
DROP TRIGGER IF EXISTS markets_fts_au;
DROP TABLE IF EXISTS markets_fts;

CREATE TABLE markets_v144 (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL,
  question TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  outcome TEXT,
  resolved_at INTEGER,
  resolved_by TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO markets_v144 (id, room_id, question, category, status, outcome, resolved_at, resolved_by, created_at)
  SELECT id, room_id, question, category, status, outcome, resolved_at, resolved_by, created_at
  FROM markets ORDER BY created_at, rowid;

CREATE TABLE market_positions_v144 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES markets_v144(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO market_positions_v144 SELECT id, market_id, entity_name, direction, confidence, reasoning, created_at, updated_at FROM market_positions;

CREATE TABLE market_scores_v144 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES markets_v144(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  brier_score REAL NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  scored_at INTEGER NOT NULL
);
INSERT INTO market_scores_v144 SELECT id, market_id, entity_name, brier_score, correct, scored_at FROM market_scores;

DROP TABLE market_positions;
DROP TABLE market_scores;
DROP TABLE markets;
ALTER TABLE markets_v144 RENAME TO markets;
ALTER TABLE market_positions_v144 RENAME TO market_positions;
ALTER TABLE market_scores_v144 RENAME TO market_scores;

CREATE INDEX idx_markets_room ON markets(room_id);
CREATE INDEX idx_markets_status ON markets(status);
CREATE UNIQUE INDEX idx_positions_market_entity ON market_positions(market_id, entity_name);
CREATE INDEX idx_positions_entity ON market_positions(entity_name);
CREATE INDEX idx_scores_entity ON market_scores(entity_name);
CREATE INDEX idx_scores_market ON market_scores(market_id);

CREATE VIRTUAL TABLE markets_fts USING fts5(question, category, content=markets, content_rowid=seq);
CREATE TRIGGER markets_fts_ai AFTER INSERT ON markets BEGIN
  INSERT INTO markets_fts(rowid, question, category) VALUES (new.seq, new.question, new.category);
END;
CREATE TRIGGER markets_fts_ad AFTER DELETE ON markets BEGIN
  INSERT INTO markets_fts(markets_fts, rowid, question, category) VALUES ('delete', old.seq, old.question, old.category);
END;
CREATE TRIGGER markets_fts_au AFTER UPDATE ON markets BEGIN
  INSERT INTO markets_fts(markets_fts, rowid, question, category) VALUES ('delete', old.seq, old.question, old.category);
  INSERT INTO markets_fts(rowid, question, category) VALUES (new.seq, new.question, new.category);
END;
INSERT INTO markets_fts(markets_fts) VALUES ('rebuild');
`,
  },
  // Migration 145: every `forecast <question>` answer is kept (the full answer
  // object is the audit trail), optionally linked to the resolver Sample id it
  // resolves on; the `forecast-question` calibration finder scores it when
  // that Sample resolves (src/resolvers/calibration.ts).
  {
    version: 145,
    sql: `
CREATE TABLE forecast_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_name TEXT NOT NULL,
  question TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('probability', 'number')),
  probability REAL,
  mean REAL,
  sd REAL,
  answer_json TEXT NOT NULL,
  sample_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  outcome_json TEXT,
  score REAL
);
CREATE INDEX idx_forecast_answers_open_sample ON forecast_answers(sample_id) WHERE resolved_at IS NULL;
CREATE INDEX idx_forecast_answers_entity ON forecast_answers(entity_name, created_at);
`,
  },
  // Migration 146: the benchmark ledger — every run carries its cost, n,
  // Wilson interval, item slice, judge and target (a model, a crew + formation,
  // or a model population), and every item outcome is kept (ids only, never
  // case content) so runs compare paired on shared items and participants are
  // credited from their traces. `content_hash` makes imports idempotent.
  // Ledger rows are never rewritten; retention never prunes either table.
  {
    version: 146,
    sql: `
ALTER TABLE benchmark_runs ADD COLUMN cost_usd REAL;
ALTER TABLE benchmark_runs ADD COLUMN n INTEGER;
ALTER TABLE benchmark_runs ADD COLUMN ci_low REAL;
ALTER TABLE benchmark_runs ADD COLUMN ci_high REAL;
ALTER TABLE benchmark_runs ADD COLUMN seed INTEGER;
ALTER TABLE benchmark_runs ADD COLUMN slice_hash TEXT;
ALTER TABLE benchmark_runs ADD COLUMN judge TEXT;
ALTER TABLE benchmark_runs ADD COLUMN target_kind TEXT CHECK (target_kind IS NULL OR target_kind IN ('model', 'crew', 'population'));
ALTER TABLE benchmark_runs ADD COLUMN target_json TEXT;
ALTER TABLE benchmark_runs ADD COLUMN label TEXT;
ALTER TABLE benchmark_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'in-world' CHECK (source IN ('in-world', 'import'));
ALTER TABLE benchmark_runs ADD COLUMN content_hash TEXT;
CREATE UNIQUE INDEX idx_benchmark_runs_content_hash ON benchmark_runs(content_hash) WHERE content_hash IS NOT NULL;
CREATE TABLE benchmark_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  score REAL,
  latency_ms REAL,
  cost_usd REAL,
  trace_id TEXT,
  participants_json TEXT,
  judge_verdict TEXT,
  UNIQUE (run_id, item_id)
);
CREATE INDEX idx_benchmark_items_item ON benchmark_items(item_id);
CREATE TRIGGER benchmark_items_no_update BEFORE UPDATE ON benchmark_items
BEGIN SELECT RAISE(ABORT, 'benchmark_items is append-only'); END;
`,
  },
  // Earned promotion of defaults (src/engine/benchmark-promotion.ts): one row
  // per named slot holds the current incumbent; every seed, promotion and
  // refused attempt is an append-only history row with its evidence. The
  // holdout fraction is fixed per slot once set — moving it would move items
  // between the selection and holdout splits.
  {
    version: 147,
    sql: `
CREATE TABLE benchmark_defaults (
  slot TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  incumbent_run_id TEXT,
  holdout_fraction REAL NOT NULL DEFAULT 0.5 CHECK (holdout_fraction > 0 AND holdout_fraction < 1),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE TABLE benchmark_promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('seeded', 'promoted', 'refused')),
  challenger_run_id TEXT,
  incumbent_run_id TEXT,
  value_json TEXT,
  actor TEXT,
  stats_json TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_benchmark_promotions_slot ON benchmark_promotions(slot, id);
CREATE TRIGGER benchmark_promotions_no_update BEFORE UPDATE ON benchmark_promotions
BEGIN SELECT RAISE(ABORT, 'benchmark_promotions is append-only'); END;
`,
  },
  // Replicate groups (src/engine/benchmark-replicates.ts): repeated runs of one
  // configuration — same target, item slice and judge — pool into one group so
  // comparisons and promotions rest on more than a single noisy draw. Runs that
  // name no group are grouped by that (target, slice, judge) identity when read.
  {
    version: 148,
    sql: `
ALTER TABLE benchmark_runs ADD COLUMN replicate_group TEXT;
CREATE INDEX idx_benchmark_runs_replicate_group ON benchmark_runs(replicate_group) WHERE replicate_group IS NOT NULL;
`,
  },
  // Migration 149: RESERVED table for an agent-loop execution checkpoint (one
  // row per agent: the single in-flight tool call and its `replay` policy).
  // Nothing reads or writes it: the accessor module and resume decision that
  // shipped with it had no production caller and were removed (2026-10-04).
  // The table stays (migrations are immutable); a future crash-resume path
  // must add its own writer, reader and store interface before relying on it.
  {
    version: 149,
    sql: `
CREATE TABLE run_state (
  agent_name TEXT PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase IN ('tool_call', 'model_request')),
  tool_call_id TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL DEFAULT '',
  args_json TEXT NOT NULL DEFAULT '{}',
  replay TEXT NOT NULL CHECK (replay IN ('safe', 'never')),
  partial_output_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
`,
  },
  // Migration 150: RESERVED table for an exactly-once submission ledger
  // (`pending` → `resolved` per request id). Nothing reads or writes it: the
  // accessor module that shipped with it had no production caller and was
  // removed (2026-10-04). The table stays (migrations are immutable); a
  // future user must add a writer, a reader and a retention policy.
  {
    version: 150,
    sql: `
CREATE TABLE submission_requests (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX idx_submission_requests_pending ON submission_requests(status, created_at)
  WHERE status = 'pending';
`,
  },
  // Typed forecast answers (src/forecast/typed.ts): a saved forecast may be a
  // choice, a set of options, a ranking or a short string, not only a
  // probability or a number. SQLite cannot widen a CHECK in place, so the
  // table is rebuilt with the wider kind list and a `prediction` column (the
  // typed answer as one string); every existing row is copied unchanged.
  {
    version: 151,
    sql: `
CREATE TABLE forecast_answers_v151 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_name TEXT NOT NULL,
  question TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('probability', 'number', 'choice', 'multi', 'ranking', 'text')),
  probability REAL,
  mean REAL,
  sd REAL,
  prediction TEXT,
  answer_json TEXT NOT NULL,
  sample_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  outcome_json TEXT,
  score REAL
);
INSERT INTO forecast_answers_v151
  (id, entity_name, question, kind, probability, mean, sd, answer_json, sample_id, created_at, resolved_at, outcome_json, score)
  SELECT id, entity_name, question, kind, probability, mean, sd, answer_json, sample_id, created_at, resolved_at, outcome_json, score
  FROM forecast_answers;
DROP TABLE forecast_answers;
ALTER TABLE forecast_answers_v151 RENAME TO forecast_answers;
CREATE INDEX idx_forecast_answers_open_sample ON forecast_answers(sample_id) WHERE resolved_at IS NULL;
CREATE INDEX idx_forecast_answers_entity ON forecast_answers(entity_name, created_at);
`,
  },
  // Submissions to outside evaluations (a weekly forecasting competition, …):
  // what was filed, for which batch, under which identity, with the file's
  // hash. A submission has no outcome yet, so it is not a ledger run; once the
  // batch resolves, its scored run joins the benchmark ledger. Append-only.
  {
    version: 152,
    sql: `
CREATE TABLE external_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  benchmark TEXT NOT NULL,
  batch_ref TEXT NOT NULL,
  variant TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  items INTEGER NOT NULL,
  answered INTEGER NOT NULL,
  cost_usd REAL,
  meta_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (benchmark, file_sha256)
);
CREATE INDEX idx_external_submissions_batch ON external_submissions(benchmark, batch_ref);
CREATE TRIGGER external_submissions_no_update BEFORE UPDATE ON external_submissions
BEGIN SELECT RAISE(ABORT, 'external_submissions is append-only'); END;
`,
  },
  // Benchmark run validity (src/engine/commands/benchmark.ts `invalidate` /
  // `revalidate`, the import script's operator path, and the automatic
  // fallback-rate check): a run that measured the infrastructure rather than
  // the target is retired by status `invalid` — every ledger reader ranks only
  // `completed` runs — and every change is an append-only audit row. Item
  // rows are never deleted.
  {
    version: 153,
    sql: `
CREATE TABLE benchmark_run_validity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('invalidate', 'revalidate')),
  reason TEXT NOT NULL,
  actor TEXT,
  source TEXT NOT NULL CHECK (source IN ('in-world', 'operator', 'auto')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_benchmark_run_validity_run ON benchmark_run_validity(run_id, id);
CREATE TRIGGER benchmark_run_validity_no_update BEFORE UPDATE ON benchmark_run_validity
BEGIN SELECT RAISE(ABORT, 'benchmark_run_validity is append-only'); END;
`,
  },
  // Keep the local forecast evidence beside the exact signed wire body.
  // Old submissions retain an empty trace; retries preserve the original one.
  {
    version: 154,
    sql: "ALTER TABLE arena_submissions ADD COLUMN detail TEXT NOT NULL DEFAULT '{}';",
  },
  // Replicate regrouping (benchmark:import --regroup / --replicate-of): moving a
  // run between replicate groups changes what pools and promotes, so every move
  // is an append-only audit row with the old and new group, who and why.
  {
    version: 155,
    sql: `
CREATE TABLE benchmark_run_regroups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  from_group TEXT,
  to_group TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT,
  source TEXT NOT NULL CHECK (source IN ('in-world', 'operator')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_benchmark_run_regroups_run ON benchmark_run_regroups(run_id, id);
CREATE TRIGGER benchmark_run_regroups_no_update BEFORE UPDATE ON benchmark_run_regroups
BEGIN SELECT RAISE(ABORT, 'benchmark_run_regroups is append-only'); END;
`,
  },
  // Budget scopes (src/engine/spend-ledger.ts): a process with
  // MARINA_SPEND_SCOPE=<name> records its dollars here as well as in
  // spend_daily (same transaction), capped by MARINA_SPEND_SCOPE_CAP_USD.
  {
    version: 156,
    sql: `
CREATE TABLE spend_scope_daily (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model_api', 'agent', 'decision', 'forecast', 'media')),
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, scope, source)
);
`,
  },
  // Per-item answer identity and outcome labels for the benchmark ledger:
  // `answer_hash` is a keyed hash of the normalised answer (never the answer —
  // the key is per ledger, so a short answer cannot be recovered by hashing
  // guesses), so plurality and offline selectors can be measured across runs;
  // `budget_forced` marks an answer the harness forced at a turn, step or time
  // budget; `verification` separates checks that never ran from checks that
  // ran and failed. NULL = not reported (every row recorded before this).
  {
    version: 157,
    sql: `
ALTER TABLE benchmark_items ADD COLUMN answer_hash TEXT;
ALTER TABLE benchmark_items ADD COLUMN budget_forced INTEGER CHECK (budget_forced IS NULL OR budget_forced IN (0, 1));
ALTER TABLE benchmark_items ADD COLUMN verification TEXT CHECK (verification IS NULL OR verification IN ('passed', 'failed', 'not_run'));
CREATE INDEX idx_benchmark_items_answer ON benchmark_items(item_id, answer_hash) WHERE answer_hash IS NOT NULL;
`,
  },
  // Migration 158: paid search API calls (Tavily, Exa, OpenRouter's search
  // plugin — the `web search` command and research retrieval) join the daily
  // spend ledger and the budget scopes as source 'search'. Both tables are
  // rebuilt like migration 142, every existing row carried over.
  {
    version: 158,
    sql: `
CREATE TABLE spend_daily_v158 (
  day TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model_api', 'agent', 'decision', 'forecast', 'media', 'search')),
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, source)
);
INSERT INTO spend_daily_v158 (day, source, cost_usd, calls, updated_at)
  SELECT day, source, cost_usd, calls, updated_at FROM spend_daily;
DROP TABLE spend_daily;
ALTER TABLE spend_daily_v158 RENAME TO spend_daily;
CREATE TABLE spend_scope_daily_v158 (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model_api', 'agent', 'decision', 'forecast', 'media', 'search')),
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, scope, source)
);
INSERT INTO spend_scope_daily_v158 (day, scope, source, cost_usd, calls, updated_at)
  SELECT day, scope, source, cost_usd, calls, updated_at FROM spend_scope_daily;
DROP TABLE spend_scope_daily;
ALTER TABLE spend_scope_daily_v158 RENAME TO spend_scope_daily;
`,
  },
  // Source execution attribution recovered from an operator-owned run DB.
  // Scores, replicate identity and content hashes are never rewritten.
  {
    version: 159,
    sql: `
CREATE TABLE benchmark_run_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES benchmark_runs(id),
  source_run_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  changed_items INTEGER NOT NULL CHECK (changed_items >= 0),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, source_hash)
);
CREATE TRIGGER benchmark_run_evidence_no_update BEFORE UPDATE ON benchmark_run_evidence
BEGIN SELECT RAISE(ABORT, 'benchmark_run_evidence is append-only'); END;
CREATE TABLE benchmark_item_evidence (
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  evidence_id INTEGER NOT NULL REFERENCES benchmark_run_evidence(id),
  participants_json TEXT NOT NULL,
  PRIMARY KEY(run_id, item_id),
  FOREIGN KEY(run_id, item_id) REFERENCES benchmark_items(run_id, item_id)
);
CREATE TRIGGER benchmark_item_evidence_no_update BEFORE UPDATE ON benchmark_item_evidence
BEGIN SELECT RAISE(ABORT, 'benchmark_item_evidence is append-only'); END;
`,
  },
];

/** Migration 143 body — self-contained so later edits to db-notes never change it. */
function hashMemApiKeySecrets(db: Database): void {
  const rows = db.query("SELECT id, secret FROM mem_api_keys").all() as {
    id: string;
    secret: string;
  }[];
  const update = db.prepare("UPDATE mem_api_keys SET secret = ? WHERE id = ?");
  for (const row of rows) {
    if (row.secret.startsWith("sha256:")) continue;
    const digest = createHash("sha256").update(row.secret, "utf8").digest("hex");
    update.run(`sha256:${digest}`, row.id);
  }
}
export const SCHEMA_VERSION = FORWARD_MIGRATIONS.at(-1)?.version ?? SCHEMA_BASELINE_VERSION;

/** Full upgrade history; fresh databases use SCHEMA_BASELINE in one transaction. */
export const MIGRATIONS: Migration[] = [...HISTORICAL_MIGRATIONS, ...FORWARD_MIGRATIONS];
