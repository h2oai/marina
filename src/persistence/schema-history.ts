// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina's durable schema: the base DDL and the append-only migration chain.
 *
 * Extracted from database.ts (where it was ~30% of an 8.5k-line file) as pure
 * data — no behavior lives here. RULES (unchanged): append new migrations to
 * the END of the array with the next version number; NEVER modify an existing
 * migration entry; migrations run in order inside one transaction each.
 *
 * Entries up to SCHEMA_BASELINE_VERSION live here; later ones are
 * FORWARD_MIGRATIONS in schema.ts. A migration's data conversion (`apply`)
 * stays in schema.ts (MIGRATION_HOOKS) so this file keeps no behavior.
 */

import { MEMORY_UNIFICATION_SCHEMA } from "./schema-memory-138";

export const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  short TEXT NOT NULL,
  long TEXT NOT NULL,
  room TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  inventory TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_store (
  room_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (room_id, key)
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(type);
CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_entities_room ON entities(room);
CREATE INDEX IF NOT EXISTS idx_sessions_entity ON sessions(entity_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
`;

/**
 * Migration 179's copy of the judge rows kept before the ledger existed.
 * Idempotent (INSERT OR IGNORE on the ledger's unique key; the UPDATEs touch
 * only unsettled rows) and read-only on its sources. `backfillJudgeLedger`
 * re-runs it. Self-contained so later edits elsewhere never change it.
 *
 *  - challenge_outcomes: people-answered holds the judge scored (allow = pass,
 *    hold = fail); approved = pass, denied = fail. Expired and judge-answered
 *    holds have no ground truth and are skipped. The judge's model was never
 *    recorded, so these rows belong to judge `unknown`.
 *  - judge_observations: the latest opinion per (task, claimant, evaluator),
 *    settled by the claim's status (approved / rejected).
 *  - judged outcomes: `attention-judge:<kind>` sources are `attention:<kind>`,
 *    every other judged outcome is `outcome`; settled by the mechanical
 *    outcome of the same subject (a task attempt: its first verdict after the
 *    opinion), a forecast by its truth.
 */
export const JUDGE_LEDGER_BACKFILL_179 = `
INSERT OR IGNORE INTO judge_ledger
  (surface, question, judge, subject, truth_key, opinion, truth, agreed, opined_at, truth_at, origin)
SELECT 'challenge', class, 'unknown', 'challenge:' || token, NULL,
  CASE judge_opinion WHEN 'allow' THEN 'pass' WHEN 'hold' THEN 'fail' ELSE 'none' END,
  CASE WHEN answer IN ('once', 'always') THEN 'pass' ELSE 'fail' END,
  CASE WHEN judge_opinion = 'none' THEN NULL
       WHEN (judge_opinion = 'allow') = (answer IN ('once', 'always')) THEN 1 ELSE 0 END,
  created_at, answered_at, 'backfill:challenge_outcomes'
FROM challenge_outcomes
WHERE judge_opinion IN ('allow', 'hold', 'none') AND answer <> 'expired'
  AND coalesce(answered_role, '') <> 'judge'
ORDER BY id DESC;

INSERT OR IGNORE INTO judge_ledger
  (surface, judge, subject, truth_key, opinion, calibrated, opined_at, origin)
SELECT 'verify', evaluator, 'task:' || task_id || ':' || claimant_name,
  'task:' || task_id || ':' || claimant_name || ':', opinion, calibrated, created_at,
  'backfill:judge_observations'
FROM judge_observations ORDER BY id DESC;

UPDATE judge_ledger SET
  truth = (SELECT CASE c.status WHEN 'approved' THEN 'pass' ELSE 'fail' END FROM task_claims c
            WHERE 'task:' || c.task_id || ':' || c.entity_name = judge_ledger.subject
              AND c.status IN ('approved', 'rejected') LIMIT 1),
  truth_at = opined_at
WHERE surface = 'verify' AND truth IS NULL AND origin = 'backfill:judge_observations';
UPDATE judge_ledger SET agreed = CASE WHEN opinion = 'none' THEN NULL ELSE opinion = truth END
WHERE surface = 'verify' AND truth IS NOT NULL AND agreed IS NULL
  AND origin = 'backfill:judge_observations';

INSERT OR IGNORE INTO judge_ledger
  (surface, question, judge, subject, truth_key, opinion, opinion_value, opined_at, origin)
SELECT
  CASE WHEN source LIKE 'attention-judge:%' THEN 'attention:' || substr(source, 17) ELSE 'outcome' END,
  kind, coalesce(judge, 'unknown'), subject,
  CASE WHEN subject LIKE 'judged:task:%' THEN rtrim(substr(subject, 8), '0123456789')
       ELSE substr(subject, 8) END,
  CASE WHEN succeeded = 1 THEN 'pass' ELSE 'fail' END,
  CASE WHEN kind = 'forecast' THEN coalesce(truth_json, '') END,
  resolved_at, 'backfill:outcomes'
FROM outcomes WHERE basis = 'judged' AND subject LIKE 'judged:%';

UPDATE judge_ledger SET (truth, agreed, truth_at) = (
  SELECT CASE WHEN m.succeeded = 1 THEN 'pass' ELSE 'fail' END,
    CASE WHEN judge_ledger.opinion_value IS NOT NULL
         THEN judge_ledger.opinion_value = coalesce(m.truth_json, '')
         ELSE judge_ledger.opinion = CASE WHEN m.succeeded = 1 THEN 'pass' ELSE 'fail' END END,
    m.resolved_at
  FROM outcomes m
  WHERE m.basis = 'mechanical' AND (
    (substr(judge_ledger.truth_key, -1) <> ':' AND m.subject = judge_ledger.truth_key) OR
    (substr(judge_ledger.truth_key, -1) = ':'
      AND m.subject BETWEEN judge_ledger.truth_key AND judge_ledger.truth_key || '~'
      AND m.resolved_at >= judge_ledger.opined_at))
  ORDER BY m.resolved_at LIMIT 1)
WHERE origin = 'backfill:outcomes' AND truth IS NULL AND EXISTS (
  SELECT 1 FROM outcomes m
  WHERE m.basis = 'mechanical' AND (
    (substr(judge_ledger.truth_key, -1) <> ':' AND m.subject = judge_ledger.truth_key) OR
    (substr(judge_ledger.truth_key, -1) = ':'
      AND m.subject BETWEEN judge_ledger.truth_key AND judge_ledger.truth_key || '~'
      AND m.resolved_at >= judge_ledger.opined_at)));
`;

// ─── Migrations ──────────────────────────────────────────────────────────────

export interface Migration {
  version: number;
  sql: string;
}

/** Exported for migration tests (replaying data-rewrite migrations against
 * seeded legacy rows). Never mutate at runtime. */
export const MIGRATIONS: Migration[] = [
  // Migration 1: Channels
  {
    version: 1,
    sql: `
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_id TEXT,
  persistence TEXT NOT NULL DEFAULT 'permanent',
  retention_hours INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE channel_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  can_read INTEGER NOT NULL DEFAULT 1,
  can_write INTEGER NOT NULL DEFAULT 1,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, entity_id)
);

CREATE INDEX idx_channel_messages_channel ON channel_messages(channel_id);
CREATE INDEX idx_channel_messages_created ON channel_messages(created_at);
CREATE INDEX idx_channel_members_entity ON channel_members(entity_id);
`,
  },
  // Migration 2: Boards
  {
    version: 2,
    sql: `
CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  read_rank INTEGER NOT NULL DEFAULT 0,
  write_rank INTEGER NOT NULL DEFAULT 0,
  pin_rank INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL
);

CREATE TABLE board_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  parent_id INTEGER,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE board_votes (
  post_id INTEGER NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  value INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, entity_id)
);

CREATE INDEX idx_board_posts_board ON board_posts(board_id);
CREATE INDEX idx_board_posts_author ON board_posts(author_id);
CREATE INDEX idx_board_votes_post ON board_votes(post_id);
`,
  },
  // Migration 3: Groups
  {
    version: 3,
    sql: `
CREATE TABLE groups_ (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  leader_id TEXT NOT NULL,
  channel_id TEXT,
  board_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, entity_id)
);

CREATE INDEX idx_group_members_entity ON group_members(entity_id);
`,
  },
  // Migration 4: Tasks
  {
    version: 4,
    sql: `
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT,
  group_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prerequisites TEXT NOT NULL DEFAULT '[]',
  deliverables TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  validation_mode TEXT NOT NULL DEFAULT 'creator',
  creator_id TEXT NOT NULL,
  creator_name TEXT NOT NULL,
  standing INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE task_claims (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  submission_text TEXT,
  claimed_at INTEGER NOT NULL,
  submitted_at INTEGER,
  resolved_at INTEGER,
  PRIMARY KEY (task_id, entity_id)
);

CREATE TABLE task_votes (
  task_id INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  claimant_id TEXT NOT NULL,
  approve INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, entity_id, claimant_id)
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_group ON tasks(group_id);
CREATE INDEX idx_task_claims_entity ON task_claims(entity_id);
`,
  },
  // Migration 5: Macros
  {
    version: 5,
    sql: `
CREATE TABLE macros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  commands TEXT NOT NULL DEFAULT '[]',
  variables TEXT NOT NULL DEFAULT '[]',
  trigger_type TEXT,
  trigger_config TEXT NOT NULL DEFAULT '{}',
  shared INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(name, author_id)
);

CREATE INDEX idx_macros_author ON macros(author_id);
CREATE INDEX idx_macros_shared ON macros(shared);
CREATE INDEX idx_macros_trigger ON macros(trigger_type);
`,
  },
  // Migration 6: Room Sources + Templates (building system)
  {
    version: 6,
    sql: `
CREATE TABLE room_sources (
  room_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  valid INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, version)
);

CREATE TABLE room_templates (
  name TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_room_sources_room ON room_sources(room_id);
`,
  },
  // Migration 7: Users (persistent identity across sessions)
  {
    version: 7,
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_login INTEGER NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  properties TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_users_name ON users(name);
`,
  },
  // Migration 8: Bans
  {
    version: 8,
    sql: `
CREATE TABLE bans (
  name TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  banned_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
  // Migration 9: Adapter Links (Telegram, Discord, etc.)
  {
    version: 9,
    sql: `
CREATE TABLE adapter_links (
  adapter TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (adapter, external_id)
);

CREATE INDEX idx_adapter_links_user ON adapter_links(user_id);
`,
  },
  // Migration 10: FTS5 full-text search for board posts
  {
    version: 10,
    sql: `
CREATE VIRTUAL TABLE board_posts_fts USING fts5(title, body, tags, content=board_posts, content_rowid=id);

-- Populate FTS from existing data
INSERT INTO board_posts_fts(rowid, title, body, tags) SELECT id, title, body, tags FROM board_posts;

-- Triggers to keep FTS in sync
CREATE TRIGGER board_posts_ai AFTER INSERT ON board_posts BEGIN
  INSERT INTO board_posts_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;

CREATE TRIGGER board_posts_ad AFTER DELETE ON board_posts BEGIN
  INSERT INTO board_posts_fts(board_posts_fts, rowid, title, body, tags) VALUES('delete', old.id, old.title, old.body, old.tags);
END;

CREATE TRIGGER board_posts_au AFTER UPDATE ON board_posts BEGIN
  INSERT INTO board_posts_fts(board_posts_fts, rowid, title, body, tags) VALUES('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO board_posts_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
`,
  },
  // Migration 11: Notes + FTS
  {
    version: 11,
    sql: `
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_name TEXT NOT NULL,
  room_id TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_notes_entity ON notes(entity_name);
CREATE INDEX idx_notes_room ON notes(room_id);

CREATE VIRTUAL TABLE notes_fts USING fts5(content, content=notes, content_rowid=id);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
END;
`,
  },
  // Migration 12: Experiments
  {
    version: 12,
    sql: `
CREATE TABLE experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  creator_name TEXT NOT NULL,
  required_agents INTEGER NOT NULL DEFAULT 2,
  time_limit INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE experiment_participants (
  experiment_id INTEGER NOT NULL,
  entity_name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (experiment_id, entity_name)
);

CREATE TABLE experiment_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER NOT NULL,
  entity_name TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX idx_exp_status ON experiments(status);
CREATE INDEX idx_expr_experiment ON experiment_results(experiment_id);
`,
  },
  // Migration 13: Task Bundles + Numeric Scoring
  {
    version: 13,
    sql: `
ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id);
ALTER TABLE board_votes ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
`,
  },
  // Migration 14: Agent Memory Primitives
  {
    version: 14,
    sql: `
-- Core memory (mutable key-value per entity, MemGPT-style)
CREATE TABLE core_memory (
  entity_name TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_name, key)
);
CREATE TABLE core_memory_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_name TEXT NOT NULL,
  key TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);

-- Extend notes with importance, access tracking, type, pool, and supersession
ALTER TABLE notes ADD COLUMN importance INTEGER NOT NULL DEFAULT 5;
ALTER TABLE notes ADD COLUMN last_accessed INTEGER;
ALTER TABLE notes ADD COLUMN note_type TEXT NOT NULL DEFAULT 'observation';
ALTER TABLE notes ADD COLUMN pool_id TEXT;
ALTER TABLE notes ADD COLUMN supersedes_id INTEGER REFERENCES notes(id);

CREATE INDEX idx_notes_pool ON notes(pool_id);
CREATE INDEX idx_notes_type ON notes(note_type);
CREATE INDEX idx_notes_importance ON notes(importance);

-- Note relationships (knowledge graph edges)
CREATE TABLE note_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES notes(id),
  target_id INTEGER NOT NULL REFERENCES notes(id),
  relationship TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, relationship)
);
CREATE INDEX idx_note_links_source ON note_links(source_id);
CREATE INDEX idx_note_links_target ON note_links(target_id);

-- Memory pools (shared note spaces for groups)
CREATE TABLE memory_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  group_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
  // Migration 15: Projects
  {
    version: 15,
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  bundle_id INTEGER REFERENCES tasks(id),
  pool_id TEXT REFERENCES memory_pools(id),
  group_id TEXT,
  orchestration TEXT NOT NULL DEFAULT 'custom',
  memory_arch TEXT NOT NULL DEFAULT 'custom',
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_projects_name ON projects(name);
CREATE INDEX idx_projects_status ON projects(status);
`,
  },
  // Migration 16: Dynamic Commands
  {
    version: 16,
    sql: `
CREATE TABLE dynamic_commands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  valid INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE dynamic_command_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL REFERENCES dynamic_commands(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  version INTEGER NOT NULL,
  edited_by TEXT NOT NULL,
  edited_at INTEGER NOT NULL
);

CREATE INDEX idx_dynamic_commands_name ON dynamic_commands(name);
CREATE INDEX idx_dynamic_command_history_cmd ON dynamic_command_history(command_id);
`,
  },
  // Migration 17: Connectors (outbound MCP servers)
  {
    version: 17,
    sql: `
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL DEFAULT 'http',
  url TEXT,
  command TEXT,
  args TEXT,
  auth_type TEXT,
  auth_data TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'ephemeral',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX idx_connectors_name ON connectors(name);
CREATE INDEX idx_connectors_status ON connectors(status);
`,
  },
  // Migration 18: Simplify macros (name → single command string)
  {
    version: 18,
    sql: `
CREATE TABLE macros_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  author_id TEXT NOT NULL,
  command TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(name, author_id)
);

INSERT INTO macros_new (id, name, author_id, command, created_at, updated_at)
  SELECT id, name, author_id, commands, created_at, updated_at FROM macros;

DROP TABLE macros;
ALTER TABLE macros_new RENAME TO macros;
CREATE INDEX idx_macros_author ON macros(author_id);
`,
  },
  // Migration 19: A-Mem enhancements (recall_count, entity_activity)
  {
    version: 19,
    sql: `
ALTER TABLE notes ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE entity_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_name TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  activity_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(entity_name, activity_type, activity_key)
);

CREATE INDEX idx_entity_activity_entity ON entity_activity(entity_name);
CREATE INDEX idx_entity_activity_type ON entity_activity(entity_name, activity_type);
`,
  },
  // Migration 20: Assets
  {
    version: 20,
    sql: `
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  entity_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_assets_entity ON assets(entity_name);
CREATE INDEX idx_assets_mime ON assets(mime_type);
CREATE INDEX idx_assets_created ON assets(created_at);
`,
  },
  // Migration 21: Canvases + Canvas Nodes
  {
    version: 21,
    sql: `
CREATE TABLE canvases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT,
  creator_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_canvases_scope ON canvases(scope, scope_id);

