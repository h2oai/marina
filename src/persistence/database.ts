import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import type { Session } from "../auth/session-manager";
import type { NoteTier } from "../engine/constants";
import type { EngineEvent, Entity, EntityId, RoomId } from "../types";
import type { TraitCapabilities } from "./db-agents";
import * as agentsDb from "./db-agents";
import * as channelsDb from "./db-channels";
import * as chronicleDb from "./db-chronicle";
import * as competenceDb from "./db-competence";
import * as crewsDb from "./db-crews";
import * as entitiesDb from "./db-entities";
import * as feedDb from "./db-feed";
import * as notesDb from "./db-notes";
import * as standingDb from "./db-standing";
import * as tasksDb from "./db-tasks";

export type {
  AdapterRow,
  AgentConfigRow,
  ApiKeyRow,
  RoleRow,
  TraitCapabilities,
  TraitRow,
} from "./db-agents";
export type {
  BoardPostRow,
  BoardRow,
  BoardVoteRow,
  ChannelMemberRow,
  ChannelMessageRow,
  ChannelRow,
  GlobalSearchResult,
  GroupMemberRow,
  GroupRow,
} from "./db-channels";
export type { CompetenceRow } from "./db-competence";
export type { CrewMemberRow, CrewRow } from "./db-crews";
export type { StandingCacheRow, StandingLedgerRow } from "./db-standing";
export type { TaskClaimRow, TaskRow } from "./db-tasks";

import type { AdapterRow, AgentConfigRow, ApiKeyRow, RoleRow, TraitRow } from "./db-agents";
import type {
  BoardPostRow,
  BoardRow,
  BoardVoteRow,
  ChannelMemberRow,
  ChannelMessageRow,
  ChannelRow,
  GlobalSearchResult,
  GroupMemberRow,
  GroupRow,
} from "./db-channels";
import type { ProjectRow, TaskClaimRow, TaskRow } from "./db-tasks";

export type {
  ChronicleEntry,
  ChronicleKind,
  ChronicleQuery,
  InsertChronicle,
} from "./db-chronicle";
export type { FeedEventRow, FeedQuery, InsertFeedEvent } from "./db-feed";
export type {
  CoreMemoryHistoryRow,
  CoreMemoryRow,
  MemApiKeyRow,
  MemoryPoolRow,
  NoteLinkRow,
  NoteRow,
  ScoredNoteRow,
} from "./db-notes";

import type {
  CoreMemoryHistoryRow,
  CoreMemoryRow,
  MemApiKeyRow,
  MemoryPoolRow,
  NoteLinkRow,
  NoteRow,
  ScoredNoteRow,
} from "./db-notes";

// ─── Base Schema (migration 0 — applied via CREATE IF NOT EXISTS) ────────────

