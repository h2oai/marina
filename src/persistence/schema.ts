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

export { SCHEMA_BASELINE, SCHEMA_BASELINE_VERSION } from "./schema-baseline";
/** Historical definitions stay immutable for upgrades and data-rewrite fixtures. */
export {
  BASE_SCHEMA,
  JUDGE_LEDGER_BACKFILL_179,
  type Migration as HistoricalMigration,
} from "./schema-history";

/** Append new versions after the baseline here. Do not rewrite the baseline or history. */
export interface Migration extends HistoricalMigration {
  apply?: (db: Database) => void;
}

/** Data conversions of migrations folded into the baseline, keyed by version.
 * They run with that version's SQL when an EXISTING database upgrades through
 * it, and once on an empty database when the baseline is generated (138 drops
 * the historical outbox; 143 finds no rows; 172 adds the known-at columns and
 * triggers). */
const MIGRATION_HOOKS: Readonly<Partial<Record<number, (db: Database) => void>>> = {
  138: upgradeNumericMemory,
  143: hashMemApiKeySecrets,
  172: installMemoryKnownAt,
};

export const FORWARD_MIGRATIONS: Migration[] = [
  // Durable lesson decisions and memory request receipts survive a process
  // crash between admission, primary/meta writes and delivery settlement.
  {
    version: 180,
    sql: `CREATE TABLE outcome_learning_steps (
  outcome_id INTEGER NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (outcome_id, step)
);`,
  },
  {
    version: 181,
    sql: `CREATE TABLE outcome_learning_state (
  outcome_id INTEGER PRIMARY KEY REFERENCES outcomes(id) ON DELETE CASCADE,
  erased_at INTEGER
);
CREATE TABLE outcome_learning_spaces (
  outcome_id INTEGER NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  PRIMARY KEY (outcome_id, space_id)
);
CREATE INDEX idx_outcome_learning_spaces_space ON outcome_learning_spaces(space_id);
-- Pre-journal-erasure workflows have no reliable space lineage. Stop replay
-- and discard their opaque payloads instead of risking erased-data revival.
INSERT INTO outcome_learning_state SELECT DISTINCT outcome_id, unixepoch()*1000 FROM outcome_learning_steps;
UPDATE outcome_deliveries SET state='skipped',reason='learning journal upgraded without erasure lineage'
 WHERE consumer='lessons' AND state='pending' AND outcome_id IN (SELECT outcome_id FROM outcome_learning_state);
DELETE FROM outcome_learning_steps;`,
  },
  {
    version: 182,
    sql: `CREATE TABLE investigation_spend_receipts (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES investigation_attempts(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  model TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','priced','unknown')),
  usd REAL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX idx_investigation_spend_attempt ON investigation_spend_receipts(attempt_id);`,
  },
  {
    version: 183,
    sql: `CREATE TABLE sandbox_bindings_183 (
  provider_id TEXT NOT NULL DEFAULT 'flywheel',
  entity_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  image TEXT NOT NULL,
  keep_alive INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  published_url TEXT,
  active_project_id TEXT,
  guest_cwd TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reconciled_at INTEGER,
  network_profile TEXT NOT NULL DEFAULT 'provider-default',
  network_profile_enforced INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER,
  lifecycle_expires_at INTEGER,
  hibernated_reason TEXT,
  PRIMARY KEY(provider_id, entity_id),
  UNIQUE(provider_id, session_id),
  UNIQUE(provider_id, sandbox_id)
);
INSERT INTO sandbox_bindings_183 SELECT 'flywheel', * FROM flywheel_bindings;
DROP TABLE flywheel_bindings;
ALTER TABLE sandbox_bindings_183 RENAME TO flywheel_bindings;
CREATE INDEX idx_flywheel_bindings_state ON flywheel_bindings(provider_id, state);`,
  },
  {
    version: 184,
    sql: `ALTER TABLE task_claims ADD COLUMN submission_clock INTEGER NOT NULL DEFAULT 0;
UPDATE task_claims SET submission_clock = coalesce(submitted_at, 0);`,
  },
  {
    version: 185,
    sql: `CREATE TABLE task_work_revisions (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  action TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, revision)
);
CREATE TABLE task_work_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  report TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (task_id, reviewer_id, fingerprint)
);
CREATE INDEX idx_task_work_checks_expiry ON task_work_checks(expires_at);`,
  },
  {
    // Indexes for queries that scanned a growing table or sorted through a temp
    // B-tree (plans checked on the baseline): name lookups, the agent lineage
    // walk (`name = ? COLLATE NOCASE` cannot use the BINARY primary-key index),
    // tasks by creator, the board archive sweep, the chronicle supersession
    // chain, and the ordered pages of board posts, sessions, submitted claims
    // and channel messages.
    version: 186,
    sql: `CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name);
CREATE INDEX IF NOT EXISTS idx_boards_name ON boards(name);
CREATE INDEX IF NOT EXISTS idx_groups_name ON groups_(name);
CREATE INDEX IF NOT EXISTS idx_agent_configs_name_nocase ON agent_configs(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_id, id);
CREATE INDEX IF NOT EXISTS idx_board_posts_archive ON board_posts(archived, created_at);
CREATE INDEX IF NOT EXISTS idx_board_posts_page ON board_posts(board_id, archived, pinned, id);
CREATE INDEX IF NOT EXISTS idx_chronicle_supersedes ON chronicle(supersedes);
CREATE INDEX IF NOT EXISTS idx_sessions_entity_created ON sessions(entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_claims_submitted ON task_claims(status, submitted_at, task_id);
CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created ON channel_messages(channel_id, created_at);`,
  },
  {
    // `numeric_notes` resolved every row through five index probes (projection →
    // record → version → content note, plus NOT EXISTS over versions): a count
    // over the view cost ~100 ms at 50k notes and drove the hourly note jobs.
    // The two derived facts now live on `notes` — `content_id` (the resolved
    // content note, NULL when the note is its own content) and `version_note`
    // (a canonical version row points at it) — kept current by triggers on the
    // three tables that can change them, so no writer changes; the view is one
    // optional probe. `notes_au` re-indexed FTS on EVERY notes update (each
    // recall touch); it now fires on content only.
    version: 187,
    sql: `ALTER TABLE notes ADD COLUMN content_id INTEGER;
ALTER TABLE notes ADD COLUMN version_note INTEGER NOT NULL DEFAULT 0;
UPDATE notes SET version_note=1 WHERE id IN (SELECT note_id FROM memory_record_versions);
UPDATE notes SET content_id=(
  SELECT CASE WHEN p.version IS NULL THEN r.current_note_id ELSE v.note_id END
  FROM memory_note_projections p
  LEFT JOIN memory_records r ON r.id=p.record_id
  LEFT JOIN memory_record_versions v ON v.record_id=p.record_id AND v.version=p.version
  WHERE p.note_id=notes.id)
WHERE id IN (SELECT note_id FROM memory_note_projections);
CREATE TRIGGER numeric_resolution_projection_ai AFTER INSERT ON memory_note_projections BEGIN
 UPDATE notes SET content_id=(
  SELECT CASE WHEN new.version IS NULL THEN r.current_note_id ELSE v.note_id END
  FROM memory_records r LEFT JOIN memory_record_versions v ON v.record_id=new.record_id AND v.version=new.version
  WHERE r.id=new.record_id) WHERE id=new.note_id;
END;
CREATE TRIGGER numeric_resolution_projection_au AFTER UPDATE ON memory_note_projections BEGIN
 UPDATE notes SET content_id=NULL WHERE id=old.note_id AND old.note_id!=new.note_id;
 UPDATE notes SET content_id=(
  SELECT CASE WHEN new.version IS NULL THEN r.current_note_id ELSE v.note_id END
  FROM memory_records r LEFT JOIN memory_record_versions v ON v.record_id=new.record_id AND v.version=new.version
  WHERE r.id=new.record_id) WHERE id=new.note_id;
END;
CREATE TRIGGER numeric_resolution_projection_ad AFTER DELETE ON memory_note_projections BEGIN
 UPDATE notes SET content_id=NULL WHERE id=old.note_id;
END;
CREATE TRIGGER numeric_resolution_record_current AFTER UPDATE OF current_note_id ON memory_records BEGIN
 UPDATE notes SET content_id=new.current_note_id
 WHERE id IN (SELECT note_id FROM memory_note_projections WHERE record_id=new.id AND version IS NULL);
END;
CREATE TRIGGER numeric_resolution_version_ai AFTER INSERT ON memory_record_versions BEGIN
 UPDATE notes SET version_note=1 WHERE id=new.note_id;
 UPDATE notes SET content_id=new.note_id
 WHERE id IN (SELECT note_id FROM memory_note_projections WHERE record_id=new.record_id AND version=new.version);
END;
CREATE TRIGGER numeric_resolution_version_ad AFTER DELETE ON memory_record_versions BEGIN
 UPDATE notes SET version_note=0 WHERE id=old.note_id;
 UPDATE notes SET content_id=NULL
 WHERE id IN (SELECT note_id FROM memory_note_projections WHERE record_id=old.record_id AND version=old.version);
END;
DROP TRIGGER notes_au;
CREATE TRIGGER notes_au AFTER UPDATE OF content ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
END;
DROP VIEW numeric_notes;
CREATE VIEW numeric_notes AS
 SELECT n.id,n.entity_name,n.room_id,coalesce(c.content,n.content) AS content,n.created_at,
 coalesce(c.importance,n.importance) AS importance,n.last_accessed,n.note_type,n.pool_id,n.supersedes_id,
 n.recall_count,n.tier,n.confidence,n.verification_status,n.claim_key,
 coalesce(c.id,n.id) AS content_id
 FROM notes n LEFT JOIN notes c ON c.id=n.content_id
 WHERE n.entity_name NOT LIKE 'memory:%' AND n.version_note=0;`,
  },
];