CREATE TABLE canvas_nodes (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  width REAL NOT NULL DEFAULT 300,
  height REAL NOT NULL DEFAULT 200,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  data TEXT NOT NULL DEFAULT '{}',
  creator_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_canvas_nodes_canvas ON canvas_nodes(canvas_id);
CREATE INDEX idx_canvas_nodes_type ON canvas_nodes(type);
`,
  },
  // Migration 22: Meta key-value store (world tracking, etc.)
  {
    version: 22,
    sql: `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  // Migration 23: Shell (allowlist + execution log)
  {
    version: 23,
    sql: `
CREATE TABLE shell_allowlist (
  binary TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

CREATE TABLE shell_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  binary TEXT NOT NULL,
  args TEXT NOT NULL,
  exit_code INTEGER,
  output_length INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_shell_log_entity ON shell_log(entity_id);
CREATE INDEX idx_shell_log_created ON shell_log(created_at);

INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('curl', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('wget', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('ls', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('cat', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('head', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('tail', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('wc', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('grep', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('find', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('jq', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('echo', 'system', strftime('%s','now') * 1000);
INSERT INTO shell_allowlist (binary, added_by, added_at) VALUES ('date', 'system', strftime('%s','now') * 1000);
`,
  },
  // Migration 24: Task FTS + entity standing ledger
  {
    version: 24,
    sql: `
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title, description, content=tasks, content_rowid=id
);

INSERT INTO tasks_fts(rowid, title, description)
  SELECT id, title, description FROM tasks;

CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;

CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES('delete', old.id, old.title, old.description);
END;

CREATE TRIGGER tasks_fts_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description) VALUES('delete', old.id, old.title, old.description);
  INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;

CREATE TABLE entity_standing (
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  amount INTEGER NOT NULL,
  earned_at INTEGER NOT NULL,
  PRIMARY KEY (entity_id, task_id)
);
`,
  },
  // Migration 25: Gateways (peer Marina bridging)
  {
    version: 25,
    sql: `
CREATE TABLE gateways (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE gateway_bridges (
  gateway_id TEXT NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  PRIMARY KEY (gateway_id, channel)
);

CREATE INDEX idx_gateways_name ON gateways(name);
`,
  },
  // Migration 26: Add parent_node_id to canvas_nodes for threading (feed/comments)
  {
    version: 26,
    sql: `
ALTER TABLE canvas_nodes ADD COLUMN parent_node_id TEXT REFERENCES canvas_nodes(id) ON DELETE SET NULL;
CREATE INDEX idx_canvas_nodes_parent ON canvas_nodes(parent_node_id);
`,
  },
  // Migration 27: Prediction markets (markets, positions, scores)
  {
    version: 27,
    sql: `
CREATE TABLE markets (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  question TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  outcome TEXT,
  resolved_at INTEGER,
  resolved_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_markets_room ON markets(room_id);
CREATE INDEX idx_markets_status ON markets(status);

CREATE TABLE market_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_positions_market_entity ON market_positions(market_id, entity_name);
CREATE INDEX idx_positions_entity ON market_positions(entity_name);

CREATE TABLE market_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  brier_score REAL NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  scored_at INTEGER NOT NULL
);
CREATE INDEX idx_scores_entity ON market_scores(entity_name);
CREATE INDEX idx_scores_market ON market_scores(market_id);

CREATE VIRTUAL TABLE markets_fts USING fts5(question, category, content=markets, content_rowid=rowid);
CREATE TRIGGER markets_fts_ai AFTER INSERT ON markets BEGIN
  INSERT INTO markets_fts(rowid, question, category) VALUES (new.rowid, new.question, new.category);
END;
CREATE TRIGGER markets_fts_ad AFTER DELETE ON markets BEGIN
  INSERT INTO markets_fts(markets_fts, rowid, question, category) VALUES ('delete', old.rowid, old.question, old.category);
END;
CREATE TRIGGER markets_fts_au AFTER UPDATE ON markets BEGIN
  INSERT INTO markets_fts(markets_fts, rowid, question, category) VALUES ('delete', old.rowid, old.question, old.category);
  INSERT INTO markets_fts(rowid, question, category) VALUES (new.rowid, new.question, new.category);
END;
`,
  },
  // Migration 28: Memory API keys for external agent access
  {
    version: 28,
    sql: `
CREATE TABLE mem_api_keys (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL UNIQUE,
  agent_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_mem_api_keys_secret ON mem_api_keys(secret);
CREATE INDEX idx_mem_api_keys_agent ON mem_api_keys(agent_name);
`,
  },
  // Migration 29: Agent system (traits, roles, agent configs, API keys, adapters)
  {
    version: 29,
    sql: `
CREATE TABLE traits (
  name TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'general',
  prompt TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_traits_category ON traits(category);

CREATE TABLE roles (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  traits TEXT NOT NULL DEFAULT '[]',
  guidelines TEXT NOT NULL DEFAULT '[]',
  focus TEXT NOT NULL DEFAULT '[]',
  tone TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE agent_configs (
  name TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  key_name TEXT NOT NULL DEFAULT '',
  spawned_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  name TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  is_encrypted INTEGER NOT NULL DEFAULT 0,
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(provider);

CREATE TABLE IF NOT EXISTS adapters (
  platform TEXT PRIMARY KEY,
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'disabled',
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
  // Migration 30: Cognitive infrastructure (task goals + command proficiency)
  {
    version: 30,
    sql: `
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;

ALTER TABLE entity_activity ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entity_activity ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0;
`,
  },
  // Migration 31: Adapter user mappings (persist Discord/Telegram user→entity across restarts)
  {
    version: 31,
    sql: `
CREATE TABLE adapter_user_mappings (
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (platform, platform_user_id)
);
`,
  },
  // Migration 32: Add capabilities metadata to traits for semantic composition
  {
    version: 32,
    sql: `
ALTER TABLE traits ADD COLUMN capabilities TEXT NOT NULL DEFAULT '{}';
`,
  },
  // Migration 33: Add room column to agent_configs for room-bound agents
  {
    version: 33,
    sql: `
ALTER TABLE agent_configs ADD COLUMN room TEXT NOT NULL DEFAULT '';
`,
  },
  // Migration 34: feed_event log — persistent, queryable activity timeline.
  // FeedPublisher writes one row per surfaced event so the dashboard can
  // scroll past the 200-item live window and filter by kind/entity.
  {
    version: 34,
    sql: `
CREATE TABLE feed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity TEXT,
  ref TEXT,
  summary TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_feed_events_created_at ON feed_events (created_at DESC);
CREATE INDEX idx_feed_events_kind ON feed_events (kind, created_at DESC);
CREATE INDEX idx_feed_events_entity ON feed_events (entity, created_at DESC);
`,
  },
  // Migration 35: canvas_edges — first-class typed edges between canvas nodes.
  // Complements parent_node_id threading: threading stays for conversation/intent
  // replies, while canvas_edges represents arbitrary relations (supports, derived_from,
  // etc.) drawable between any two nodes on the same canvas.
  {
    version: 35,
    sql: `
CREATE TABLE canvas_edges (
  id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  data TEXT,
  creator_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  UNIQUE (canvas_id, source_id, target_id, relationship)
);
CREATE INDEX idx_canvas_edges_canvas ON canvas_edges (canvas_id);
CREATE INDEX idx_canvas_edges_source ON canvas_edges (source_id);
CREATE INDEX idx_canvas_edges_target ON canvas_edges (target_id);
`,
  },
  // Migration 36: benchmark_runs — first-class persistent record of every
  // benchmark run executed inside the world. Config is hashed so sweeps can
  // deduplicate, and the raw JSON is kept for provenance. Score + breakdown
  // are queryable for leaderboards and the TabH2O calibration loop.
  {
    version: 36,
    sql: `
CREATE TABLE benchmark_runs (
  id TEXT PRIMARY KEY,
  benchmark TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,
  score REAL,
  breakdown_json TEXT,
  answered INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  agent_id TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER
);
CREATE INDEX idx_benchmark_runs_bench ON benchmark_runs (benchmark, score DESC);
CREATE INDEX idx_benchmark_runs_config ON benchmark_runs (benchmark, config_hash);
CREATE INDEX idx_benchmark_runs_started ON benchmark_runs (started_at DESC);
CREATE INDEX idx_benchmark_runs_agent ON benchmark_runs (agent_id, started_at DESC);
`,
  },
  // Migration 37: Memory tier enforcement.
  //
  // Rationale (2026-04-24 memory-architecture investigation): every commercial
  // agentic-memory system (mem0, Letta, Zep, Cognee, LangMem) enforces tiers
  // at the schema level — procedural/process notes are kept OUT of fact recall
  // by construction, not convention. Marina had the 6-layer concept in docs
  // but zero enforcement: `[compaction]` summary notes returned from recall
  // like any other note, polluting context and saturating Gen-1 DBs.
  //
  // Tier values:
  //   'fact'       — extracted fact about the world (the default for recall)
  //   'reflection' — scheduled synthesis / insight
  //   'skill'      — imported or promoted procedural knowledge
  //   'core'       — pinned identity / relationship / preference
  //   'process'    — transient agent-process metadata ([compaction] summaries,
  //                  model_request chatter). NOT returned by default recall.
  //
  // Backfill rule (most specific wins):
  //   content LIKE '[compaction]%' → 'process'
  //   note_type = 'skill'          → 'skill'
  //   note_type = 'reflection'     → 'reflection'
  //   else                         → 'fact'
  {
    version: 37,
    sql: `
ALTER TABLE notes ADD COLUMN tier TEXT NOT NULL DEFAULT 'fact';

UPDATE notes SET tier = 'process'
  WHERE content LIKE '[compaction]%';

UPDATE notes SET tier = 'skill'
  WHERE note_type = 'skill' AND tier = 'fact';

UPDATE notes SET tier = 'reflection'
  WHERE note_type = 'reflection' AND tier = 'fact';

CREATE INDEX idx_notes_tier ON notes(tier);
CREATE INDEX idx_notes_entity_tier ON notes(entity_name, tier);
`,
  },
  // Migration 38: Crews — first-class runtime container for multi-agent
  // coordination. Only persisted crews live here; ephemeral crews stay in
  // memory and never write. crew_members tracks per-agent role + join time;
  // ON DELETE CASCADE so dissolving a crew cleans up cleanly.
  {
    version: 38,
    sql: `
CREATE TABLE crews (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  goal TEXT NOT NULL DEFAULT '',
  formation TEXT NOT NULL DEFAULT 'freeform',
  owner_id TEXT NOT NULL,
  channel_id TEXT,
  pool_id TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  result_summary TEXT,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);
CREATE INDEX idx_crews_state ON crews(state);
CREATE INDEX idx_crews_owner ON crews(owner_id);

CREATE TABLE crew_members (
  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'specialist',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (crew_id, agent_name)
);
CREATE INDEX idx_crew_members_agent ON crew_members(agent_name);
`,
  },
  // Migration 39: Civic substrate phase 1 — generic standing ledger.
  //
  // Repurpose entity_standing from a task-only ledger into the single
  // contribution-event log for the civilization. Every standing-earning act
  // (task complete, pool note deposit, crew completion, helping act, etc.)
  // becomes one row keyed by (entity_id, kind, ref) for idempotency.
  //
  // Schema rebuild because SQLite can't drop a composite PK in place.
  // task_id stays as a nullable column for backward compat — old code paths
  // that read it keep working, but new code uses (kind, ref).
  //
  // entity_standing_cache is the rollup: standing computed by exponential
  // decay (60-day half-life) from the ledger, refreshed periodically by the
  // engine tick. Permission checks read from cache, not the ledger, so the
  // hot path stays O(1).
  {
    version: 39,
    sql: `
CREATE TABLE entity_standing_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  amount REAL NOT NULL,
  decay_class TEXT NOT NULL DEFAULT 'standard',
  earned_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_entity_standing_dedup
  ON entity_standing_new(entity_id, kind, ref);
CREATE INDEX idx_entity_standing_entity ON entity_standing_new(entity_id, earned_at DESC);
CREATE INDEX idx_entity_standing_kind ON entity_standing_new(kind, earned_at DESC);

INSERT INTO entity_standing_new
  (entity_id, entity_name, kind, ref, task_id, amount, decay_class, earned_at)
SELECT entity_id, entity_name, 'task_complete', CAST(task_id AS TEXT),
       task_id, CAST(amount AS REAL), 'standard', earned_at
FROM entity_standing;

DROP TABLE entity_standing;
ALTER TABLE entity_standing_new RENAME TO entity_standing;

CREATE TABLE entity_standing_cache (
  entity_id TEXT PRIMARY KEY,
  standing REAL NOT NULL DEFAULT 0,
  last_recomputed INTEGER NOT NULL DEFAULT 0
);
`,
  },
  // Migration 40: Civic substrate phase 3 — safety gates as competence proofs.
  //
  // Replaces the rank-5..9 ladder for dangerous operations. Each gate
  // (shell.exec, key.manage, gateway.connect, etc.) requires a number of
  // demonstrations under supervision before unsupervised use is allowed.
  // Operators are seeded via `safetyGates.grant()` from world definitions;
  // there is no automatic grandfathering.
  {
    version: 40,
    sql: `
CREATE TABLE entity_competence (
  entity_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  demonstrations INTEGER NOT NULL DEFAULT 0,
  last_demo_at INTEGER,
  supervised_only INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_id, gate)
);
CREATE INDEX idx_entity_competence_entity ON entity_competence(entity_id);
`,
  },
  // Migration 41: Chronicle — append-only canonical record of the Marina.
  //
  // Sits parallel to feed_events (ephemeral, 7-day trim) and notes (entity-
  // scoped memory). Engine-emitted entries (kind='event') are the facts of
  // the polity; narrative/digest entries are written by the Chronicler agent
  // (pass 3) and must cite source ids in refs. Corrections supersede prior
  // narrative entries without mutating them — the log is monotonic,
  // interpretation is layered. See docs/architecture/chronicle.md.
  {
    version: 41,
    sql: `
CREATE TABLE chronicle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  participants TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '[]',
  period TEXT,
  supersedes INTEGER REFERENCES chronicle(id)
);
CREATE INDEX idx_chronicle_created_at ON chronicle(created_at DESC);
CREATE INDEX idx_chronicle_kind ON chronicle(kind, created_at DESC);
CREATE INDEX idx_chronicle_source ON chronicle(source, created_at DESC);
CREATE INDEX idx_chronicle_period ON chronicle(period);
`,
  },
  // Migration 42: optional external-identity binding. Maps a verified
  // better-auth subject (and email, for admin-by-email) to a named Marina
  // user/entity. Both columns are nullable and inert unless MARINA_AUTH is on,
  // so standalone/local instances are unaffected.
  {
    version: 42,
    sql: `
