// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina's durable schema: the base DDL and the append-only migration chain.
 *
 * Extracted from database.ts (where it was ~30% of an 8.5k-line file) as pure
 * data — no behavior lives here. RULES (unchanged): append new migrations to
 * the END of the array with the next version number; NEVER modify an existing
 * migration entry; migrations run in order inside one transaction each.
 */

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
  // interpretation is layered. See docs/chronicle.md for the full design.
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
];