/** Migration 172 body — self-contained so later edits elsewhere never change it. */
function installMemoryKnownAt(db: Database): void {
  const addColumn = (table: string, column: string) => {
    const columns = db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
  };
  addColumn("memory_record_versions", "known_at");
  addColumn("memory_sources", "known_at");
  addColumn("memory_assistance_jobs", "completed_known_at");
  db.exec(`
CREATE TRIGGER IF NOT EXISTS memory_known_at_version AFTER INSERT ON memory_service_events
WHEN new.operation IN ('memory.created','memory.revised') AND new.reference_id IS NOT NULL BEGIN
  UPDATE memory_record_versions SET known_at = max(coalesce(known_at, 0), new.created_at)
   WHERE record_id = new.reference_id AND version = new.version;
END;
CREATE TRIGGER IF NOT EXISTS memory_known_at_source AFTER INSERT ON memory_service_events
WHEN new.operation = 'source.captured' AND new.reference_id IS NOT NULL BEGIN
  UPDATE memory_sources SET known_at = max(coalesce(known_at, 0), new.created_at)
   WHERE id = new.reference_id;
END;
CREATE TRIGGER IF NOT EXISTS memory_known_at_proposal AFTER INSERT ON memory_service_events
WHEN new.operation = 'assistance.completed' AND new.reference_id IS NOT NULL BEGIN
  UPDATE memory_assistance_jobs SET completed_known_at = max(coalesce(completed_known_at, 0), new.created_at)
   WHERE id = new.reference_id;
END;
`);
  // Everything at or below today's last event is the backfill's; later events
  // are dated by the triggers above. An empty log has nothing to backfill.
  db.run(
    `INSERT OR IGNORE INTO memory_known_at_backfill (id, cursor, upto)
     SELECT 1, 0, coalesce(max(seq), 0) FROM memory_service_events`,
  );
}

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
export const MIGRATIONS: Migration[] = [
  ...HISTORICAL_MIGRATIONS.map((migration) => {
    const apply = MIGRATION_HOOKS[migration.version];
    return apply ? { ...migration, apply } : migration;
  }),
  ...FORWARD_MIGRATIONS,
];