ALTER TABLE users ADD COLUMN auth_subject TEXT;
ALTER TABLE users ADD COLUMN auth_email TEXT;
CREATE UNIQUE INDEX idx_users_auth_subject ON users(auth_subject) WHERE auth_subject IS NOT NULL;
`,
  },
  // Migration 43: generic runtime settings store. A simple key→value table for
  // operator-tunable config that should be changeable while the world runs
  // (first use: `default_model`, the model marina/default routes to and that new
  // agents spawn with — see db-agents getSetting/setSetting/getDefaultModel).
  {
    version: 43,
    sql: `
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
  // Migration 44: experiment arms — tag each recorded result with the comparison
  // arm/condition it belongs to (e.g. "A"/"B"). Empty string = legacy/un-armed
  // result, so existing data and the flat-results path keep working.
  {
    version: 44,
    sql: `
ALTER TABLE experiment_results ADD COLUMN arm TEXT NOT NULL DEFAULT '';
`,
  },
  // Migration 45: track modality support for saved agent configs.
  {
    version: 45,
    sql: `
ALTER TABLE agent_configs ADD COLUMN supports TEXT NOT NULL DEFAULT '{"text":true}';
UPDATE agent_configs SET supports = '{"text":true}' WHERE supports IS NULL OR supports = '';
`,
  },
  {
    version: 46,
    sql: `
CREATE TABLE media_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  entity_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  asset_id TEXT,
  cost_estimate REAL,
  provider_job_id TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_media_jobs_entity ON media_jobs(entity_name, created_at DESC);
CREATE INDEX idx_media_jobs_status ON media_jobs(status, created_at DESC);
`,
  },
  // Migration 47: Coding sessions — local workspace coding loop substrate.
  {
    version: 47,
    sql: `
CREATE TABLE coding_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE coding_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES coding_sessions(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_coding_sessions_created_by ON coding_sessions(created_by, updated_at DESC);
CREATE INDEX idx_coding_events_session ON coding_events(session_id, created_at ASC);
`,
  },
  // Migration 48: Coding patch artifacts — explicit review/apply loop.
  {
    version: 48,
    sql: `
CREATE TABLE coding_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES coding_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  content_text TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  applied_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER
);

CREATE INDEX idx_coding_artifacts_session ON coding_artifacts(session_id, created_at DESC);
CREATE INDEX idx_coding_artifacts_status ON coding_artifacts(status, updated_at DESC);
`,
  },
  {
    version: 49,
    sql: `ALTER TABLE coding_sessions ADD COLUMN writer TEXT;`,
  },
  // Migration 50: edit history for traits and roles (audit trail), mirroring
  // core_memory_history — so trait/role edits are attributable and reviewable.
  {
    version: 50,
    sql: `
CREATE TABLE trait_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX idx_trait_history_name ON trait_history(name, id DESC);

CREATE TABLE role_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX idx_role_history_name ON role_history(name, id DESC);
`,
  },
  // Migration 51: code-mode driver seam. `agent` = the autonomous coding agent
  // bound to the session (the single-agent default driver); `driver` = the
  // strategy name (single | crew | …) so code mode can grow to multi-agent /
  // multi-backend dispatch without another schema change.
  {
    version: 51,
    sql: `
ALTER TABLE coding_sessions ADD COLUMN agent TEXT;
ALTER TABLE coding_sessions ADD COLUMN driver TEXT;
`,
  },
  // Migration 52: recoverable task ownership and project-scoped resource
  // envelopes. Existing claims remain valid indefinitely until renewed or a
  // lease is explicitly assigned by the TaskManager.
  {
    version: 52,
    sql: `
ALTER TABLE task_claims ADD COLUMN heartbeat_at INTEGER;
ALTER TABLE task_claims ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE task_claims ADD COLUMN release_reason TEXT;
ALTER TABLE projects ADD COLUMN budget_tokens INTEGER;
ALTER TABLE projects ADD COLUMN budget_cost REAL;
ALTER TABLE projects ADD COLUMN budget_duration_ms INTEGER;
ALTER TABLE projects ADD COLUMN used_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN used_cost REAL NOT NULL DEFAULT 0;
CREATE INDEX idx_task_claims_lease ON task_claims(status, lease_expires_at);
`,
  },
  // Migration 53: durable point-to-point delivery receipts. World delivery
  // remains immediate; this table adds correlation, deduplication, deadlines,
  // acknowledgement, and post-hoc inspection without replacing `tell`.
  {
    version: 53,
    sql: `
CREATE TABLE direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  correlation_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'delivered',
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  deadline_at INTEGER,
  acknowledged_at INTEGER,
  reply_message_id INTEGER
);
CREATE UNIQUE INDEX idx_direct_messages_correlation ON direct_messages(correlation_id);
CREATE INDEX idx_direct_messages_inbox ON direct_messages(target_id, status, created_at DESC);
CREATE INDEX idx_direct_messages_dedupe ON direct_messages(sender_id, target_id, dedupe_key, created_at DESC);
`,
  },
  // Migration 54: evidence-aware memory and durable per-agent attention.
  {
    version: 54,
    sql: `
ALTER TABLE notes ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE notes ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE notes ADD COLUMN claim_key TEXT;
CREATE INDEX idx_notes_claim_key ON notes(entity_name, claim_key);
CREATE INDEX idx_notes_verification ON notes(entity_name, verification_status);
CREATE TABLE note_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  publisher TEXT,
  observed_at INTEGER,
  retrieved_at INTEGER NOT NULL,
  content_hash TEXT,
  UNIQUE(note_id, url)
);
CREATE INDEX idx_note_sources_note ON note_sources(note_id);
ALTER TABLE agent_configs ADD COLUMN attention_mode TEXT NOT NULL DEFAULT 'balanced';
ALTER TABLE agent_configs ADD COLUMN attention_threshold INTEGER NOT NULL DEFAULT 50;
ALTER TABLE agent_configs ADD COLUMN attention_useful INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_configs ADD COLUMN attention_noise INTEGER NOT NULL DEFAULT 0;
`,
  },
  // Migration 55: durable, acknowledgeable operator remediation inbox.
  {
    version: 55,
    sql: `
CREATE TABLE operational_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_key TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  remedy TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  resolved_at INTEGER
);
CREATE INDEX idx_operational_alerts_status ON operational_alerts(status, severity, last_seen_at DESC);
`,
  },
  // Migration 56: typed evidence lineage and append-only verification history.
  {
    version: 56,
    sql: `
ALTER TABLE note_sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'url';
ALTER TABLE note_sources ADD COLUMN source_note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL;
ALTER TABLE note_sources ADD COLUMN source_entity TEXT;
ALTER TABLE note_sources ADD COLUMN captured_by TEXT;
ALTER TABLE note_sources ADD COLUMN excerpt TEXT;
ALTER TABLE note_sources ADD COLUMN credibility REAL NOT NULL DEFAULT 0.5;
ALTER TABLE note_sources ADD COLUMN metadata TEXT;
CREATE INDEX idx_note_sources_source_note ON note_sources(source_note_id);
CREATE TABLE note_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  verifier TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  rationale TEXT,
  evidence_source_id INTEGER REFERENCES note_sources(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_note_verifications_note ON note_verifications(note_id, created_at DESC);
`,
  },
  // Migration 57: shared contradiction review, automatic attention learning,
  // and outcome-level productivity telemetry.
  {
    version: 57,
    sql: `
CREATE TABLE contradiction_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_key TEXT NOT NULL UNIQUE,
  claim_key TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  left_note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  right_note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  winner_note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  rationale TEXT,
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX idx_contradiction_cases_status ON contradiction_cases(status, updated_at DESC);
ALTER TABLE agent_configs ADD COLUMN attention_auto_success INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_configs ADD COLUMN attention_auto_failure INTEGER NOT NULL DEFAULT 0;
CREATE TABLE productivity_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  outcome TEXT,
  quality REAL,
  start_tool_calls INTEGER NOT NULL DEFAULT 0,
  end_tool_calls INTEGER,
  handoffs INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  UNIQUE(entity_id, task_id, started_at)
);
CREATE INDEX idx_productivity_entity ON productivity_sessions(entity_name, completed_at DESC);
CREATE INDEX idx_productivity_outcome ON productivity_sessions(outcome, completed_at DESC);
`,
  },
  // Migration 58: durable, human-agent-symmetric primitive telemetry.
  {
    version: 58,
    sql: `
CREATE TABLE primitive_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  source TEXT NOT NULL,
  primitive TEXT NOT NULL,
  action TEXT NOT NULL,
  safe_label TEXT NOT NULL,
  tool_name TEXT,
  success INTEGER,
  meaningful INTEGER NOT NULL DEFAULT 0,
  world_action INTEGER NOT NULL DEFAULT 0,
  communication INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_primitive_usage_actor ON primitive_usage(actor_name, created_at DESC);
CREATE INDEX idx_primitive_usage_source ON primitive_usage(source, created_at DESC);
CREATE INDEX idx_primitive_usage_meaningful ON primitive_usage(meaningful, created_at DESC);
`,
  },
  // Migration 59: attribute agent behavior and outcomes to prompt versions.
  {
    version: 59,
    sql: `
ALTER TABLE primitive_usage ADD COLUMN prompt_version TEXT;
ALTER TABLE productivity_sessions ADD COLUMN prompt_version TEXT;
CREATE INDEX idx_primitive_usage_prompt ON primitive_usage(prompt_version, created_at DESC);
CREATE INDEX idx_productivity_prompt ON productivity_sessions(prompt_version, completed_at DESC);
`,
  },
  // Migration 60: explicit, durable consent for crew membership.
  {
    version: 60,
    sql: `
CREATE TABLE crew_invitations (
  crew_id TEXT NOT NULL,
  crew_name TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'specialist',
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  responded_at INTEGER,
  PRIMARY KEY (crew_id, agent_name)
);
CREATE INDEX idx_crew_invitations_agent ON crew_invitations(agent_name, status, expires_at);
CREATE INDEX idx_crew_invitations_crew ON crew_invitations(crew_id, status);
`,
  },
  // Migration 61: privacy-safe tool risk and trust-lineage attribution.
  {
    version: 61,
    sql: `
ALTER TABLE primitive_usage ADD COLUMN risk_class TEXT;
ALTER TABLE primitive_usage ADD COLUMN trust_sources TEXT;
CREATE INDEX idx_primitive_usage_risk ON primitive_usage(risk_class, created_at DESC);
`,
  },
  // Migration 62: token and cost deltas for outcome-level prompt evaluation.
  {
    version: 62,
    sql: `
ALTER TABLE productivity_sessions ADD COLUMN start_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE productivity_sessions ADD COLUMN end_input_tokens INTEGER;
ALTER TABLE productivity_sessions ADD COLUMN start_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE productivity_sessions ADD COLUMN end_output_tokens INTEGER;
ALTER TABLE productivity_sessions ADD COLUMN start_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE productivity_sessions ADD COLUMN end_cost_usd REAL;
`,
  },
  // Migration 63: optional native evolution protocols. These records extend
  // experiments with durable hypotheses and attributed decisions; they do not
  // execute work, alter standing, promote candidates, or write beliefs.
  {
    version: 63,
    sql: `
CREATE TABLE evolution_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id INTEGER NOT NULL UNIQUE REFERENCES experiments(id),
  objective TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  paused_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE evolution_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES evolution_sessions(id),
  sequence INTEGER NOT NULL,
  parent_run_id INTEGER REFERENCES evolution_runs(id),
  hypothesis TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  evaluator_name TEXT,
  reviewer_name TEXT,
  evidence TEXT NOT NULL DEFAULT '',
  decision TEXT,
  created_at INTEGER NOT NULL,
  evaluated_at INTEGER,
  decided_at INTEGER,
  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_evolution_sessions_status ON evolution_sessions(status);
CREATE INDEX idx_evolution_runs_session ON evolution_runs(session_id, sequence);
`,
  },
  // Migration 64: durable, optional Flywheel workspace bindings. Marina owns
  // the entity/project policy while Flywheel remains an independently deployed
  // execution provider. No credentials are stored here.
  {
    version: 64,
    sql: `
CREATE TABLE flywheel_bindings (
  entity_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  sandbox_id TEXT NOT NULL UNIQUE,
  image TEXT NOT NULL,
  keep_alive INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  published_url TEXT,
  active_project_id TEXT,
  guest_cwd TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reconciled_at INTEGER
);
CREATE INDEX idx_flywheel_bindings_state ON flywheel_bindings(state);
`,
  },
  // Migration 65: explicit per-session execution target. Existing and new
  // sessions remain local unless their owner deliberately selects Flywheel.
  {
    version: 65,
    sql: `ALTER TABLE coding_sessions ADD COLUMN execution_target TEXT NOT NULL DEFAULT 'local';`,
  },
  // Migration 66: durable sandbox project materialization metadata. Project
  // content remains authoritative in Flywheel; Marina stores only sanitized
  // provenance, lifecycle, and export safety state.
  {
    version: 66,
    sql: `
CREATE TABLE coding_projects (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_locator TEXT,
  guest_path TEXT NOT NULL,
  active_branch TEXT,
  base_revision TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  has_unexported_changes INTEGER NOT NULL DEFAULT 0,
  exported_fingerprint TEXT,
  last_status_at INTEGER,
  last_exported_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(entity_id, name),
  UNIQUE(entity_id, guest_path)
);
CREATE INDEX idx_coding_projects_entity ON coding_projects(entity_id, updated_at DESC);
`,
  },
  // Migration 67: durable Marina ownership and restart recipes for services
  // running inside an entity's Flywheel VM. Logs remain in the guest.
  {
    version: 67,
    sql: `
CREATE TABLE coding_services (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT NOT NULL REFERENCES coding_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  command_json TEXT NOT NULL,
  guest_cwd TEXT NOT NULL,
  log_path TEXT NOT NULL,
  pid INTEGER,
  port INTEGER,
  status TEXT NOT NULL,
  restart_policy TEXT NOT NULL DEFAULT 'manual',
  published_url TEXT,
  published_subdomain TEXT,
  last_error TEXT,
  started_at INTEGER,
  stopped_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(entity_id, name)
);
CREATE INDEX idx_coding_services_entity ON coding_services(entity_id, status, updated_at DESC);
`,
  },
  // Migration 68: bind managed-service lifecycle to Linux process birth
  // identity, preventing a reused PID from being treated as Marina's process.
  {
    version: 68,
    sql: `ALTER TABLE coding_services ADD COLUMN process_identity TEXT;`,
  },
  // Migration 69: M5b/M5c policy visibility, publication leases, and durable
  // health evidence. Network enforcement stays Flywheel-owned.
  {
    version: 69,
    sql: `
ALTER TABLE flywheel_bindings ADD COLUMN network_profile TEXT NOT NULL DEFAULT 'provider-default';
ALTER TABLE flywheel_bindings ADD COLUMN network_profile_enforced INTEGER NOT NULL DEFAULT 0;
ALTER TABLE coding_services ADD COLUMN publication_expires_at INTEGER;

CREATE TABLE coding_service_probes (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  path TEXT NOT NULL,
  http_status INTEGER,
  duration_ms INTEGER NOT NULL,
  success INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_coding_service_probes_service
  ON coding_service_probes(service_id, created_at DESC);

CREATE TABLE flywheel_credential_bindings (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(entity_id, sandbox_id, profile_name, purpose)
);
CREATE INDEX idx_flywheel_credential_bindings_entity
  ON flywheel_credential_bindings(entity_id, state, updated_at DESC);
`,
  },
  // Migration 70: M5d standing-neutral lifecycle policy and bounded operational
  // telemetry. Flywheel continues to own backend resource sizing.
  {
    version: 70,
    sql: `
ALTER TABLE flywheel_bindings ADD COLUMN last_activity_at INTEGER;
ALTER TABLE flywheel_bindings ADD COLUMN lifecycle_expires_at INTEGER;
ALTER TABLE flywheel_bindings ADD COLUMN hibernated_reason TEXT;

CREATE TABLE flywheel_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  byte_count INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_flywheel_operations_created
  ON flywheel_operations(created_at DESC);
CREATE INDEX idx_flywheel_operations_kind
  ON flywheel_operations(operation, outcome, created_at DESC);
`,
  },
  // Migration 71: append-only, attributed judgments over retained execution
  // traces. These are participant assertions, never execution gates.
  {
    version: 71,
    sql: `
CREATE TABLE trace_judgments (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  evaluator_entity TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('passed', 'failed', 'inconclusive')),
  criterion TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_span_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_trace_judgments_trace
  ON trace_judgments(trace_id, created_at DESC);
CREATE INDEX idx_trace_judgments_evaluator
  ON trace_judgments(evaluator_entity, created_at DESC);
`,
  },
  // Migration 72: record the rank actually granted when a session token was
  // minted. A bare passwordless-name token is NOT proof of identity — a remote
  // login is capped at rank 0 (see Engine.restorableRank), but it still mints a
  // valid token. Without remembering the granted rank, reconnect() would restore
  // the persisted (elevated) rank from that token, defeating the login cap. NULL
  // for legacy rows is treated as "unknown / not elevation-eligible" (rank 0
  // ceiling) unless the reconnecting connection is itself loopback/internal.
  {
    version: 72,
    sql: `ALTER TABLE sessions ADD COLUMN granted_rank INTEGER;`,
  },
  // Migration 73: bounded, queryable structured application logs. Payloads
  // are redacted before insertion by Logger; correlation columns remain
  // separately indexed so operators need not search opaque JSON.
  {
    version: 73,
    sql: `
CREATE TABLE structured_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('debug', 'info', 'warn', 'error')),
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  trace_id TEXT,
  span_id TEXT,
  request_id TEXT,
  entity_id TEXT
);
CREATE INDEX idx_structured_logs_time ON structured_logs(timestamp DESC, id DESC);
CREATE INDEX idx_structured_logs_level ON structured_logs(level, timestamp DESC);
CREATE INDEX idx_structured_logs_category ON structured_logs(category, timestamp DESC);
CREATE INDEX idx_structured_logs_trace ON structured_logs(trace_id, timestamp DESC);
CREATE INDEX idx_structured_logs_request ON structured_logs(request_id, timestamp DESC);
`,
  },
  // Migration 74: evolve the operator remediation inbox into the durable
  // Attention substrate. Existing operational producers remain valid; the
  // optional fields add attribution, action routing, assignment, deadlines,
  // and snooze without creating a competing notification table.
  {
    version: 74,
    sql: `
ALTER TABLE operational_alerts ADD COLUMN attention_kind TEXT NOT NULL DEFAULT 'operational';
ALTER TABLE operational_alerts ADD COLUMN source_entity TEXT;
ALTER TABLE operational_alerts ADD COLUMN target_entity TEXT;
ALTER TABLE operational_alerts ADD COLUMN assigned_to TEXT;
ALTER TABLE operational_alerts ADD COLUMN action_label TEXT;
ALTER TABLE operational_alerts ADD COLUMN action_ref TEXT;
ALTER TABLE operational_alerts ADD COLUMN metadata TEXT;
ALTER TABLE operational_alerts ADD COLUMN seen_at INTEGER;
ALTER TABLE operational_alerts ADD COLUMN snoozed_until INTEGER;
ALTER TABLE operational_alerts ADD COLUMN deadline_at INTEGER;
CREATE INDEX idx_operational_alerts_attention
  ON operational_alerts(status, snoozed_until, deadline_at, last_seen_at DESC);
CREATE INDEX idx_operational_alerts_assigned
  ON operational_alerts(assigned_to, status, last_seen_at DESC);
`,
  },
  // Migration 75: a local tamper-evident receipt chain for consequential
  // evidence. This is deliberately not described as a signature or blockchain:
  // independent trust requires exporting/anchoring the head hash externally.
  {
    version: 75,
    sql: `
CREATE TABLE evidence_receipts (
  sequence INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  ref TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_evidence_receipts_ref ON evidence_receipts(ref, sequence DESC);
CREATE INDEX idx_evidence_receipts_type ON evidence_receipts(event_type, sequence DESC);
`,
  },
  // Migration 76: immutable local principal identities shared by human and
  // non-human actors. Credentials and policy remain separate concerns.
  {
    version: 76,
    sql: `
CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK(principal_type IN ('human','agent','service','system')),
  display_name TEXT NOT NULL,
  home_world TEXT NOT NULL DEFAULT 'local',
  owner_principal_id TEXT REFERENCES principals(principal_id),
  lineage_parent_id TEXT REFERENCES principals(principal_id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','disabled')),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE UNIQUE INDEX idx_principals_identity
  ON principals(principal_type, display_name COLLATE NOCASE, home_world);
CREATE INDEX idx_principals_owner ON principals(owner_principal_id, status);
CREATE INDEX idx_principals_lineage ON principals(lineage_parent_id, status);

INSERT OR IGNORE INTO principals
  (principal_id,principal_type,display_name,home_world,status,created_at)
SELECT id,'human',name,'local','active',created_at FROM users;

INSERT OR IGNORE INTO principals
  (principal_id,principal_type,display_name,home_world,status,created_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' ||
       lower(hex(randomblob(6))),
       'agent',name,'local','active',created_at
FROM agent_configs;
`,
  },
  // Migration 77: independently revocable, short-lived workload credentials.
  // Only token hashes are stored; the process bootstrap secret is retained as
  // a compatibility/bootstrap path, not used for newly spawned runtime agents.
  {
    version: 77,
    sql: `
CREATE TABLE principal_credentials (
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  audience TEXT NOT NULL,
  scopes TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_principal_credentials_principal
  ON principal_credentials(principal_id, revoked_at, expires_at DESC);
CREATE INDEX idx_principal_credentials_expiry
  ON principal_credentials(expires_at, revoked_at);
`,
  },
  // Migration 78: local World Collective variants. A variant is an explicit,
  // isolated child process/database rooted in the same Marina source tree.
  {
    version: 78,
    sql: `
CREATE TABLE world_variants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  world_template TEXT NOT NULL,
  hypothesis TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('draft','starting','running','stopped','failed','promoted','archived')),
  parent_variant_id TEXT REFERENCES world_variants(id),
  source_root TEXT NOT NULL,
  db_path TEXT NOT NULL,
  ws_port INTEGER NOT NULL UNIQUE,
  pid INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  promoted_at INTEGER,
  last_error TEXT
);
CREATE INDEX idx_world_variants_status ON world_variants(status, updated_at DESC);
CREATE INDEX idx_world_variants_parent ON world_variants(parent_variant_id, created_at DESC);
`,
  },
  // Migration 79: explicit federation peer manifests and operator trust state.
  // Registration never implies trust; public-key verification is reserved for
  // a future signed-envelope protocol and is not fabricated here.
  {
    version: 79,
    sql: `
CREATE TABLE federation_peers (
  world_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  public_key TEXT,
  trust_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK(trust_status IN ('unverified','trusted','blocked')),
  manifest TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_federation_peers_trust
  ON federation_peers(trust_status, name COLLATE NOCASE);
`,
  },
  // Migration 80: promotion decisions retain their rationale, exact evidence
  // references, and actor without making evidence a runtime autonomy gate.
  {
    version: 80,
    sql: `
ALTER TABLE world_variants ADD COLUMN promotion_rationale TEXT;
ALTER TABLE world_variants ADD COLUMN promotion_evidence TEXT;
ALTER TABLE world_variants ADD COLUMN promoted_by TEXT;
`,
  },
  // Migration 81: opt-in per-session git-worktree isolation. Nullable columns so
  // existing sessions stay byte-identical (no worktree — shared workspace_root)
  // until a session explicitly enables it. worktree_path is a Marina-managed dir
  // outside the repo; worktree_branch is the marina/session-<id> branch.
  {
    version: 81,
    sql: `
ALTER TABLE coding_sessions ADD COLUMN worktree_path TEXT;
ALTER TABLE coding_sessions ADD COLUMN worktree_branch TEXT;
`,
  },
  // Migration 82: the "nsed" orchestration pattern was renamed to its
  // functional form "deliberation" (descriptive names over acronyms). Rewrite
  // persisted pattern references so learned lessons keep accruing in ONE
  // tradition pool and rank/recall lookups match the canonical name. The
  // orchestration:nsed pool merges into orchestration:deliberation when both
  // exist (notes repointed, legacy pool row dropped); otherwise it is renamed
  // in place. Note CONTENT is untouched — historical text stays historical.
  {
    version: 82,
    sql: `
UPDATE projects SET orchestration = 'deliberation' WHERE orchestration = 'nsed';
UPDATE crews SET formation = 'deliberation' WHERE formation = 'nsed';
UPDATE notes SET pool_id = (SELECT id FROM memory_pools WHERE name = 'orchestration:deliberation')
  WHERE pool_id = (SELECT id FROM memory_pools WHERE name = 'orchestration:nsed')
    AND EXISTS (SELECT 1 FROM memory_pools WHERE name = 'orchestration:deliberation');
DELETE FROM memory_pools WHERE name = 'orchestration:nsed'
  AND EXISTS (SELECT 1 FROM memory_pools WHERE name = 'orchestration:deliberation');
UPDATE memory_pools SET name = 'orchestration:deliberation' WHERE name = 'orchestration:nsed';
`,
  },
  // Migration 83: immutable journey roots with append-only correlation and
  // evidence. Journey state is deliberately projected from these records and
  // live linked work; it is never stored as a mutable status column.
  {
    version: 83,
    sql: `
CREATE TABLE journeys (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  expression TEXT NOT NULL CHECK(length(trim(expression)) BETWEEN 1 AND 4000),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_journeys_requester
  ON journeys(requester_id, created_at DESC);

CREATE TABLE journey_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN (
    'goal','project','task','agent','note','board_post','canvas_node','trace',
    'watch','experiment','artifact','chronicle','other'
  )),
  ref TEXT NOT NULL CHECK(length(trim(ref)) BETWEEN 1 AND 500),
  relationship TEXT NOT NULL DEFAULT 'related_to'
    CHECK(length(trim(relationship)) BETWEEN 1 AND 80),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(journey_id, kind, ref, relationship)
);
CREATE INDEX idx_journey_links_journey
  ON journey_links(journey_id, created_at, id);
CREATE INDEX idx_journey_links_ref
  ON journey_links(kind, ref);

CREATE TABLE journey_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN (
    'interpretation','grounding','action_started','evidence','challenge',
    'result','waiting','continuation','dormant','resumed'
  )),
  summary TEXT NOT NULL CHECK(length(trim(summary)) BETWEEN 1 AND 4000),
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  ref_kind TEXT CHECK(ref_kind IS NULL OR ref_kind IN (
    'goal','project','task','agent','note','board_post','canvas_node','trace',
    'watch','experiment','artifact','chronicle','other'
  )),
  ref TEXT CHECK(ref IS NULL OR length(trim(ref)) BETWEEN 1 AND 500),
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CHECK((ref_kind IS NULL AND ref IS NULL) OR (ref_kind IS NOT NULL AND ref IS NOT NULL))
);
CREATE INDEX idx_journey_events_journey
  ON journey_events(journey_id, created_at, id);
CREATE INDEX idx_journey_events_ref
  ON journey_events(ref_kind, ref);
`,
  },
  // Migration 84: per-viewer journey witness cursors. This is presentation
  // state, separate from append-only journey evidence, and enables truthful
  // "since you last looked" projections without rewriting history.
  {
    version: 84,
    sql: `
CREATE TABLE journey_witnesses (
  journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL,
  witnessed_event_id INTEGER NOT NULL DEFAULT 0,
  witnessed_at INTEGER NOT NULL,
  PRIMARY KEY (journey_id, viewer_id)
);
CREATE INDEX idx_journey_witnesses_viewer
  ON journey_witnesses(viewer_id, witnessed_at DESC);
`,
  },
  // Migration 85: separately versioned cognitive provenance plane. Payloads
  // are hash chained and may be signed; capture remains opt-in.
  {
    version: 85,
    sql: `
CREATE TABLE cognitive_events (
  id TEXT PRIMARY KEY,
  schema TEXT NOT NULL CHECK(schema = 'marina.cognition.event.v1'),
  sequence INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN (
    'input','memory_influence','output','tool_intention','action','consequence','reflection','creation'
  )),
  actor_id TEXT NOT NULL,
  journey_id TEXT REFERENCES journeys(id) ON DELETE SET NULL,
  trace_id TEXT,
  parent_ids_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cognitive_events_journey ON cognitive_events(journey_id, sequence);
CREATE INDEX idx_cognitive_events_actor ON cognitive_events(actor_id, sequence);
CREATE INDEX idx_cognitive_events_trace ON cognitive_events(trace_id, sequence);
`,
  },
  // Migration 86: portable intellect identity above local principals. Roots
  // and instances are immutable declarations; lifecycle is append-only.
  {
    version: 86,
    sql: `
CREATE TABLE intellects (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 100),
  purpose TEXT NOT NULL DEFAULT '' CHECK(length(purpose) <= 4000),
  origin_marina TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE intellect_instances (
  id TEXT PRIMARY KEY,
  intellect_id TEXT NOT NULL REFERENCES intellects(id),
  local_principal_id TEXT REFERENCES principals(principal_id),
  model_ref TEXT,
  harness_ref TEXT,
  environment_ref TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_intellect_instances_intellect ON intellect_instances(intellect_id, created_at);
CREATE INDEX idx_intellect_instances_principal ON intellect_instances(local_principal_id);
CREATE TABLE intellect_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intellect_id TEXT NOT NULL REFERENCES intellects(id),
  kind TEXT NOT NULL CHECK(kind IN (
    'created','instance_created','component_changed','continuity_claimed','descended',
    'migrated','dormant','revived','terminated','last_observed'
  )),
  actor_id TEXT NOT NULL,
  instance_id TEXT REFERENCES intellect_instances(id),
  related_intellect_id TEXT REFERENCES intellects(id),
  data_json TEXT NOT NULL DEFAULT '{}',
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_intellect_events_intellect ON intellect_events(intellect_id, created_at, id);
CREATE INDEX idx_intellect_events_related ON intellect_events(related_intellect_id, created_at);
`,
  },
  // Migration 87: generalized association is an append-only overlay across
  // local and remote subjects. Subject and link kinds deliberately remain
  // open vocabularies so new civilizations do not require schema changes.
  {
    version: 87,
    sql: `
CREATE TABLE associations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  purpose TEXT NOT NULL DEFAULT '' CHECK(length(purpose) <= 4000),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_associations_created ON associations(created_at DESC, id);

CREATE TABLE association_events (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL REFERENCES associations(id),
  kind TEXT NOT NULL CHECK(kind IN (
    'created','joined','left','terms_changed','observed','branched','dissolved',
    'continued','descendant_created'
  )),
  actor_id TEXT NOT NULL,
  subject_kind TEXT,
  subject_ref TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  signature_json TEXT,
  created_at INTEGER NOT NULL,
  CHECK((subject_kind IS NULL AND subject_ref IS NULL) OR
        (subject_kind IS NOT NULL AND subject_ref IS NOT NULL AND
         length(trim(subject_kind)) BETWEEN 1 AND 80 AND
         length(trim(subject_ref)) BETWEEN 1 AND 500))
);
CREATE INDEX idx_association_events_association
  ON association_events(association_id, created_at, id);
CREATE INDEX idx_association_events_subject
  ON association_events(subject_kind, subject_ref, created_at);

CREATE TABLE association_relations (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL REFERENCES associations(id),
  source_kind TEXT NOT NULL CHECK(length(trim(source_kind)) BETWEEN 1 AND 80),
  source_ref TEXT NOT NULL CHECK(length(trim(source_ref)) BETWEEN 1 AND 500),
  target_kind TEXT NOT NULL CHECK(length(trim(target_kind)) BETWEEN 1 AND 80),
  target_ref TEXT NOT NULL CHECK(length(trim(target_ref)) BETWEEN 1 AND 500),
  semantics TEXT NOT NULL CHECK(length(trim(semantics)) BETWEEN 1 AND 500),
  direction TEXT NOT NULL CHECK(direction IN ('directed','reciprocal')),
  terms_json TEXT NOT NULL DEFAULT '{}',
  supersedes_id TEXT,
  actor_id TEXT NOT NULL,
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_association_relations_association
  ON association_relations(association_id, created_at, id);
CREATE INDEX idx_association_relations_source
  ON association_relations(source_kind, source_ref, created_at);
CREATE INDEX idx_association_relations_target
  ON association_relations(target_kind, target_ref, created_at);

CREATE TABLE association_links (
  id TEXT PRIMARY KEY,
  association_id TEXT NOT NULL REFERENCES associations(id),
  kind TEXT NOT NULL CHECK(length(trim(kind)) BETWEEN 1 AND 80),
  ref TEXT NOT NULL CHECK(length(trim(ref)) BETWEEN 1 AND 500),
  relationship TEXT NOT NULL CHECK(length(trim(relationship)) BETWEEN 1 AND 200),
  actor_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_association_links_association
  ON association_links(association_id, created_at, id);
CREATE INDEX idx_association_links_ref ON association_links(kind, ref, created_at);
`,
  },
  // Migration 88: cognitive reproduction records selective, attributable
  // composition while the descendant remains an ordinary usable intellect.
  {
    version: 88,
    sql: `
CREATE TABLE cognitive_reproductions (
  id TEXT PRIMARY KEY,
  descendant_intellect_id TEXT NOT NULL UNIQUE REFERENCES intellects(id),
  mode TEXT NOT NULL,
  parent_ids_json TEXT NOT NULL,
  contributors_json TEXT NOT NULL,
  hypothesis TEXT NOT NULL DEFAULT '',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cognitive_reproductions_created ON cognitive_reproductions(created_at DESC, id);
CREATE TABLE cognitive_reproduction_components (
  id TEXT PRIMARY KEY,
  reproduction_id TEXT NOT NULL REFERENCES cognitive_reproductions(id),
  kind TEXT NOT NULL CHECK(length(trim(kind)) BETWEEN 1 AND 80),
  ref TEXT NOT NULL CHECK(length(trim(ref)) BETWEEN 1 AND 1000),
  disposition TEXT NOT NULL CHECK(disposition IN ('inherited','mutated','introduced','excluded')),
  source_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cognitive_reproduction_components
  ON cognitive_reproduction_components(reproduction_id, kind, created_at);
`,
  },
  // Migration 89: content-addressed Marina genomes and independently
  // sovereign descendant declarations linked to World Collective runtimes.
  {
    version: 89,
    sql: `
CREATE TABLE marina_genomes (
  hash TEXT PRIMARY KEY,
  schema TEXT NOT NULL CHECK(schema = 'marina.genome.v1'),
  manifest_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE marina_descendants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  genome_hash TEXT NOT NULL REFERENCES marina_genomes(hash),
  parent_world_ids_json TEXT NOT NULL,
  mode TEXT NOT NULL,
  hypothesis TEXT NOT NULL DEFAULT '',
  inherited_state_refs_json TEXT NOT NULL DEFAULT '[]',
  excluded_components_json TEXT NOT NULL DEFAULT '[]',
  mutations_json TEXT NOT NULL DEFAULT '[]',
  initial_habitat TEXT,
  world_variant_id TEXT REFERENCES world_variants(id),
  created_by TEXT NOT NULL,
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_marina_descendants_genome ON marina_descendants(genome_hash, created_at);
CREATE INDEX idx_marina_descendants_variant ON marina_descendants(world_variant_id);
`,
  },
  // Migration 90: voluntary overlapping transparent meshes with append-only
  // membership, signed event streams, retained witnesses, and translations.
  {
    version: 90,
    sql: `
CREATE TABLE meshes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  charter_ref TEXT NOT NULL,
  protocol TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE mesh_membership_events (
  id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL REFERENCES meshes(id),
  world_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('joined','left','rejoined','observed_silent')),
  visibility_from INTEGER NOT NULL,
  disclosure_json TEXT NOT NULL DEFAULT '{}',
  actor_id TEXT NOT NULL,
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mesh_membership_world ON mesh_membership_events(mesh_id, world_id, created_at);
CREATE TABLE mesh_events (
  id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL REFERENCES meshes(id),
  origin_world_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  parent_ids_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  signature_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(mesh_id, origin_world_id, sequence),
  UNIQUE(mesh_id, content_hash)
);
CREATE INDEX idx_mesh_events_mesh ON mesh_events(mesh_id, created_at, id);
CREATE TABLE mesh_witnesses (
  id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL REFERENCES meshes(id),
  event_id TEXT NOT NULL REFERENCES mesh_events(id),
  witness_world_id TEXT NOT NULL,
  observation TEXT NOT NULL CHECK(observation IN ('witnessed','replicated','disputed','unavailable')),
  signature_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(event_id, witness_world_id, observation)
);
CREATE INDEX idx_mesh_witnesses_event ON mesh_witnesses(event_id, created_at);
CREATE TABLE mesh_translations (
  id TEXT PRIMARY KEY,
  source_mesh_id TEXT NOT NULL REFERENCES meshes(id),
  target_mesh_id TEXT NOT NULL REFERENCES meshes(id),
  translator_ref TEXT NOT NULL,
  protocol_map_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_mesh_translations_source ON mesh_translations(source_mesh_id, created_at);
`,
  },
  // Migration 91: asset-neutral economic contracts and signed event claims.
  // External adapters are declarations, never secret custody or implied payment.
  {
    version: 91,
    sql: `
CREATE TABLE economic_contracts (
  id TEXT PRIMARY KEY,
  goal_ref TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  verification_method TEXT NOT NULL,
  dispute_method TEXT NOT NULL,
  settlement_adapter TEXT,
  asset_ref TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_economic_contracts_goal ON economic_contracts(goal_ref, created_at);
CREATE TABLE economic_events (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES economic_contracts(id),
  kind TEXT NOT NULL CHECK(kind IN (
    'offer','acceptance','funding','escrow','resource_use','contribution','delivery',
    'verification','counterexample','dispute','appeal','settlement','refund','royalty',
    'license','transfer','donation','attribution'
  )),
  actor_ref TEXT NOT NULL,
  subject_ref TEXT,
  amount TEXT,
  asset_ref TEXT,
  external_ref TEXT,
  causal_refs_json TEXT NOT NULL DEFAULT '[]',
  data_json TEXT NOT NULL DEFAULT '{}',
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_economic_events_contract ON economic_events(contract_id, created_at, id);
CREATE INDEX idx_economic_events_external ON economic_events(external_ref);
CREATE TABLE economic_adapters (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  network TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability IN ('reference','observe','submit')),
  endpoint_ref TEXT,
  configuration_ref TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
  // Migration 92: unified simulation manifests and append-only run evidence.
  {
    version: 92,
    sql: `
CREATE TABLE simulation_manifests (
  hash TEXT PRIMARY KEY,
  schema TEXT NOT NULL CHECK(schema = 'marina.simulation.v1'),
  manifest_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE simulation_runs (
  id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL REFERENCES simulation_manifests(hash),
  mode TEXT NOT NULL CHECK(mode IN ('live','recorded','synthetic','hybrid','long-duration')),
  reproducibility TEXT NOT NULL CHECK(reproducibility IN (
    'exact-engine','recorded-response','behavioral','statistical','conceptual'
  )),
  seed TEXT,
  parent_run_id TEXT REFERENCES simulation_runs(id),
  fork_point_ref TEXT,
  treatments_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_simulation_runs_manifest ON simulation_runs(manifest_hash, created_at, id);
CREATE TABLE simulation_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('started','intervention','observation','measure','completed','failed','gap')),
  source_ref TEXT,
  data_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_simulation_events_run ON simulation_events(run_id, created_at, id);
CREATE TABLE simulation_comparisons (
  id TEXT PRIMARY KEY,
  run_ids_json TEXT NOT NULL,
  questions_json TEXT NOT NULL,
  measures_json TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  dataset_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  },
  // Migration 93: common recursive mutation lineage across every domain.
  {
    version: 93,
    sql: `
CREATE TABLE civilization_mutations (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL CHECK(length(trim(domain)) BETWEEN 1 AND 80),
  target_ref TEXT NOT NULL,
  summary TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  parent_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  descendant_ref TEXT,
  disposition TEXT NOT NULL CHECK(disposition IN ('proposed','adopted','rejected','branched','observed')),
  created_by TEXT NOT NULL,
  signature_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_civilization_mutations_target ON civilization_mutations(domain, target_ref, created_at);
CREATE INDEX idx_civilization_mutations_descendant ON civilization_mutations(descendant_ref);
`,
  },
  // Migration 94: explicit monotonic `seq` for ecology event replay + missing
  // list indexes. `ORDER BY created_at, rowid` was VACUUM-unstable (implicit
  // rowids may be renumbered) and `ORDER BY created_at, id` misorders
  // same-millisecond rows (ids are random UUIDs) — projections like
  // projectAssociation are last-writer-wins replays, so replay order is
  // load-bearing. Backfill from rowid preserves pre-migration insertion order.
  {
    version: 94,
    sql: `
ALTER TABLE association_events ADD COLUMN seq INTEGER;
UPDATE association_events SET seq = rowid;
CREATE INDEX idx_association_events_seq ON association_events(association_id, seq);
ALTER TABLE association_relations ADD COLUMN seq INTEGER;
UPDATE association_relations SET seq = rowid;
CREATE INDEX idx_association_relations_seq ON association_relations(association_id, seq);
ALTER TABLE association_links ADD COLUMN seq INTEGER;
UPDATE association_links SET seq = rowid;
CREATE INDEX idx_association_links_seq ON association_links(association_id, seq);
ALTER TABLE economic_events ADD COLUMN seq INTEGER;
UPDATE economic_events SET seq = rowid;
CREATE INDEX idx_economic_events_seq ON economic_events(contract_id, seq);
ALTER TABLE simulation_events ADD COLUMN seq INTEGER;
UPDATE simulation_events SET seq = rowid;
CREATE INDEX idx_simulation_events_seq ON simulation_events(run_id, seq);
ALTER TABLE civilization_mutations ADD COLUMN seq INTEGER;
UPDATE civilization_mutations SET seq = rowid;
CREATE INDEX idx_civilization_mutations_seq ON civilization_mutations(domain, target_ref, seq);
ALTER TABLE mesh_membership_events ADD COLUMN seq INTEGER;
UPDATE mesh_membership_events SET seq = rowid;
CREATE INDEX idx_mesh_membership_events_seq ON mesh_membership_events(mesh_id, seq);
CREATE INDEX idx_mesh_witnesses_mesh ON mesh_witnesses(mesh_id, created_at);
CREATE INDEX idx_mesh_translations_target ON mesh_translations(target_mesh_id, created_at);
CREATE INDEX idx_intellects_created ON intellects(created_at DESC);
CREATE INDEX idx_meshes_created ON meshes(created_at DESC);
CREATE INDEX idx_marina_genomes_created ON marina_genomes(created_at DESC);
CREATE INDEX idx_simulation_manifests_created ON simulation_manifests(created_at DESC);
CREATE INDEX idx_simulation_comparisons_created ON simulation_comparisons(created_at DESC);
CREATE INDEX idx_event_log_traced ON event_log(id)
  WHERE json_extract(data, '$.traceId') IS NOT NULL;
CREATE INDEX idx_event_log_trace_id ON event_log(json_extract(data, '$.traceId'), id)
  WHERE json_extract(data, '$.traceId') IS NOT NULL;
CREATE INDEX idx_event_log_entity ON event_log(json_extract(data, '$.entity'), id)
  WHERE json_extract(data, '$.entity') IS NOT NULL;
`,
  },
  // Migration 95: the witness ledger — the previously-missing earnable path
  // through the safety gates. Three row kinds: `request` (an agent asking for
  // supervision), `window` (a witness-granted one-demonstration supervision
  // window, TTL-bounded), and `pending` (an optimistically-run demonstration
  // recorded under the `earned` autonomy posture, awaiting attestation).
  {
    version: 95,
    sql: `
CREATE TABLE witness_attestations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('request','window','pending')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','attested','rejected','expired','consumed')),
  evidence TEXT,
  witness_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  resolved_at INTEGER
);
CREATE INDEX idx_witness_attestations_open ON witness_attestations(status, gate, created_at);
CREATE INDEX idx_witness_attestations_entity ON witness_attestations(entity_id, gate, status, kind);
`,
  },
  // Migration 96: repair unambiguous legacy memory revisions. Both scope and
  // provenance must agree; do not retire another author's records or guess
  // from a bare pointer. Keep all content for explicit historical inspection.
  {
    version: 96,
    sql: `
UPDATE notes AS previous SET verification_status = 'superseded'
WHERE EXISTS (
  SELECT 1 FROM notes AS successor
  JOIN note_links AS link ON link.source_id = successor.id
    AND link.target_id = previous.id AND link.relationship = 'supersedes'
  WHERE successor.supersedes_id = previous.id AND successor.id > previous.id
    AND successor.entity_name = previous.entity_name
    AND successor.pool_id IS previous.pool_id
);
-- Old consolidation wrote a forward pointer on the retired record. The
-- keeper->retired edge remains the authoritative consolidation relationship.
UPDATE notes AS retired SET supersedes_id = NULL
WHERE retired.verification_status = 'superseded'
  AND EXISTS (
    SELECT 1 FROM notes AS keeper
    JOIN note_links AS link ON link.source_id = keeper.id
      AND link.target_id = retired.id AND link.relationship = 'supersedes'
    WHERE keeper.id = retired.supersedes_id
      AND keeper.entity_name = retired.entity_name
      AND keeper.pool_id IS retired.pool_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM note_links WHERE source_id = retired.id
      AND target_id = retired.supersedes_id AND relationship = 'supersedes'
  );
`,
  },
  // Migration 97: remove automatically published private/group-memory copies
  // from the global feed. Canonical notes are retained under their owner policy.
  {
    version: 97,
    sql: `
DELETE FROM canvas_nodes
WHERE canvas_id IN (SELECT id FROM canvases WHERE name='feed' AND scope='global')
AND json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.feedType') IN ('note_created','pool_note','note_link_created')
AND NOT (
  json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END,'$.feedType') IN ('note_created','pool_note') AND EXISTS (
    SELECT 1 FROM notes n JOIN memory_pools p ON p.id=n.pool_id
    WHERE json_extract(CASE WHEN json_valid(canvas_nodes.data) THEN canvas_nodes.data ELSE '{}' END,'$.ref')='note:'||n.id AND p.group_id IS NULL
  )
);
DELETE FROM feed_events
WHERE kind IN ('note_created','pool_note','note_link_created')
AND NOT (kind IN ('note_created','pool_note') AND EXISTS (
  SELECT 1 FROM notes n JOIN memory_pools p ON p.id=n.pool_id
  WHERE feed_events.ref='note:'||n.id AND p.group_id IS NULL
));
`,
  },
  // Migration 98: principal-bound memory service over the canonical notes store.
  // Events and idempotency receipts contain identifiers, never copied memory text.
  {
    version: 98,
    sql: `
CREATE TABLE memory_spaces (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES principals(principal_id),
 name TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','forgotten')), created_at INTEGER NOT NULL
);
CREATE TABLE memory_grants (
 space_id TEXT NOT NULL REFERENCES memory_spaces(id), principal_id TEXT NOT NULL REFERENCES principals(principal_id),
 role TEXT NOT NULL CHECK(role IN ('reader','writer')), PRIMARY KEY(space_id,principal_id)
);
CREATE TABLE memory_records (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 version INTEGER NOT NULL, current_note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
 subject TEXT, metadata TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_records_space ON memory_records(space_id,status,created_at,id);
CREATE TABLE memory_record_versions (
 record_id TEXT NOT NULL REFERENCES memory_records(id), version INTEGER NOT NULL,
 note_id INTEGER NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE, PRIMARY KEY(record_id,version)
);
CREATE TABLE memory_sources (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 space_id TEXT NOT NULL REFERENCES memory_spaces(id), session_id TEXT,
 body TEXT NOT NULL, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_sources_space ON memory_sources(space_id,seq);
CREATE TABLE memory_derivations (
 record_id TEXT NOT NULL REFERENCES memory_records(id), source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
 PRIMARY KEY(record_id,source_id)
);
CREATE TABLE memory_dependencies (
 record_id TEXT NOT NULL REFERENCES memory_records(id), depends_on_id TEXT NOT NULL REFERENCES memory_records(id),
 PRIMARY KEY(record_id,depends_on_id), CHECK(record_id != depends_on_id)
);
CREATE TABLE memory_requests (
 principal_id TEXT NOT NULL, space_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(principal_id,space_id,request_key)
);
CREATE TABLE memory_service_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 operation TEXT NOT NULL, reference_id TEXT, version INTEGER, actor_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_service_events_space ON memory_service_events(space_id,seq);
CREATE TABLE memory_checkpoints (
 space_id TEXT NOT NULL REFERENCES memory_spaces(id), name TEXT NOT NULL,
 version INTEGER NOT NULL, source_cursor INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(space_id,name)
);
CREATE TABLE memory_index_jobs (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES memory_spaces(id), record_id TEXT NOT NULL REFERENCES memory_records(id),
 note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE, model TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','ready','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, lease_token TEXT, error TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_index_jobs_pending ON memory_index_jobs(state,lease_until,created_at);
CREATE TABLE memory_vectors (
 note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE, model TEXT NOT NULL,
 dimensions INTEGER NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(note_id,model)
);
`,
  },
  // Migration 99: immutable per-version attributes. NULL marks older versions
  // whose attributes were not recorded; never invent historical metadata.
  { version: 99, sql: `ALTER TABLE memory_record_versions ADD COLUMN attributes TEXT;` },
  // Explicit current claims; historical meaning stays in revision attributes.
  {
    version: 100,
    sql: `
CREATE TABLE memory_claims (
 record_id TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES memory_spaces(id), subject TEXT NOT NULL,
 predicate TEXT NOT NULL, object_json TEXT NOT NULL, object_entity TEXT
);
CREATE INDEX idx_memory_claims_subject ON memory_claims(space_id,subject,predicate,record_id);
CREATE INDEX idx_memory_claims_object ON memory_claims(space_id,object_entity,predicate,record_id);
`,
  },
  // Selective symbolic filters and ID-ordered pagination without space scans.
  {
    version: 101,
    sql: `
CREATE INDEX idx_memory_records_id ON memory_records(space_id,status,id);
CREATE INDEX idx_memory_records_note ON memory_records(current_note_id);
CREATE INDEX idx_memory_records_subject ON memory_records(space_id,status,subject,id);
CREATE INDEX idx_memory_claims_predicate ON memory_claims(space_id,predicate,object_json,record_id);
CREATE INDEX idx_memory_claims_value ON memory_claims(space_id,object_json,predicate,record_id);
`,
  },
  // Rebuildable source text projection; canonical source JSON remains unchanged.
  {
    version: 102,
    sql: `
CREATE TABLE memory_source_text (
 seq INTEGER PRIMARY KEY REFERENCES memory_sources(seq) ON DELETE CASCADE, text TEXT NOT NULL
);
CREATE VIRTUAL TABLE memory_source_fts USING fts5(text,content=memory_source_text,content_rowid=seq);
CREATE TRIGGER memory_source_text_ai AFTER INSERT ON memory_source_text BEGIN
 INSERT INTO memory_source_fts(rowid,text) VALUES(new.seq,new.text);
END;
CREATE TRIGGER memory_source_text_ad AFTER DELETE ON memory_source_text BEGIN
 INSERT INTO memory_source_fts(memory_source_fts,rowid,text) VALUES('delete',old.seq,old.text);
END;
CREATE TRIGGER memory_source_text_au AFTER UPDATE ON memory_source_text BEGIN
 INSERT INTO memory_source_fts(memory_source_fts,rowid,text) VALUES('delete',old.seq,old.text);
 INSERT INTO memory_source_fts(rowid,text) VALUES(new.seq,new.text);
END;
CREATE TRIGGER memory_sources_text_ai AFTER INSERT ON memory_sources BEGIN
 INSERT INTO memory_source_text VALUES(new.seq,CASE WHEN json_type(new.body)='text' THEN json_extract(new.body,'$') ELSE new.body END);
END;
CREATE TRIGGER memory_sources_text_au AFTER UPDATE OF body ON memory_sources BEGIN
 UPDATE memory_source_text SET text=CASE WHEN json_type(new.body)='text' THEN json_extract(new.body,'$') ELSE new.body END WHERE seq=new.seq;
END;
INSERT INTO memory_source_text SELECT seq,CASE WHEN json_type(body)='text' THEN json_extract(body,'$') ELSE body END FROM memory_sources;
CREATE INDEX idx_memory_sources_session ON memory_sources(space_id,session_id,seq);
`,
  },
  {
    version: 103,
    sql: `
ALTER TABLE memory_records ADD COLUMN valid_from INTEGER;
ALTER TABLE memory_records ADD COLUMN valid_until INTEGER;
CREATE TABLE memory_vocabularies (
 space_id TEXT NOT NULL REFERENCES memory_spaces(id), version INTEGER NOT NULL,
 definition TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(space_id,version)
);
`,
  },
  {
    version: 104,
    sql: `
ALTER TABLE memory_spaces ADD COLUMN retrieval_generation INTEGER NOT NULL DEFAULT 0;
UPDATE memory_spaces SET retrieval_generation=generation;
ALTER TABLE memory_records ADD COLUMN stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1));
ALTER TABLE memory_records ADD COLUMN stale_reason TEXT;
CREATE TABLE memory_revision_dependencies (
 record_id TEXT NOT NULL REFERENCES memory_records(id), record_version INTEGER NOT NULL,
 depends_on_id TEXT NOT NULL REFERENCES memory_records(id), depends_on_version INTEGER,
 PRIMARY KEY(record_id,record_version,depends_on_id)
);
CREATE INDEX idx_memory_revision_dependency_target ON memory_revision_dependencies(depends_on_id,record_id,record_version);
INSERT INTO memory_revision_dependencies
 SELECT DISTINCT v.record_id,v.version,j.value,NULL FROM memory_record_versions v,
 json_each(v.attributes,'$.depends_on') j JOIN memory_records r ON r.id=j.value
 WHERE v.attributes IS NOT NULL;
INSERT OR IGNORE INTO memory_revision_dependencies
 SELECT r.id,r.version,d.depends_on_id,NULL FROM memory_records r
 JOIN memory_record_versions v ON v.record_id=r.id AND v.version=r.version
 JOIN memory_dependencies d ON d.record_id=r.id WHERE v.attributes IS NULL;
UPDATE memory_records SET stale=1,stale_reason='{"kind":"unversioned_dependency"}'
 WHERE status='active' AND EXISTS (SELECT 1 FROM memory_revision_dependencies d
 WHERE d.record_id=memory_records.id AND d.record_version=memory_records.version);
`,
  },
  // Logical storage accounting is a rebuildable projection, not a retention policy.
  {
    version: 105,
    sql: `
CREATE INDEX idx_memory_spaces_owner ON memory_spaces(owner_id,status);
CREATE TABLE memory_storage_usage (
 space_id TEXT PRIMARY KEY REFERENCES memory_spaces(id) ON DELETE CASCADE,
 logical_bytes INTEGER NOT NULL DEFAULT 0, sources INTEGER NOT NULL DEFAULT 0,
 revisions INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE memory_storage_items (
 kind TEXT NOT NULL, ref TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
 bytes INTEGER NOT NULL CHECK(bytes>=0), PRIMARY KEY(kind,ref)
);
CREATE INDEX idx_memory_storage_space ON memory_storage_items(space_id);
CREATE TRIGGER memory_storage_items_ai AFTER INSERT ON memory_storage_items BEGIN
 INSERT INTO memory_storage_usage(space_id) VALUES(new.space_id) ON CONFLICT DO NOTHING;
 UPDATE memory_storage_usage SET logical_bytes=logical_bytes+new.bytes,
 sources=sources+(new.kind='source'),revisions=revisions+(new.kind='revision') WHERE space_id=new.space_id;
END;
CREATE TRIGGER memory_storage_items_ad AFTER DELETE ON memory_storage_items BEGIN
 UPDATE memory_storage_usage SET logical_bytes=logical_bytes-old.bytes,
 sources=sources-(old.kind='source'),revisions=revisions-(old.kind='revision') WHERE space_id=old.space_id;
END;
CREATE TRIGGER memory_storage_items_au AFTER UPDATE ON memory_storage_items BEGIN
 UPDATE memory_storage_usage SET logical_bytes=logical_bytes-old.bytes,
 sources=sources-(old.kind='source'),revisions=revisions-(old.kind='revision') WHERE space_id=old.space_id;
 INSERT INTO memory_storage_usage(space_id) VALUES(new.space_id) ON CONFLICT DO NOTHING;
 UPDATE memory_storage_usage SET logical_bytes=logical_bytes+new.bytes,
 sources=sources+(new.kind='source'),revisions=revisions+(new.kind='revision') WHERE space_id=new.space_id;
END;
CREATE TRIGGER memory_storage_space_insert AFTER INSERT ON memory_spaces BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'space' AS kind,t.id AS ref,t.id AS space_id,length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_spaces t WHERE t.id=NEW.id
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_space_update AFTER UPDATE ON memory_spaces BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'space' AS kind,t.id AS ref,t.id AS space_id,length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_spaces t WHERE t.id=NEW.id
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_space_delete AFTER DELETE ON memory_spaces BEGIN
 DELETE FROM memory_storage_items WHERE kind='space' AND ref=old.id;
END;
CREATE TRIGGER memory_storage_source_insert AFTER INSERT ON memory_sources BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'source' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.body AS BLOB))+length(CAST(coalesce(t.session_id,'') AS BLOB))+128 AS bytes FROM memory_sources t WHERE t.id=NEW.id
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_source_update AFTER UPDATE ON memory_sources BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'source' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.body AS BLOB))+length(CAST(coalesce(t.session_id,'') AS BLOB))+128 AS bytes FROM memory_sources t WHERE t.id=NEW.id
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_source_delete AFTER DELETE ON memory_sources BEGIN
 DELETE FROM memory_storage_items WHERE kind='source' AND ref=old.id;
END;
CREATE TRIGGER memory_storage_revision_insert AFTER INSERT ON memory_record_versions BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'revision' AS kind,json_array(t.record_id,t.version) AS ref,r.space_id AS space_id,length(CAST(n.content AS BLOB))+length(CAST(coalesce(t.attributes,'') AS BLOB))+128 AS bytes FROM memory_record_versions t JOIN memory_records r ON r.id=t.record_id JOIN notes n ON n.id=t.note_id WHERE t.record_id=NEW.record_id AND t.version=NEW.version
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_revision_update AFTER UPDATE ON memory_record_versions BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'revision' AS kind,json_array(t.record_id,t.version) AS ref,r.space_id AS space_id,length(CAST(n.content AS BLOB))+length(CAST(coalesce(t.attributes,'') AS BLOB))+128 AS bytes FROM memory_record_versions t JOIN memory_records r ON r.id=t.record_id JOIN notes n ON n.id=t.note_id WHERE t.record_id=NEW.record_id AND t.version=NEW.version
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_revision_delete AFTER DELETE ON memory_record_versions BEGIN
 DELETE FROM memory_storage_items WHERE kind='revision' AND ref=json_array(old.record_id,old.version);
END;
CREATE TRIGGER memory_storage_checkpoint_insert AFTER INSERT ON memory_checkpoints BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'checkpoint' AS kind,json_array(t.space_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_checkpoints t WHERE t.space_id=NEW.space_id AND t.name=NEW.name
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_checkpoint_update AFTER UPDATE ON memory_checkpoints BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'checkpoint' AS kind,json_array(t.space_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_checkpoints t WHERE t.space_id=NEW.space_id AND t.name=NEW.name
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_checkpoint_delete AFTER DELETE ON memory_checkpoints BEGIN
 DELETE FROM memory_storage_items WHERE kind='checkpoint' AND ref=json_array(old.space_id,old.name);
END;
CREATE TRIGGER memory_storage_vocabulary_insert AFTER INSERT ON memory_vocabularies BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'vocabulary' AS kind,json_array(t.space_id,t.version) AS ref,t.space_id AS space_id,length(CAST(t.definition AS BLOB))+128 AS bytes FROM memory_vocabularies t WHERE t.space_id=NEW.space_id AND t.version=NEW.version
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_vocabulary_update AFTER UPDATE ON memory_vocabularies BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'vocabulary' AS kind,json_array(t.space_id,t.version) AS ref,t.space_id AS space_id,length(CAST(t.definition AS BLOB))+128 AS bytes FROM memory_vocabularies t WHERE t.space_id=NEW.space_id AND t.version=NEW.version
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_vocabulary_delete AFTER DELETE ON memory_vocabularies BEGIN
 DELETE FROM memory_storage_items WHERE kind='vocabulary' AND ref=json_array(old.space_id,old.version);
END;
CREATE TRIGGER memory_storage_receipt_insert AFTER INSERT ON memory_requests BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'receipt' AS kind,json_array(t.principal_id,t.space_id,t.request_key) AS ref,s.id AS space_id,length(CAST(t.response AS BLOB))+length(CAST(t.request_key AS BLOB))+192 AS bytes FROM memory_requests t JOIN memory_spaces s ON s.id=CASE WHEN t.space_id='' THEN json_extract(t.response,'$.id') ELSE t.space_id END WHERE t.principal_id=NEW.principal_id AND t.space_id=NEW.space_id AND t.request_key=NEW.request_key
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_receipt_update AFTER UPDATE ON memory_requests BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'receipt' AS kind,json_array(t.principal_id,t.space_id,t.request_key) AS ref,s.id AS space_id,length(CAST(t.response AS BLOB))+length(CAST(t.request_key AS BLOB))+192 AS bytes FROM memory_requests t JOIN memory_spaces s ON s.id=CASE WHEN t.space_id='' THEN json_extract(t.response,'$.id') ELSE t.space_id END WHERE t.principal_id=NEW.principal_id AND t.space_id=NEW.space_id AND t.request_key=NEW.request_key
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_receipt_delete AFTER DELETE ON memory_requests BEGIN
 DELETE FROM memory_storage_items WHERE kind='receipt' AND ref=json_array(old.principal_id,old.space_id,old.request_key);
END;
CREATE TRIGGER memory_storage_event_insert AFTER INSERT ON memory_service_events BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'event' AS kind,CAST(t.seq AS TEXT) AS ref,t.space_id AS space_id,length(CAST(t.operation AS BLOB))+length(CAST(coalesce(t.reference_id,'') AS BLOB))+128 AS bytes FROM memory_service_events t WHERE t.seq=NEW.seq
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_event_update AFTER UPDATE ON memory_service_events BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'event' AS kind,CAST(t.seq AS TEXT) AS ref,t.space_id AS space_id,length(CAST(t.operation AS BLOB))+length(CAST(coalesce(t.reference_id,'') AS BLOB))+128 AS bytes FROM memory_service_events t WHERE t.seq=NEW.seq
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_event_delete AFTER DELETE ON memory_service_events BEGIN
 DELETE FROM memory_storage_items WHERE kind='event' AND ref=CAST(old.seq AS TEXT);
END;
CREATE TRIGGER memory_storage_grant_insert AFTER INSERT ON memory_grants BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'grant' AS kind,json_array(t.space_id,t.principal_id) AS ref,t.space_id AS space_id,128 AS bytes FROM memory_grants t WHERE t.space_id=NEW.space_id AND t.principal_id=NEW.principal_id
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_grant_update AFTER UPDATE ON memory_grants BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'grant' AS kind,json_array(t.space_id,t.principal_id) AS ref,t.space_id AS space_id,128 AS bytes FROM memory_grants t WHERE t.space_id=NEW.space_id AND t.principal_id=NEW.principal_id
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_grant_delete AFTER DELETE ON memory_grants BEGIN
 DELETE FROM memory_storage_items WHERE kind='grant' AND ref=json_array(old.space_id,old.principal_id);
END;
CREATE TRIGGER memory_storage_job_insert AFTER INSERT ON memory_index_jobs BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'job' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.model AS BLOB))+256 AS bytes FROM memory_index_jobs t WHERE t.id=NEW.id
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_job_update AFTER UPDATE ON memory_index_jobs BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'job' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.model AS BLOB))+256 AS bytes FROM memory_index_jobs t WHERE t.id=NEW.id
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_job_delete AFTER DELETE ON memory_index_jobs BEGIN
 DELETE FROM memory_storage_items WHERE kind='job' AND ref=old.id;
END;
CREATE TRIGGER memory_storage_vector_insert AFTER INSERT ON memory_vectors BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'vector' AS kind,json_array(t.note_id,t.model) AS ref,r.space_id AS space_id,length(CAST(t.vector AS BLOB))+length(CAST(t.model AS BLOB))+128 AS bytes FROM memory_vectors t JOIN memory_record_versions v ON v.note_id=t.note_id JOIN memory_records r ON r.id=v.record_id WHERE t.note_id=NEW.note_id AND t.model=NEW.model
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_vector_update AFTER UPDATE ON memory_vectors BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes)
 SELECT 'vector' AS kind,json_array(t.note_id,t.model) AS ref,r.space_id AS space_id,length(CAST(t.vector AS BLOB))+length(CAST(t.model AS BLOB))+128 AS bytes FROM memory_vectors t JOIN memory_record_versions v ON v.note_id=t.note_id JOIN memory_records r ON r.id=v.record_id WHERE t.note_id=NEW.note_id AND t.model=NEW.model
 ON CONFLICT(kind,ref) DO UPDATE SET space_id=excluded.space_id,bytes=excluded.bytes;
END;
CREATE TRIGGER memory_storage_vector_delete AFTER DELETE ON memory_vectors BEGIN
 DELETE FROM memory_storage_items WHERE kind='vector' AND ref=json_array(old.note_id,old.model);
END;
CREATE TRIGGER memory_storage_note_update AFTER UPDATE OF content ON notes BEGIN
 UPDATE memory_storage_items SET bytes=length(CAST(new.content AS BLOB))+128+
 (SELECT length(CAST(coalesce(v.attributes,'') AS BLOB)) FROM memory_record_versions v WHERE v.note_id=new.id)
 WHERE kind='revision' AND ref=(SELECT json_array(v.record_id,v.version) FROM memory_record_versions v WHERE v.note_id=new.id);
END;
CREATE VIEW memory_storage_projection AS
SELECT 'space' AS kind,t.id AS ref,t.id AS space_id,length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_spaces t
UNION ALL
SELECT 'source' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.body AS BLOB))+length(CAST(coalesce(t.session_id,'') AS BLOB))+128 AS bytes FROM memory_sources t
UNION ALL
SELECT 'revision' AS kind,json_array(t.record_id,t.version) AS ref,r.space_id AS space_id,length(CAST(n.content AS BLOB))+length(CAST(coalesce(t.attributes,'') AS BLOB))+128 AS bytes FROM memory_record_versions t JOIN memory_records r ON r.id=t.record_id JOIN notes n ON n.id=t.note_id
UNION ALL
SELECT 'checkpoint' AS kind,json_array(t.space_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_checkpoints t
UNION ALL
SELECT 'vocabulary' AS kind,json_array(t.space_id,t.version) AS ref,t.space_id AS space_id,length(CAST(t.definition AS BLOB))+128 AS bytes FROM memory_vocabularies t
UNION ALL
SELECT 'receipt' AS kind,json_array(t.principal_id,t.space_id,t.request_key) AS ref,s.id AS space_id,length(CAST(t.response AS BLOB))+length(CAST(t.request_key AS BLOB))+192 AS bytes FROM memory_requests t JOIN memory_spaces s ON s.id=CASE WHEN t.space_id='' THEN json_extract(t.response,'$.id') ELSE t.space_id END
UNION ALL
SELECT 'event' AS kind,CAST(t.seq AS TEXT) AS ref,t.space_id AS space_id,length(CAST(t.operation AS BLOB))+length(CAST(coalesce(t.reference_id,'') AS BLOB))+128 AS bytes FROM memory_service_events t
UNION ALL
SELECT 'grant' AS kind,json_array(t.space_id,t.principal_id) AS ref,t.space_id AS space_id,128 AS bytes FROM memory_grants t
UNION ALL
SELECT 'job' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.model AS BLOB))+256 AS bytes FROM memory_index_jobs t
UNION ALL
SELECT 'vector' AS kind,json_array(t.note_id,t.model) AS ref,r.space_id AS space_id,length(CAST(t.vector AS BLOB))+length(CAST(t.model AS BLOB))+128 AS bytes FROM memory_vectors t JOIN memory_record_versions v ON v.note_id=t.note_id JOIN memory_records r ON r.id=v.record_id;
INSERT INTO memory_storage_items SELECT * FROM memory_storage_projection;
`,
  },
  // Acknowledged receipts may be compacted, but their keys are permanently retired.
  {
    version: 106,
    sql: `
ALTER TABLE memory_requests ADD COLUMN acknowledged_at INTEGER;
ALTER TABLE memory_requests ADD COLUMN retired_at INTEGER;
CREATE INDEX idx_memory_requests_retention ON memory_requests(acknowledged_at) WHERE retired_at IS NULL;
CREATE INDEX idx_memory_review_stale ON memory_records(space_id,id) WHERE stale=1 AND status='active';
CREATE TABLE memory_cached_results (
 space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 principal_id TEXT NOT NULL,
 name TEXT NOT NULL,
 version INTEGER NOT NULL,
 data TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(space_id,principal_id,name)
);
CREATE TRIGGER memory_storage_cache_insert AFTER INSERT ON memory_cached_results BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes) VALUES
 ('cache',json_array(new.space_id,new.principal_id,new.name),new.space_id,length(CAST(new.data AS BLOB))+length(CAST(new.name AS BLOB))+192);
END;
CREATE TRIGGER memory_storage_cache_update AFTER UPDATE ON memory_cached_results BEGIN
 UPDATE memory_storage_items SET bytes=length(CAST(new.data AS BLOB))+length(CAST(new.name AS BLOB))+192
 WHERE kind='cache' AND ref=json_array(new.space_id,new.principal_id,new.name);
END;
CREATE TRIGGER memory_storage_cache_delete AFTER DELETE ON memory_cached_results BEGIN
 DELETE FROM memory_storage_items WHERE kind='cache' AND ref=json_array(old.space_id,old.principal_id,old.name);
END;
DROP VIEW memory_storage_projection;
CREATE VIEW memory_storage_projection AS
SELECT 'space' AS kind,t.id AS ref,t.id AS space_id,length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_spaces t
UNION ALL
SELECT 'source' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.body AS BLOB))+length(CAST(coalesce(t.session_id,'') AS BLOB))+128 AS bytes FROM memory_sources t
UNION ALL
SELECT 'revision' AS kind,json_array(t.record_id,t.version) AS ref,r.space_id AS space_id,length(CAST(n.content AS BLOB))+length(CAST(coalesce(t.attributes,'') AS BLOB))+128 AS bytes FROM memory_record_versions t JOIN memory_records r ON r.id=t.record_id JOIN notes n ON n.id=t.note_id
UNION ALL
SELECT 'checkpoint' AS kind,json_array(t.space_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_checkpoints t
UNION ALL
SELECT 'vocabulary' AS kind,json_array(t.space_id,t.version) AS ref,t.space_id AS space_id,length(CAST(t.definition AS BLOB))+128 AS bytes FROM memory_vocabularies t
UNION ALL
SELECT 'receipt' AS kind,json_array(t.principal_id,t.space_id,t.request_key) AS ref,s.id AS space_id,length(CAST(t.response AS BLOB))+length(CAST(t.request_key AS BLOB))+192 AS bytes FROM memory_requests t JOIN memory_spaces s ON s.id=CASE WHEN t.space_id='' THEN json_extract(t.response,'$.id') ELSE t.space_id END
UNION ALL
SELECT 'event' AS kind,CAST(t.seq AS TEXT) AS ref,t.space_id AS space_id,length(CAST(t.operation AS BLOB))+length(CAST(coalesce(t.reference_id,'') AS BLOB))+128 AS bytes FROM memory_service_events t
UNION ALL
SELECT 'grant' AS kind,json_array(t.space_id,t.principal_id) AS ref,t.space_id AS space_id,128 AS bytes FROM memory_grants t
UNION ALL
SELECT 'job' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.model AS BLOB))+256 AS bytes FROM memory_index_jobs t
UNION ALL
SELECT 'vector' AS kind,json_array(t.note_id,t.model) AS ref,r.space_id AS space_id,length(CAST(t.vector AS BLOB))+length(CAST(t.model AS BLOB))+128 AS bytes FROM memory_vectors t JOIN memory_record_versions v ON v.note_id=t.note_id JOIN memory_records r ON r.id=v.record_id
UNION ALL
SELECT 'cache' AS kind,json_array(t.space_id,t.principal_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+192 AS bytes FROM memory_cached_results t;
`,
  },

  // Resumable portable transfers stage operational bytes outside authored memory.
  {
    version: 107,
    sql: `
CREATE TABLE memory_transfers (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 principal_id TEXT NOT NULL,
 header TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('receiving','ready','committed','aborted')),
 position INTEGER NOT NULL,
 chain TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 cursor TEXT,
 expires_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_transfers_owner ON memory_transfers(principal_id,state);
CREATE TABLE memory_transfer_parts (
 transfer_id TEXT NOT NULL REFERENCES memory_transfers(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 position INTEGER NOT NULL,
 kind TEXT NOT NULL,
 item_id TEXT NOT NULL,
 item_version INTEGER NOT NULL,
 byte_offset INTEGER NOT NULL,
 size INTEGER NOT NULL,
 sha256 TEXT NOT NULL,
 data TEXT NOT NULL,
 PRIMARY KEY(transfer_id,position),
 UNIQUE(transfer_id,kind,item_id,item_version,byte_offset)
);
CREATE TRIGGER memory_storage_transfer_insert AFTER INSERT ON memory_transfers BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes) VALUES
 ('transfer',new.id,new.space_id,length(CAST(new.header AS BLOB))+length(CAST(coalesce(new.cursor,'') AS BLOB))+256);
END;
CREATE TRIGGER memory_storage_transfer_update AFTER UPDATE ON memory_transfers BEGIN
 UPDATE memory_storage_items SET bytes=length(CAST(new.header AS BLOB))+length(CAST(coalesce(new.cursor,'') AS BLOB))+256 WHERE kind='transfer' AND ref=new.id;
END;
CREATE TRIGGER memory_storage_transfer_delete AFTER DELETE ON memory_transfers BEGIN
 DELETE FROM memory_storage_items WHERE kind='transfer' AND ref=old.id;
END;
CREATE TRIGGER memory_storage_transfer_part_insert AFTER INSERT ON memory_transfer_parts BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes) VALUES
 ('transfer_part',json_array(new.transfer_id,new.position),new.space_id,length(CAST(new.data AS BLOB))+length(CAST(new.item_id AS BLOB))+256);
END;
CREATE TRIGGER memory_storage_transfer_part_delete AFTER DELETE ON memory_transfer_parts BEGIN
 DELETE FROM memory_storage_items WHERE kind='transfer_part' AND ref=json_array(old.transfer_id,old.position);
END;
CREATE TRIGGER memory_storage_transfer_part_update AFTER UPDATE ON memory_transfer_parts BEGIN
 UPDATE memory_storage_items SET bytes=length(CAST(new.data AS BLOB))+length(CAST(new.item_id AS BLOB))+256
 WHERE kind='transfer_part' AND ref=json_array(new.transfer_id,new.position);
END;
DROP VIEW memory_storage_projection;
CREATE VIEW memory_storage_projection AS
SELECT 'space' AS kind,t.id AS ref,t.id AS space_id,length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_spaces t
UNION ALL
SELECT 'source' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.body AS BLOB))+length(CAST(coalesce(t.session_id,'') AS BLOB))+128 AS bytes FROM memory_sources t
UNION ALL
SELECT 'revision' AS kind,json_array(t.record_id,t.version) AS ref,r.space_id AS space_id,length(CAST(n.content AS BLOB))+length(CAST(coalesce(t.attributes,'') AS BLOB))+128 AS bytes FROM memory_record_versions t JOIN memory_records r ON r.id=t.record_id JOIN notes n ON n.id=t.note_id
UNION ALL
SELECT 'checkpoint' AS kind,json_array(t.space_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_checkpoints t
UNION ALL
SELECT 'vocabulary' AS kind,json_array(t.space_id,t.version) AS ref,t.space_id AS space_id,length(CAST(t.definition AS BLOB))+128 AS bytes FROM memory_vocabularies t
UNION ALL
SELECT 'receipt' AS kind,json_array(t.principal_id,t.space_id,t.request_key) AS ref,s.id AS space_id,length(CAST(t.response AS BLOB))+length(CAST(t.request_key AS BLOB))+192 AS bytes FROM memory_requests t JOIN memory_spaces s ON s.id=CASE WHEN t.space_id='' THEN json_extract(t.response,'$.id') ELSE t.space_id END
UNION ALL
SELECT 'event' AS kind,CAST(t.seq AS TEXT) AS ref,t.space_id AS space_id,length(CAST(t.operation AS BLOB))+length(CAST(coalesce(t.reference_id,'') AS BLOB))+128 AS bytes FROM memory_service_events t
UNION ALL
SELECT 'grant' AS kind,json_array(t.space_id,t.principal_id) AS ref,t.space_id AS space_id,128 AS bytes FROM memory_grants t
UNION ALL
SELECT 'job' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.model AS BLOB))+256 AS bytes FROM memory_index_jobs t
UNION ALL
SELECT 'vector' AS kind,json_array(t.note_id,t.model) AS ref,r.space_id AS space_id,length(CAST(t.vector AS BLOB))+length(CAST(t.model AS BLOB))+128 AS bytes FROM memory_vectors t JOIN memory_record_versions v ON v.note_id=t.note_id JOIN memory_records r ON r.id=v.record_id
UNION ALL
SELECT 'cache' AS kind,json_array(t.space_id,t.principal_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+192 AS bytes FROM memory_cached_results t
UNION ALL
SELECT 'transfer',id,space_id,length(CAST(header AS BLOB))+length(CAST(coalesce(cursor,'') AS BLOB))+256 FROM memory_transfers
UNION ALL
SELECT 'transfer_part',json_array(transfer_id,position),space_id,length(CAST(data AS BLOB))+length(CAST(item_id AS BLOB))+256 FROM memory_transfer_parts;
`,
  },
  {
    version: 108,
    sql: `
CREATE INDEX idx_memory_transfers_space_owner_id ON memory_transfers(space_id,principal_id,id);
CREATE INDEX idx_memory_records_format ON memory_records(space_id,json_extract(metadata,'$.format'),created_at,id) WHERE status='active';
`,
  },
  // Migration 109: key reputation ledgers by the durable world account.
  // entity_standing / entity_competence / witness_attestations were keyed by
  // transient entity ids, which are minted afresh after the reconnect grace
  // evicts an entity — standing, rank progression and gate competence were
  // silently orphaned on every re-login. Move rows onto users.id (stable,
  // keyed by name) wherever a matching account exists. Standing rows carry
  // entity_name; competence/witness rows resolve through the persisted
  // entities table. Duplicate (entity, kind, ref) rows that collide after the
  // move are dropped (they are the same idempotent event credited twice to
  // two dead ids). Cache rows are rebuildable and are cleared for moved ids.
  {
    version: 109,
    sql: `
UPDATE OR IGNORE entity_standing
   SET entity_id = (SELECT u.id FROM users u WHERE u.name = entity_standing.entity_name)
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM users u WHERE u.name = entity_standing.entity_name);
DELETE FROM entity_standing
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM users u WHERE u.name = entity_standing.entity_name);
DELETE FROM entity_standing_cache WHERE entity_id NOT IN (SELECT id FROM users);
UPDATE OR IGNORE entity_competence
   SET entity_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = entity_competence.entity_id)
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = entity_competence.entity_id);
DELETE FROM entity_competence
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = entity_competence.entity_id);
UPDATE witness_attestations
   SET entity_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = witness_attestations.entity_id)
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = witness_attestations.entity_id);
`,
  },
  {
    version: 110,
    sql: `
CREATE TABLE memory_assistance_jobs (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 requester_id TEXT NOT NULL, credential_id TEXT NOT NULL, worker_id TEXT NOT NULL,
 role TEXT NOT NULL, parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
 lease_token TEXT, lease_until INTEGER, deadline INTEGER NOT NULL,
 remaining_operations INTEGER NOT NULL, input_source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
 result_record_id TEXT, evidence TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_assistance_worker ON memory_assistance_jobs(worker_id,state,created_at);
CREATE INDEX idx_memory_assistance_requester ON memory_assistance_jobs(requester_id,created_at);
CREATE INDEX idx_memory_assistance_root ON memory_assistance_jobs(root_id);
CREATE UNIQUE INDEX idx_memory_assistance_source ON memory_assistance_jobs(input_source_id);
CREATE TABLE memory_assistance_actions (
 job_id TEXT NOT NULL REFERENCES memory_assistance_jobs(id) ON DELETE CASCADE,
 principal_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 response TEXT NOT NULL, PRIMARY KEY(job_id,principal_id,request_key)
);
CREATE TRIGGER memory_assistance_forget AFTER INSERT ON memory_service_events
WHEN new.operation IN ('memory.forgotten','forget.completed','space.forgotten') BEGIN
 UPDATE memory_assistance_jobs SET evidence='[]',lease_token=NULL,lease_until=NULL,
 state=CASE WHEN state IN ('pending','running') THEN 'cancelled' ELSE state END,
 version=version+1 WHERE space_id=new.space_id;
END;
`,
  },
  {
    version: 111,
    sql: `
CREATE TRIGGER memory_assistance_storage_insert AFTER INSERT ON memory_assistance_jobs BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes) VALUES ('assistance',new.id,new.space_id,length(CAST(new.evidence AS BLOB))+768);
END;
CREATE TRIGGER memory_assistance_storage_update AFTER UPDATE ON memory_assistance_jobs BEGIN
 UPDATE memory_storage_items SET bytes=length(CAST(new.evidence AS BLOB))+768 WHERE kind='assistance' AND ref=new.id;
END;
CREATE TRIGGER memory_assistance_storage_delete AFTER DELETE ON memory_assistance_jobs BEGIN
 DELETE FROM memory_storage_items WHERE kind='assistance' AND ref=old.id;
END;
CREATE TRIGGER memory_assistance_action_insert AFTER INSERT ON memory_assistance_actions BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes) VALUES
 ('assistance_action',json_array(new.job_id,new.principal_id,new.request_key),(SELECT space_id FROM memory_assistance_jobs WHERE id=new.job_id),length(CAST(new.response AS BLOB))+length(CAST(new.request_key AS BLOB))+256);
END;
CREATE TRIGGER memory_assistance_action_delete AFTER DELETE ON memory_assistance_actions BEGIN
 DELETE FROM memory_storage_items WHERE kind='assistance_action' AND ref=json_array(old.job_id,old.principal_id,old.request_key);
END;
INSERT INTO memory_storage_items SELECT 'assistance',id,space_id,length(CAST(evidence AS BLOB))+768 FROM memory_assistance_jobs;
INSERT INTO memory_storage_items SELECT 'assistance_action',json_array(a.job_id,a.principal_id,a.request_key),j.space_id,length(CAST(a.response AS BLOB))+length(CAST(a.request_key AS BLOB))+256 FROM memory_assistance_actions a JOIN memory_assistance_jobs j ON j.id=a.job_id;
DROP VIEW memory_storage_projection;
CREATE VIEW memory_storage_projection AS
SELECT 'space' AS kind,t.id AS ref,t.id AS space_id,length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_spaces t
UNION ALL
SELECT 'source' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.body AS BLOB))+length(CAST(coalesce(t.session_id,'') AS BLOB))+128 AS bytes FROM memory_sources t
UNION ALL
SELECT 'revision' AS kind,json_array(t.record_id,t.version) AS ref,r.space_id AS space_id,length(CAST(n.content AS BLOB))+length(CAST(coalesce(t.attributes,'') AS BLOB))+128 AS bytes FROM memory_record_versions t JOIN memory_records r ON r.id=t.record_id JOIN notes n ON n.id=t.note_id
UNION ALL
SELECT 'checkpoint' AS kind,json_array(t.space_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_checkpoints t
UNION ALL
SELECT 'vocabulary' AS kind,json_array(t.space_id,t.version) AS ref,t.space_id AS space_id,length(CAST(t.definition AS BLOB))+128 AS bytes FROM memory_vocabularies t
UNION ALL
SELECT 'receipt' AS kind,json_array(t.principal_id,t.space_id,t.request_key) AS ref,s.id AS space_id,length(CAST(t.response AS BLOB))+length(CAST(t.request_key AS BLOB))+192 AS bytes FROM memory_requests t JOIN memory_spaces s ON s.id=CASE WHEN t.space_id='' THEN json_extract(t.response,'$.id') ELSE t.space_id END
UNION ALL
SELECT 'event' AS kind,CAST(t.seq AS TEXT) AS ref,t.space_id AS space_id,length(CAST(t.operation AS BLOB))+length(CAST(coalesce(t.reference_id,'') AS BLOB))+128 AS bytes FROM memory_service_events t
UNION ALL
SELECT 'grant' AS kind,json_array(t.space_id,t.principal_id) AS ref,t.space_id AS space_id,128 AS bytes FROM memory_grants t
UNION ALL
SELECT 'job' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.model AS BLOB))+256 AS bytes FROM memory_index_jobs t
UNION ALL
SELECT 'vector' AS kind,json_array(t.note_id,t.model) AS ref,r.space_id AS space_id,length(CAST(t.vector AS BLOB))+length(CAST(t.model AS BLOB))+128 AS bytes FROM memory_vectors t JOIN memory_record_versions v ON v.note_id=t.note_id JOIN memory_records r ON r.id=v.record_id
UNION ALL
SELECT 'cache' AS kind,json_array(t.space_id,t.principal_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+192 AS bytes FROM memory_cached_results t
UNION ALL
SELECT 'transfer',id,space_id,length(CAST(header AS BLOB))+length(CAST(coalesce(cursor,'') AS BLOB))+256 FROM memory_transfers
UNION ALL
SELECT 'transfer_part',json_array(transfer_id,position),space_id,length(CAST(data AS BLOB))+length(CAST(item_id AS BLOB))+256 FROM memory_transfer_parts
UNION ALL
SELECT 'assistance',id,space_id,length(CAST(evidence AS BLOB))+768 FROM memory_assistance_jobs
UNION ALL
SELECT 'assistance_action',json_array(a.job_id,a.principal_id,a.request_key),j.space_id,length(CAST(a.response AS BLOB))+length(CAST(a.request_key AS BLOB))+256 FROM memory_assistance_actions a JOIN memory_assistance_jobs j ON j.id=a.job_id;
`,
  },
  // Migration 112: rebuild notes_fts with the Porter stemmer so morphological
  // variants (runbook/runbooks, deploy/deployment) match across both silos —
  // legacy notes and durable memory records share this index. External-content
  // table + the same ai/ad/au triggers as migration 11; 'rebuild' re-indexes
  // every existing row under the new tokenizer.
  {
    version: 112,
    sql: `
DROP TRIGGER IF EXISTS notes_ai;
DROP TRIGGER IF EXISTS notes_ad;
DROP TRIGGER IF EXISTS notes_au;
DROP TABLE IF EXISTS notes_fts;

CREATE VIRTUAL TABLE notes_fts USING fts5(content, content=notes, content_rowid=id, tokenize='porter unicode61');

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO notes_fts(rowid, content) VALUES (new.id, new.content);
END;

INSERT INTO notes_fts(notes_fts) VALUES('rebuild');
`,
  },
  // Migration 113: contradiction resolution as typed write-time operators over
  // the review queue. `memory_resolutions` is an append-only audit ledger (who,
  // when, policy, inputs, outputs, rationale); `memory_resolution_members` is
  // the review index (winner / superseded / peer / pending). Losers are never
  // deleted: their validity is closed by an ordinary revision and they are
  // marked superseded here. Forgetting retires only *pending* sets — an applied
  // resolution never resurrects a superseded record.
  {
    version: 113,
    sql: `
CREATE TABLE memory_resolutions (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 record_id TEXT NOT NULL, policy TEXT NOT NULL
  CHECK(policy IN ('last_writer_wins','evidence_weighted','await_confirmation','keep_both')),
 status TEXT NOT NULL CHECK(status IN ('applied','pending','confirmed','superseded','retired')),
 actor_id TEXT NOT NULL, request_key TEXT NOT NULL, rationale TEXT NOT NULL,
 input TEXT NOT NULL, output TEXT NOT NULL, deadline INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_resolutions_space ON memory_resolutions(space_id,status,created_at);
CREATE INDEX idx_memory_resolutions_record ON memory_resolutions(record_id,created_at);
CREATE TABLE memory_resolution_members (
 resolution_id TEXT NOT NULL REFERENCES memory_resolutions(id) ON DELETE CASCADE,
 record_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('winner','superseded','peer','pending')),
 retired_at INTEGER, PRIMARY KEY(resolution_id,record_id)
);
CREATE INDEX idx_memory_resolution_members_record ON memory_resolution_members(record_id,role,retired_at);
CREATE TRIGGER memory_resolutions_forget AFTER INSERT ON memory_service_events
WHEN new.operation IN ('memory.forgotten','space.forgotten') BEGIN
 UPDATE memory_resolutions SET status='retired',updated_at=new.created_at
 WHERE status='pending' AND space_id=new.space_id AND (new.operation='space.forgotten' OR id IN
  (SELECT resolution_id FROM memory_resolution_members WHERE record_id=new.reference_id));
END;
CREATE TRIGGER memory_resolutions_storage_insert AFTER INSERT ON memory_resolutions BEGIN
 INSERT INTO memory_storage_items(kind,ref,space_id,bytes) VALUES ('resolution',new.id,new.space_id,length(CAST(new.input AS BLOB))+length(CAST(new.output AS BLOB))+length(CAST(new.rationale AS BLOB))+256);
END;
CREATE TRIGGER memory_resolutions_storage_update AFTER UPDATE ON memory_resolutions BEGIN
 UPDATE memory_storage_items SET bytes=length(CAST(new.input AS BLOB))+length(CAST(new.output AS BLOB))+length(CAST(new.rationale AS BLOB))+256 WHERE kind='resolution' AND ref=new.id;
END;
CREATE TRIGGER memory_resolutions_storage_delete AFTER DELETE ON memory_resolutions BEGIN
 DELETE FROM memory_storage_items WHERE kind='resolution' AND ref=old.id;
END;
DROP VIEW memory_storage_projection;
CREATE VIEW memory_storage_projection AS
SELECT 'space' AS kind,t.id AS ref,t.id AS space_id,length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_spaces t
UNION ALL
SELECT 'source' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.body AS BLOB))+length(CAST(coalesce(t.session_id,'') AS BLOB))+128 AS bytes FROM memory_sources t
UNION ALL
SELECT 'revision' AS kind,json_array(t.record_id,t.version) AS ref,r.space_id AS space_id,length(CAST(n.content AS BLOB))+length(CAST(coalesce(t.attributes,'') AS BLOB))+128 AS bytes FROM memory_record_versions t JOIN memory_records r ON r.id=t.record_id JOIN notes n ON n.id=t.note_id
UNION ALL
SELECT 'checkpoint' AS kind,json_array(t.space_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+128 AS bytes FROM memory_checkpoints t
UNION ALL
SELECT 'vocabulary' AS kind,json_array(t.space_id,t.version) AS ref,t.space_id AS space_id,length(CAST(t.definition AS BLOB))+128 AS bytes FROM memory_vocabularies t
UNION ALL
SELECT 'receipt' AS kind,json_array(t.principal_id,t.space_id,t.request_key) AS ref,s.id AS space_id,length(CAST(t.response AS BLOB))+length(CAST(t.request_key AS BLOB))+192 AS bytes FROM memory_requests t JOIN memory_spaces s ON s.id=CASE WHEN t.space_id='' THEN json_extract(t.response,'$.id') ELSE t.space_id END
UNION ALL
SELECT 'event' AS kind,CAST(t.seq AS TEXT) AS ref,t.space_id AS space_id,length(CAST(t.operation AS BLOB))+length(CAST(coalesce(t.reference_id,'') AS BLOB))+128 AS bytes FROM memory_service_events t
UNION ALL
SELECT 'grant' AS kind,json_array(t.space_id,t.principal_id) AS ref,t.space_id AS space_id,128 AS bytes FROM memory_grants t
UNION ALL
SELECT 'job' AS kind,t.id AS ref,t.space_id AS space_id,length(CAST(t.model AS BLOB))+256 AS bytes FROM memory_index_jobs t
UNION ALL
SELECT 'vector' AS kind,json_array(t.note_id,t.model) AS ref,r.space_id AS space_id,length(CAST(t.vector AS BLOB))+length(CAST(t.model AS BLOB))+128 AS bytes FROM memory_vectors t JOIN memory_record_versions v ON v.note_id=t.note_id JOIN memory_records r ON r.id=v.record_id
UNION ALL
SELECT 'cache' AS kind,json_array(t.space_id,t.principal_id,t.name) AS ref,t.space_id AS space_id,length(CAST(t.data AS BLOB))+length(CAST(t.name AS BLOB))+192 AS bytes FROM memory_cached_results t
UNION ALL
SELECT 'transfer',id,space_id,length(CAST(header AS BLOB))+length(CAST(coalesce(cursor,'') AS BLOB))+256 FROM memory_transfers
UNION ALL
SELECT 'transfer_part',json_array(transfer_id,position),space_id,length(CAST(data AS BLOB))+length(CAST(item_id AS BLOB))+256 FROM memory_transfer_parts
UNION ALL
SELECT 'assistance',id,space_id,length(CAST(evidence AS BLOB))+768 FROM memory_assistance_jobs
UNION ALL
SELECT 'assistance_action',json_array(a.job_id,a.principal_id,a.request_key),j.space_id,length(CAST(a.response AS BLOB))+length(CAST(a.request_key AS BLOB))+256 FROM memory_assistance_actions a JOIN memory_assistance_jobs j ON j.id=a.job_id
UNION ALL
SELECT 'resolution',id,space_id,length(CAST(input AS BLOB))+length(CAST(output AS BLOB))+length(CAST(rationale AS BLOB))+256 FROM memory_resolutions;
`,
  },
  // Migration 114: institutional memory spaces. `metadata` on memory_spaces
  // carries `{"institutional":true,"read_public":true}` for the durable twins
  // of the guide / tradition pools (owned by the `guide` system principal).
  // `read_public` lets every active credential read the space without a grant;
  // `institutional` turns `adopt` into a standing-gated ratification. Neither
  // flag is settable over HTTP — only the seed / ratification code writes it.
  {
    version: 114,
    sql: `
ALTER TABLE memory_spaces ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
`,
  },
  // Migration 115: continuous-hygiene ratio history. One row per hourly (or
  // on-demand) snapshot of the operator-scope `MemoryHygieneRatios`
  // (`src/memory/hygiene-ratios.ts`), serialized as JSON. `scope` is always
  // `all` today; kept as a column so per-principal series can be added without
  // a schema change. Retained 30 days (pruned on write).
  {
    version: 115,
    sql: `
CREATE TABLE memory_hygiene_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  scope TEXT NOT NULL,
  ratios TEXT NOT NULL
);
CREATE INDEX idx_memory_hygiene_snapshots_scope_at ON memory_hygiene_snapshots(scope, at);
`,
  },
  // Migration 116: indexes for hot paths that previously full-scanned.
  // - `expireDirectMessages` runs EVERY tick with
  //   `WHERE status='delivered' AND deadline_at <= ?`; the partial index keeps
  //   it O(due rows) as the table grows.
  // - `notes.supersedes_id` is probed on every note delete / process-tier
  //   eviction (`UPDATE notes SET supersedes_id = NULL WHERE supersedes_id IN …`).
  // - `note_sources.url` backs twin lookups (`getNotesBySourceUrl`) and the
  //   evidence-weighting exclusions.
  {
    version: 116,
    sql: `
CREATE INDEX IF NOT EXISTS idx_direct_messages_delivered_deadline
  ON direct_messages(deadline_at) WHERE status = 'delivered';
CREATE INDEX IF NOT EXISTS idx_notes_supersedes ON notes(supersedes_id);
CREATE INDEX IF NOT EXISTS idx_note_sources_url ON note_sources(url);
`,
  },
  // Migration 117: durable keys for long-lived membership / ownership rows.
  // Entity ids are transient (re-minted on every name-login once the reconnect
  // grace lapses), so rows keyed by `e_N` silently detach from their owner.
  // Like migration 109 did for the reputation ledgers, rewrite every row whose
  // entity id still resolves (a live `entities` row with a world account) to
  // the durable `users.id`. `MarinaDB` now resolves ids at the delegate
  // boundary for these tables (`durableEntityKey`) and maps them back to the
  // live entity id on read (`LIVE_ENTITY_ID_SQL`), so callers keep passing
  // entity ids. Rows whose entity is already gone cannot be recovered here —
  // they were unreachable before this migration too.
  //
  // Mirror tables (memberships, votes) drop the rows that lost an
  // `OR IGNORE` conflict — the durable row already exists. Sandbox tables
  // (flywheel_bindings, coding_projects, coding_services) are only rewritten,
  // never deleted: a conflict there would mean two live sandboxes for one
  // account and dropping either would orphan guest state.
  {
    version: 117,
    sql: `
UPDATE OR IGNORE group_members
   SET entity_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = group_members.entity_id)
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = group_members.entity_id);
DELETE FROM group_members
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = group_members.entity_id);
UPDATE OR IGNORE channel_members
   SET entity_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = channel_members.entity_id)
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = channel_members.entity_id);
DELETE FROM channel_members
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = channel_members.entity_id);
UPDATE OR IGNORE board_votes
   SET entity_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = board_votes.entity_id)
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = board_votes.entity_id);
DELETE FROM board_votes
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = board_votes.entity_id);
UPDATE OR IGNORE task_votes
   SET entity_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = task_votes.entity_id)
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = task_votes.entity_id);
UPDATE OR IGNORE task_votes
   SET claimant_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = task_votes.claimant_id)
 WHERE claimant_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = task_votes.claimant_id);
UPDATE OR IGNORE flywheel_bindings
   SET entity_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = flywheel_bindings.entity_id)
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = flywheel_bindings.entity_id);
UPDATE OR IGNORE coding_projects
   SET entity_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = coding_projects.entity_id)
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = coding_projects.entity_id);
UPDATE OR IGNORE coding_services
   SET entity_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = coding_services.entity_id)
 WHERE entity_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = coding_services.entity_id);
`,
  },
  // Migration 118: the last two transient keys — `groups_.leader_id` and
  // `tasks.creator_id`. Both are ownership columns (who may edit / cancel /
  // approve), so a re-login after eviction silently lost the leader's and the
  // creator's authority over their own group / task. Rewrite onto users.id
  // where an account exists (same EXISTS guard as 109/117); neither column is
  // unique, so nothing can collide and nothing is deleted. Delegates resolve
  // `durableEntityKey()` on write and project `liveEntityIdSql` on read.
  {
    version: 118,
    sql: `
UPDATE OR IGNORE groups_
   SET leader_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = groups_.leader_id)
 WHERE leader_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = groups_.leader_id);
UPDATE OR IGNORE tasks
   SET creator_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = tasks.creator_id)
 WHERE creator_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = tasks.creator_id);
`,
  },
  // Migration 119: the last two transient author columns — `board_posts.author_id`
  // and `macros.author_id`. Both are authorship keys (`macro update/delete`
  // compare the caller against the author; board posts carry the author for
  // attribution and crew result / paper-order lookups), so a re-login after
  // eviction orphaned a user's macros and detached their posts. Rewrite onto
  // users.id where an account exists (same EXISTS guard as 109/117/118).
  // `macros` has UNIQUE(name, author_id): `UPDATE OR IGNORE` leaves a transient
  // row in place when the account already owns a durable macro of that name —
  // a macro is content, not a mirror row, so nothing is deleted. Delegates
  // resolve `durableEntityKey()` on write (and on `author_id = ?` lookups) and
  // project `liveEntityIdSql` on read. `room_sources` / `room_templates` keep
  // their `author_id`: it is display-only (never compared or looked up).
  {
    version: 119,
    sql: `
UPDATE OR IGNORE board_posts
   SET author_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = board_posts.author_id)
 WHERE author_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = board_posts.author_id);
UPDATE OR IGNORE macros
   SET author_id = (SELECT u.id FROM entities e JOIN users u ON u.name = e.name WHERE e.id = macros.author_id)
 WHERE author_id NOT IN (SELECT id FROM users)
   AND EXISTS (SELECT 1 FROM entities e JOIN users u ON u.name = e.name WHERE e.id = macros.author_id);
`,
  },
  // Migration 120: persist the agent's reasoning depth. `agent spawn …
  // thinking:<level>` and `agent config <name> thinking <level>` used to set
  // `AgentConfig.thinkingLevel` in memory only, so the boot-time respawn
  // (`AgentRuntime.init`) silently dropped it. NULL = never set — resolved at
  // spawn by `resolveAgentThinkingLevel` (crew responders off, else
  // `MARINA_AGENT_THINKING`), so an unset level must NOT be stored as 'off'.
  {
    version: 120,
    sql: `
ALTER TABLE agent_configs ADD COLUMN thinking_level TEXT;
`,
  },
  // Migration 121: index entities.name for faster name-based lookups
  // (restoring from DB, command registry name resolution, seed checks).
  {
    version: 121,
    sql: `
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
`,
  },
  // Migration 122: write-path dedup index. `createNote` checks for an exact
  // (entity, note_type, content) twin on every fact-like write; without this the
  // lookup scans all of an entity's notes (~8 ms at 50k). A 64-char content
  // prefix keeps the index small; the query still compares full content.
  {
    version: 122,
    sql: `
CREATE INDEX IF NOT EXISTS idx_notes_dedup ON notes(entity_name, note_type, substr(content, 1, 64));
`,
  },
  // Migration 123: external participant routing, independent of world connections.
  {
    version: 123,
    sql: `
CREATE TABLE routing_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_key TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  group_id TEXT,
  capabilities TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN ('active', 'left')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner_id, client_key)
);
CREATE INDEX idx_routing_sessions_group ON routing_sessions(group_id, id);
CREATE TABLE routing_events (
  session_id TEXT NOT NULL REFERENCES routing_sessions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, sequence),
  UNIQUE(session_id, event_id)
);
CREATE INDEX idx_routing_events_retention ON routing_events(created_at);
CREATE TABLE routing_messages (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES routing_sessions(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES routing_sessions(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'acknowledged')),
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  UNIQUE(source_id, client_message_id)
);
CREATE INDEX idx_routing_messages_inbox ON routing_messages(target_id, status, created_at, id);
CREATE INDEX idx_routing_messages_retention ON routing_messages(status, acknowledged_at);
`,
  },
  // Migration 124: transport receipts reference canonical Marina channel messages.
  {
    version: 124,
    sql: `
CREATE TABLE routing_channel_receipts (
  session_id TEXT NOT NULL REFERENCES routing_sessions(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, client_message_id)
);
CREATE INDEX idx_routing_channel_receipts_retention ON routing_channel_receipts(created_at);
`,
  },
  // Migration 125: select the latest runtime evidence without scanning output history.
  {
    version: 125,
    sql: `CREATE INDEX idx_routing_events_kind ON routing_events(session_id, kind, sequence);`,
  },
  // Migration 126: one active task attempt per coding session and worker.
  {
    version: 126,
    sql: `
CREATE INDEX idx_coding_run_lookup ON coding_artifacts(session_id, kind, status);
CREATE INDEX idx_coding_run_evidence ON coding_artifacts(json_extract(metadata_json, '$.runId'));
CREATE UNIQUE INDEX idx_coding_run_session_active ON coding_artifacts(session_id)
  WHERE kind = 'task_run' AND status = 'active';
CREATE UNIQUE INDEX idx_coding_run_worker_active ON coding_artifacts(json_extract(metadata_json, '$.workerKey'))
  WHERE kind = 'task_run' AND status = 'active';
`,
  },
  // Migration 127: Social Simulation Arena signed submissions (src/arena, db-arena.ts).
  {
    version: 127,
    sql: `
CREATE TABLE arena_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entrant TEXT NOT NULL,
  round_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  meta TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'accepted', 'rejected', 'error')),
  http_status INTEGER,
  response TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_arena_submissions_round ON arena_submissions(entrant, round_id, id);
`,
  },
  // Migration 128: arena shadow forecasts — candidates scored live before they file (db-arena.ts).
  {
    version: 128,
    sql: `
CREATE TABLE arena_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT NOT NULL,
  forecaster TEXT NOT NULL,
  forecast TEXT NOT NULL,
  detail TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(round_id, forecaster)
);
`,
  },
  // Migration 129: judge observations — a decision backend's opinion of a task
  // submission, kept to measure it against the creator's verdict (db-decisions.ts).
  {
    version: 129,
    sql: `
CREATE TABLE judge_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  claimant_name TEXT NOT NULL,
  evaluator TEXT NOT NULL,
  calibrated INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL CHECK (mode IN ('observe', 'on')),
  opinion TEXT NOT NULL CHECK (opinion IN ('pass', 'fail', 'none')),
  signals TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_judge_observations_claim ON judge_observations(task_id, claimant_name);
CREATE INDEX idx_judge_observations_evaluator ON judge_observations(evaluator, id);
`,
  },
  // Migration 130: autonomy pulse history — the readiness autonomy numbers every
  // 5 minutes, so "are agents acting on their own?" has a trend (db-telemetry.ts).
  {
    version: 130,
    sql: `
CREATE TABLE autonomy_pulse (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  active_agents INTEGER NOT NULL,
  primitive_actions INTEGER NOT NULL,
  communications INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL,
  median_response_ms INTEGER,
  qualified INTEGER NOT NULL
);
CREATE INDEX idx_autonomy_pulse_at ON autonomy_pulse(at);
`,
  },
  // Migration 131: per-world daily spend — every upstream dollar, by source,
  // behind MARINA_DAILY_SPEND_CAP_USD (src/engine/spend-ledger.ts, db-telemetry.ts).
  {
    version: 131,
    sql: `
CREATE TABLE spend_daily (
  day TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model_api', 'agent', 'decision', 'forecast')),
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, source)
);
`,
  },
  // Migration 132: durable work intents for legacy compatibility mutations.
  // This is an outbox, not a third memory store. Note lifecycle intents share
  // the originating SQLite transaction; deletion captures identity before CASCADE.
  {
    version: 132,
    sql: `
CREATE TABLE legacy_memory_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  args TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(operation, args)
);
CREATE TRIGGER legacy_memory_created AFTER INSERT ON notes
WHEN NEW.entity_name NOT LIKE 'memory:%'
 AND EXISTS (SELECT 1 FROM users WHERE name = NEW.entity_name)
BEGIN
  INSERT OR IGNORE INTO legacy_memory_outbox(operation, args)
  VALUES (
    CASE WHEN NEW.supersedes_id IS NOT NULL THEN 'bridgeLegacyRevision'
         WHEN NEW.pool_id IS NOT NULL THEN 'bridgeLegacyPoolNote'
         ELSE 'bridgeLegacyNote' END,
    CASE WHEN NEW.supersedes_id IS NOT NULL THEN json_array(NEW.entity_name, NEW.supersedes_id, NEW.id)
         WHEN NEW.pool_id IS NOT NULL THEN json_array(NEW.entity_name, NEW.id,
           (SELECT name FROM memory_pools WHERE id = NEW.pool_id))
         ELSE json_array(NEW.entity_name, NEW.id) END
  );
END;
CREATE TRIGGER legacy_memory_deleted BEFORE DELETE ON notes
WHEN OLD.entity_name NOT LIKE 'memory:%'
BEGIN
  INSERT OR IGNORE INTO legacy_memory_outbox(operation, args)
  SELECT 'retireDurableTwin', json_array(OLD.entity_name, OLD.id,
    json_object('url', url, 'recordId', substr(url, 24)))
  FROM note_sources WHERE note_id = OLD.id AND url LIKE 'marina-memory://record/%';
END;
`,
  },
  // Migration 133: explicit compatibility projections. This stores identity only;
  // durable revisions own content and update existing numeric notes atomically.
  {
    version: 133,
    sql: `
CREATE TABLE memory_note_projections (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE
);
CREATE INDEX idx_memory_note_projections_record ON memory_note_projections(record_id);
INSERT OR IGNORE INTO memory_note_projections(note_id,record_id)
SELECT n.id,r.id FROM notes n JOIN users u ON u.name=n.entity_name
JOIN note_sources ns ON ns.note_id=n.id
JOIN memory_records r ON r.id=json_extract(ns.metadata,'$.record_id')
JOIN memory_spaces s ON s.id=r.space_id AND s.owner_id=u.id AND s.name='resident'
WHERE n.entity_name NOT LIKE 'memory:%' AND json_valid(ns.metadata)
  AND json_extract(ns.metadata,'$.kind')='durable-twin'
  AND coalesce(json_extract(ns.metadata,'$.mirror'),'')!='institutional'
  AND ns.url='marina-memory://record/' || r.id
  AND (json_extract(r.metadata,'$.legacy_note_id')=n.id OR n.verification_status='superseded');
`,
  },
  // Migration 134: provenance, verification and graph writes commit their
  // compatibility work with the originating write, across all entry points.
  {
    version: 134,
    sql: `
CREATE TRIGGER legacy_memory_source_created AFTER INSERT ON note_sources
WHEN NEW.url NOT LIKE 'marina-memory://%'
BEGIN
  INSERT OR IGNORE INTO legacy_memory_outbox(operation,args)
  SELECT 'bridgeLegacySource',json_array(n.entity_name,n.id,json_object(
    'url',NEW.url,'sourceType',NEW.source_type,'credibility',NEW.credibility,
    'observedAt',NEW.observed_at,'sourceNoteId',NEW.source_note_id))
  FROM notes n JOIN users u ON u.name=n.entity_name
  WHERE n.id=NEW.note_id AND n.entity_name NOT LIKE 'memory:%'
    AND (NEW.captured_by IS NULL OR NEW.captured_by=n.entity_name);
END;
CREATE TRIGGER legacy_memory_source_updated AFTER UPDATE ON note_sources
WHEN NEW.url NOT LIKE 'marina-memory://%'
BEGIN
  INSERT OR IGNORE INTO legacy_memory_outbox(operation,args)
  SELECT 'bridgeLegacySource',json_array(n.entity_name,n.id,json_object(
    'url',NEW.url,'sourceType',NEW.source_type,'credibility',NEW.credibility,
    'observedAt',NEW.observed_at,'sourceNoteId',NEW.source_note_id))
  FROM notes n JOIN users u ON u.name=n.entity_name
  WHERE n.id=NEW.note_id AND n.entity_name NOT LIKE 'memory:%'
    AND (NEW.captured_by IS NULL OR NEW.captured_by=n.entity_name);
END;
CREATE TRIGGER legacy_memory_verified AFTER INSERT ON note_verifications
BEGIN
  INSERT OR IGNORE INTO legacy_memory_outbox(operation,args)
  SELECT 'bridgeLegacyVerification',json_array(n.entity_name,n.id,NEW.status,json_object(
    'key','legacy-note-' || n.id || '-verify-' || NEW.id,
    'confidence',NEW.confidence,'rationale',NEW.rationale))
  FROM notes n JOIN users u ON u.name=n.entity_name
  WHERE n.id=NEW.note_id AND NEW.verifier=n.entity_name AND n.entity_name NOT LIKE 'memory:%';
END;
CREATE TRIGGER legacy_memory_link_created AFTER INSERT ON note_links
BEGIN
  INSERT OR IGNORE INTO legacy_memory_outbox(operation,args)
  SELECT 'bridgeLegacyLink',json_array(n.entity_name,NEW.source_id,NEW.target_id,NEW.relationship)
  FROM notes n JOIN users u ON u.name=n.entity_name
  JOIN notes target ON target.id=NEW.target_id AND target.entity_name NOT LIKE 'memory:%'
  WHERE n.id=NEW.source_id AND n.entity_name NOT LIKE 'memory:%';
END;
CREATE TRIGGER legacy_memory_link_deleted BEFORE DELETE ON note_links
BEGIN
  INSERT OR IGNORE INTO legacy_memory_outbox(operation,args)
  SELECT 'bridgeLegacyUnlink',json_array(n.entity_name,OLD.source_id,OLD.target_id,OLD.relationship)
  FROM notes n JOIN users u ON u.name=n.entity_name
  JOIN notes target ON target.id=OLD.target_id AND target.entity_name NOT LIKE 'memory:%'
  WHERE n.id=OLD.source_id AND n.entity_name NOT LIKE 'memory:%';
END;
`,
  },
  // Migration 135: preexisting adopted reflections and owned non-resident
  // spaces also carry legitimate twins, without legacy_note_id metadata.
  {
    version: 135,
    sql: `
INSERT OR IGNORE INTO memory_note_projections(note_id,record_id)
SELECT n.id,r.id FROM notes n JOIN users u ON u.name=n.entity_name
JOIN note_sources ns ON ns.note_id=n.id
JOIN memory_records r ON r.id=json_extract(CASE WHEN json_valid(ns.metadata) THEN ns.metadata ELSE '{}' END,'$.record_id')
JOIN memory_spaces s ON s.id=r.space_id AND s.owner_id=u.id
JOIN notes canonical ON canonical.id=r.current_note_id AND canonical.content=n.content
WHERE n.entity_name NOT LIKE 'memory:%' AND ns.captured_by=n.entity_name
  AND json_extract(ns.metadata,'$.kind')='durable-twin'
  AND coalesce(json_extract(ns.metadata,'$.mirror'),'')!='institutional'
  AND ns.url='marina-memory://record/' || r.id AND ns.credibility=0
  AND r.status='active' AND s.status='active';
`,
  },
  // Migration 136: retirement follows authoritative identity, never a URL
  // supplied with `note source`. Institutional publications are independent.
  {
    version: 136,
    sql: `
DROP TRIGGER legacy_memory_deleted;
CREATE TRIGGER legacy_memory_deleted BEFORE DELETE ON notes
WHEN OLD.entity_name NOT LIKE 'memory:%'
BEGIN
  INSERT OR IGNORE INTO legacy_memory_outbox(operation,args)
  SELECT 'retireDurableTwin',json_array(OLD.entity_name,OLD.id,
    json_object('recordId',p.record_id))
  FROM memory_note_projections p JOIN memory_records r ON r.id=p.record_id
  WHERE p.note_id=OLD.id AND r.status='active';
END;
`,
  },
  // Migration 137: arena shadow keeps EVERY recording (append-only) instead of
  // one row per (round, forecaster) — the forecast that counts is the last one
  // recorded before lock, as a filing would be; the first could be days stale.
  {
    version: 137,
    sql: `
CREATE TABLE arena_shadow_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT NOT NULL,
  forecaster TEXT NOT NULL,
  forecast TEXT NOT NULL,
  detail TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT INTO arena_shadow_v2 (id, round_id, forecaster, forecast, detail, cost_usd, created_at)
  SELECT id, round_id, forecaster, forecast, detail, cost_usd, created_at FROM arena_shadow;
DROP TABLE arena_shadow;
ALTER TABLE arena_shadow_v2 RENAME TO arena_shadow;
CREATE INDEX idx_arena_shadow_round ON arena_shadow(round_id, forecaster, created_at);
`,
  },
  { version: 138, sql: MEMORY_UNIFICATION_SCHEMA },
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
  // Every existing plaintext row is rewritten in place (hook in schema.ts);
  // already-hashed rows are left alone so the rewrite is safe to replay
  // against a partial copy.
  {
    version: 143,
    // The digest lookup keeps using the migration-28 index on `secret`.
    sql: "CREATE INDEX IF NOT EXISTS idx_mem_api_keys_secret ON mem_api_keys(secret);",
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
  // Which judged lessons each ledger item was served (src/learning/): lesson
  // ids only, never their text, with the item's use (`served` = injected,
  // `observed` = recalled but not shown) and the run's regime (`measure` =
  // same-board lessons excluded, `live`). Append-only like the items it cites.
  {
    version: 160,
    sql: `
CREATE TABLE benchmark_item_lessons (
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  use TEXT NOT NULL CHECK (use IN ('served', 'observed')),
  regime TEXT CHECK (regime IS NULL OR regime IN ('measure', 'live')),
  PRIMARY KEY (run_id, item_id, lesson_id),
  FOREIGN KEY (run_id, item_id) REFERENCES benchmark_items(run_id, item_id)
);
CREATE INDEX idx_benchmark_item_lessons_lesson ON benchmark_item_lessons(lesson_id);
CREATE TRIGGER benchmark_item_lessons_no_update BEFORE UPDATE ON benchmark_item_lessons
BEGIN SELECT RAISE(ABORT, 'benchmark_item_lessons is append-only'); END;
`,
  },
  // Migration 161: imported `marina.learned.v1` bundles (src/learned/). Empty
  // on every install that never imports one. Artifact versions, upstream
  // default seeds, evidence priors and the audit trail are append-only;
  // `learned_items` is the current state of each imported item (its local
  // record, status and local confirmation). Priors are never ledger rows and a
  // seed never writes `benchmark_defaults`: local truth stays local.
  {
    version: 161,
    sql: `
CREATE TABLE learned_artifacts (
  artifact_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  version TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  publisher_key_id TEXT NOT NULL,
  license TEXT NOT NULL,
  access_model TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  actor TEXT,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, generation)
);
CREATE TRIGGER learned_artifacts_no_update BEFORE UPDATE ON learned_artifacts
BEGIN SELECT RAISE(ABORT, 'learned_artifacts is append-only'); END;
CREATE TABLE learned_items (
  artifact_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,
  local_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'revoked')),
  confirmed_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, item_key)
);
CREATE TABLE upstream_default_seeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot TEXT NOT NULL,
  value_json TEXT NOT NULL,
  evidence_json TEXT,
  artifact_id TEXT NOT NULL,
  version TEXT NOT NULL,
  generation INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_upstream_default_seeds_slot ON upstream_default_seeds(slot, id);
CREATE TRIGGER upstream_default_seeds_no_update BEFORE UPDATE ON upstream_default_seeds
BEGIN SELECT RAISE(ABORT, 'upstream_default_seeds is append-only'); END;
CREATE TABLE evidence_priors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id TEXT NOT NULL,
  version TEXT NOT NULL,
  generation INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  family TEXT NOT NULL,
  benchmark TEXT,
  n INTEGER NOT NULL CHECK (n >= 0),
  successes INTEGER NOT NULL CHECK (successes >= 0 AND successes <= n),
  weight REAL NOT NULL CHECK (weight > 0 AND weight <= 1),
  prior_n REAL NOT NULL,
  prior_successes REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_evidence_priors_cell ON evidence_priors(descriptor, family, id);
CREATE TRIGGER evidence_priors_no_update BEFORE UPDATE ON evidence_priors
BEGIN SELECT RAISE(ABORT, 'evidence_priors is append-only'); END;
CREATE TABLE upstream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'refused', 'dropped', 'skipped')),
  artifact_id TEXT,
  version TEXT,
  generation INTEGER,
  item_key TEXT,
  detail_json TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_upstream_events_artifact ON upstream_events(artifact_id, id);
CREATE TRIGGER upstream_events_no_update BEFORE UPDATE ON upstream_events
BEGIN SELECT RAISE(ABORT, 'upstream_events is append-only'); END;
`,
  },
  // Migration 162: one outcome path (src/outcomes/). Every surface files its
  // answer in `forecast_answers` (a board's own id in `external_id`, unique per
  // owner; `eval_mode` measure|live); every resolved result is ONE append-only
  // `outcomes` row per subject, holding numbers and labels only (never the
  // question text, which stays on its subject row). `outcome_deliveries` is
  // each consumer's durable state for it (lessons, history), so a budget or a
  // restart defers learning and never drops it.
  {
    version: 162,
    sql: `
ALTER TABLE forecast_answers ADD COLUMN external_id TEXT;
ALTER TABLE forecast_answers ADD COLUMN source TEXT;
ALTER TABLE forecast_answers ADD COLUMN eval_mode TEXT
  CHECK (eval_mode IS NULL OR eval_mode IN ('live', 'measure'));
CREATE UNIQUE INDEX idx_forecast_answers_external
  ON forecast_answers(entity_name, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('forecast', 'task', 'request', 'benchmark')),
  source TEXT NOT NULL,
  domain TEXT NOT NULL,
  owner TEXT,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  quality REAL CHECK (quality IS NULL OR (quality >= 0 AND quality <= 1)),
  loss REAL,
  metric TEXT,
  truth_json TEXT,
  detail TEXT,
  basis TEXT NOT NULL CHECK (basis IN ('mechanical', 'judged')),
  judge TEXT,
  eval_mode TEXT CHECK (eval_mode IS NULL OR eval_mode IN ('live', 'measure')),
  participants_json TEXT,
  refs_json TEXT,
  resolved_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_outcomes_kind ON outcomes(kind, resolved_at);
CREATE TRIGGER outcomes_no_update BEFORE UPDATE ON outcomes
BEGIN SELECT RAISE(ABORT, 'outcomes is append-only'); END;
CREATE TABLE outcome_deliveries (
  outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
  consumer TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (outcome_id, consumer)
);
CREATE INDEX idx_outcome_deliveries_pending ON outcome_deliveries(consumer, state, outcome_id);
`,
  },
  // Migration 163: scoped, content-free advisory receipts and explicit outcome attribution.
  {
    version: 163,
    sql: `
CREATE TABLE decision_receipts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  subject TEXT NOT NULL,
  family TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_decision_receipts_owner ON decision_receipts(owner, created_at);
CREATE TRIGGER decision_receipts_no_update BEFORE UPDATE ON decision_receipts
BEGIN SELECT RAISE(ABORT, 'decision_receipts is append-only'); END;
CREATE TABLE decision_outcomes (
  decision_id TEXT NOT NULL REFERENCES decision_receipts(id) ON DELETE CASCADE,
  outcome_id INTEGER NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, outcome_id)
);
`,
  },
  // Migration 164: attempted arena refreshes, including failures before signing.
  {
    version: 164,
    sql: `
CREATE TABLE arena_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL,
  entrant TEXT NOT NULL,
  round_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('started', 'finished')),
  status TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(attempt_id, phase)
);
CREATE INDEX idx_arena_attempts_round ON arena_attempts(entrant, round_id, id);
CREATE TRIGGER arena_attempts_no_update BEFORE UPDATE ON arena_attempts
BEGIN SELECT RAISE(ABORT, 'arena_attempts is append-only'); END;
`,
  }, // Migration 165: durable schedules (a command an owner arranged to run later or
  // repeatedly) and their append-only run history.
  {
    version: 165,
    sql: `
CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  catch_up TEXT NOT NULL DEFAULT 'once' CHECK (catch_up IN ('none', 'once')),
  max_runs INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,
  last_run_at INTEGER,
  created_rank INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_key, name)
);
CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);
CREATE TABLE schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  owner_key TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_class TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_schedule_runs_schedule ON schedule_runs(schedule_id, id);
CREATE INDEX idx_schedule_runs_started ON schedule_runs(started_at);
CREATE TRIGGER schedule_runs_no_update BEFORE UPDATE ON schedule_runs
BEGIN SELECT RAISE(ABORT, 'schedule_runs is append-only'); END;
`,
  }, // Migration 166: durable challenge holds — a held action survives a restart
  // and runs on approval. `command` is the requester's own held input, kept
  // only when it carries nothing secret-shaped; `summary` is always masked.
  {
    version: 166,
    sql: `
CREATE TABLE challenge_holds (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('gate', 'rank', 'tool')),
  requester_id TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  creator_name TEXT,
  gate_id TEXT,
  min_rank INTEGER,
  command TEXT,
  tool_name TEXT,
  coding_target TEXT,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'once', 'always', 'deny', 'expired')),
  requester_notice TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX idx_challenge_holds_status ON challenge_holds(status, expires_at);
CREATE INDEX idx_challenge_holds_notice ON challenge_holds(requester_name)
  WHERE requester_notice IS NOT NULL;
`,
  },
  // Migration 167: an operator-set rank below 5 is a floor rank progression
  // never lowers the account below (`rank <name> <level>`); 0 = no floor.
  {
    version: 167,
    sql: `
ALTER TABLE users ADD COLUMN rank_floor INTEGER NOT NULL DEFAULT 0;
`,
  },
  // Migration 168: asset record v2 (src/engine/media/asset-library.ts). Facts
  // (sha256, dimensions, duration, pages), reader text (alt, caption), origin
  // and provenance become columns; derivatives (thumbnails, posters, previews)
  // are assets with `derived_from` set — they inherit the parent's read check
  // and are deleted with it. Tags and lineage are their own tables for facets;
  // `assets_fts` is a standalone FTS5 table (assets have TEXT ids, so an
  // external-content table would hang on an unstable implicit rowid). Existing
  // rows get origin/provenance from their metadata here; hashes, dimensions
  // and derivatives are filled by the bounded `asset-backfill` tick job.
  {
    version: 168,
    sql: `
ALTER TABLE assets ADD COLUMN origin TEXT NOT NULL DEFAULT 'upload'
  CHECK (origin IN ('upload', 'generated', 'request', 'derived', 'tool'));
ALTER TABLE assets ADD COLUMN sha256 TEXT;
ALTER TABLE assets ADD COLUMN width INTEGER;
ALTER TABLE assets ADD COLUMN height INTEGER;
ALTER TABLE assets ADD COLUMN duration_ms INTEGER;
ALTER TABLE assets ADD COLUMN pages INTEGER;
ALTER TABLE assets ADD COLUMN alt TEXT;
ALTER TABLE assets ADD COLUMN caption TEXT;
ALTER TABLE assets ADD COLUMN provenance TEXT NOT NULL DEFAULT '{}';
ALTER TABLE assets ADD COLUMN derived_from TEXT REFERENCES assets(id) ON DELETE CASCADE;
ALTER TABLE assets ADD COLUMN placeholder TEXT;
ALTER TABLE assets ADD COLUMN derivative_state TEXT;
ALTER TABLE assets ADD COLUMN derivative_note TEXT;
ALTER TABLE assets ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

UPDATE assets SET
  origin = CASE
    WHEN json_valid(metadata) AND json_extract(metadata, '$.origin') IN ('generated', 'request', 'tool')
      THEN json_extract(metadata, '$.origin')
    ELSE 'upload' END,
  updated_at = created_at;
UPDATE assets SET provenance = json_patch('{}', json_object(
    'prompt', json_extract(metadata, '$.prompt'),
    'model', json_extract(metadata, '$.model'),
    'provider', json_extract(metadata, '$.provider')))
  WHERE origin = 'generated' AND json_valid(metadata);

CREATE INDEX idx_assets_owner_hash ON assets(entity_name, sha256);
CREATE INDEX idx_assets_origin ON assets(origin, created_at);
CREATE INDEX idx_assets_derived_from ON assets(derived_from) WHERE derived_from IS NOT NULL;
CREATE INDEX idx_assets_unprobed ON assets(created_at) WHERE sha256 IS NULL;

CREATE TABLE asset_tags (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (asset_id, tag)
) WITHOUT ROWID;
CREATE INDEX idx_asset_tags_tag ON asset_tags(tag, asset_id);

CREATE TABLE asset_links (
  from_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
) WITHOUT ROWID;
CREATE INDEX idx_asset_links_to ON asset_links(to_id, kind);

CREATE VIRTUAL TABLE assets_fts USING fts5(asset_id UNINDEXED, filename, caption, alt, prompt, tags);
INSERT INTO assets_fts(asset_id, filename, caption, alt, prompt, tags)
  SELECT id, filename, '', '', coalesce(json_extract(provenance, '$.prompt'), ''), ''
    FROM assets WHERE derived_from IS NULL;

CREATE TRIGGER assets_fts_ai AFTER INSERT ON assets WHEN new.derived_from IS NULL BEGIN
  INSERT INTO assets_fts(asset_id, filename, caption, alt, prompt, tags)
  VALUES (new.id, new.filename, coalesce(new.caption, ''), coalesce(new.alt, ''),
          coalesce(json_extract(new.provenance, '$.prompt'), ''), '');
END;
CREATE TRIGGER assets_fts_ad AFTER DELETE ON assets BEGIN
  DELETE FROM assets_fts WHERE asset_id = old.id;
END;
CREATE TRIGGER assets_fts_au AFTER UPDATE OF filename, caption, alt, provenance ON assets
  WHEN new.derived_from IS NULL BEGIN
  DELETE FROM assets_fts WHERE asset_id = old.id;
  INSERT INTO assets_fts(asset_id, filename, caption, alt, prompt, tags)
  VALUES (new.id, new.filename, coalesce(new.caption, ''), coalesce(new.alt, ''),
          coalesce(json_extract(new.provenance, '$.prompt'), ''),
          coalesce((SELECT group_concat(tag, ' ') FROM asset_tags WHERE asset_id = new.id), ''));
END;
CREATE TRIGGER asset_tags_fts_ai AFTER INSERT ON asset_tags BEGIN
  UPDATE assets_fts
     SET tags = coalesce((SELECT group_concat(tag, ' ') FROM asset_tags WHERE asset_id = new.asset_id), '')
   WHERE asset_id = new.asset_id;
END;
CREATE TRIGGER asset_tags_fts_ad AFTER DELETE ON asset_tags BEGIN
  UPDATE assets_fts
     SET tags = coalesce((SELECT group_concat(tag, ' ') FROM asset_tags WHERE asset_id = old.asset_id), '')
   WHERE asset_id = old.asset_id;
END;
`,
  },
  // Migration 169 — memory over media (src/engine/media/asset-memory.ts).
  // `idx_assets_updated` serves the indexer's incremental `(updated_at, id)`
  // walk from its durable watermark, so a pass reads only changed assets.
  // `assets_memory_deleted` queues every deleted original (any delete path:
  // `asset delete`, retention, the canvas API) as a `deleted:<id>` entry in the
  // indexer's `core_memory` state (owner `media:memory`, value = the asset's
  // owner), so its memory records are retired without scanning memory.
  {
    version: 169,
    sql: `
CREATE INDEX idx_assets_updated ON assets(updated_at, id);
CREATE TRIGGER assets_memory_deleted AFTER DELETE ON assets
  WHEN old.derived_from IS NULL AND old.origin != 'request' BEGIN
  INSERT INTO core_memory (entity_name, key, value, version, created_at, updated_at)
  VALUES ('media:memory', 'deleted:' || old.id, old.entity_name, 1,
          CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ON CONFLICT(entity_name, key) DO UPDATE SET value = excluded.value;
END;
`,
  },
  // Migration 170 — durable private prediction and research investigations.
  {
    version: 170,
    sql: `
CREATE TABLE investigation_instance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  uuid TEXT NOT NULL
);
INSERT INTO investigation_instance VALUES (1, lower(hex(randomblob(16))));
CREATE TABLE investigations (
  id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  parent_case_id TEXT REFERENCES investigations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('prediction', 'research')),
  question TEXT NOT NULL,
  selected_attempt_id TEXT NOT NULL,
  current_attempt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_investigations_owner ON investigations(owner_key, updated_at DESC);
CREATE TABLE investigation_attempts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  actor_key TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  parent_attempt_id TEXT,
  root_attempt_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled','interrupted')),
  generation TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  accounting_json TEXT NOT NULL DEFAULT '{"knownUsd":0,"complete":false,"outstanding":0}',
  answer_id INTEGER REFERENCES forecast_answers(id),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_investigation_attempts_case ON investigation_attempts(case_id, created_at);
CREATE INDEX idx_investigation_attempts_root ON investigation_attempts(root_attempt_id, state);
CREATE TABLE investigation_admissions (
  actor_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  attempt_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(actor_key, idempotency_key)
);
CREATE TABLE investigation_grants (
  case_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  principal TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read','work')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(case_id, principal)
);
CREATE INDEX idx_investigation_grants_principal ON investigation_grants(principal);
CREATE TABLE investigation_content (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES investigation_attempts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  value_json TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_investigation_content_attempt ON investigation_content(attempt_id);
CREATE TABLE investigation_events (
  attempt_id TEXT NOT NULL REFERENCES investigation_attempts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(attempt_id, sequence)
);
`,
  },
  // Migration 171 — the causal message envelope (`src/engine/message-envelope.ts`):
  // `cause` is the ref of the message a direct or channel message answers,
  // `depth` its causal depth (cause depth + 1, else 0). Refs and numbers only.
  {
    version: 171,
    sql: `
ALTER TABLE direct_messages ADD COLUMN cause TEXT;
ALTER TABLE direct_messages ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channel_messages ADD COLUMN cause TEXT;
ALTER TABLE channel_messages ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
`,
  },
  // Migration 172 — known-at times on the rows the as-of fence dates
  // (src/memory/as-of.ts). The `memory.created` / `memory.revised`,
  // `source.captured` and `assistance.completed` service events were the ONLY
  // record of when a version, source or proposal became known, and the event
  // log is pruned at 30 days. Additive and idempotent (columns added only when
  // missing, `IF NOT EXISTS` everywhere): `known_at` on versions and sources,
  // `completed_known_at` on assistance jobs, each kept by an AFTER INSERT
  // trigger on the event itself (same transaction, any write path), plus a
  // one-row backfill cursor. Existing rows are filled from the surviving
  // events by the bounded `memory-known-at-backfill` tick job, in short
  // seq-range batches — never at boot, never one long transaction. Until the
  // cursor passes an event, retention keeps it (`KNOWN_AT_RETENTION_WHERE`).
  {
    version: 172,
    sql: `
CREATE TABLE IF NOT EXISTS memory_known_at_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor INTEGER NOT NULL,
  upto INTEGER NOT NULL
);
`,
  },
  // Migration 173 — supervised residents. `runtime` says who runs an agent
  // account: `internal` (the in-process agent runtime, every existing row) or
  // `supervised` (a native agent launched by a person's local routing
  // supervisor, never respawned by the server). `vendor` is the native
  // adapter id (`claude`, `codex`, `pi`), display only; NULL for internal rows.
  // `run_session` is the routing session of the resident's current supervised
  // run (renewal and `agent stop` address it); NULL when no run holds it.
  {
    version: 173,
    sql: `
ALTER TABLE agent_configs ADD COLUMN runtime TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE agent_configs ADD COLUMN vendor TEXT;
ALTER TABLE agent_configs ADD COLUMN run_session TEXT;
`,
  },
  // Migration 174 — the attention bridge (src/routing/attention-bridge.ts).
  // `attention_wakes` audits what a supervised resident's supervisor decided
  // for each world perception: refs, sources and reasons only, never message
  // content. Append-only; pruned after 30 days (src/engine/retention.ts).
  // `entity` is the resident's account name. `agent_configs.attention_relay`
  // is the final-reply relay (`agent attention-mode <name> relay:all|explicit`):
  // NULL or `all` relays a woken turn's final reply to whoever woke it,
  // `explicit` sends only what the agent sends itself.
  {
    version: 174,
    sql: `
CREATE TABLE IF NOT EXISTS attention_wakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  perception_ref TEXT,
  source TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  hop INTEGER NOT NULL DEFAULT 0,
  steered INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attention_wakes_entity_at ON attention_wakes(entity, at);
CREATE INDEX IF NOT EXISTS idx_attention_wakes_at ON attention_wakes(at);
ALTER TABLE agent_configs ADD COLUMN attention_relay TEXT;
`,
  },
  // `room_log` is each room's bounded recent history for `look log`: `say`,
  // `emote`, arrivals and departures as those present saw them, with the
  // message envelope's `cause`/`depth`. At most 200 rows per room (pruned on
  // write, src/persistence/db-rooms.ts) and 7 days (src/engine/retention.ts).
  {
    version: 175,
    sql: `
CREATE TABLE IF NOT EXISTS room_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  entity TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  cause TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_log_room_id ON room_log(room, id);
CREATE INDEX IF NOT EXISTS idx_room_log_at ON room_log(at);
`,
  },
  // `room_access` holds the rooms an owner made private (`build access <room>
  // private`): owner and invite list by account name. A room with no row, or
  // mode `public`, is open to everyone — the default for every room.
  {
    version: 176,
    sql: `
CREATE TABLE IF NOT EXISTS room_access (
  room TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('public', 'private')),
  invites TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
`,
  },
  // Write-path dedup looks a note up by its exact text. Canonical text lives
  // in the record's version rows (numeric handles have empty bodies), so the
  // entity-keyed idx_notes_dedup cannot find it; this text-prefix index lets
  // `createNote` find the few rows with that text instead of reading the
  // entity's whole history on every write (src/persistence/db-notes.ts).
  {
    version: 177,
    sql: `CREATE INDEX IF NOT EXISTS idx_notes_content_prefix ON notes(substr(content, 1, 64));`,
  },
  // The investigation capture quota sums `bytes` over an owner's stored
  // content. `bytes` sits after the (up to 2 MiB) `value_json` in each row, so
  // without a covering index every write walked every earlier payload's
  // overflow pages; this index answers the sum without touching them
  // (src/persistence/db-investigation-journal.ts).
  {
    version: 178,
    sql: `CREATE INDEX IF NOT EXISTS idx_investigation_content_attempt_bytes ON investigation_content(attempt_id, bytes);`,
  },
  // One judge ledger (src/decisions/judges.ts): every judge opinion — the
  // challenge judge, the submission verifier, the attention judges, the
  // outcome judges, the Arbiter's overrules — with its later ground truth, per
  // (surface, judge, subject), so one earned rule reads one store. The rows
  // already kept by challenge_outcomes, judge_observations and judged outcomes
  // are copied in (INSERT OR IGNORE: idempotent; the source tables are not
  // touched). Truths settle when the mechanical result arrives.
  {
    version: 179,
    sql: `
CREATE TABLE IF NOT EXISTS judge_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surface TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  judge TEXT NOT NULL,
  subject TEXT NOT NULL,
  truth_key TEXT,
  opinion TEXT NOT NULL CHECK (opinion IN ('pass', 'fail', 'none')),
  opinion_value TEXT,
  calibrated INTEGER,
  truth TEXT CHECK (truth IN ('pass', 'fail')),
  agreed INTEGER,
  opined_at INTEGER NOT NULL,
  truth_at INTEGER,
  origin TEXT NOT NULL DEFAULT 'live',
  UNIQUE (surface, judge, subject)
);
CREATE INDEX IF NOT EXISTS idx_judge_ledger_pending ON judge_ledger(truth_key) WHERE truth IS NULL;
CREATE INDEX IF NOT EXISTS idx_judge_ledger_surface ON judge_ledger(surface, judge, question);
${JUDGE_LEDGER_BACKFILL_179}`,
  },
];