const BASE_SCHEMA = `
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

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
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
];

// ─── Database Class ──────────────────────────────────────────────────────────

export class MarinaDB {
  private db: Database;
  private reader: Database;

  constructor(path = "marina.db") {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000"); // Wait up to 5s for locks instead of failing immediately
    this.db.exec("PRAGMA cache_size=-64000"); // 64MB page cache (negative = KB)
    this.db.exec("PRAGMA mmap_size=268435456"); // 256MB memory-mapped I/O for reads
    this.db.exec("PRAGMA temp_store=MEMORY"); // Keep temp tables in memory
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // Flush WAL so read-only connection can open

    this.db.exec(BASE_SCHEMA);
    this.runMigrations();

    // Checkpoint so the readonly reader can see all schema/migration changes
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    this.reader = new Database(path, { readonly: true });
    this.reader.exec("PRAGMA mmap_size=268435456");
    this.reader.exec("PRAGMA cache_size=-64000");
  }

  private runMigrations(): void {
    const currentVersion = this.getSchemaVersion();
    const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
    if (pending.length === 0) return;

    for (const migration of pending) {
      try {
        this.db.transaction(() => {
          this.db.exec(migration.sql);
          this.db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (?)", [
            migration.version,
          ]);
        })();
      } catch (err) {
        // Do not silently advance past a failed migration. Bun SQLite
        // auto-rolls-back the transaction, so the DB is still at the
        // previous version — halt startup with a clear error so the
        // operator can fix the migration or restore from backup before
        // running again. Continuing would leave later migrations running
        // against partially-migrated schema.
        const version = migration.version;
        const schemaNow = this.getSchemaVersion();
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Migration ${version} failed — halting startup.\n  Current schema version: ${schemaNow}\n  Failed migration: ${version}\n  Error: ${msg}\n  Fix the migration or restore the DB from backup, then restart.`,
        );
      }
    }
  }

  private getSchemaVersion(): number {
    const row = this.db.query("SELECT MAX(version) as version FROM schema_version").get() as {
      version: number | null;
    } | null;
    return row?.version ?? 0;
  }

  // ─── Entity Persistence (delegated to db-entities.ts) ────────────────────

  saveEntity(entity: Entity): void {
    entitiesDb.saveEntity(this.db, entity);
  }

  loadEntity(id: EntityId): Entity | undefined {
    return entitiesDb.loadEntity(this.reader, id);
  }

  loadAllEntities(): Entity[] {
    return entitiesDb.loadAllEntities(this.reader);
  }

  deleteEntity(id: EntityId): void {
    entitiesDb.deleteEntity(this.db, id);
  }

  loadEntitiesInRoom(room: RoomId): Entity[] {
    return entitiesDb.loadEntitiesInRoom(this.db, room);
  }

  // ─── Room Key-Value Store (delegated to db-entities.ts) ────────────────

  getRoomStoreValue(roomId: RoomId, key: string): unknown | undefined {
    return entitiesDb.getRoomStoreValue(this.reader, roomId, key);
  }

  setRoomStoreValue(roomId: RoomId, key: string, value: unknown): void {
    entitiesDb.setRoomStoreValue(this.db, roomId, key, value);
  }

  deleteRoomStoreValue(roomId: RoomId, key: string): void {
    entitiesDb.deleteRoomStoreValue(this.db, roomId, key);
  }

  getRoomStoreKeys(roomId: RoomId): string[] {
    return entitiesDb.getRoomStoreKeys(this.reader, roomId);
  }

  // ─── Event Log (delegated to db-entities.ts) ──────────────────────────

  logEvent(event: EngineEvent): void {
    entitiesDb.logEvent(this.db, event);
  }

  getRecentEvents(limit = 100): EngineEvent[] {
    return entitiesDb.getRecentEvents(this.db, limit);
  }

  getEventCount(): number {
    return entitiesDb.getEventCount(this.db);
  }

  pruneEvents(keepLast: number): void {
    entitiesDb.pruneEvents(this.db, keepLast);
  }

  // ─── Session Persistence (delegated to db-entities.ts) ─────────────────

  saveSession(session: Session): void {
    entitiesDb.saveSession(this.db, session);
  }

  loadSession(token: string): Session | undefined {
    return entitiesDb.loadSession(this.db, token);
  }

  deleteSession(token: string): void {
    entitiesDb.deleteSession(this.db, token);
  }

  deleteSessionsByEntity(entityId: EntityId): void {
    entitiesDb.deleteSessionsByEntity(this.db, entityId);
  }

  deleteExpiredSessions(now: number): number {
    return entitiesDb.deleteExpiredSessions(this.db, now);
  }

  loadSessionByEntity(entityId: EntityId): Session | undefined {
    return entitiesDb.loadSessionByEntity(this.db, entityId);
  }

  // ─── Bulk Operations (delegated to db-entities.ts) ─────────────────────

  saveAllEntities(entities: Entity[]): void {
    entitiesDb.saveAllEntities(this.db, entities);
  }

  // ─── Channel Persistence (delegated to db-channels.ts) ──────────────────

  createChannel(c: {
    id: string;
    type: string;
    name: string;
    ownerId?: string;
    persistence?: string;
    retentionHours?: number;
  }): void {
    channelsDb.createChannel(this.db, c);
  }
  getChannel(id: string): ChannelRow | undefined {
    return channelsDb.getChannel(this.db, id);
  }
  getChannelByName(name: string): ChannelRow | undefined {
    return channelsDb.getChannelByName(this.db, name);
  }
  getAllChannels(): ChannelRow[] {
    return channelsDb.getAllChannels(this.db);
  }
  deleteChannel(id: string): void {
    channelsDb.deleteChannel(this.db, id);
  }
  addChannelMember(channelId: string, entityId: string, canRead = true, canWrite = true): void {
    channelsDb.addChannelMember(this.db, channelId, entityId, canRead, canWrite);
  }
  removeChannelMember(channelId: string, entityId: string): void {
    channelsDb.removeChannelMember(this.db, channelId, entityId);
  }
  getChannelMembers(channelId: string): ChannelMemberRow[] {
    return channelsDb.getChannelMembers(this.db, channelId);
  }
  getEntityChannels(entityId: string): ChannelRow[] {
    return channelsDb.getEntityChannels(this.db, entityId);
  }
  isChannelMember(channelId: string, entityId: string): boolean {
    return channelsDb.isChannelMember(this.db, channelId, entityId);
  }
  addChannelMessage(
    channelId: string,
    senderId: string,
    senderName: string,
    content: string,
  ): number {
    return channelsDb.addChannelMessage(this.db, channelId, senderId, senderName, content);
  }
  getChannelHistory(channelId: string, limit = 20): ChannelMessageRow[] {
    return channelsDb.getChannelHistory(this.db, channelId, limit);
  }
  countChannelMessages(channelId: string): number {
    return channelsDb.countChannelMessages(this.db, channelId);
  }
  pruneExpiredMessages(now: number): number {
    return channelsDb.pruneExpiredMessages(this.db, now);
  }

  // ─── Board Persistence (delegated to db-channels.ts) ───────────────────

  createBoard(b: {
    id: string;
    name: string;
    scopeType?: string;
    scopeId?: string;
    readRank?: number;
    writeRank?: number;
    pinRank?: number;
  }): void {
    channelsDb.createBoard(this.db, b);
  }
  getBoard(id: string): BoardRow | undefined {
    return channelsDb.getBoard(this.db, id);
  }
  getBoardByName(name: string): BoardRow | undefined {
    return channelsDb.getBoardByName(this.db, name);
  }
  getBoardsForScope(scopeType: string, scopeId: string): BoardRow[] {
    return channelsDb.getBoardsForScope(this.db, scopeType, scopeId);
  }
  getAllBoards(): BoardRow[] {
    return channelsDb.getAllBoards(this.db);
  }
  deleteBoard(id: string): void {
    channelsDb.deleteBoard(this.db, id);
  }
  createBoardPost(post: {
    boardId: string;
    parentId?: number;
    authorId: string;
    authorName: string;
    title?: string;
    body: string;
    tags?: string[];
  }): number {
    return channelsDb.createBoardPost(this.db, post);
  }
  getBoardPost(id: number): BoardPostRow | undefined {
    return channelsDb.getBoardPost(this.db, id);
  }
  listBoardPosts(
    boardId: string,
    opts?: { offset?: number; limit?: number; archived?: boolean },
  ): BoardPostRow[] {
    return channelsDb.listBoardPosts(this.db, boardId, opts);
  }
  searchBoardPosts(boardId: string, query: string): BoardPostRow[] {
    return channelsDb.searchBoardPosts(this.db, boardId, query);
  }
  rebuildBoardSearchIndex(): void {
    channelsDb.rebuildBoardSearchIndex(this.db);
  }
  pinBoardPost(postId: number): void {
    channelsDb.pinBoardPost(this.db, postId);
  }
  unpinBoardPost(postId: number): void {
    channelsDb.unpinBoardPost(this.db, postId);
  }
  archiveBoardPost(postId: number): void {
    channelsDb.archiveBoardPost(this.db, postId);
  }
  voteBoardPost(postId: number, entityId: string, value: number, score = 0): void {
    channelsDb.voteBoardPost(this.db, postId, entityId, value, score);
  }
  getBoardPostVoteCount(postId: number): number {
    return channelsDb.getBoardPostVoteCount(this.db, postId);
  }
  autoArchiveBoardPosts(daysOld: number, minVotes: number): number {
    return channelsDb.autoArchiveBoardPosts(this.db, daysOld, minVotes);
  }
  getBoardPostScores(postId: number): BoardVoteRow[] {
    return channelsDb.getBoardPostScores(this.db, postId);
  }
  getScoreMatrix(boardId: string): BoardVoteRow[] {
    return channelsDb.getScoreMatrix(this.db, boardId);
  }

  // ─── Group Persistence (delegated to db-channels.ts) ───────────────────

  createGroup(g: {
    id: string;
    name: string;
    description?: string;
    leaderId: string;
    channelId?: string;
    boardId?: string;
  }): void {
    channelsDb.createGroup(this.db, g);
  }
  getGroup(id: string): GroupRow | undefined {
    return channelsDb.getGroup(this.db, id);
  }
  getGroupByName(name: string): GroupRow | undefined {
    return channelsDb.getGroupByName(this.db, name);
  }
  getAllGroups(): GroupRow[] {
    return channelsDb.getAllGroups(this.db);
  }
  deleteGroup(id: string): void {
    channelsDb.deleteGroup(this.db, id);
  }
  updateGroupChannelAndBoard(groupId: string, channelId: string, boardId: string): void {
    channelsDb.updateGroupChannelAndBoard(this.db, groupId, channelId, boardId);
  }
  addGroupMember(groupId: string, entityId: string, rank = 0): void {
    channelsDb.addGroupMember(this.db, groupId, entityId, rank);
  }
  removeGroupMember(groupId: string, entityId: string): void {
    channelsDb.removeGroupMember(this.db, groupId, entityId);
  }
  getGroupMembers(groupId: string): GroupMemberRow[] {
    return channelsDb.getGroupMembers(this.db, groupId);
  }
  getGroupMember(groupId: string, entityId: string): GroupMemberRow | undefined {
    return channelsDb.getGroupMember(this.db, groupId, entityId);
  }
  getEntityGroups(entityId: string): GroupRow[] {
    return channelsDb.getEntityGroups(this.db, entityId);
  }
  updateGroupMemberRank(groupId: string, entityId: string, rank: number): void {
    channelsDb.updateGroupMemberRank(this.db, groupId, entityId, rank);
  }

  // ─── Crew Persistence (delegated to db-crews.ts) ────────────────────────

  saveCrew(c: Parameters<typeof crewsDb.saveCrew>[1]): void {
    crewsDb.saveCrew(this.db, c);
  }
  getCrew(id: string): import("./db-crews").CrewRow | undefined {
    return crewsDb.getCrew(this.db, id);
  }
  getCrewByName(name: string): import("./db-crews").CrewRow | undefined {
    return crewsDb.getCrewByName(this.db, name);
  }
  getAllCrews(): import("./db-crews").CrewRow[] {
    return crewsDb.getAllCrews(this.db);
  }
  deleteCrew(id: string): void {
    crewsDb.deleteCrew(this.db, id);
  }
  addCrewMember(crewId: string, agentName: string, role: string, joinedAt: number): void {
    crewsDb.addCrewMember(this.db, crewId, agentName, role, joinedAt);
  }
  removeCrewMember(crewId: string, agentName: string): void {
    crewsDb.removeCrewMember(this.db, crewId, agentName);
  }
  getCrewMembers(crewId: string): import("./db-crews").CrewMemberRow[] {
    return crewsDb.getCrewMembers(this.db, crewId);
  }

  // ─── Competence Persistence (delegated to db-competence.ts) ─────────────

  getCompetence(entityId: string, gate: string) {
    return competenceDb.getCompetence(this.db, entityId, gate);
  }
  listCompetenceForEntity(entityId: string) {
    return competenceDb.listCompetenceForEntity(this.db, entityId);
  }
  recordDemonstration(entityId: string, gate: string, unlockAt: number, now: number): void {
    competenceDb.recordDemonstration(this.db, entityId, gate, unlockAt, now);
  }
  grantCompetence(entityId: string, gate: string): void {
    competenceDb.grantCompetence(this.db, entityId, gate);
  }
  revokeCompetence(entityId: string, gate: string): void {
    competenceDb.revokeCompetence(this.db, entityId, gate);
  }

  // ─── Standing Persistence (delegated to db-standing.ts) ─────────────────

  appendStandingEvent(row: Parameters<typeof standingDb.appendStandingEvent>[1]): void {
    standingDb.appendStandingEvent(this.db, row);
  }
  computeStanding(entityId: string, halfLifeMs: number, horizonMs: number, now: number): number {
    return standingDb.computeStanding(this.db, entityId, halfLifeMs, horizonMs, now);
  }
  getStandingCache(entityId: string) {
    return standingDb.getStandingCache(this.db, entityId);
  }
  setStandingCache(entityId: string, standing: number, now: number): void {
    standingDb.setStandingCache(this.db, entityId, standing, now);
  }
  listStandingEntities(): string[] {
    return standingDb.listStandingEntities(this.db);
  }
  standingLeaderboard(limit: number) {
    return standingDb.standingLeaderboard(this.db, limit);
  }
  ledgerForEntity(entityId: string, limit: number) {
    return standingDb.ledgerForEntity(this.db, entityId, limit);
  }

  // ─── Task Persistence (delegated to db-tasks.ts) ────────────────────────

  createTask(task: {
    groupId?: string;
    title: string;
    description?: string;
    creatorId: string;
    creatorName: string;
    validationMode?: string;
    standing?: number;
    parentTaskId?: number;
    priority?: number;
  }): number {
    return tasksDb.createTask(this.db, task);
  }

  updateTaskProgress(id: number, progress: number): void {
    tasksDb.updateTaskProgress(this.db, id, progress);
  }

  updateTaskPriority(id: number, priority: number): void {
    tasksDb.updateTaskPriority(this.db, id, priority);
  }

  getTask(id: number): TaskRow | undefined {
    return tasksDb.getTask(this.db, id);
  }

  listTasks(opts?: {
    status?: string;
    groupId?: string;
    parentId?: number;
    limit?: number;
    orderByStanding?: boolean;
  }): TaskRow[] {
    return tasksDb.listTasks(this.db, opts);
  }

  updateTaskStatus(id: number, status: string): void {
    tasksDb.updateTaskStatus(this.db, id, status);
  }

  createTaskClaim(taskId: number, entityId: string, entityName: string): void {
    tasksDb.createTaskClaim(this.db, taskId, entityId, entityName);
  }

  getTaskClaim(taskId: number, entityId: string): TaskClaimRow | undefined {
    return tasksDb.getTaskClaim(this.db, taskId, entityId);
  }

  listTasksClaimedBy(entityId: string): TaskRow[] {
    return tasksDb.listTasksClaimedBy(this.db, entityId);
  }

  getTaskClaims(taskId: number): TaskClaimRow[] {
    return tasksDb.getTaskClaims(this.db, taskId);
  }

  updateTaskClaimStatus(
    taskId: number,
    entityId: string,
    status: string,
    submissionText?: string,
  ): void {
    tasksDb.updateTaskClaimStatus(this.db, taskId, entityId, status, submissionText);
  }

  getChildTaskCount(parentId: number): { total: number; completed: number } {
    return tasksDb.getChildTaskCount(this.db, parentId);
  }

  setTaskParent(taskId: number, parentTaskId: number): void {
    tasksDb.setTaskParent(this.db, taskId, parentTaskId);
  }

  searchTasks(
    query: string,
    opts?: { status?: string; limit?: number },
  ): (TaskRow & { score: number })[] {
    return tasksDb.searchTasks(this.db, query, opts);
  }

  recordStandingEarned(entityId: string, entityName: string, taskId: number, amount: number): void {
    tasksDb.recordStandingEarned(this.db, entityId, entityName, taskId, amount);
  }

  getEntityStanding(entityId: string): number {
    return tasksDb.getEntityStanding(this.db, entityId);
  }

  getStandingLeaderboard(limit = 10): { entityName: string; total: number; taskCount: number }[] {
    return tasksDb.getStandingLeaderboard(this.db, limit);
  }

  rejectAllOtherClaims(taskId: number, winnerEntityId: string): void {
    tasksDb.rejectAllOtherClaims(this.db, taskId, winnerEntityId);
  }

  // ─── Macro Persistence ────────────────────────────────────────────────────

  createMacro(name: string, authorId: string, command: string): number {
    const now = Date.now();
    const result = this.db.run(
      "INSERT INTO macros (name, author_id, command, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [name, authorId, command, now, now],
    );
    return Number(result.lastInsertRowid);
  }

  getMacro(id: number): MacroRow | undefined {
    return (
      (this.db.query("SELECT * FROM macros WHERE id = ?").get(id) as MacroRow | null) ?? undefined
    );
  }

  getMacroByName(name: string, authorId: string): MacroRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM macros WHERE name = ? AND author_id = ?")
        .get(name, authorId) as MacroRow | null) ?? undefined
    );
  }

  listMacros(authorId?: string): MacroRow[] {
    if (authorId) {
      return this.db
        .query("SELECT * FROM macros WHERE author_id = ? ORDER BY name")
        .all(authorId) as MacroRow[];
    }
    return this.db.query("SELECT * FROM macros ORDER BY name").all() as MacroRow[];
  }

  updateMacro(id: number, command: string): void {
    this.db.run("UPDATE macros SET command = ?, updated_at = ? WHERE id = ?", [
      command,
      Date.now(),
      id,
    ]);
  }

  deleteMacro(id: number): void {
    this.db.run("DELETE FROM macros WHERE id = ?", [id]);
  }

  // ─── Room Source Persistence ─────────────────────────────────────────────

  saveRoomSource(opts: {
    roomId: string;
    source: string;
    authorId: string;
    authorName: string;
    valid?: boolean;
  }): number {
    const version = this.getLatestRoomSourceVersion(opts.roomId) + 1;
    this.db.run(
      `INSERT INTO room_sources (room_id, version, source, author_id, author_name, valid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.roomId,
        version,
        opts.source,
        opts.authorId,
        opts.authorName,
        opts.valid ? 1 : 0,
        Date.now(),
      ],
    );
    return version;
  }

  getRoomSource(roomId: string, version?: number): RoomSourceRow | undefined {
    if (version !== undefined) {
      return (
        (this.db
          .query("SELECT * FROM room_sources WHERE room_id = ? AND version = ?")
          .get(roomId, version) as RoomSourceRow | null) ?? undefined
      );
    }
    // Latest version
    return (
      (this.db
        .query("SELECT * FROM room_sources WHERE room_id = ? ORDER BY version DESC LIMIT 1")
        .get(roomId) as RoomSourceRow | null) ?? undefined
    );
  }

  getRoomSourceHistory(roomId: string, limit = 20): RoomSourceRow[] {
    return this.db
      .query("SELECT * FROM room_sources WHERE room_id = ? ORDER BY version DESC LIMIT ?")
      .all(roomId, limit) as RoomSourceRow[];
  }

  getLatestRoomSourceVersion(roomId: string): number {
    const row = this.db
      .query("SELECT MAX(version) as max_version FROM room_sources WHERE room_id = ?")
      .get(roomId) as { max_version: number | null } | null;
    return row?.max_version ?? 0;
  }

  getAllRoomSourceIds(): string[] {
    return (
      this.db.query("SELECT DISTINCT room_id FROM room_sources ORDER BY room_id").all() as {
        room_id: string;
      }[]
    ).map((r) => r.room_id);
  }

  markRoomSourceValid(roomId: string, version: number): void {
    this.db.run("UPDATE room_sources SET valid = 1 WHERE room_id = ? AND version = ?", [
      roomId,
      version,
    ]);
  }

  deleteRoomSources(roomId: string): void {
    this.db.run("DELETE FROM room_sources WHERE room_id = ?", [roomId]);
  }

  // ─── Room Template Persistence ──────────────────────────────────────────

  saveRoomTemplate(opts: {
    name: string;
    source: string;
    authorId: string;
    authorName: string;
    description?: string;
  }): void {
    this.db.run(
      `INSERT OR REPLACE INTO room_templates (name, source, author_id, author_name, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [opts.name, opts.source, opts.authorId, opts.authorName, opts.description ?? "", Date.now()],
    );
  }

  getRoomTemplate(name: string): RoomTemplateRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM room_templates WHERE name = ?")
        .get(name) as RoomTemplateRow | null) ?? undefined
    );
  }

  getAllRoomTemplates(): RoomTemplateRow[] {
    return this.db.query("SELECT * FROM room_templates ORDER BY name").all() as RoomTemplateRow[];
  }

  deleteRoomTemplate(name: string): void {
    this.db.run("DELETE FROM room_templates WHERE name = ?", [name]);
  }

  // ─── User Persistence ───────────────────────────────────────────────────

  createUser(user: { id: string; name: string; rank?: number }): void {
    const now = Date.now();
    this.db.run(
      "INSERT INTO users (id, name, created_at, last_login, rank) VALUES (?, ?, ?, ?, ?)",
      [user.id, user.name, now, now, user.rank ?? 0],
    );
  }

  getUser(id: string): UserRow | undefined {
    return (
      (this.db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null) ?? undefined
    );
  }

  getUserByName(name: string): UserRow | undefined {
    return (
      (this.db.query("SELECT * FROM users WHERE name = ?").get(name) as UserRow | null) ?? undefined
    );
  }

  updateUserLastLogin(id: string): void {
    this.db.run("UPDATE users SET last_login = ? WHERE id = ?", [Date.now(), id]);
  }

  updateUserRank(id: string, rank: number): void {
    this.db.run("UPDATE users SET rank = ? WHERE id = ?", [rank, id]);
  }

  /** Look up the named user bound to a verified external-identity subject. */
  getUserByAuthSubject(subject: string): UserRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM users WHERE auth_subject = ?")
        .get(subject) as UserRow | null) ?? undefined
    );
  }

  /** Bind a verified identity (subject + email) to an existing named user. */
  bindAuthSubject(id: string, subject: string, email: string): void {
    this.db.run("UPDATE users SET auth_subject = ?, auth_email = ? WHERE id = ?", [
      subject,
      email,
      id,
    ]);
  }

  updateUserProperties(id: string, properties: Record<string, unknown>): void {
    this.db.run("UPDATE users SET properties = ? WHERE id = ?", [JSON.stringify(properties), id]);
  }

  deleteUser(id: string): void {
    this.db.run("DELETE FROM users WHERE id = ?", [id]);
  }

  // ─── Ban Persistence ──────────────────────────────────────────────────

  addBan(name: string, bannedBy: string, reason = ""): void {
    this.db.run(
      "INSERT OR REPLACE INTO bans (name, reason, banned_by, created_at) VALUES (?, ?, ?, ?)",
      [name.toLowerCase(), reason, bannedBy, Date.now()],
    );
  }

  removeBan(name: string): boolean {
    const result = this.db.run("DELETE FROM bans WHERE name = ?", [name.toLowerCase()]);
    return result.changes > 0;
  }

  isBanned(name: string): boolean {
    const row = this.db.query("SELECT 1 FROM bans WHERE name = ?").get(name.toLowerCase());
    return row !== null;
  }

  getBan(name: string): BanRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM bans WHERE name = ?")
        .get(name.toLowerCase()) as BanRow | null) ?? undefined
    );
  }

  listBans(): BanRow[] {
    return this.db.query("SELECT * FROM bans ORDER BY created_at DESC").all() as BanRow[];
  }

  // ─── Adapter Link Persistence ──────────────────────────────────────────

  linkAdapter(adapter: string, externalId: string, userId: string): void {
    this.db.run(
      "INSERT OR REPLACE INTO adapter_links (adapter, external_id, user_id, created_at) VALUES (?, ?, ?, ?)",
      [adapter, externalId, userId, Date.now()],
    );
  }

  getLinkedUser(adapter: string, externalId: string): AdapterLinkRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM adapter_links WHERE adapter = ? AND external_id = ?")
        .get(adapter, externalId) as AdapterLinkRow | null) ?? undefined
    );
  }

  getUserLinks(userId: string): AdapterLinkRow[] {
    return this.db
      .query("SELECT * FROM adapter_links WHERE user_id = ?")
      .all(userId) as AdapterLinkRow[];
  }

  unlinkAdapter(adapter: string, externalId: string): boolean {
    const result = this.db.run("DELETE FROM adapter_links WHERE adapter = ? AND external_id = ?", [
      adapter,
      externalId,
    ]);
    return result.changes > 0;
  }

  // ─── Adapter User Mappings ────────────────────────────────────────────────

  saveAdapterUserMapping(platform: string, platformUserId: string, entityName: string): void {
    this.db.run(
      `INSERT OR REPLACE INTO adapter_user_mappings (platform, platform_user_id, entity_name, created_at)
       VALUES (?, ?, ?, ?)`,
      [platform, platformUserId, entityName, Date.now()],
    );
  }

  getAdapterUserMapping(
    platform: string,
    platformUserId: string,
  ): AdapterUserMappingRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM adapter_user_mappings WHERE platform = ? AND platform_user_id = ?")
        .get(platform, platformUserId) as AdapterUserMappingRow | null) ?? undefined
    );
  }

  getAdapterUserMappings(platform: string): AdapterUserMappingRow[] {
    return this.db
      .query("SELECT * FROM adapter_user_mappings WHERE platform = ?")
      .all(platform) as AdapterUserMappingRow[];
  }

  deleteAdapterUserMapping(platform: string, platformUserId: string): boolean {
    const result = this.db.run(
      "DELETE FROM adapter_user_mappings WHERE platform = ? AND platform_user_id = ?",
      [platform, platformUserId],
    );
    return result.changes > 0;
  }

  // ─── Notes Persistence (delegated to db-notes.ts) ───────────────────────

  createNote(
    entityName: string,
    content: string,
    roomId?: string,
    opts?: {
      importance?: number;
      noteType?: string;
      poolId?: string;
      supersedesId?: number;
      tier?: NoteTier;
      skipDedup?: boolean;
    },
  ): number {
    return notesDb.createNote(this.db, entityName, content, roomId, opts);
  }

  getNotesByEntity(entityName: string, limit = 50): NoteRow[] {
    return notesDb.getNotesByEntity(this.db, entityName, limit);
  }

  getNotesByRoom(roomId: string, limit = 50): NoteRow[] {
    return notesDb.getNotesByRoom(this.db, roomId, limit);
  }

  searchNotes(entityName: string, query: string): NoteRow[] {
    return notesDb.searchNotes(this.db, entityName, query);
  }

  deleteNote(id: number, entityName: string): boolean {
    return notesDb.deleteNote(this.db, id, entityName);
  }

  getNote(id: number): NoteRow | undefined {
    return notesDb.getNote(this.db, id);
  }

  touchNote(id: number): void {
    notesDb.touchNote(this.db, id);
  }

  recallNotes(
    entityName: string,
    query: string,
    opts?: {
      weightImportance?: number;
      weightRecency?: number;
      weightRelevance?: number;
      includeProcess?: boolean;
    },
  ): ScoredNoteRow[] {
    return notesDb.recallNotes(this.db, entityName, query, opts);
  }

  recallNotesWithType(
    entityName: string,
    query: string,
    noteType: string,
    opts?: { weightImportance?: number; weightRecency?: number; weightRelevance?: number },
  ): ScoredNoteRow[] {
    return notesDb.recallNotesWithType(this.db, entityName, query, noteType, opts);
  }

  /** Find existing notes similar to content (for auto-linking) */
  findSimilarNotes(entityName: string, content: string, excludeId?: number): NoteRow[] {
    return notesDb.findSimilarNotes(this.db, entityName, content, excludeId);
  }

  /** Count total and fading matches for a query (beyond the top-20 recall returns) */
  countMatchingNotes(entityName: string, query: string): { total: number; fading: number } {
    return notesDb.countMatchingNotes(this.db, entityName, query);
  }

  /** Boost importance for frequently-recalled notes, decay for stale ones.
   *  Structural awareness: well-linked notes (3+ links) decay slower,
   *  bridge notes (connecting different clusters) are protected. */
  adjustNoteImportance(): { boosted: number; decayed: number } {
    return notesDb.adjustNoteImportance(this.db);
  }

  // ─── Entity Activity Tracking (delegated to db-entities.ts) ─────────────

  trackActivity(
    entityName: string,
    activityType: string,
    activityKey: string,
    success?: boolean,
  ): void {
    entitiesDb.trackActivity(this.db, entityName, activityType, activityKey, success);
  }

  getActivityStats(entityName: string): {
    roomsVisited: number;
    uniqueCommands: number;
    entitiesInteracted: number;
    totalActions: number;
  } {
    return entitiesDb.getActivityStats(this.db, entityName);
  }

  getLastActivityAt(entityName: string): number | null {
    return entitiesDb.getLastActivityAt(this.db, entityName);
  }

  getRoomVisitCount(entityName: string, roomId: string): number {
    return entitiesDb.getRoomVisitCount(this.db, entityName, roomId);
  }

  getActivityByType(
    entityName: string,
    activityType: string,
    limit = 20,
  ): { key: string; count: number; successCount: number; failCount: number; lastSeen: number }[] {
    return entitiesDb.getActivityByType(this.db, entityName, activityType, limit);
  }

  // ─── Core Memory Persistence (delegated to db-notes.ts) ─────────────────

  setCoreMemory(entityName: string, key: string, value: string): void {
    notesDb.setCoreMemory(this.db, entityName, key, value);
  }

  getCoreMemory(entityName: string, key: string): CoreMemoryRow | undefined {
    return notesDb.getCoreMemory(this.db, entityName, key);
  }

  listCoreMemory(entityName: string): CoreMemoryRow[] {
    return notesDb.listCoreMemory(this.db, entityName);
  }

  deleteCoreMemory(entityName: string, key: string): boolean {
    return notesDb.deleteCoreMemory(this.db, entityName, key);
  }

  getCoreMemoryHistory(entityName: string, key: string, limit = 10): CoreMemoryHistoryRow[] {
    return notesDb.getCoreMemoryHistory(this.db, entityName, key, limit);
  }

  // ─── Note Links (delegated to db-notes.ts) ────────────────────────────

  createNoteLink(sourceId: number, targetId: number, relationship: string): number {
    return notesDb.createNoteLink(this.db, sourceId, targetId, relationship);
  }

  getNoteLinks(noteId: number): NoteLinkRow[] {
    return notesDb.getNoteLinks(this.db, noteId);
  }

  searchAllNotes(query: string, limit = 20): NoteRow[] {
    return notesDb.searchAllNotes(this.db, query, limit);
  }

  removeNoteLink(sourceId: number, targetId: number, relationship: string): boolean {
    return notesDb.removeNoteLink(this.db, sourceId, targetId, relationship);
  }

  getGraphSnapshot(limit = 500): { notes: NoteRow[]; links: NoteLinkRow[] } {
    return notesDb.getGraphSnapshot(this.db, limit);
  }

  // ─── Feed Events (delegated to db-feed.ts) ────────────────────────────

  insertFeedEvent(event: feedDb.InsertFeedEvent): number {
    return feedDb.insertFeedEvent(this.db, event);
  }

  queryFeedEvents(q: feedDb.FeedQuery = {}): feedDb.FeedEventRow[] {
    return feedDb.queryFeedEvents(this.reader, q);
  }

  trimFeedEvents(keepMs: number): number {
    return feedDb.trimFeedEvents(this.db, keepMs);
  }

  // ─── Chronicle (delegated to db-chronicle.ts) ──────────────────────────
  // The canonical, append-only record of the Marina. See docs/chronicle.md.

  appendChronicle(entry: chronicleDb.InsertChronicle): number {
    return chronicleDb.appendChronicle(this.db, entry);
  }

  queryChronicle(q: chronicleDb.ChronicleQuery = {}): chronicleDb.ChronicleEntry[] {
    return chronicleDb.queryChronicle(this.reader, q);
  }

  getChronicleEntry(id: number): chronicleDb.ChronicleEntry | undefined {
    return chronicleDb.getChronicleEntry(this.reader, id);
  }

  getChronicleCorrectionsFor(id: number): chronicleDb.ChronicleEntry[] {
    return chronicleDb.getCorrectionsFor(this.reader, id);
  }

  getChronicleCount(): number {
    return chronicleDb.getChronicleCount(this.reader);
  }

  // ─── Benchmark Runs (inline — small surface, no dedicated module) ─────

  insertBenchmarkRun(row: {
    id: string;
    benchmark: string;
    config_hash: string;
    config_json: string;
    status: string;
    agent_id?: string;
    started_at: number;
  }): void {
    this.db.run(
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

  completeBenchmarkRun(
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
    this.db.run(
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

  getBenchmarkRun(id: string): BenchmarkRunRow | undefined {
    return this.reader.query("SELECT * FROM benchmark_runs WHERE id = ?").get(id) as
      | BenchmarkRunRow
      | undefined;
  }

  queryBenchmarkRuns(q: {
    benchmark?: string;
    status?: string;
    agentId?: string;
    limit?: number;
  }): BenchmarkRunRow[] {
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
    return this.reader
      .query(`SELECT * FROM benchmark_runs${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...params) as BenchmarkRunRow[];
  }

  leaderboardBenchmark(benchmark: string, limit = 20): BenchmarkRunRow[] {
    return this.reader
      .query(
        "SELECT * FROM benchmark_runs WHERE benchmark = ? AND status = 'completed' AND score IS NOT NULL ORDER BY score DESC, started_at DESC LIMIT ?",
      )
      .all(benchmark, Math.min(limit, 100)) as BenchmarkRunRow[];
  }

  traceNoteGraph(
    noteId: number,
    depth = 2,
  ): { note: NoteRow; links: NoteLinkRow[]; depth: number }[] {
    return notesDb.traceNoteGraph(this.db, noteId, depth);
  }

  /** Count total note links for an entity's notes */
  countNoteLinks(entityName: string): number {
    return notesDb.countNoteLinks(this.db, entityName);
  }

  /** Count links for a specific note */
  countLinksForNote(noteId: number): number {
    return notesDb.countLinksForNote(this.db, noteId);
  }

  // ─── Memory Pools (delegated to db-notes.ts) ───────────────────────────

  createMemoryPool(id: string, name: string, createdBy: string, groupId?: string): void {
    notesDb.createMemoryPool(this.db, id, name, createdBy, groupId);
  }

  getMemoryPool(name: string): MemoryPoolRow | undefined {
    return notesDb.getMemoryPool(this.db, name);
  }

  listMemoryPools(): MemoryPoolRow[] {
    return notesDb.listMemoryPools(this.db);
  }

  addPoolNote(
    poolId: string,
    entityName: string,
    content: string,
    importance?: number,
    noteType?: string,
  ): number {
    return notesDb.addPoolNote(this.db, poolId, entityName, content, importance, noteType);
  }

  getPoolNotes(poolId: string, limit = 100): NoteRow[] {
    return notesDb.getPoolNotes(this.db, poolId, limit);
  }

  countPoolNotes(poolId: string): number {
    return notesDb.countPoolNotes(this.db, poolId);
  }

  recallPoolNotes(
    poolId: string,
    query: string,
    opts?: { weightImportance?: number; weightRecency?: number; weightRelevance?: number },
  ): ScoredNoteRow[] {
    return notesDb.recallPoolNotes(this.db, poolId, query, opts);
  }

  // ─── Memory API Keys (delegated to db-notes.ts) ────────────────────────

  createMemApiKey(id: string, secret: string, agentName: string): void {
    notesDb.createMemApiKey(this.db, id, secret, agentName);
  }

  validateMemApiKey(secret: string): MemApiKeyRow | undefined {
    return notesDb.validateMemApiKey(this.db, secret);
  }

  listMemApiKeys(): MemApiKeyRow[] {
    return notesDb.listMemApiKeys(this.db);
  }

  deleteMemApiKey(id: string): boolean {
    return notesDb.deleteMemApiKey(this.db, id);
  }

  /** Aggregate stats for an agent's memory namespace */
  getMemStats(agentName: string): {
    notes: number;
    links: number;
    coreKeys: number;
    pools: number;
  } {
    return notesDb.getMemStats(this.db, agentName);
  }

  /** Count personal notes (excluding pool notes) for an entity, optionally filtered by type. */
  countNotes(entityName: string, noteType?: string): number {
    return notesDb.countNotes(this.db, entityName, noteType);
  }

  /** Count completed tasks created by an entity. */
  countCompletedTasks(entityName: string): number {
    return tasksDb.countCompletedTasks(this.db, entityName);
  }

  // ─── Project Persistence (delegated to db-tasks.ts) ────────────────────

  createProject(project: {
    id: string;
    name: string;
    description?: string;
    bundleId?: number;
    poolId?: string;
    groupId?: string;
    orchestration?: string;
    memoryArch?: string;
    createdBy: string;
  }): void {
    tasksDb.createProject(this.db, project);
  }

  getProject(id: string): ProjectRow | undefined {
    return tasksDb.getProject(this.db, id);
  }

  getProjectByName(name: string): ProjectRow | undefined {
    return tasksDb.getProjectByName(this.db, name);
  }

  listProjects(status?: string): ProjectRow[] {
    return tasksDb.listProjects(this.db, status);
  }

  updateProjectStatus(id: string, status: string): void {
    tasksDb.updateProjectStatus(this.db, id, status);
  }

  updateProjectOrchestration(id: string, orchestration: string): void {
    tasksDb.updateProjectOrchestration(this.db, id, orchestration);
  }

  updateProjectMemoryArch(id: string, memoryArch: string): void {
    tasksDb.updateProjectMemoryArch(this.db, id, memoryArch);
  }

  // ─── Dynamic Command Persistence ─────────────────────────────────────

  saveCommandSource(opts: { id: string; name: string; source: string; createdBy: string }): void {
    const existing = this.getCommandByName(opts.name);
    if (existing) {
      // Save history before updating
      this.db.run(
        "INSERT INTO dynamic_command_history (command_id, source, version, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)",
        [existing.id, existing.source, existing.version, opts.createdBy, Date.now()],
      );
      this.db.run(
        "UPDATE dynamic_commands SET source = ?, version = version + 1, valid = 0 WHERE id = ?",
        [opts.source, existing.id],
      );
    } else {
      this.db.run(
        "INSERT INTO dynamic_commands (id, name, source, version, valid, created_by, created_at) VALUES (?, ?, ?, 1, 0, ?, ?)",
        [opts.id, opts.name, opts.source, opts.createdBy, Date.now()],
      );
    }
  }

  getCommand(id: string): CommandSourceRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM dynamic_commands WHERE id = ?")
        .get(id) as CommandSourceRow | null) ?? undefined
    );
  }

  getCommandByName(name: string): CommandSourceRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM dynamic_commands WHERE name = ?")
        .get(name) as CommandSourceRow | null) ?? undefined
    );
  }

  listCommands(): CommandSourceRow[] {
    return this.db
      .query("SELECT * FROM dynamic_commands ORDER BY name")
      .all() as CommandSourceRow[];
  }

  markCommandValid(name: string): void {
    this.db.run("UPDATE dynamic_commands SET valid = 1 WHERE name = ?", [name]);
  }

  deleteCommand(name: string): void {
    const cmd = this.getCommandByName(name);
    if (cmd) {
      this.db.run("DELETE FROM dynamic_command_history WHERE command_id = ?", [cmd.id]);
      this.db.run("DELETE FROM dynamic_commands WHERE id = ?", [cmd.id]);
    }
  }

  getCommandHistory(name: string, limit = 20): CommandHistoryRow[] {
    const cmd = this.getCommandByName(name);
    if (!cmd) return [];
    return this.db
      .query(
        "SELECT * FROM dynamic_command_history WHERE command_id = ? ORDER BY version DESC LIMIT ?",
      )
      .all(cmd.id, limit) as CommandHistoryRow[];
  }

  getAllValidCommandNames(): string[] {
    return (
      this.db.query("SELECT name FROM dynamic_commands WHERE valid = 1").all() as { name: string }[]
    ).map((r) => r.name);
  }

  // ─── Connector Persistence ──────────────────────────────────────────────

  createConnector(conn: {
    id: string;
    name: string;
    transport: string;
    url?: string;
    command?: string;
    args?: string;
    createdBy: string;
  }): void {
    this.db.run(
      "INSERT INTO connectors (id, name, transport, url, command, args, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        conn.id,
        conn.name,
        conn.transport,
        conn.url ?? null,
        conn.command ?? null,
        conn.args ?? null,
        conn.createdBy,
        Date.now(),
      ],
    );
  }

  getConnector(id: string): ConnectorRow | undefined {
    return (
      (this.db.query("SELECT * FROM connectors WHERE id = ?").get(id) as ConnectorRow | null) ??
      undefined
    );
  }

  getConnectorByName(name: string): ConnectorRow | undefined {
    return (
      (this.db.query("SELECT * FROM connectors WHERE name = ?").get(name) as ConnectorRow | null) ??
      undefined
    );
  }

  listConnectors(status?: string): ConnectorRow[] {
    if (status) {
      return this.db
        .query("SELECT * FROM connectors WHERE status = ? ORDER BY name")
        .all(status) as ConnectorRow[];
    }
    return this.db.query("SELECT * FROM connectors ORDER BY name").all() as ConnectorRow[];
  }

  updateConnectorStatus(id: string, status: string): void {
    this.db.run("UPDATE connectors SET status = ? WHERE id = ?", [status, id]);
  }

  updateConnectorAuth(id: string, authType: string, authData: string): void {
    this.db.run("UPDATE connectors SET auth_type = ?, auth_data = ? WHERE id = ?", [
      authType,
      authData,
      id,
    ]);
  }

  deleteConnector(id: string): void {
    this.db.run("DELETE FROM connectors WHERE id = ?", [id]);
  }

  // ─── Gateway Persistence ──────────────────────────────────────────────

  createGateway(opts: { id: string; name: string; url: string; createdBy: string }): void {
    this.db.run(
      "INSERT INTO gateways (id, name, url, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
      [opts.id, opts.name, opts.url, opts.createdBy, Date.now()],
    );
  }

  getGatewayByName(name: string): GatewayRow | undefined {
    return (
      (this.db.query("SELECT * FROM gateways WHERE name = ?").get(name) as GatewayRow | null) ??
      undefined
    );
  }

  listGateways(status?: string): GatewayRow[] {
    if (status) {
      return this.db
        .query("SELECT * FROM gateways WHERE status = ? ORDER BY name")
        .all(status) as GatewayRow[];
    }
    return this.db.query("SELECT * FROM gateways ORDER BY name").all() as GatewayRow[];
  }

  updateGatewayStatus(id: string, status: string): void {
    this.db.run("UPDATE gateways SET status = ? WHERE id = ?", [status, id]);
  }

  deleteGateway(id: string): void {
    this.db.run("DELETE FROM gateways WHERE id = ?", [id]);
  }

  addGatewayBridge(gatewayId: string, channel: string): void {
    this.db.run("INSERT OR IGNORE INTO gateway_bridges (gateway_id, channel) VALUES (?, ?)", [
      gatewayId,
      channel,
    ]);
  }

  removeGatewayBridge(gatewayId: string, channel: string): void {
    this.db.run("DELETE FROM gateway_bridges WHERE gateway_id = ? AND channel = ?", [
      gatewayId,
      channel,
    ]);
  }

  listGatewayBridges(gatewayId: string): string[] {
    return (
      this.db.query("SELECT channel FROM gateway_bridges WHERE gateway_id = ?").all(gatewayId) as {
        channel: string;
      }[]
    ).map((r) => r.channel);
  }

  // ─── Experiment Persistence ────────────────────────────────────────────

  createExperiment(opts: {
    name: string;
    description?: string;
    config?: Record<string, unknown>;
    creatorName: string;
    requiredAgents?: number;
    timeLimit?: number;
  }): number {
    const result = this.db.run(
      `INSERT INTO experiments (name, description, config, creator_name, required_agents, time_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.name,
        opts.description ?? "",
        JSON.stringify(opts.config ?? {}),
        opts.creatorName,
        opts.requiredAgents ?? 2,
        opts.timeLimit ?? null,
        Date.now(),
      ],
    );
    return Number(result.lastInsertRowid);
  }

  getExperiment(id: number): ExperimentRow | undefined {
    return (
      (this.db.query("SELECT * FROM experiments WHERE id = ?").get(id) as ExperimentRow | null) ??
      undefined
    );
  }

  getExperimentByName(name: string): ExperimentRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM experiments WHERE name = ?")
        .get(name) as ExperimentRow | null) ?? undefined
    );
  }

  listExperiments(status?: string): ExperimentRow[] {
    if (status) {
      return this.db
        .query("SELECT * FROM experiments WHERE status = ? ORDER BY id DESC")
        .all(status) as ExperimentRow[];
    }
    return this.db.query("SELECT * FROM experiments ORDER BY id DESC").all() as ExperimentRow[];
  }

  updateExperimentStatus(id: number, status: string): void {
    this.db.run("UPDATE experiments SET status = ? WHERE id = ?", [status, id]);
  }

  startExperiment(id: number): void {
    this.db.run("UPDATE experiments SET status = 'active', started_at = ? WHERE id = ?", [
      Date.now(),
      id,
    ]);
  }

  completeExperiment(id: number): void {
    this.db.run("UPDATE experiments SET status = 'completed', completed_at = ? WHERE id = ?", [
      Date.now(),
      id,
    ]);
  }

  addParticipant(experimentId: number, entityName: string): void {
    this.db.run(
      "INSERT OR IGNORE INTO experiment_participants (experiment_id, entity_name, joined_at) VALUES (?, ?, ?)",
      [experimentId, entityName, Date.now()],
    );
  }

  getParticipants(experimentId: number): ExperimentParticipantRow[] {
    return this.db
      .query("SELECT * FROM experiment_participants WHERE experiment_id = ?")
      .all(experimentId) as ExperimentParticipantRow[];
  }

  isParticipant(experimentId: number, entityName: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM experiment_participants WHERE experiment_id = ? AND entity_name = ?")
      .get(experimentId, entityName);
    return row !== null;
  }

  recordResult(
    experimentId: number,
    entityName: string,
    metricName: string,
    metricValue: number,
  ): void {
    this.db.run(
      `INSERT INTO experiment_results (experiment_id, entity_name, metric_name, metric_value, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
      [experimentId, entityName, metricName, metricValue, Date.now()],
    );
  }

  getResults(experimentId: number): ExperimentResultRow[] {
    return this.db
      .query("SELECT * FROM experiment_results WHERE experiment_id = ? ORDER BY id")
      .all(experimentId) as ExperimentResultRow[];
  }

  // ─── Event Queries (delegated to db-entities.ts) ────────────────────────

  getEventsByEntity(
    entityId: string,
    limit = 20,
  ): { type: string; input?: string; timestamp: number }[] {
    return entitiesDb.getEventsByEntity(this.db, entityId, limit);
  }

  getEntityCommandCount(entityId: string): number {
    return entitiesDb.getEntityCommandCount(this.db, entityId);
  }

  getLastActivity(
    entityId: string,
  ): { type: string; timestamp: number; input?: string } | undefined {
    return entitiesDb.getLastActivity(this.db, entityId);
  }

  getActiveEntities(
    sinceMs: number,
  ): { entityId: string; commandCount: number; lastActivity: number }[] {
    return entitiesDb.getActiveEntities(this.db, sinceMs);
  }

  // ─── Global Search (delegated to db-channels.ts) ────────────────────────

  globalSearch(query: string): GlobalSearchResult[] {
    return channelsDb.globalSearch(this.db, query);
  }

  // ─── Assets ─────────────────────────────────────────────────────────────

  createAsset(asset: {
    id: string;
    entityName: string;
    filename: string;
    mimeType: string;
    size: number;
    storageKey: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.db.run(
      `INSERT INTO assets (id, entity_name, filename, mime_type, size, storage_key, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        asset.id,
        asset.entityName,
        asset.filename,
        asset.mimeType,
        asset.size,
        asset.storageKey,
        JSON.stringify(asset.metadata ?? {}),
        Date.now(),
      ],
    );
  }

  getAsset(id: string): AssetRow | undefined {
    return (
      (this.db.query("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow | null) ?? undefined
    );
  }

  getAssetsByEntity(entityName: string, limit = 50): AssetRow[] {
    return this.db
      .query("SELECT * FROM assets WHERE entity_name = ? ORDER BY created_at DESC LIMIT ?")
      .all(entityName, limit) as AssetRow[];
  }

  listAssets(opts?: { limit?: number; mime?: string }): AssetRow[] {
    if (opts?.mime) {
      return this.db
        .query("SELECT * FROM assets WHERE mime_type LIKE ? ORDER BY created_at DESC LIMIT ?")
        .all(`${opts.mime}%`, opts?.limit ?? 50) as AssetRow[];
    }
    return this.db
      .query("SELECT * FROM assets ORDER BY created_at DESC LIMIT ?")
      .all(opts?.limit ?? 50) as AssetRow[];
  }

  deleteAsset(id: string): boolean {
    const result = this.db.run("DELETE FROM assets WHERE id = ?", [id]);
    return result.changes > 0;
  }

  // ─── Canvases ──────────────────────────────────────────────────────────

  createCanvas(canvas: {
    id: string;
    name: string;
    description?: string;
    scope?: string;
    scopeId?: string;
    creatorName: string;
  }): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO canvases (id, name, description, scope, scope_id, creator_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        canvas.id,
        canvas.name,
        canvas.description ?? "",
        canvas.scope ?? "global",
        canvas.scopeId ?? null,
        canvas.creatorName,
        now,
        now,
      ],
    );
  }

  getCanvas(id: string): CanvasRow | undefined {
    return (
      (this.db.query("SELECT * FROM canvases WHERE id = ?").get(id) as CanvasRow | null) ??
      undefined
    );
  }

  getCanvasByName(name: string): CanvasRow | undefined {
    return (
      (this.db.query("SELECT * FROM canvases WHERE name = ?").get(name) as CanvasRow | null) ??
      undefined
    );
  }

  listCanvases(opts?: { scope?: string; limit?: number }): CanvasRow[] {
    if (opts?.scope) {
      return this.db
        .query("SELECT * FROM canvases WHERE scope = ? ORDER BY updated_at DESC LIMIT ?")
        .all(opts.scope, opts?.limit ?? 50) as CanvasRow[];
    }
    return this.db
      .query("SELECT * FROM canvases ORDER BY updated_at DESC LIMIT ?")
      .all(opts?.limit ?? 50) as CanvasRow[];
  }

  /** Look up the per-entity workspace canvas, if one exists. */
  getEntityCanvas(entityId: string): CanvasRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM canvases WHERE scope = 'entity' AND scope_id = ? LIMIT 1")
        .get(entityId) as CanvasRow | null) ?? undefined
    );
  }

  /**
   * Return the entity's canvas, lazily creating it on first access. Canvas
   * names have a UNIQUE constraint, so we try `"{name}'s canvas"` first and
   * fall back to an id-qualified name on collision. Per-entity addressing
   * always goes through scope lookup (`getEntityCanvas`), so the name is
   * mostly a human-readable label shown in the breadcrumb.
   */
  ensureEntityCanvas(entityId: string, entityName: string, creatorName: string): CanvasRow {
    const existing = this.getEntityCanvas(entityId);
    if (existing) return existing;
    const shortId = entityId.slice(-6);
    const candidates = [
      `${entityName}'s canvas`,
      `${entityName}'s canvas (${shortId})`,
      `canvas-${entityId}`,
    ];
    for (const name of candidates) {
      if (this.getCanvasByName(name)) continue;
      const id = crypto.randomUUID();
      try {
        this.createCanvas({
          id,
          name,
          description: `${entityName}'s workspace`,
          scope: "entity",
          scopeId: entityId,
          creatorName,
        });
        const row = this.getCanvas(id);
        if (row) return row;
      } catch {
        // Name collided with a row the pre-check missed (race). Try the next.
      }
    }
    throw new Error(`Failed to create entity canvas for ${entityName}`);
  }

  deleteCanvas(id: string): boolean {
    const result = this.db.run("DELETE FROM canvases WHERE id = ?", [id]);
    return result.changes > 0;
  }

  // ─── Canvas Nodes ─────────────────────────────────────────────────────

  createNode(node: {
    id: string;
    canvasId: string;
    type: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    assetId?: string;
    data?: Record<string, unknown>;
    creatorName: string;
    parentNodeId?: string;
  }): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO canvas_nodes (id, canvas_id, type, x, y, width, height, asset_id, data, creator_name, parent_node_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        node.id,
        node.canvasId,
        node.type,
        node.x ?? 0,
        node.y ?? 0,
        node.width ?? 300,
        node.height ?? 200,
        node.assetId ?? null,
        JSON.stringify(node.data ?? {}),
        node.creatorName,
        node.parentNodeId ?? null,
        now,
        now,
      ],
    );
    // Touch canvas updated_at
    this.db.run("UPDATE canvases SET updated_at = ? WHERE id = ?", [now, node.canvasId]);
  }

  getNode(id: string): CanvasNodeRow | undefined {
    return (
      (this.db.query("SELECT * FROM canvas_nodes WHERE id = ?").get(id) as CanvasNodeRow | null) ??
      undefined
    );
  }

  getNodesByCanvas(canvasId: string): CanvasNodeRow[] {
    return this.db
      .query("SELECT * FROM canvas_nodes WHERE canvas_id = ? ORDER BY created_at ASC")
      .all(canvasId) as CanvasNodeRow[];
  }

  /**
   * Delete all but the most recent `max` nodes on a canvas. Returns the
   * number of rows deleted. Used by FeedPublisher to bound the feed canvas
   * (without this, every event adds a permanent node — thousands over a
   * day, enough to hang the dashboard when it loads the canvas).
   */
  trimCanvasNodes(canvasId: string, max: number): number {
    const result = this.db.run(
      `DELETE FROM canvas_nodes
       WHERE canvas_id = ?
         AND id NOT IN (
           SELECT id FROM canvas_nodes
           WHERE canvas_id = ?
           ORDER BY created_at DESC
           LIMIT ?
         )`,
      [canvasId, canvasId, max],
    );
    return result.changes ?? 0;
  }

  updateNode(
    id: string,
    updates: { x?: number; y?: number; width?: number; height?: number; data?: string },
  ): boolean {
    const node = this.getNode(id);
    if (!node) return false;
    const now = Date.now();
    this.db.run(
      `UPDATE canvas_nodes SET x = ?, y = ?, width = ?, height = ?, data = ?, updated_at = ?
       WHERE id = ?`,
      [
        updates.x ?? node.x,
        updates.y ?? node.y,
        updates.width ?? node.width,
        updates.height ?? node.height,
        updates.data ?? node.data,
        now,
        id,
      ],
    );
    this.db.run("UPDATE canvases SET updated_at = ? WHERE id = ?", [now, node.canvas_id]);
    return true;
  }

  getChildNodes(parentNodeId: string): CanvasNodeRow[] {
    return this.db
      .query("SELECT * FROM canvas_nodes WHERE parent_node_id = ? ORDER BY created_at ASC")
      .all(parentNodeId) as CanvasNodeRow[];
  }

  getRootNodes(canvasId: string): CanvasNodeRow[] {
    return this.db
      .query(
        "SELECT * FROM canvas_nodes WHERE canvas_id = ? AND parent_node_id IS NULL ORDER BY created_at DESC",
      )
      .all(canvasId) as CanvasNodeRow[];
  }

  deleteNode(id: string): boolean {
    const result = this.db.run("DELETE FROM canvas_nodes WHERE id = ?", [id]);
    return result.changes > 0;
  }

  // ─── Canvas Edges ─────────────────────────────────────────────────────

  createCanvasEdge(edge: {
    id: string;
    canvasId: string;
    sourceId: string;
    targetId: string;
    relationship: string;
    data?: Record<string, unknown>;
    creatorName: string;
  }): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO canvas_edges (id, canvas_id, source_id, target_id, relationship, data, creator_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        edge.id,
        edge.canvasId,
        edge.sourceId,
        edge.targetId,
        edge.relationship,
        edge.data ? JSON.stringify(edge.data) : null,
        edge.creatorName,
        now,
      ],
    );
    this.db.run("UPDATE canvases SET updated_at = ? WHERE id = ?", [now, edge.canvasId]);
  }

  getCanvasEdges(canvasId: string): CanvasEdgeRow[] {
    return this.db
      .query("SELECT * FROM canvas_edges WHERE canvas_id = ? ORDER BY created_at ASC")
      .all(canvasId) as CanvasEdgeRow[];
  }

  getCanvasEdge(id: string): CanvasEdgeRow | undefined {
    return (
      (this.db.query("SELECT * FROM canvas_edges WHERE id = ?").get(id) as CanvasEdgeRow | null) ??
      undefined
    );
  }

  deleteCanvasEdge(id: string): boolean {
    const edge = this.getCanvasEdge(id);
    if (!edge) return false;
    this.db.run("DELETE FROM canvas_edges WHERE id = ?", [id]);
    this.db.run("UPDATE canvases SET updated_at = ? WHERE id = ?", [Date.now(), edge.canvas_id]);
    return true;
  }

  // ─── Meta Key-Value ────────────────────────────────────────────────────

  getMetaValue(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value ?? undefined;
  }

  setMetaValue(key: string, value: string): void {
    this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value]);
  }

  clearDynamicRooms(): void {
    this.db.run("DELETE FROM room_sources");
  }

  clearDynamicCommands(): void {
    this.db.run("DELETE FROM dynamic_command_history");
    this.db.run("DELETE FROM dynamic_commands");
  }

  // ─── Shell ─────────────────────────────────────────────────────────────

  getShellAllowlist(): string[] {
    const rows = this.db.query("SELECT binary FROM shell_allowlist ORDER BY binary").all() as {
      binary: string;
    }[];
    return rows.map((r) => r.binary);
  }

  isShellAllowed(binary: string): boolean {
    const row = this.db.query("SELECT 1 FROM shell_allowlist WHERE binary = ?").get(binary);
    return row !== null;
  }

  addToShellAllowlist(binary: string, addedBy: string): void {
    this.db.run(
      "INSERT OR IGNORE INTO shell_allowlist (binary, added_by, added_at) VALUES (?, ?, ?)",
      [binary, addedBy, Date.now()],
    );
  }

  removeFromShellAllowlist(binary: string): boolean {
    const result = this.db.run("DELETE FROM shell_allowlist WHERE binary = ?", [binary]);
    return result.changes > 0;
  }

  logShellExec(
    entityId: string,
    binary: string,
    args: string,
    exitCode: number | null,
    outputLength: number,
  ): void {
    this.db.run(
      "INSERT INTO shell_log (entity_id, binary, args, exit_code, output_length, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [entityId, binary, args, exitCode, outputLength, Date.now()],
    );
  }

  getShellHistory(entityId: string, limit = 10): ShellLogRow[] {
    return this.db
      .query("SELECT * FROM shell_log WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(entityId, limit) as ShellLogRow[];
  }

  getShellLog(entityId: string | null, limit = 10): ShellLogRow[] {
    if (entityId) {
      return this.db
        .query("SELECT * FROM shell_log WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(entityId, limit) as ShellLogRow[];
    }
    return this.db
      .query("SELECT * FROM shell_log ORDER BY created_at DESC LIMIT ?")
      .all(limit) as ShellLogRow[];
  }

  // ─── Entity Migration (delegated to db-entities.ts) ─────────────────────

  migrateEntityId(oldId: string, newId: string): void {
    entitiesDb.migrateEntityId(this.db, oldId, newId);
  }

  migrateTaskClaimsByName(entityName: string, newId: string): void {
    entitiesDb.migrateTaskClaimsByName(this.db, entityName, newId);
  }

  /** Get active task claims for an entity by name. */
  getActiveClaimsByName(entityName: string): {
    task_id: number;
    title: string;
    status: string;
    priority: number;
    progress: number;
    claimed_at: number;
  }[] {
    return entitiesDb.getActiveClaimsByName(this.db, entityName);
  }

  /** Get recent activity entries for an entity. */
  getRecentActivity(
    entityName: string,
    limit = 5,
  ): { activity_type: string; activity_key: string; count: number; last_seen: number }[] {
    return entitiesDb.getRecentActivity(this.db, entityName, limit);
  }

  // ─── Markets ───────────────────────────────────────────────────────────

  createMarket(market: { id: string; roomId: string; question: string; category?: string }): void {
    this.db.run(
      "INSERT OR IGNORE INTO markets (id, room_id, question, category, created_at) VALUES (?, ?, ?, ?, ?)",
      [market.id, market.roomId, market.question, market.category ?? "", Date.now()],
    );
  }

  getMarket(id: string): MarketRow | undefined {
    return (
      (this.db.query("SELECT * FROM markets WHERE id = ?").get(id) as MarketRow | null) ?? undefined
    );
  }

  getMarketByRoom(roomId: string): MarketRow | undefined {
    return (
      (this.db.query("SELECT * FROM markets WHERE room_id = ?").get(roomId) as MarketRow | null) ??
      undefined
    );
  }

  listMarkets(opts?: { status?: string; category?: string; limit?: number }): MarketRow[] {
    const limit = opts?.limit ?? 50;
    if (opts?.status) {
      return this.db
        .query("SELECT * FROM markets WHERE status = ? ORDER BY created_at DESC LIMIT ?")
        .all(opts.status, limit) as MarketRow[];
    }
    if (opts?.category) {
      return this.db
        .query("SELECT * FROM markets WHERE category = ? ORDER BY created_at DESC LIMIT ?")
        .all(opts.category, limit) as MarketRow[];
    }
    return this.db
      .query("SELECT * FROM markets ORDER BY created_at DESC LIMIT ?")
      .all(limit) as MarketRow[];
  }

  searchMarkets(query: string): MarketRow[] {
    return this.db
      .query(
        `SELECT m.* FROM markets m
         JOIN markets_fts f ON m.rowid = f.rowid
         WHERE markets_fts MATCH ?
         ORDER BY rank LIMIT 20`,
      )
      .all(query) as MarketRow[];
  }

  upsertPosition(
    marketId: string,
    entityName: string,
    direction: string,
    confidence: number,
    reasoning: string,
  ): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO market_positions (market_id, entity_name, direction, confidence, reasoning, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(market_id, entity_name)
       DO UPDATE SET direction = excluded.direction, confidence = excluded.confidence,
                     reasoning = excluded.reasoning, updated_at = excluded.updated_at`,
      [marketId, entityName, direction, confidence, reasoning, now, now],
    );
  }

  getMarketPositions(marketId: string): MarketPositionRow[] {
    return this.db
      .query("SELECT * FROM market_positions WHERE market_id = ? ORDER BY updated_at DESC")
      .all(marketId) as MarketPositionRow[];
  }

  resolveMarket(marketId: string, outcome: string, resolvedBy: string): void {
    this.db.run(
      "UPDATE markets SET status = 'resolved', outcome = ?, resolved_at = ?, resolved_by = ? WHERE id = ?",
      [outcome, Date.now(), resolvedBy, marketId],
    );
  }

  recordMarketScore(
    marketId: string,
    entityName: string,
    brierScore: number,
    correct: boolean,
  ): void {
    this.db.run(
      "INSERT INTO market_scores (market_id, entity_name, brier_score, correct, scored_at) VALUES (?, ?, ?, ?, ?)",
      [marketId, entityName, brierScore, correct ? 1 : 0, Date.now()],
    );
  }

  getCalibrationLeaderboard(limit = 20): {
    entity_name: string;
    avg_brier: number;
    markets_scored: number;
    correct_count: number;
  }[] {
    return this.db
      .query(
        `SELECT entity_name, AVG(brier_score) as avg_brier,
                COUNT(*) as markets_scored, SUM(correct) as correct_count
         FROM market_scores
         GROUP BY entity_name
         HAVING markets_scored >= 1
         ORDER BY avg_brier ASC
         LIMIT ?`,
      )
      .all(limit) as {
      entity_name: string;
      avg_brier: number;
      markets_scored: number;
      correct_count: number;
    }[];
  }

  getEntityMarketScore(entityName: string):
    | {
        avg_brier: number;
        markets_scored: number;
        correct_count: number;
      }
    | undefined {
    return (
      (this.db
        .query(
          `SELECT AVG(brier_score) as avg_brier, COUNT(*) as markets_scored,
                  SUM(correct) as correct_count
           FROM market_scores WHERE entity_name = ?`,
        )
        .get(entityName) as {
        avg_brier: number;
        markets_scored: number;
        correct_count: number;
      } | null) ?? undefined
    );
  }

  // ─── Traits (delegated to db-agents.ts) ──────────────────────────────────

  saveTrait(opts: {
    name: string;
    category: string;
    prompt: string;
    capabilities?: TraitCapabilities;
    createdBy: string;
  }): void {
    agentsDb.saveTrait(this.db, opts);
  }
  getTrait(name: string): TraitRow | undefined {
    return agentsDb.getTrait(this.db, name);
  }
  getAllTraits(): TraitRow[] {
    return agentsDb.getAllTraits(this.db);
  }
  getTraitsByCategory(category: string): TraitRow[] {
    return agentsDb.getTraitsByCategory(this.db, category);
  }
  deleteTrait(name: string): void {
    agentsDb.deleteTrait(this.db, name);
  }

  // ─── Roles (delegated to db-agents.ts) ─────────────────────────────────

  saveRole(opts: {
    name: string;
    description?: string;
    traits?: string[];
    guidelines?: string[];
    focus?: string[];
    tone?: string;
    origin?: string;
    createdBy: string;
  }): void {
    agentsDb.saveRole(this.db, opts);
  }
  getRole(name: string): RoleRow | undefined {
    return agentsDb.getRole(this.db, name);
  }
  getAllRoles(): RoleRow[] {
    return agentsDb.getAllRoles(this.db);
  }
  deleteRole(name: string): void {
    agentsDb.deleteRole(this.db, name);
  }

  // ─── Agent Configs (delegated to db-agents.ts) ─────────────────────────

  saveAgentConfig(opts: {
    name: string;
    model: string;
    role?: string;
    goal?: string;
    keyName?: string;
    room?: string;
    spawnedBy: string;
  }): void {
    agentsDb.saveAgentConfig(this.db, opts);
  }
  getAgentConfig(name: string): AgentConfigRow | undefined {
    return agentsDb.getAgentConfig(this.db, name);
  }
  getAllAgentConfigs(): AgentConfigRow[] {
    return agentsDb.getAllAgentConfigs(this.db);
  }
  getAgentConfigsBySpawnedBy(spawnedBy: string): AgentConfigRow[] {
    return agentsDb.getAgentConfigsBySpawnedBy(this.db, spawnedBy);
  }
  deleteAgentConfig(name: string): void {
    agentsDb.deleteAgentConfig(this.db, name);
  }

  // ─── Settings (delegated to db-agents.ts) ──────────────────────────────

  getSetting(key: string): string | undefined {
    return agentsDb.getSetting(this.db, key);
  }
  setSetting(key: string, value: string): void {
    agentsDb.setSetting(this.db, key, value);
  }
  deleteSetting(key: string): void {
    agentsDb.deleteSetting(this.db, key);
  }
  /** Effective default model — DB `default_model` setting, else MARINA_DEFAULT_MODEL. */
  getDefaultModel(): string {
    return agentsDb.getDefaultModel(this.db);
  }

  // ─── API Keys (delegated to db-agents.ts) ──────────────────────────────

  saveApiKey(opts: {
    name: string;
    provider: string;
    encryptedValue: string;
    isEncrypted?: boolean;
    setBy: string;
  }): void {
    agentsDb.saveApiKey(this.db, opts);
  }
  getApiKey(name: string): ApiKeyRow | undefined {
    return agentsDb.getApiKey(this.db, name);
  }
  getApiKeysByProvider(provider: string): ApiKeyRow[] {
    return agentsDb.getApiKeysByProvider(this.db, provider);
  }
  getAllApiKeys(): ApiKeyRow[] {
    return agentsDb.getAllApiKeys(this.db);
  }
  deleteApiKey(name: string): void {
    agentsDb.deleteApiKey(this.db, name);
  }

  // ─── Adapters (delegated to db-agents.ts) ──────────────────────────────

  saveAdapter(opts: { platform: string; config: string; status: string; setBy: string }): void {
    agentsDb.saveAdapter(this.db, opts);
  }
  getAdapter(platform: string): AdapterRow | undefined {
    return agentsDb.getAdapter(this.db, platform);
  }
  getAllAdapters(): AdapterRow[] {
    return agentsDb.getAllAdapters(this.db);
  }
  updateAdapterStatus(platform: string, status: string): void {
    agentsDb.updateAdapterStatus(this.db, platform, status);
  }
  deleteAdapter(platform: string): void {
    agentsDb.deleteAdapter(this.db, platform);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Checkpoint WAL file to reduce its size */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  /**
   * Clone the live database into a self-contained file at `targetPath` using
   * SQLite's VACUUM INTO. The WAL is checkpointed first so the snapshot
   * reflects committed state. Returns summary counts for metadata.
   *
   * Fails if `targetPath` already exists (VACUUM INTO refuses to overwrite).
   */
  snapshot(targetPath: string): {
    notes: number;
    pools: number;
    benchmarkRuns: number;
    entities: number;
    bytes: number;
  } {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const escaped = targetPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);

    const count = (sql: string): number => {
      try {
        const row = this.reader.query(sql).get() as { n: number } | null;
        return row?.n ?? 0;
      } catch {
        return 0;
      }
    };
    const notes = count("SELECT COUNT(*) as n FROM notes");
    const pools = count("SELECT COUNT(DISTINCT pool_id) as n FROM notes WHERE pool_id IS NOT NULL");
    const benchmarkRuns = count("SELECT COUNT(*) as n FROM benchmark_runs");
    const entities = count("SELECT COUNT(*) as n FROM entities");
    let bytes = 0;
    try {
      bytes = statSync(targetPath).size;
    } catch {
      /* stat failure is non-fatal */
    }
    return { notes, pools, benchmarkRuns, entities, bytes };
  }

  /**
   * Clone + prune. Produces a compacted snapshot at `targetPath` by first
   * VACUUM-ing into the target, then running safe pruning passes on the
   * target file (never touching the live DB), then VACUUM-ing again to
   * reclaim freed pages.
   *
   * Why: during the 2026-04-23 Gen-1 saturation investigation we found that
   * a warm snapshot accumulated 4945 `[compaction]` summary notes averaging
   * 150KB each — **99.8% of the DB's note content was compaction chaff**.
   * FTS5 recall had to scan that bulk on every turn. Pruning transient
   * metadata gives the snapshot a fighting chance to be faster than its
   * predecessor instead of slower. Generational memory with a compaction
   * discipline, not an accumulation race.
   *
   * What's dropped (opts control the thresholds):
   *  - `[compaction]`-prefixed notes (transient per-turn metadata written
   *    by the context manager's onBeforeCompact callback; capped at 2KB
   *    for new writes but legacy ones can be 100KB+)
   *  - Orphaned note_links (source or target note no longer exists after
   *    pruning)
   *  - entity_activity rows older than a cutoff (default 30 days)
   *
   * What's NEVER dropped:
   *  - Skills (note_type = 'skill')
   *  - Reflections (note_type = 'reflection')
   *  - High-importance notes (importance >= 7)
   *  - Pool notes with pool_id set (shared knowledge)
   *  - Core memory, agent_configs, entities, benchmark_runs,
   *    canvas/feed/session/auth data (schema-wise untouched)
   *
   * Dry-run mode (opts.dryRun=true) writes nothing — runs the counting
   * queries against a throwaway in-memory copy and returns what would
   * happen. Useful for `admin snapshot --compact --dry-run`.
   *
   * Returns a CompactionStats record: before / after / dropped counts +
   * disk-size delta.
   */
  snapshotCompacted(targetPath: string, opts?: CompactionOpts): CompactionStats {
    const {
      dropCompactionSummaries = true,
      compactionOlderThanDays = 0, // 0 = drop all; >0 = only older than N days
      activityOlderThanDays = 30,
      dropOrphanedLinks = true,
    } = opts ?? {};

    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const escaped = targetPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);

    // Open the target as a separate connection for pruning. Never pollute
    // the live DB.
    const target = new Database(targetPath);
    target.exec("PRAGMA foreign_keys=OFF"); // allow cascades we do manually

    const before = {
      notes: target.query("SELECT COUNT(*) AS n FROM notes").get() as { n: number },
      links: target.query("SELECT COUNT(*) AS n FROM note_links").get() as { n: number },
      activity: target.query("SELECT COUNT(*) AS n FROM entity_activity").get() as { n: number },
      entities: target.query("SELECT COUNT(*) AS n FROM entities").get() as { n: number },
    };
    const beforeBytes = statSync(targetPath).size;

    const dropped = {
      compactionSummaries: 0,
      orphanedLinks: 0,
      staleActivity: 0,
    };

    // Count rows matching a predicate — used for accurate deletion reporting
    // since bun:sqlite's `res.changes` counts trigger-fired side effects too.
    const countRows = (sql: string, params: unknown[] = []): number => {
      const row = target.query(sql).get(...(params as [])) as { n: number } | null;
      return row?.n ?? 0;
    };

    // 1. Drop compaction-summary notes. Skills, reflections, high-importance
    //    notes, and pool-deposited notes are explicitly preserved even if
    //    they (somehow) start with [compaction] — paranoid belt-and-suspenders.
    if (dropCompactionSummaries) {
      const ageCutoff =
        compactionOlderThanDays > 0
          ? Date.now() - compactionOlderThanDays * 86_400_000
          : Date.now() + 1; // future → matches everything
      dropped.compactionSummaries = countRows(
        `SELECT COUNT(*) AS n FROM notes
           WHERE content LIKE '[compaction]%'
             AND created_at < ?
             AND note_type NOT IN ('skill', 'reflection')
             AND importance < 7
             AND pool_id IS NULL`,
        [ageCutoff],
      );
      target.run(
        `DELETE FROM notes
           WHERE content LIKE '[compaction]%'
             AND created_at < ?
             AND note_type NOT IN ('skill', 'reflection')
             AND importance < 7
             AND pool_id IS NULL`,
        [ageCutoff],
      );
    }

    // 2. Drop orphaned note_links (source or target vanished — common
    //    after compaction-summary pruning above).
    if (dropOrphanedLinks) {
      dropped.orphanedLinks = countRows(
        `SELECT COUNT(*) AS n FROM note_links
           WHERE source_id NOT IN (SELECT id FROM notes)
              OR target_id NOT IN (SELECT id FROM notes)`,
      );
      target.run(
        `DELETE FROM note_links
           WHERE source_id NOT IN (SELECT id FROM notes)
              OR target_id NOT IN (SELECT id FROM notes)`,
      );
    }

    // 3. Drop stale entity_activity rows.
    if (activityOlderThanDays > 0) {
      const activityCutoff = Date.now() - activityOlderThanDays * 86_400_000;
      dropped.staleActivity = countRows(
        "SELECT COUNT(*) AS n FROM entity_activity WHERE last_seen < ?",
        [activityCutoff],
      );
      target.run("DELETE FROM entity_activity WHERE last_seen < ?", [activityCutoff]);
    }

    // 4. Reclaim space. The FTS5 triggers fire on note DELETE and keep the
    //    virtual index in sync automatically.
    target.exec("VACUUM");

    const after = {
      notes: target.query("SELECT COUNT(*) AS n FROM notes").get() as { n: number },
      links: target.query("SELECT COUNT(*) AS n FROM note_links").get() as { n: number },
      activity: target.query("SELECT COUNT(*) AS n FROM entity_activity").get() as { n: number },
      entities: target.query("SELECT COUNT(*) AS n FROM entities").get() as { n: number },
    };
    target.close();
    const afterBytes = statSync(targetPath).size;

    return {
      before: {
        notes: before.notes.n,
        links: before.links.n,
        activity: before.activity.n,
        entities: before.entities.n,
        bytes: beforeBytes,
      },
      after: {
        notes: after.notes.n,
        links: after.links.n,
        activity: after.activity.n,
        entities: after.entities.n,
        bytes: afterBytes,
      },
      dropped,
    };
  }

  close(): void {
    try {
      this.reader.close();
    } catch {
      /* already closed */
    }
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

// ─── Row Types (remaining — channel/board/group/task/note/agent types moved to modules) ──

export interface CompactionOpts {
  /** Drop `[compaction]`-prefixed transient summary notes. Default true. */
  dropCompactionSummaries?: boolean;
  /** Only drop compaction notes older than this many days. 0 = drop all. Default 0. */
  compactionOlderThanDays?: number;
  /** Drop entity_activity rows older than this many days. Default 30. */
  activityOlderThanDays?: number;
  /** Drop note_links whose source or target no longer exists. Default true. */
  dropOrphanedLinks?: boolean;
}

export interface CompactionStats {
  before: { notes: number; links: number; activity: number; entities: number; bytes: number };
  after: { notes: number; links: number; activity: number; entities: number; bytes: number };
  dropped: { compactionSummaries: number; orphanedLinks: number; staleActivity: number };
}

export interface MacroRow {
  id: number;
  name: string;
  author_id: string;
  command: string;
  created_at: number;
  updated_at: number;
}

interface RoomSourceRow {
  room_id: string;
  version: number;
  source: string;
  author_id: string;
  author_name: string;
  valid: number;
  created_at: number;
}

interface RoomTemplateRow {
  name: string;
  source: string;
  author_id: string;
  author_name: string;
  description: string;
  created_at: number;
}

interface UserRow {
  id: string;
  name: string;
  created_at: number;
  last_login: number;
  rank: number;
  properties: string;
  /** better-auth subject bound to this named user (null unless MARINA_AUTH on). */
  auth_subject?: string | null;
  /** Verified email from the bound identity (used for admin-by-email). */
  auth_email?: string | null;
}

interface BanRow {
  name: string;
  reason: string;
  banned_by: string;
  created_at: number;
}

interface AdapterLinkRow {
  adapter: string;
  external_id: string;
  user_id: string;
  created_at: number;
}

export interface AdapterUserMappingRow {
  platform: string;
  platform_user_id: string;
  entity_name: string;
  created_at: number;
}

interface ExperimentRow {
  id: number;
  name: string;
  description: string;
  config: string;
  status: string;
  creator_name: string;
  required_agents: number;
  time_limit: number | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface ExperimentParticipantRow {
  experiment_id: number;
  entity_name: string;
  joined_at: number;
}

interface ExperimentResultRow {
  id: number;
  experiment_id: number;
  entity_name: string;
  metric_name: string;
  metric_value: number;
  recorded_at: number;
}

interface CommandSourceRow {
  id: string;
  name: string;
  source: string;
  version: number;
  valid: number;
  created_by: string;
  created_at: number;
}

interface CommandHistoryRow {
  id: number;
  command_id: string;
  source: string;
  version: number;
  edited_by: string;
  edited_at: number;
}

interface ConnectorRow {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string | null;
  auth_type: string | null;
  auth_data: string | null;
  lifecycle: string;
  created_by: string;
  created_at: number;
  status: string;
}

interface AssetRow {
  id: string;
  entity_name: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_key: string;
  metadata: string;
  created_at: number;
}

interface CanvasRow {
  id: string;
  name: string;
  description: string;
  scope: string;
  scope_id: string | null;
  creator_name: string;
  created_at: number;
  updated_at: number;
}

interface CanvasNodeRow {
  id: string;
  canvas_id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  asset_id: string | null;
  data: string;
  creator_name: string;
  parent_node_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CanvasEdgeRow {
  id: string;
  canvas_id: string;
  source_id: string;
  target_id: string;
  relationship: string;
  data: string | null;
  creator_name: string;
  created_at: number;
}

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

interface ShellLogRow {
  id: number;
  entity_id: string;
  binary: string;
  args: string;
  exit_code: number | null;
  output_length: number;
  created_at: number;
}

interface GatewayRow {
  id: string;
  name: string;
  url: string;
  created_by: string;
  created_at: number;
  status: string;
}

export interface MarketRow {
  id: string;
  room_id: string;
  question: string;
  category: string;
  status: string;
  outcome: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
  created_at: number;
}

export interface MarketPositionRow {
  id: number;
  market_id: string;
  entity_name: string;
  direction: string;
  confidence: number;
  reasoning: string;
  created_at: number;
  updated_at: number;
}
