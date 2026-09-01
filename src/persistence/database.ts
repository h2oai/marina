// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import type { AgentSupports } from "../agent/agent-types";
import type { Session } from "../auth/session-manager";
import type { NoteTier } from "../engine/constants";
import type { EngineEvent, Entity, EntityId, RoomId } from "../types";
import type { TraitCapabilities } from "./db-agents";
import * as agentsDb from "./db-agents";
import * as associationsDb from "./db-associations";
import * as channelsDb from "./db-channels";
import * as chronicleDb from "./db-chronicle";
import * as cognitiveEventsDb from "./db-cognitive-events";
import * as competenceDb from "./db-competence";
import * as crewsDb from "./db-crews";
import * as economicsDb from "./db-economics";
import * as entitiesDb from "./db-entities";
import * as evidenceDb from "./db-evidence";
import * as federationDb from "./db-federation";
import * as feedDb from "./db-feed";
import * as intellectsDb from "./db-intellects";
import * as journeysDb from "./db-journeys";
import * as logsDb from "./db-logs";
import * as mediaDb from "./db-media";
import * as meshesDb from "./db-meshes";
import * as mutationsDb from "./db-mutations";
import * as notesDb from "./db-notes";
import * as principalsDb from "./db-principals";
import * as reproductionDb from "./db-reproduction";
import * as simulationsDb from "./db-simulations";
import * as standingDb from "./db-standing";
import * as tasksDb from "./db-tasks";
import * as worldVariantsDb from "./db-world-variants";

export type {
  AdapterRow,
  AgentConfigRow,
  ApiKeyRow,
  EditHistoryRow,
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
export type {
  EconomicAdapterRow,
  EconomicContractRow,
  EconomicEventKind,
  EconomicEventRow,
} from "./db-economics";
export { ECONOMIC_EVENT_KINDS } from "./db-economics";
export type { MediaJobRow, MediaJobStatus, MediaJobType } from "./db-media";
export type { StandingCacheRow, StandingLedgerRow } from "./db-standing";
export type { TaskClaimRow, TaskRow } from "./db-tasks";

import type {
  AdapterRow,
  AgentConfigRow,
  ApiKeyRow,
  EditHistoryRow,
  RoleRow,
  TraitRow,
} from "./db-agents";
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
  AssociationDirection,
  AssociationEventKind,
  AssociationEventRow,
  AssociationLinkRow,
  AssociationParticipant,
  AssociationProjection,
  AssociationRelationRow,
  AssociationRow,
} from "./db-associations";
export { ASSOCIATION_DIRECTIONS, ASSOCIATION_EVENT_KINDS } from "./db-associations";
export type {
  ChronicleEntry,
  ChronicleKind,
  ChronicleQuery,
  InsertChronicle,
} from "./db-chronicle";
export type {
  CognitiveEventKind,
  CognitiveEventRow,
  CognitiveVerification,
} from "./db-cognitive-events";
export { COGNITIVE_EVENT_KINDS } from "./db-cognitive-events";
export type { FeedEventRow, FeedQuery, InsertFeedEvent } from "./db-feed";
export type {
  IntellectEventKind,
  IntellectEventRow,
  IntellectInstanceRow,
  IntellectRow,
} from "./db-intellects";
export { INTELLECT_EVENT_KINDS } from "./db-intellects";
export type {
  JourneyEventKind,
  JourneyEventRow,
  JourneyLinkKind,
  JourneyLinkRow,
  JourneyRow,
  JourneyWitnessRow,
} from "./db-journeys";
export { JOURNEY_EVENT_KINDS, JOURNEY_LINK_KINDS } from "./db-journeys";
export type {
  MeshEventRow,
  MeshMembershipEventRow,
  MeshRow,
  MeshTranslationRow,
  MeshWitnessRow,
} from "./db-meshes";
export type { CivilizationMutationRow, MutationDisposition } from "./db-mutations";
export type {
  CoreMemoryHistoryRow,
  CoreMemoryRow,
  MemApiKeyRow,
  MemoryPoolRow,
  NoteLinkRow,
  NoteRow,
  ScoredNoteRow,
} from "./db-notes";
export type {
  CognitiveReproductionComponentRow,
  CognitiveReproductionRow,
  ComponentDisposition,
  MarinaDescendantRow,
  MarinaGenomeRow,
} from "./db-reproduction";
export type {
  ReproducibilityLevel,
  SimulationComparisonRow,
  SimulationEventRow,
  SimulationManifestRow,
  SimulationMode,
  SimulationRunRow,
} from "./db-simulations";

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
];

export interface OperationalAlertRow {
  id: number;
  alert_key: string;
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  remedy: string;
  status: "open" | "acknowledged" | "resolved";
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  acknowledged_at: number | null;
  resolved_at: number | null;
  attention_kind: string;
  source_entity: string | null;
  target_entity: string | null;
  assigned_to: string | null;
  action_label: string | null;
  action_ref: string | null;
  metadata: string | null;
  seen_at: number | null;
  snoozed_until: number | null;
  deadline_at: number | null;
}

export interface ProductivitySummary {
  entityName: string | null;
  outcomes: number;
  successes: number;
  failures: number;
  successRate: number;
  averageDurationMs: number;
  medianDurationMs: number;
  averageToolCalls: number;
  averageHandoffs: number;
  outcomesLast7d: number;
}
export interface ProductivityTrendPoint {
  date: string;
  outcomes: number;
  successes: number;
  averageDurationMs: number;
  averageToolCalls: number;
  averageHandoffs: number;
}

export interface PrimitiveUsageSummary {
  entityName: string | null;
  commands: number;
  meaningfulActions: number;
  meaningfulRate: number;
  worldActions: number;
  communications: number;
  primitiveDiversity: number;
  activeParticipants: number;
  activeAgents: number;
  toolCalls: number;
  marinaToolCalls: number;
  reasoningOnlyCalls: number;
  consequentialToolCalls: number;
  untrustedToolCalls: number;
  lastActionAt: number | null;
  outcomeSessions: number;
  approvedMeaningfulAverage: number;
  failedMeaningfulAverage: number;
  topPrimitives: Array<{ primitive: string; count: number }>;
  promptVersions: string[];
}

export interface PromptOutcomeSummary {
  promptVersion: string;
  agents: number;
  outcomes: number;
  successes: number;
  failures: number;
  successRate: number;
  averageDurationMs: number;
  averageToolCalls: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  averageCostUsd: number;
  meaningfulActions: number;
}

export interface DirectMessageRow {
  id: number;
  correlation_id: string;
  dedupe_key: string;
  sender_id: string;
  sender_name: string;
  target_id: string;
  target_name: string;
  content: string;
  status: "delivered" | "acknowledged" | "expired";
  created_at: number;
  delivered_at: number | null;
  deadline_at: number | null;
  acknowledged_at: number | null;
  reply_message_id: number | null;
}

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

  getRecentTraceEvents(
    limit = 5000,
    traceId?: string,
  ): { events: EngineEvent[]; truncated: boolean } {
    return entitiesDb.getRecentTraceEvents(this.reader, limit, traceId);
  }

  addTraceJudgment(input: entitiesDb.TraceJudgmentInput): entitiesDb.TraceJudgmentRow {
    return this.db.transaction(() => {
      const row = entitiesDb.addTraceJudgment(this.db, input);
      evidenceDb.appendEvidenceReceipt(this.db, {
        eventType: "trace_judgment",
        ref: `trace:${row.traceId}/judgment:${row.id}`,
        payload: row,
        createdAt: row.createdAt,
      });
      return row;
    })();
  }

  getTraceJudgments(traceId: string, limit = 100): entitiesDb.TraceJudgmentRow[] {
    return entitiesDb.getTraceJudgments(this.reader, traceId, limit);
  }

  appendEvidenceReceipt(
    input: Parameters<typeof evidenceDb.appendEvidenceReceipt>[1],
  ): evidenceDb.EvidenceReceiptRow {
    return evidenceDb.appendEvidenceReceipt(this.db, input);
  }

  listEvidenceReceipts(limit = 100): evidenceDb.EvidenceReceiptRow[] {
    return evidenceDb.listEvidenceReceipts(this.reader, limit);
  }

  verifyEvidenceChain(): evidenceDb.EvidenceVerification {
    return evidenceDb.verifyEvidenceChain(this.reader);
  }

  getEventCount(): number {
    return entitiesDb.getEventCount(this.db);
  }

  // ─── Structured Logs (delegated to db-logs.ts) ──────────────────────

  appendStructuredLog(entry: logsDb.StoredLogEntry | Omit<logsDb.StoredLogEntry, "id">): number {
    return logsDb.appendLog(this.db, entry);
  }

  queryStructuredLogs(query: logsDb.LogQuery = {}): logsDb.LogPage {
    return logsDb.queryLogs(this.reader, query);
  }

  pruneStructuredLogs(keepLast: number): number {
    return logsDb.pruneLogs(this.db, keepLast);
  }

  pruneEvents(keepLast: number): void {
    entitiesDb.pruneEvents(this.db, keepLast);
  }

  // ─── Journeys (delegated to db-journeys.ts) ──────────────────────────

  createJourney(input: Parameters<typeof journeysDb.createJourney>[1]): journeysDb.JourneyRow {
    return journeysDb.createJourney(this.db, input);
  }

  getJourney(id: string): journeysDb.JourneyRow | undefined {
    return journeysDb.getJourney(this.reader, id);
  }

  getLatestJourneyForRequester(requesterId: string): journeysDb.JourneyRow | undefined {
    return journeysDb.getLatestJourneyForRequester(this.reader, requesterId);
  }

  listJourneys(input: Parameters<typeof journeysDb.listJourneys>[1] = {}): journeysDb.JourneyRow[] {
    return journeysDb.listJourneys(this.reader, input);
  }

  addJourneyLink(
    input: Parameters<typeof journeysDb.addJourneyLink>[1],
  ): journeysDb.JourneyLinkRow {
    return journeysDb.addJourneyLink(this.db, input);
  }

  listJourneyLinks(journeyId: string): journeysDb.JourneyLinkRow[] {
    return journeysDb.listJourneyLinks(this.reader, journeyId);
  }

  appendJourneyEvent(
    input: Parameters<typeof journeysDb.appendJourneyEvent>[1],
  ): journeysDb.JourneyEventRow {
    return journeysDb.appendJourneyEvent(this.db, input);
  }

  listJourneyEvents(journeyId: string, limit = 200): journeysDb.JourneyEventRow[] {
    return journeysDb.listJourneyEvents(this.reader, journeyId, limit);
  }

  getJourneyWitness(journeyId: string, viewerId: string): journeysDb.JourneyWitnessRow | undefined {
    return journeysDb.getJourneyWitness(this.reader, journeyId, viewerId);
  }

  witnessJourney(
    journeyId: string,
    viewerId: string,
    eventId: number,
  ): journeysDb.JourneyWitnessRow {
    return journeysDb.witnessJourney(this.db, journeyId, viewerId, eventId);
  }

  // ─── Cognitive provenance (delegated to db-cognitive-events.ts) ───────

  appendCognitiveEvent(
    input: Parameters<typeof cognitiveEventsDb.appendCognitiveEvent>[1],
  ): cognitiveEventsDb.CognitiveEventRow {
    return cognitiveEventsDb.appendCognitiveEvent(this.db, input);
  }

  listCognitiveEvents(
    input: Parameters<typeof cognitiveEventsDb.listCognitiveEvents>[1] = {},
  ): cognitiveEventsDb.CognitiveEventRow[] {
    return cognitiveEventsDb.listCognitiveEvents(this.reader, input);
  }

  verifyCognitiveEvent(row: cognitiveEventsDb.CognitiveEventRow) {
    return cognitiveEventsDb.verifyCognitiveEvent(row);
  }

  // ─── Intellect identity and lifecycle (delegated to db-intellects.ts) ──

  createIntellect(input: Parameters<typeof intellectsDb.createIntellect>[1]) {
    return intellectsDb.createIntellect(this.db, input);
  }
  getIntellect(id: string) {
    return intellectsDb.getIntellect(this.reader, id);
  }
  listIntellects(limit = 100) {
    return intellectsDb.listIntellects(this.reader, limit);
  }
  createIntellectInstance(input: Parameters<typeof intellectsDb.createIntellectInstance>[1]) {
    return intellectsDb.createIntellectInstance(this.db, input);
  }
  listIntellectInstances(intellectId: string) {
    return intellectsDb.listIntellectInstances(this.reader, intellectId);
  }
  appendIntellectEvent(input: Parameters<typeof intellectsDb.appendIntellectEvent>[1]) {
    return intellectsDb.appendIntellectEvent(this.db, input);
  }
  listIntellectEvents(intellectId: string) {
    return intellectsDb.listIntellectEvents(this.reader, intellectId);
  }
  verifyIntellectEvent(row: intellectsDb.IntellectEventRow) {
    return intellectsDb.verifyIntellectEvent(row);
  }

  // ─── Generalized association (delegated to db-associations.ts) ───────

  createAssociation(input: Parameters<typeof associationsDb.createAssociation>[1]) {
    return associationsDb.createAssociation(this.db, input);
  }
  getAssociation(id: string) {
    return associationsDb.getAssociation(this.reader, id);
  }
  listAssociations(limit = 100) {
    return associationsDb.listAssociations(this.reader, limit);
  }
  appendAssociationEvent(input: Parameters<typeof associationsDb.appendAssociationEvent>[1]) {
    return associationsDb.appendAssociationEvent(this.db, input);
  }
  listAssociationEvents(associationId: string) {
    return associationsDb.listAssociationEvents(this.reader, associationId);
  }
  declareAssociationRelation(
    input: Parameters<typeof associationsDb.declareAssociationRelation>[1],
  ) {
    return associationsDb.declareAssociationRelation(this.db, input);
  }
  listAssociationRelations(associationId: string) {
    return associationsDb.listAssociationRelations(this.reader, associationId);
  }
  linkAssociation(input: Parameters<typeof associationsDb.linkAssociation>[1]) {
    return associationsDb.linkAssociation(this.db, input);
  }
  listAssociationLinks(associationId: string) {
    return associationsDb.listAssociationLinks(this.reader, associationId);
  }
  projectAssociation(associationId: string) {
    return associationsDb.projectAssociation(
      this.listAssociationEvents(associationId),
      this.listAssociationRelations(associationId),
    );
  }
  verifyAssociationEvent(row: associationsDb.AssociationEventRow) {
    return associationsDb.verifyAssociationEvent(row);
  }
  verifyAssociationRelation(row: associationsDb.AssociationRelationRow) {
    return associationsDb.verifyAssociationRelation(row);
  }
  verifyAssociationLink(row: associationsDb.AssociationLinkRow) {
    return associationsDb.verifyAssociationLink(row);
  }

  // ─── Cognitive and Marina reproduction ──────────────────────────────

  recordCognitiveReproduction(
    input: Parameters<typeof reproductionDb.recordCognitiveReproduction>[1],
  ) {
    return reproductionDb.recordCognitiveReproduction(this.db, input);
  }
  getCognitiveReproduction(id: string) {
    return reproductionDb.getCognitiveReproduction(this.reader, id);
  }
  listCognitiveReproductions() {
    return reproductionDb.listCognitiveReproductions(this.reader);
  }
  listReproductionComponents(id: string) {
    return reproductionDb.listReproductionComponents(this.reader, id);
  }
  createMarinaGenome(input: Parameters<typeof reproductionDb.createMarinaGenome>[1]) {
    return reproductionDb.createMarinaGenome(this.db, input);
  }
  getMarinaGenome(hash: string) {
    return reproductionDb.getMarinaGenome(this.reader, hash);
  }
  listMarinaGenomes() {
    return reproductionDb.listMarinaGenomes(this.reader);
  }
  createMarinaDescendant(input: Parameters<typeof reproductionDb.createMarinaDescendant>[1]) {
    return reproductionDb.createMarinaDescendant(this.db, input);
  }
  getMarinaDescendant(id: string) {
    return reproductionDb.getMarinaDescendant(this.reader, id);
  }
  listMarinaDescendants() {
    return reproductionDb.listMarinaDescendants(this.reader);
  }

  // ─── Transparent meshes ──────────────────────────────────────────────

  createMesh(input: Parameters<typeof meshesDb.createMesh>[1]) {
    return meshesDb.createMesh(this.db, input);
  }
  getMesh(id: string) {
    return meshesDb.getMesh(this.reader, id);
  }
  listMeshes() {
    return meshesDb.listMeshes(this.reader);
  }
  appendMeshMembershipEvent(input: Parameters<typeof meshesDb.appendMeshMembershipEvent>[1]) {
    return meshesDb.appendMeshMembershipEvent(this.db, input);
  }
  listMeshMembershipEvents(id: string) {
    return meshesDb.listMeshMembershipEvents(this.reader, id);
  }
  appendMeshEvent(input: Parameters<typeof meshesDb.appendMeshEvent>[1]) {
    return meshesDb.appendMeshEvent(this.db, input);
  }
  listMeshEvents(id: string) {
    return meshesDb.listMeshEvents(this.reader, id);
  }
  witnessMeshEvent(input: Parameters<typeof meshesDb.witnessMeshEvent>[1]) {
    return meshesDb.witnessMeshEvent(this.db, input);
  }
  listMeshWitnesses(id: string) {
    return meshesDb.listMeshWitnesses(this.reader, id);
  }
  createMeshTranslation(input: Parameters<typeof meshesDb.createMeshTranslation>[1]) {
    return meshesDb.createMeshTranslation(this.db, input);
  }
  listMeshTranslations(id: string) {
    return meshesDb.listMeshTranslations(this.reader, id);
  }
  verifyMeshEvent(row: meshesDb.MeshEventRow) {
    return meshesDb.verifyMeshEvent(row);
  }
  exportMeshEvent(row: meshesDb.MeshEventRow) {
    return meshesDb.exportMeshEvent(row);
  }
  importMeshEvent(token: string) {
    return meshesDb.importMeshEvent(this.db, token);
  }

  // ─── Asset-neutral economics ────────────────────────────────────────
  createEconomicContract(input: Parameters<typeof economicsDb.createEconomicContract>[1]) {
    return economicsDb.createEconomicContract(this.db, input);
  }
  getEconomicContract(id: string) {
    return economicsDb.getEconomicContract(this.reader, id);
  }
  listEconomicContracts() {
    return economicsDb.listEconomicContracts(this.reader);
  }
  appendEconomicEvent(input: Parameters<typeof economicsDb.appendEconomicEvent>[1]) {
    return economicsDb.appendEconomicEvent(this.db, input);
  }
  listEconomicEvents(id: string) {
    return economicsDb.listEconomicEvents(this.reader, id);
  }
  verifyEconomicEvent(row: economicsDb.EconomicEventRow) {
    return economicsDb.verifyEconomicEvent(row);
  }
  createEconomicAdapter(input: Parameters<typeof economicsDb.createEconomicAdapter>[1]) {
    return economicsDb.createEconomicAdapter(this.db, input);
  }
  listEconomicAdapters() {
    return economicsDb.listEconomicAdapters(this.reader);
  }

  // ─── Unified simulation laboratory ──────────────────────────────────
  createSimulationManifest(input: Parameters<typeof simulationsDb.createSimulationManifest>[1]) {
    return simulationsDb.createSimulationManifest(this.db, input);
  }
  getSimulationManifest(hash: string) {
    return simulationsDb.getSimulationManifest(this.reader, hash);
  }
  listSimulationManifests() {
    return simulationsDb.listSimulationManifests(this.reader);
  }
  createSimulationRun(input: Parameters<typeof simulationsDb.createSimulationRun>[1]) {
    return simulationsDb.createSimulationRun(this.db, input);
  }
  getSimulationRun(id: string) {
    return simulationsDb.getSimulationRun(this.reader, id);
  }
  listSimulationRuns(hash?: string) {
    return simulationsDb.listSimulationRuns(this.reader, hash);
  }
  appendSimulationEvent(input: Parameters<typeof simulationsDb.appendSimulationEvent>[1]) {
    return simulationsDb.appendSimulationEvent(this.db, input);
  }
  listSimulationEvents(id: string) {
    return simulationsDb.listSimulationEvents(this.reader, id);
  }
  createSimulationComparison(
    input: Parameters<typeof simulationsDb.createSimulationComparison>[1],
  ) {
    return simulationsDb.createSimulationComparison(this.db, input);
  }
  listSimulationComparisons() {
    return simulationsDb.listSimulationComparisons(this.reader);
  }

  // ─── Recursive civilization mutation lineage ────────────────────────
  appendCivilizationMutation(input: Parameters<typeof mutationsDb.appendCivilizationMutation>[1]) {
    return mutationsDb.appendCivilizationMutation(this.db, input);
  }
  getCivilizationMutation(id: string) {
    return mutationsDb.getCivilizationMutation(this.reader, id);
  }
  listCivilizationMutations(domain?: string, targetRef?: string) {
    return mutationsDb.listCivilizationMutations(this.reader, domain, targetRef);
  }
  verifyCivilizationMutation(row: mutationsDb.CivilizationMutationRow) {
    return mutationsDb.verifyCivilizationMutation(row);
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
  countBoardPosts(boardId: string, archived = false): number {
    return channelsDb.countBoardPosts(this.db, boardId, archived);
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
  saveCrewInvitation(row: import("./db-crews").CrewInvitationRow): void {
    crewsDb.saveCrewInvitation(this.db, row);
  }
  setCrewInvitationStatus(
    crewId: string,
    agentName: string,
    status: import("./db-crews").CrewInvitationRow["status"],
    respondedAt: number,
  ): void {
    crewsDb.setCrewInvitationStatus(this.db, crewId, agentName, status, respondedAt);
  }
  deleteCrewInvitations(crewId: string): void {
    crewsDb.deleteCrewInvitations(this.db, crewId);
  }
  getOpenCrewInvitations(): import("./db-crews").CrewInvitationRow[] {
    return crewsDb.getOpenCrewInvitations(this.db);
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
  staleStandingEntities(cutoff: number): string[] {
    return standingDb.staleStandingEntities(this.db, cutoff);
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

  countTasks(opts?: { status?: string; groupId?: string; parentId?: number }): number {
    return tasksDb.countTasks(this.db, opts);
  }

  updateTaskStatus(id: number, status: string): void {
    tasksDb.updateTaskStatus(this.db, id, status);
  }

  createTaskClaim(
    taskId: number,
    entityId: string,
    entityName: string,
    leaseExpiresAt?: number,
  ): void {
    tasksDb.createTaskClaim(this.db, taskId, entityId, entityName, leaseExpiresAt);
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

  renewTaskClaim(taskId: number, entityId: string, leaseExpiresAt: number): boolean {
    return tasksDb.renewTaskClaim(this.db, taskId, entityId, leaseExpiresAt);
  }

  recoverExpiredTaskClaims(now = Date.now()): TaskClaimRow[] {
    return tasksDb.recoverExpiredTaskClaims(this.db, now);
  }

  // ─── Durable direct-message receipts ─────────────────────────────────

  createDirectMessage(message: {
    correlationId: string;
    dedupeKey: string;
    senderId: string;
    senderName: string;
    targetId: string;
    targetName: string;
    content: string;
    deadlineAt?: number;
  }): DirectMessageRow {
    const now = Date.now();
    this.expireDirectMessages(now);
    const duplicate = this.db
      .query(
        `SELECT * FROM direct_messages WHERE sender_id = ? AND target_id = ? AND dedupe_key = ?
         AND created_at >= ? AND status IN ('delivered', 'acknowledged') ORDER BY id DESC LIMIT 1`,
      )
      .get(
        message.senderId,
        message.targetId,
        message.dedupeKey,
        now - 30_000,
      ) as DirectMessageRow | null;
    if (duplicate) return duplicate;
    const result = this.db.run(
      `INSERT INTO direct_messages
       (correlation_id, dedupe_key, sender_id, sender_name, target_id, target_name, content,
        status, created_at, delivered_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?)`,
      [
        message.correlationId,
        message.dedupeKey,
        message.senderId,
        message.senderName,
        message.targetId,
        message.targetName,
        message.content,
        now,
        now,
        message.deadlineAt ?? now + 5 * 60_000,
      ],
    );
    return this.getDirectMessage(Number(result.lastInsertRowid))!;
  }

  getDirectMessage(id: number): DirectMessageRow | undefined {
    this.expireDirectMessages();
    return (
      (this.db
        .query("SELECT * FROM direct_messages WHERE id = ?")
        .get(id) as DirectMessageRow | null) ?? undefined
    );
  }

  listDirectMessageInbox(targetId: string, limit = 20): DirectMessageRow[] {
    this.expireDirectMessages();
    return this.db
      .query("SELECT * FROM direct_messages WHERE target_id = ? ORDER BY id DESC LIMIT ?")
      .all(targetId, limit) as DirectMessageRow[];
  }

  acknowledgeDirectMessage(id: number, targetId: string, replyMessageId?: number): boolean {
    const result = this.db.run(
      `UPDATE direct_messages SET status = 'acknowledged', acknowledged_at = ?,
       reply_message_id = COALESCE(?, reply_message_id)
       WHERE id = ? AND target_id = ? AND status = 'delivered'`,
      [Date.now(), replyMessageId ?? null, id, targetId],
    );
    return result.changes > 0;
  }

  expireDirectMessages(now = Date.now()): number {
    const result = this.db.run(
      `UPDATE direct_messages SET status = 'expired'
       WHERE status = 'delivered' AND deadline_at IS NOT NULL AND deadline_at <= ?`,
      [now],
    );
    return result.changes;
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
    principalsDb.ensurePrincipal(this.db, {
      type: "human",
      displayName: user.name,
      principalId: user.id,
    });
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

  /** All user rows, name-ordered. For maintenance/admin tooling. */
  listUsers(): UserRow[] {
    return this.db.query("SELECT * FROM users ORDER BY name").all() as UserRow[];
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
      confidence?: number;
      verificationStatus?: string;
      claimKey?: string;
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

  addNoteSource(noteId: number, source: notesDb.NoteSourceInput): number {
    return notesDb.addNoteSource(this.db, noteId, source);
  }
  getNoteSources(noteId: number): notesDb.NoteSourceRow[] {
    return notesDb.getNoteSources(this.db, noteId);
  }
  recordNoteVerification(
    noteId: number,
    verifier: string,
    status: "unverified" | "verified" | "disputed",
    confidence: number,
    rationale?: string,
    evidenceSourceId?: number,
  ): number {
    return notesDb.recordNoteVerification(
      this.db,
      noteId,
      verifier,
      status,
      confidence,
      rationale,
      evidenceSourceId,
    );
  }
  getNoteVerifications(noteId: number): notesDb.NoteVerificationRow[] {
    return notesDb.getNoteVerifications(this.db, noteId);
  }
  refreshContradictionCases(): number {
    return notesDb.refreshContradictionCases(this.db);
  }
  listContradictionCases(
    status?: "open" | "resolved",
    limit = 100,
  ): notesDb.ContradictionCaseRow[] {
    return notesDb.listContradictionCases(this.db, status, limit);
  }
  resolveContradictionCase(
    id: number,
    resolution: "left" | "right" | "both" | "neither",
    resolvedBy: string,
    rationale: string,
  ): boolean {
    return notesDb.resolveContradictionCase(this.db, id, resolution, resolvedBy, rationale);
  }
  updateNoteQuality(
    id: number,
    entityName: string,
    confidence: number,
    verification: string,
  ): boolean {
    return notesDb.updateNoteQuality(this.db, id, entityName, confidence, verification);
  }
  findMemoryContradictions(entityName: string): notesDb.ContradictionCandidate[] {
    return notesDb.findMemoryContradictions(this.db, entityName);
  }
  consolidateNotes(entityName: string, keeperId: number, duplicateIds: number[]): number {
    return notesDb.consolidateNotes(this.db, entityName, keeperId, duplicateIds);
  }
  getMemoryQualitySummary(entityName?: string): {
    total: number;
    unverified: number;
    disputed: number;
    superseded: number;
    staleSources: number;
    contradictions: number;
  } {
    const where = entityName ? "WHERE entity_name = ?" : "";
    const args = entityName ? [entityName] : [];
    const row = this.db
      .query(
        `SELECT COUNT(*) total,
       SUM(CASE WHEN verification_status='unverified' THEN 1 ELSE 0 END) unverified,
       SUM(CASE WHEN verification_status='disputed' THEN 1 ELSE 0 END) disputed,
       SUM(CASE WHEN verification_status='superseded' THEN 1 ELSE 0 END) superseded
       FROM notes ${where}`,
      )
      .get(...args) as { total: number; unverified: number; disputed: number; superseded: number };
    const sourceWhere = entityName ? "AND n.entity_name = ?" : "";
    const staleSources = (
      this.db
        .query(
          `SELECT COUNT(DISTINCT ns.note_id) c FROM note_sources ns JOIN notes n ON n.id=ns.note_id
       WHERE COALESCE(ns.observed_at, ns.retrieved_at) < ? ${sourceWhere}`,
        )
        .get(Date.now() - 90 * 86_400_000, ...args) as { c: number }
    ).c;
    const entities = entityName
      ? [entityName]
      : (
          this.db.query("SELECT DISTINCT entity_name FROM notes").all() as { entity_name: string }[]
        ).map((r) => r.entity_name);
    const contradictions = entityName
      ? entities.reduce((sum, name) => sum + this.findMemoryContradictions(name).length, 0)
      : this.listContradictionCases("open", 10_000).length;
    return {
      total: row.total,
      unverified: row.unverified ?? 0,
      disputed: row.disputed ?? 0,
      superseded: row.superseded ?? 0,
      staleSources,
      contradictions,
    };
  }

  upsertOperationalAlert(alert: {
    key: string;
    severity: "critical" | "warning" | "info";
    category: string;
    title: string;
    detail: string;
    remedy: string;
    kind?: string;
    sourceEntity?: string;
    targetEntity?: string;
    assignedTo?: string;
    actionLabel?: string;
    actionRef?: string;
    metadata?: Record<string, unknown>;
    deadlineAt?: number;
  }): OperationalAlertRow {
    const now = Date.now();
    this.db.run(
      `INSERT INTO operational_alerts
       (alert_key,severity,category,title,detail,remedy,status,first_seen_at,last_seen_at,
        attention_kind,source_entity,target_entity,assigned_to,action_label,action_ref,metadata,deadline_at)
       VALUES (?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(alert_key) DO UPDATE SET severity=excluded.severity, title=excluded.title,
       detail=excluded.detail, remedy=excluded.remedy, last_seen_at=excluded.last_seen_at,
       attention_kind=excluded.attention_kind, source_entity=excluded.source_entity,
       target_entity=excluded.target_entity, assigned_to=excluded.assigned_to,
       action_label=excluded.action_label, action_ref=excluded.action_ref,
       metadata=excluded.metadata, deadline_at=excluded.deadline_at,
       occurrences=operational_alerts.occurrences+1,
       status=CASE WHEN operational_alerts.status='resolved' THEN 'open' ELSE operational_alerts.status END,
       resolved_at=NULL, snoozed_until=NULL`,
      [
        alert.key,
        alert.severity,
        alert.category,
        alert.title,
        alert.detail,
        alert.remedy,
        now,
        now,
        alert.kind ?? "operational",
        alert.sourceEntity ?? null,
        alert.targetEntity ?? null,
        alert.assignedTo ?? null,
        alert.actionLabel ?? null,
        alert.actionRef ?? null,
        alert.metadata ? JSON.stringify(alert.metadata) : null,
        alert.deadlineAt ?? null,
      ],
    );
    return this.db
      .query("SELECT * FROM operational_alerts WHERE alert_key=?")
      .get(alert.key) as OperationalAlertRow;
  }
  listOperationalAlerts(
    status?: "open" | "acknowledged" | "resolved",
    limit = 100,
  ): OperationalAlertRow[] {
    if (status)
      return this.db
        .query(
          "SELECT * FROM operational_alerts WHERE status=? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,last_seen_at DESC LIMIT ?",
        )
        .all(status, limit) as OperationalAlertRow[];
    return this.db
      .query(
        "SELECT * FROM operational_alerts ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,last_seen_at DESC LIMIT ?",
      )
      .all(limit) as OperationalAlertRow[];
  }
  setOperationalAlertStatus(id: number, status: "acknowledged" | "resolved"): boolean {
    const now = Date.now();
    const column = status === "acknowledged" ? "acknowledged_at" : "resolved_at";
    return (
      this.db.run(`UPDATE operational_alerts SET status=?, ${column}=? WHERE id=?`, [
        status,
        now,
        id,
      ]).changes > 0
    );
  }
  snoozeOperationalAlert(id: number, until: number): boolean {
    return (
      this.db.run(
        "UPDATE operational_alerts SET snoozed_until=?, status='open' WHERE id=? AND status!='resolved'",
        [until, id],
      ).changes > 0
    );
  }
  resolveOperationalAlertsExcept(category: string, activeKeys: string[]): number {
    const now = Date.now();
    if (activeKeys.length === 0)
      return this.db.run(
        "UPDATE operational_alerts SET status='resolved',resolved_at=? WHERE category=? AND status!='resolved'",
        [now, category],
      ).changes;
    const placeholders = activeKeys.map(() => "?").join(",");
    return this.db.run(
      `UPDATE operational_alerts SET status='resolved',resolved_at=? WHERE category=? AND status!='resolved' AND alert_key NOT IN (${placeholders})`,
      [now, category, ...activeKeys],
    ).changes;
  }

  startProductivitySession(
    entityId: string,
    entityName: string,
    taskId: number,
    startedAt: number,
    toolCalls = 0,
    promptVersion?: string,
    inputTokens = 0,
    outputTokens = 0,
    costUsd = 0,
  ): void {
    this.db.run(
      `INSERT OR IGNORE INTO productivity_sessions
       (entity_id,entity_name,task_id,started_at,start_tool_calls,prompt_version,
        start_input_tokens,start_output_tokens,start_cost_usd) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        entityId,
        entityName,
        taskId,
        startedAt,
        toolCalls,
        promptVersion ?? null,
        inputTokens,
        outputTokens,
        costUsd,
      ],
    );
  }
  finishProductivitySession(
    entityId: string,
    entityName: string,
    taskId: number,
    outcome: "approved" | "rejected" | "expired",
    completedAt: number,
    endToolCalls = 0,
    endInputTokens = 0,
    endOutputTokens = 0,
    endCostUsd = 0,
  ): boolean {
    let session = this.db
      .query(
        "SELECT * FROM productivity_sessions WHERE entity_id=? AND task_id=? AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(entityId, taskId) as { id: number; started_at: number; start_tool_calls: number } | null;
    if (!session) {
      const claim = this.getTaskClaim(taskId, entityId);
      this.startProductivitySession(
        entityId,
        entityName,
        taskId,
        claim?.claimed_at ?? completedAt,
        0,
      );
      session = this.db
        .query(
          "SELECT * FROM productivity_sessions WHERE entity_id=? AND task_id=? AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1",
        )
        .get(entityId, taskId) as typeof session;
    }
    if (!session) return false;
    const handoffs = (
      this.db
        .query(
          `SELECT COUNT(*) c FROM direct_messages WHERE created_at BETWEEN ? AND ?
       AND (sender_name=? OR target_name=?)`,
        )
        .get(session.started_at, completedAt, entityName, entityName) as { c: number }
    ).c;
    return (
      this.db.run(
        `UPDATE productivity_sessions SET completed_at=?,outcome=?,quality=?,end_tool_calls=?,handoffs=?,
         end_input_tokens=?,end_output_tokens=?,end_cost_usd=? WHERE id=?`,
        [
          completedAt,
          outcome,
          outcome === "approved" ? 1 : 0,
          endToolCalls,
          handoffs,
          endInputTokens,
          endOutputTokens,
          endCostUsd,
          session.id,
        ],
      ).changes > 0
    );
  }
  getProductivitySummary(entityName?: string): ProductivitySummary {
    const rows = (
      entityName
        ? this.db
            .query(
              "SELECT * FROM productivity_sessions WHERE completed_at IS NOT NULL AND entity_name=? ORDER BY completed_at",
            )
            .all(entityName)
        : this.db
            .query(
              "SELECT * FROM productivity_sessions WHERE completed_at IS NOT NULL ORDER BY completed_at",
            )
            .all()
    ) as Array<{
      outcome: string;
      quality: number;
      started_at: number;
      completed_at: number;
      start_tool_calls: number;
      end_tool_calls: number | null;
      handoffs: number;
    }>;
    const durations = rows
      .map((r) => Math.max(0, r.completed_at - r.started_at))
      .sort((a, b) => a - b);
    const successes = rows.filter((r) => r.outcome === "approved").length;
    const average = (values: number[]) =>
      values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return {
      entityName: entityName ?? null,
      outcomes: rows.length,
      successes,
      failures: rows.length - successes,
      successRate: rows.length ? successes / rows.length : 0,
      averageDurationMs: average(durations),
      medianDurationMs: durations.length
        ? durations.length % 2
          ? durations[Math.floor(durations.length / 2)]!
          : (durations[durations.length / 2 - 1]! + durations[durations.length / 2]!) / 2
        : 0,
      averageToolCalls: average(
        rows.map((r) => Math.max(0, (r.end_tool_calls ?? r.start_tool_calls) - r.start_tool_calls)),
      ),
      averageHandoffs: average(rows.map((r) => r.handoffs)),
      outcomesLast7d: rows.filter((r) => r.completed_at >= Date.now() - 7 * 86_400_000).length,
    };
  }
  getProductivityLeaderboard(limit = 20): ProductivitySummary[] {
    const names = this.db
      .query(
        "SELECT DISTINCT entity_name FROM productivity_sessions WHERE completed_at IS NOT NULL",
      )
      .all() as { entity_name: string }[];
    return names
      .map((row) => this.getProductivitySummary(row.entity_name))
      .sort((a, b) => b.successes - a.successes || a.averageDurationMs - b.averageDurationMs)
      .slice(0, limit);
  }
  getProductivityTrend(entityName?: string, days = 14): ProductivityTrendPoint[] {
    const since = Date.now() - Math.max(1, days) * 86_400_000;
    const rows = (
      entityName
        ? this.db
            .query(
              "SELECT * FROM productivity_sessions WHERE completed_at>=? AND entity_name=? ORDER BY completed_at",
            )
            .all(since, entityName)
        : this.db
            .query(
              "SELECT * FROM productivity_sessions WHERE completed_at>=? ORDER BY completed_at",
            )
            .all(since)
    ) as Array<{
      outcome: string;
      started_at: number;
      completed_at: number;
      start_tool_calls: number;
      end_tool_calls: number | null;
      handoffs: number;
    }>;
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const date = new Date(row.completed_at).toISOString().slice(0, 10);
      groups.set(date, [...(groups.get(date) ?? []), row]);
    }
    const average = (values: number[]) =>
      values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return [...groups.entries()].map(([date, entries]) => ({
      date,
      outcomes: entries.length,
      successes: entries.filter((row) => row.outcome === "approved").length,
      averageDurationMs: average(entries.map((row) => row.completed_at - row.started_at)),
      averageToolCalls: average(
        entries.map((row) =>
          Math.max(0, (row.end_tool_calls ?? row.start_tool_calls) - row.start_tool_calls),
        ),
      ),
      averageHandoffs: average(entries.map((row) => row.handoffs)),
    }));
  }

  recordPrimitiveUsage(input: {
    actorId?: string;
    actorName: string;
    actorKind: string;
    source: "command" | "agent_tool";
    primitive: string;
    action: string;
    safeLabel: string;
    toolName?: string;
    success?: boolean;
    meaningful?: boolean;
    worldAction?: boolean;
    communication?: boolean;
    latencyMs?: number;
    promptVersion?: string;
    riskClass?: "read" | "communicate" | "mutate" | "consequential";
    trustSources?: string[];
    createdAt?: number;
  }): number {
    const result = this.db.run(
      `INSERT INTO primitive_usage
       (actor_id,actor_name,actor_kind,source,primitive,action,safe_label,tool_name,success,
        meaningful,world_action,communication,latency_ms,created_at,prompt_version,risk_class,trust_sources)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.actorId ?? null,
        input.actorName,
        input.actorKind,
        input.source,
        input.primitive,
        input.action,
        input.safeLabel,
        input.toolName ?? null,
        input.success === undefined ? null : input.success ? 1 : 0,
        input.meaningful ? 1 : 0,
        input.worldAction ? 1 : 0,
        input.communication ? 1 : 0,
        input.latencyMs ?? null,
        input.createdAt ?? Date.now(),
        input.promptVersion ?? null,
        input.riskClass ?? null,
        input.trustSources?.length ? JSON.stringify([...new Set(input.trustSources)].sort()) : null,
      ],
    );
    return Number(result.lastInsertRowid);
  }

  finishAgentToolUsage(
    actorName: string,
    toolName: string,
    success: boolean,
    at = Date.now(),
  ): void {
    const row = this.db
      .query(
        `SELECT id,created_at FROM primitive_usage
         WHERE actor_name=? AND source='agent_tool' AND tool_name=? AND success IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(actorName, toolName) as { id: number; created_at: number } | null;
    if (!row) return;
    this.db.run("UPDATE primitive_usage SET success=?,latency_ms=? WHERE id=?", [
      success ? 1 : 0,
      Math.max(0, at - row.created_at),
      row.id,
    ]);
  }

  getPrimitiveUsageSummary(entityName?: string, days = 7): PrimitiveUsageSummary {
    const since = Date.now() - Math.max(1 / 1440, days) * 86_400_000;
    const where = entityName ? "AND actor_name=?" : "";
    const args = entityName ? [since, entityName] : [since];
    const row = this.db
      .query(
        `SELECT
          SUM(CASE WHEN source='command' THEN 1 ELSE 0 END) commands,
          SUM(CASE WHEN source='command' AND meaningful=1 THEN 1 ELSE 0 END) meaningful_actions,
          SUM(CASE WHEN source='command' AND world_action=1 THEN 1 ELSE 0 END) world_actions,
          SUM(CASE WHEN source='command' AND communication=1 THEN 1 ELSE 0 END) communications,
          COUNT(DISTINCT CASE WHEN source='command' AND meaningful=1 THEN primitive END) diversity,
          COUNT(DISTINCT CASE WHEN source='command' AND meaningful=1 THEN actor_name END) participants,
          COUNT(DISTINCT CASE WHEN source='command' AND meaningful=1 AND actor_kind='agent' THEN actor_name END) agents,
          SUM(CASE WHEN source='agent_tool' THEN 1 ELSE 0 END) tool_calls,
          SUM(CASE WHEN source='agent_tool' AND tool_name LIKE 'marina_%' THEN 1 ELSE 0 END) marina_tools,
          SUM(CASE WHEN source='agent_tool' AND tool_name='think' THEN 1 ELSE 0 END) reasoning_only,
          SUM(CASE WHEN source='agent_tool' AND risk_class='consequential' THEN 1 ELSE 0 END) consequential_tools,
          SUM(CASE WHEN source='agent_tool' AND trust_sources IS NOT NULL THEN 1 ELSE 0 END) untrusted_tools,
          MAX(CASE WHEN source='command' AND meaningful=1 THEN created_at END) last_action
         FROM primitive_usage WHERE created_at>=? ${where}`,
      )
      .get(...args) as {
      commands: number | null;
      meaningful_actions: number | null;
      world_actions: number | null;
      communications: number | null;
      diversity: number | null;
      participants: number | null;
      agents: number | null;
      tool_calls: number | null;
      marina_tools: number | null;
      reasoning_only: number | null;
      consequential_tools: number | null;
      untrusted_tools: number | null;
      last_action: number | null;
    };
    const commands = row.commands ?? 0;
    const meaningfulActions = row.meaningful_actions ?? 0;
    const topPrimitives = this.db
      .query(
        `SELECT primitive,COUNT(*) count FROM primitive_usage
         WHERE created_at>=? AND source='command' AND meaningful=1 ${where}
         GROUP BY primitive ORDER BY count DESC,primitive LIMIT 8`,
      )
      .all(...args) as Array<{ primitive: string; count: number }>;
    const promptVersions = this.db
      .query(
        `SELECT DISTINCT prompt_version FROM primitive_usage
         WHERE created_at>=? AND prompt_version IS NOT NULL ${where} ORDER BY prompt_version`,
      )
      .all(...args) as Array<{ prompt_version: string }>;
    const sessions = this.db
      .query(
        `SELECT ps.outcome,COUNT(pu.id) meaningful
         FROM productivity_sessions ps LEFT JOIN primitive_usage pu
           ON pu.actor_name=ps.entity_name AND pu.source='command' AND pu.meaningful=1
           AND pu.created_at BETWEEN ps.started_at AND ps.completed_at
         WHERE ps.completed_at IS NOT NULL AND ps.completed_at>=? ${
           entityName ? "AND ps.entity_name=?" : ""
}
         GROUP BY ps.id`,
      )
      .all(...args) as Array<{ outcome: string; meaningful: number }>;
    const average = (values: number[]) =>
      values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return {
      entityName: entityName ?? null,
      commands,
      meaningfulActions,
      meaningfulRate: commands ? meaningfulActions / commands : 0,
      worldActions: row.world_actions ?? 0,
      communications: row.communications ?? 0,
      primitiveDiversity: row.diversity ?? 0,
      activeParticipants: row.participants ?? 0,
      activeAgents: row.agents ?? 0,
      toolCalls: row.tool_calls ?? 0,
      marinaToolCalls: row.marina_tools ?? 0,
      reasoningOnlyCalls: row.reasoning_only ?? 0,
      consequentialToolCalls: row.consequential_tools ?? 0,
      untrustedToolCalls: row.untrusted_tools ?? 0,
      lastActionAt: row.last_action,
      outcomeSessions: sessions.length,
      approvedMeaningfulAverage: average(
        sessions
          .filter((session) => session.outcome === "approved")
          .map((session) => session.meaningful),
      ),
      failedMeaningfulAverage: average(
        sessions
          .filter((session) => session.outcome !== "approved")
          .map((session) => session.meaningful),
      ),
      topPrimitives,
      promptVersions: promptVersions.map((entry) => entry.prompt_version),
    };
  }

  getPromptOutcomeSummaries(days = 30): PromptOutcomeSummary[] {
    const since = Date.now() - Math.max(1, days) * 86_400_000;
    const outcomes = this.db
      .query(
        `SELECT prompt_version,COUNT(DISTINCT entity_name) agents,COUNT(*) outcomes,
          SUM(CASE WHEN outcome='approved' THEN 1 ELSE 0 END) successes,
          AVG(completed_at-started_at) average_duration,
          AVG(MAX(0,COALESCE(end_tool_calls,start_tool_calls)-start_tool_calls)) average_tools,
          AVG(MAX(0,COALESCE(end_input_tokens,start_input_tokens)-start_input_tokens)) average_input,
          AVG(MAX(0,COALESCE(end_output_tokens,start_output_tokens)-start_output_tokens)) average_output,
          AVG(MAX(0,COALESCE(end_cost_usd,start_cost_usd)-start_cost_usd)) average_cost
         FROM productivity_sessions
         WHERE completed_at>=? AND prompt_version IS NOT NULL
         GROUP BY prompt_version ORDER BY outcomes DESC`,
      )
      .all(since) as Array<{
      prompt_version: string;
      agents: number;
      outcomes: number;
      successes: number;
      average_duration: number;
      average_tools: number;
      average_input: number;
      average_output: number;
      average_cost: number;
    }>;
    const actions = this.db
      .query(
        `SELECT prompt_version,COUNT(*) meaningful FROM primitive_usage
         WHERE created_at>=? AND source='command' AND meaningful=1 AND prompt_version IS NOT NULL
         GROUP BY prompt_version`,
      )
      .all(since) as Array<{ prompt_version: string; meaningful: number }>;
    const actionMap = new Map(actions.map((row) => [row.prompt_version, row.meaningful]));
    return outcomes.map((row) => ({
      promptVersion: row.prompt_version,
      agents: row.agents,
      outcomes: row.outcomes,
      successes: row.successes,
      failures: row.outcomes - row.successes,
      successRate: row.outcomes ? row.successes / row.outcomes : 0,
      averageDurationMs: row.average_duration ?? 0,
      averageToolCalls: row.average_tools ?? 0,
      averageInputTokens: row.average_input ?? 0,
      averageOutputTokens: row.average_output ?? 0,
      averageCostUsd: row.average_cost ?? 0,
      meaningfulActions: actionMap.get(row.prompt_version) ?? 0,
    }));
  }

  getPrimitiveUsageLeaderboard(limit = 20): PrimitiveUsageSummary[] {
    const names = this.db
      .query("SELECT DISTINCT actor_name FROM primitive_usage WHERE actor_kind='agent'")
      .all() as Array<{ actor_name: string }>;
    return names
      .map((row) => this.getPrimitiveUsageSummary(row.actor_name))
      .sort(
        (a, b) =>
          b.meaningfulActions - a.meaningfulActions ||
          b.primitiveDiversity - a.primitiveDiversity ||
          b.meaningfulRate - a.meaningfulRate,
      )
      .slice(0, limit);
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
  calibrateMemoryConfidence(): number {
    return notesDb.calibrateMemoryConfidence(this.db);
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

  countApprovedTaskClaims(entityId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM task_claims WHERE entity_id = ? AND status = 'approved'")
      .get(entityId) as { n: number } | null;
    return row?.n ?? 0;
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

  updateProjectBudget(
    id: string,
    budget: { tokens?: number | null; cost?: number | null; durationMs?: number | null },
  ): void {
    tasksDb.updateProjectBudget(this.db, id, budget);
  }

  addProjectUsage(id: string, tokens: number, cost: number): void {
    tasksDb.addProjectUsage(this.db, id, tokens, cost);
  }

  resetProjectTasks(bundleId: number): number {
    return tasksDb.resetProjectTasks(this.db, bundleId);
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

  // ─── Optional Flywheel Workspace Bindings ──────────────────────────────

  saveFlywheelBinding(opts: {
    entityId: EntityId;
    sessionId: string;
    sandboxId: string;
    image: string;
    keepAlive: boolean;
    state: FlywheelBindingState;
    lifecycleExpiresAt?: number;
  }): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO flywheel_bindings
        (entity_id, session_id, sandbox_id, image, keep_alive, state, created_at, updated_at,
         last_activity_at, lifecycle_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         session_id = excluded.session_id,
         sandbox_id = excluded.sandbox_id,
         image = excluded.image,
         keep_alive = excluded.keep_alive,
         state = excluded.state,
         last_activity_at = excluded.last_activity_at,
         lifecycle_expires_at = excluded.lifecycle_expires_at,
         last_error = NULL,
         updated_at = excluded.updated_at`,
      [
        opts.entityId,
        opts.sessionId,
        opts.sandboxId,
        opts.image,
        opts.keepAlive ? 1 : 0,
        opts.state,
        now,
        now,
        now,
        opts.lifecycleExpiresAt ?? null,
      ],
    );
  }

  listFlywheelBindings(): FlywheelBindingRow[] {
    return this.reader
      .query("SELECT * FROM flywheel_bindings ORDER BY created_at")
      .all() as FlywheelBindingRow[];
  }

  updateFlywheelBinding(
    entityId: EntityId,
    fields: {
      state?: FlywheelBindingState;
      publishedUrl?: string | null;
      lastError?: string | null;
      reconciledAt?: number | null;
      activeProjectId?: string | null;
      guestCwd?: string | null;
      networkProfile?: string;
      networkProfileEnforced?: boolean;
      lastActivityAt?: number;
      lifecycleExpiresAt?: number | null;
      hibernatedReason?: string | null;
    },
  ): void {
    const assignments = ["updated_at = ?"];
    const values: Array<string | number | null> = [Date.now()];
    if (fields.state !== undefined) {
      assignments.push("state = ?");
      values.push(fields.state);
    }
    if (fields.publishedUrl !== undefined) {
      assignments.push("published_url = ?");
      values.push(fields.publishedUrl);
    }
    if (fields.lastError !== undefined) {
      assignments.push("last_error = ?");
      values.push(fields.lastError);
    }
    if (fields.reconciledAt !== undefined) {
      assignments.push("reconciled_at = ?");
      values.push(fields.reconciledAt);
    }
    if (fields.activeProjectId !== undefined) {
      assignments.push("active_project_id = ?");
      values.push(fields.activeProjectId);
    }
    if (fields.guestCwd !== undefined) {
      assignments.push("guest_cwd = ?");
      values.push(fields.guestCwd);
    }
    if (fields.networkProfile !== undefined) {
      assignments.push("network_profile = ?");
      values.push(fields.networkProfile);
    }
    if (fields.networkProfileEnforced !== undefined) {
      assignments.push("network_profile_enforced = ?");
      values.push(fields.networkProfileEnforced ? 1 : 0);
    }
    if (fields.lastActivityAt !== undefined) {
      assignments.push("last_activity_at = ?");
      values.push(fields.lastActivityAt);
    }
    if (fields.lifecycleExpiresAt !== undefined) {
      assignments.push("lifecycle_expires_at = ?");
      values.push(fields.lifecycleExpiresAt);
    }
    if (fields.hibernatedReason !== undefined) {
      assignments.push("hibernated_reason = ?");
      values.push(fields.hibernatedReason);
    }
    values.push(entityId);
    this.db.run(
      `UPDATE flywheel_bindings SET ${assignments.join(", ")} WHERE entity_id = ?`,
      values,
    );
  }

  deleteFlywheelBinding(entityId: EntityId): void {
    this.db.run("DELETE FROM flywheel_bindings WHERE entity_id = ?", [entityId]);
  }

  createCodingProject(project: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    name: string;
    sourceType: "empty" | "git" | "archive";
    sourceLocator?: string;
    guestPath: string;
    activeBranch?: string;
    baseRevision?: string;
  }): CodingProjectRow {
    const now = Date.now();
    this.db.run(
      `INSERT INTO coding_projects
        (id, entity_id, sandbox_id, name, source_type, source_locator, guest_path,
         active_branch, base_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        project.id,
        project.entityId,
        project.sandboxId,
        project.name,
        project.sourceType,
        project.sourceLocator ?? null,
        project.guestPath,
        project.activeBranch ?? null,
        project.baseRevision ?? null,
        now,
        now,
      ],
    );
    return this.getCodingProject(project.id) as CodingProjectRow;
  }

  getCodingProject(id: string): CodingProjectRow | null {
    return this.reader
      .query("SELECT * FROM coding_projects WHERE id = ?")
      .get(id) as CodingProjectRow | null;
  }

  getCodingProjectForEntity(entityId: EntityId, selector: string): CodingProjectRow | null {
    return this.reader
      .query("SELECT * FROM coding_projects WHERE entity_id = ? AND (id = ? OR name = ?)")
      .get(entityId, selector, selector) as CodingProjectRow | null;
  }

  listCodingProjects(entityId: EntityId): CodingProjectRow[] {
    return this.reader
      .query("SELECT * FROM coding_projects WHERE entity_id = ? ORDER BY updated_at DESC")
      .all(entityId) as CodingProjectRow[];
  }

  deleteCodingProjectsForSandbox(entityId: EntityId, sandboxId: string): void {
    this.db.run("DELETE FROM coding_projects WHERE entity_id = ? AND sandbox_id = ?", [
      entityId,
      sandboxId,
    ]);
  }

  deleteCodingProject(entityId: EntityId, projectId: string, sandboxId: string): void {
    this.db.run("DELETE FROM coding_projects WHERE entity_id = ? AND id = ? AND sandbox_id = ?", [
      entityId,
      projectId,
      sandboxId,
    ]);
  }

  updateCodingProject(
    id: string,
    fields: Partial<{
      activeBranch: string | null;
      baseRevision: string | null;
      dirty: boolean;
      hasUnexportedChanges: boolean;
      exportedFingerprint: string | null;
      lastStatusAt: number | null;
      lastExportedAt: number | null;
    }>,
  ): void {
    const assignments = ["updated_at = ?"];
    const values: Array<string | number | null> = [Date.now()];
    const mapping: Array<
      [keyof typeof fields, string, (value: unknown) => string | number | null]
    > = [
      ["activeBranch", "active_branch", (value) => value as string | null],
      ["baseRevision", "base_revision", (value) => value as string | null],
      ["dirty", "dirty", (value) => (value ? 1 : 0)],
      ["hasUnexportedChanges", "has_unexported_changes", (value) => (value ? 1 : 0)],
      ["exportedFingerprint", "exported_fingerprint", (value) => value as string | null],
      ["lastStatusAt", "last_status_at", (value) => value as number | null],
      ["lastExportedAt", "last_exported_at", (value) => value as number | null],
    ];
    for (const [key, column, normalize] of mapping) {
      if (fields[key] === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(normalize(fields[key]));
    }
    values.push(id);
    this.db.run(`UPDATE coding_projects SET ${assignments.join(", ")} WHERE id = ?`, values);
  }

  createCodingService(service: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    projectId?: string;
    sessionId: string;
    name: string;
    command: string[];
    guestCwd: string;
    logPath: string;
    pid: number;
    processIdentity: string;
    port?: number;
  }): CodingServiceRow {
    const now = Date.now();
    this.db.run(
      `INSERT INTO coding_services
        (id, entity_id, sandbox_id, project_id, session_id, name, command_json,
         guest_cwd, log_path, pid, process_identity, port, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      [
        service.id,
        service.entityId,
        service.sandboxId,
        service.projectId ?? null,
        service.sessionId,
        service.name,
        JSON.stringify(service.command),
        service.guestCwd,
        service.logPath,
        service.pid,
        service.processIdentity,
        service.port ?? null,
        now,
        now,
        now,
      ],
    );
    return this.getCodingService(service.id) as CodingServiceRow;
  }

  getCodingService(id: string): CodingServiceRow | null {
    return this.reader
      .query("SELECT * FROM coding_services WHERE id = ?")
      .get(id) as CodingServiceRow | null;
  }

  getCodingServiceForEntity(entityId: EntityId, selector: string): CodingServiceRow | null {
    return this.reader
      .query("SELECT * FROM coding_services WHERE entity_id = ? AND (id = ? OR name = ?)")
      .get(entityId, selector, selector) as CodingServiceRow | null;
  }

  listCodingServices(entityId: EntityId): CodingServiceRow[] {
    return this.reader
      .query("SELECT * FROM coding_services WHERE entity_id = ? ORDER BY updated_at DESC")
      .all(entityId) as CodingServiceRow[];
  }

  listExpiredCodingServicePublications(now = Date.now()): CodingServiceRow[] {
    return this.reader
      .query(
        `SELECT * FROM coding_services
         WHERE published_subdomain IS NOT NULL
           AND publication_expires_at IS NOT NULL
           AND publication_expires_at <= ?
         ORDER BY publication_expires_at`,
      )
      .all(now) as CodingServiceRow[];
  }

  hasRunningCodingServices(entityId: EntityId, sandboxId: string): boolean {
    return (
      this.reader
        .query(
          "SELECT 1 present FROM coding_services WHERE entity_id = ? AND sandbox_id = ? AND status IN ('running', 'unknown') LIMIT 1",
        )
        .get(entityId, sandboxId) !== null
    );
  }

  recordFlywheelOperation(operation: {
    entityId?: EntityId;
    operation: string;
    outcome: "success" | "failure" | "blocked";
    durationMs: number;
    byteCount?: number;
    detail?: string;
  }): void {
    this.db.run(
      `INSERT INTO flywheel_operations
       (entity_id, operation, outcome, duration_ms, byte_count, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        operation.entityId ?? null,
        operation.operation,
        operation.outcome,
        Math.max(0, Math.trunc(operation.durationMs)),
        operation.byteCount ?? null,
        operation.detail?.slice(0, 500) ?? null,
        Date.now(),
      ],
    );
  }

  pruneFlywheelOperations(before: number): number {
    return this.db.run("DELETE FROM flywheel_operations WHERE created_at < ?", [before]).changes;
  }

  getFlywheelOperationSummary(
    since = Date.now() - 24 * 60 * 60 * 1000,
  ): FlywheelOperationSummary[] {
    return this.reader
      .query(
        `SELECT operation, outcome, COUNT(*) count,
                CAST(AVG(duration_ms) AS INTEGER) avg_duration_ms,
                COALESCE(SUM(byte_count), 0) byte_count
         FROM flywheel_operations WHERE created_at >= ?
         GROUP BY operation, outcome ORDER BY operation, outcome`,
      )
      .all(since) as FlywheelOperationSummary[];
  }

  updateCodingService(
    id: string,
    fields: Partial<{
      pid: number | null;
      processIdentity: string | null;
      status: string;
      publishedUrl: string | null;
      publishedSubdomain: string | null;
      publicationExpiresAt: number | null;
      lastError: string | null;
      startedAt: number | null;
      stoppedAt: number | null;
    }>,
  ): void {
    const assignments = ["updated_at = ?"];
    const values: Array<string | number | null> = [Date.now()];
    const mapping: Array<[keyof typeof fields, string]> = [
      ["pid", "pid"],
      ["processIdentity", "process_identity"],
      ["status", "status"],
      ["publishedUrl", "published_url"],
      ["publishedSubdomain", "published_subdomain"],
      ["publicationExpiresAt", "publication_expires_at"],
      ["lastError", "last_error"],
      ["startedAt", "started_at"],
      ["stoppedAt", "stopped_at"],
    ];
    for (const [key, column] of mapping) {
      if (fields[key] === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(fields[key] as string | number | null);
    }
    values.push(id);
    this.db.run(`UPDATE coding_services SET ${assignments.join(", ")} WHERE id = ?`, values);
  }

  stopCodingServicesForSandbox(entityId: EntityId, sandboxId: string, reason: string): void {
    const now = Date.now();
    this.db.run(
      `UPDATE coding_services
       SET status = 'stopped', pid = NULL, process_identity = NULL, last_error = ?, stopped_at = ?, updated_at = ?
       WHERE entity_id = ? AND sandbox_id = ? AND status = 'running'`,
      [reason, now, now, entityId, sandboxId],
    );
  }

  markCodingServicesUnknownForSandbox(entityId: EntityId, sandboxId: string, reason: string): void {
    this.db.run(
      `UPDATE coding_services
       SET status = 'unknown', last_error = ?, updated_at = ?
       WHERE entity_id = ? AND sandbox_id = ? AND status = 'running'`,
      [reason, Date.now(), entityId, sandboxId],
    );
  }

  createCodingServiceProbe(probe: {
    serviceId: string;
    entityId: EntityId;
    sandboxId: string;
    path: string;
    httpStatus?: number;
    durationMs: number;
    success: boolean;
    error?: string;
  }): CodingServiceProbeRow {
    const row: CodingServiceProbeRow = {
      id: `probe_${crypto.randomUUID().slice(0, 12)}`,
      service_id: probe.serviceId,
      entity_id: probe.entityId,
      sandbox_id: probe.sandboxId,
      path: probe.path,
      http_status: probe.httpStatus ?? null,
      duration_ms: probe.durationMs,
      success: probe.success ? 1 : 0,
      error: probe.error ?? null,
      created_at: Date.now(),
    };
    this.db.run(
      `INSERT INTO coding_service_probes
       (id, service_id, entity_id, sandbox_id, path, http_status, duration_ms, success, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.service_id,
        row.entity_id,
        row.sandbox_id,
        row.path,
        row.http_status,
        row.duration_ms,
        row.success,
        row.error,
        row.created_at,
      ],
    );
    return row;
  }

  listCodingServiceProbes(serviceId: string, limit = 20): CodingServiceProbeRow[] {
    return this.reader
      .query(
        "SELECT * FROM coding_service_probes WHERE service_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(serviceId, Math.max(1, Math.min(100, limit))) as CodingServiceProbeRow[];
  }

  saveFlywheelCredentialBinding(binding: {
    id: string;
    entityId: EntityId;
    sandboxId: string;
    profileName: string;
    purpose: string;
    state: string;
    expiresAt?: number;
    lastError?: string;
  }): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO flywheel_credential_bindings
       (id, entity_id, sandbox_id, profile_name, purpose, state, expires_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, sandbox_id, profile_name, purpose) DO UPDATE SET
         state = excluded.state, expires_at = excluded.expires_at,
         last_error = excluded.last_error, updated_at = excluded.updated_at`,
      [
        binding.id,
        binding.entityId,
        binding.sandboxId,
        binding.profileName,
        binding.purpose,
        binding.state,
        binding.expiresAt ?? null,
        binding.lastError ?? null,
        now,
        now,
      ],
    );
  }

  listFlywheelCredentialBindings(entityId: EntityId): FlywheelCredentialBindingRow[] {
    return this.reader
      .query(
        "SELECT * FROM flywheel_credential_bindings WHERE entity_id = ? ORDER BY updated_at DESC",
      )
      .all(entityId) as FlywheelCredentialBindingRow[];
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
    arm = "",
  ): void {
    this.db.run(
      `INSERT INTO experiment_results (experiment_id, entity_name, metric_name, metric_value, arm, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [experimentId, entityName, metricName, metricValue, arm, Date.now()],
    );
  }

  getResults(experimentId: number): ExperimentResultRow[] {
    return this.db
      .query("SELECT * FROM experiment_results WHERE experiment_id = ? ORDER BY id")
      .all(experimentId) as ExperimentResultRow[];
  }

  // ─── Native Evolution Protocols ───────────────────────────────────────

  createEvolutionSession(opts: {
    experimentId: number;
    objective: string;
    protocol?: object;
    createdBy: string;
  }): number {
    const result = this.db.run(
      `INSERT INTO evolution_sessions
       (experiment_id, objective, protocol, status, created_by, created_at)
       VALUES (?, ?, ?, 'draft', ?, ?)`,
      [
        opts.experimentId,
        opts.objective,
        JSON.stringify(opts.protocol ?? {}),
        opts.createdBy,
        Date.now(),
      ],
    );
    return Number(result.lastInsertRowid);
  }

  getEvolutionSession(id: number): EvolutionSessionRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM evolution_sessions WHERE id = ?")
        .get(id) as EvolutionSessionRow | null) ?? undefined
    );
  }

  getEvolutionSessionByExperiment(experimentId: number): EvolutionSessionRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM evolution_sessions WHERE experiment_id = ?")
        .get(experimentId) as EvolutionSessionRow | null) ?? undefined
    );
  }

  listEvolutionSessions(status?: EvolutionSessionStatus): EvolutionSessionRow[] {
    if (status) {
      return this.db
        .query("SELECT * FROM evolution_sessions WHERE status = ? ORDER BY id DESC")
        .all(status) as EvolutionSessionRow[];
    }
    return this.db
      .query("SELECT * FROM evolution_sessions ORDER BY id DESC")
      .all() as EvolutionSessionRow[];
  }

  listActiveEvolutionSessionsForParticipant(entityName: string): EvolutionSessionRow[] {
    return this.db
      .query(
        `SELECT es.* FROM evolution_sessions es
         JOIN experiment_participants ep ON ep.experiment_id = es.experiment_id
         WHERE es.status = 'active' AND lower(ep.entity_name) = lower(?)
         ORDER BY es.id`,
      )
      .all(entityName) as EvolutionSessionRow[];
  }

  getEvolutionActivity(
    experimentId: number,
    startedAt: number,
    endedAt = Date.now(),
  ): EvolutionActivitySummary {
    const participants = this.getParticipants(experimentId).map((row) => row.entity_name);
    if (participants.length === 0) return emptyEvolutionActivity();
    const placeholders = participants.map(() => "?").join(",");
    const row = this.db
      .query(
        `SELECT
           SUM(CASE WHEN source='command' AND meaningful=1 THEN 1 ELSE 0 END) meaningful_actions,
           SUM(CASE WHEN source='command' AND communication=1 THEN 1 ELSE 0 END) communications,
           SUM(CASE WHEN source='agent_tool' THEN 1 ELSE 0 END) tool_calls,
           SUM(CASE WHEN source='agent_tool' AND tool_name LIKE 'marina_%' THEN 1 ELSE 0 END) marina_tool_calls,
           AVG(CASE WHEN source='agent_tool' AND latency_ms IS NOT NULL THEN latency_ms END) average_tool_latency_ms,
           MAX(CASE WHEN source='agent_tool' THEN latency_ms END) maximum_tool_latency_ms,
           COUNT(DISTINCT CASE WHEN meaningful=1 THEN actor_name END) active_participants
         FROM primitive_usage
         WHERE created_at BETWEEN ? AND ? AND actor_name IN (${placeholders})`,
      )
      .get(startedAt, endedAt, ...participants) as {
      meaningful_actions: number | null;
      communications: number | null;
      tool_calls: number | null;
      marina_tool_calls: number | null;
      average_tool_latency_ms: number | null;
      maximum_tool_latency_ms: number | null;
      active_participants: number | null;
    };
    return {
      participants,
      activeParticipants: row.active_participants ?? 0,
      meaningfulActions: row.meaningful_actions ?? 0,
      communications: row.communications ?? 0,
      toolCalls: row.tool_calls ?? 0,
      marinaToolCalls: row.marina_tool_calls ?? 0,
      averageToolLatencyMs: row.average_tool_latency_ms,
      maximumToolLatencyMs: row.maximum_tool_latency_ms,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    };
  }

  updateEvolutionSessionStatus(id: number, status: EvolutionSessionStatus): void {
    const timestampColumn =
      status === "active"
        ? "started_at"
        : status === "paused"
          ? "paused_at"
          : status === "completed"
            ? "completed_at"
            : undefined;
    if (timestampColumn) {
      if (status === "active") {
        this.db.run(
          "UPDATE evolution_sessions SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
          [status, Date.now(), id],
        );
        return;
      }
      this.db.run(`UPDATE evolution_sessions SET status = ?, ${timestampColumn} = ? WHERE id = ?`, [
        status,
        Date.now(),
        id,
      ]);
      return;
    }
    this.db.run("UPDATE evolution_sessions SET status = ? WHERE id = ?", [status, id]);
  }

  createEvolutionRun(opts: {
    sessionId: number;
    hypothesis: string;
    candidateRef: string;
    proposedBy: string;
    parentRunId?: number;
  }): number {
    const next = this.db
      .query(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM evolution_runs WHERE session_id = ?",
      )
      .get(opts.sessionId) as { sequence: number };
    const result = this.db.run(
      `INSERT INTO evolution_runs
       (session_id, sequence, parent_run_id, hypothesis, candidate_ref, proposed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.sessionId,
        next.sequence,
        opts.parentRunId ?? null,
        opts.hypothesis,
        opts.candidateRef,
        opts.proposedBy,
        Date.now(),
      ],
    );
    return Number(result.lastInsertRowid);
  }

  getEvolutionRun(id: number): EvolutionRunRow | undefined {
    return (
      (this.db
        .query("SELECT * FROM evolution_runs WHERE id = ?")
        .get(id) as EvolutionRunRow | null) ?? undefined
    );
  }

  listEvolutionRuns(sessionId: number): EvolutionRunRow[] {
    return this.db
      .query("SELECT * FROM evolution_runs WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as EvolutionRunRow[];
  }

  evaluateEvolutionRun(id: number, evaluatorName: string, evidence: string): void {
    this.db.run(
      `UPDATE evolution_runs
       SET status = 'evaluated', evaluator_name = ?, evidence = ?, evaluated_at = ?
       WHERE id = ?`,
      [evaluatorName, evidence, Date.now(), id],
    );
  }

  decideEvolutionRun(
    id: number,
    reviewerName: string,
    decision: "accept" | "reject" | "inconclusive",
  ): void {
    const status =
      decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "evaluated";
    this.db.run(
      `UPDATE evolution_runs
       SET status = ?, reviewer_name = ?, decision = ?, decided_at = ?
       WHERE id = ?`,
      [status, reviewerName, decision, Date.now(), id],
    );
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

  // ─── Media Jobs ──────────────────────────────────────────────────────────

  createMediaJob(job: {
    id: string;
    type: mediaDb.MediaJobType;
    entityName: string;
    entityId: string | null;
    provider: string;
    model: string;
    prompt: string;
    options: Record<string, unknown>;
    costEstimate?: number | null;
    providerJobId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): void {
    mediaDb.insertMediaJob(this.db, job);
  }

  updateMediaJob(
    id: string,
    patch: Partial<{
      status: mediaDb.MediaJobStatus;
      assetId: string | null;
      error: string | null;
      costEstimate: number | null;
      providerJobId: string | null;
      metadata: Record<string, unknown> | null;
      options: Record<string, unknown>;
      completedAt: number | null;
    }>,
  ): void {
    mediaDb.updateMediaJob(this.db, id, patch);
  }

  getMediaJob(id: string): mediaDb.MediaJobRow | undefined {
    return mediaDb.getMediaJob(this.db, id);
  }

  listMediaJobs(opts: { limit?: number; entityName?: string } = {}): mediaDb.MediaJobRow[] {
    return mediaDb.listMediaJobs(this.db, opts);
  }

  countMediaJobsSince(opts: {
    entityName?: string;
    type?: mediaDb.MediaJobType;
    since: number;
  }): number {
    return mediaDb.countMediaJobsSince(this.db, opts);
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

  /** Trim old canvas nodes and return their ids so live clients can converge. */
  trimCanvasNodesWithIds(canvasId: string, max: number): string[] {
    const rows = this.db
      .query(
        `SELECT id FROM canvas_nodes
         WHERE canvas_id = ?
         ORDER BY created_at DESC
         LIMIT -1 OFFSET ?`,
      )
      .all(canvasId, max) as Array<{ id: string }>;
    if (rows.length === 0) return [];
    this.trimCanvasNodes(canvasId, max);
    return rows.map((row) => row.id);
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

  listCanvasIntents(options?: {
    statuses?: CanvasIntentStatus[];
    canvasName?: string;
    limit?: number;
    expireActiveMs?: number;
    now?: number;
  }): CanvasIntentSummary[] {
    const now = options?.now ?? Date.now();
    if (options?.expireActiveMs) {
      this.expireCanvasIntentClaims(options.expireActiveMs, now);
    }

    const statuses = new Set(options?.statuses ?? ["pending", "active"]);
    const limit = options?.limit ?? 100;
    const rows = options?.canvasName
      ? this.db
          .query(
            `SELECT n.*, c.name AS canvas_name
             FROM canvas_nodes n
             JOIN canvases c ON c.id = n.canvas_id
             WHERE c.name = ?
             ORDER BY n.created_at ASC`,
          )
          .all(options.canvasName)
      : this.db
          .query(
            `SELECT n.*, c.name AS canvas_name
             FROM canvas_nodes n
             JOIN canvases c ON c.id = n.canvas_id
             ORDER BY n.created_at ASC`,
          )
          .all();

    const intents: CanvasIntentSummary[] = [];
    for (const row of rows as (CanvasNodeRow & { canvas_name: string })[]) {
      const intent = parseCanvasIntent(row.data);
      if (!intent || !statuses.has(intent.status)) continue;
      intents.push({
        nodeId: row.id,
        canvasId: row.canvas_id,
        canvasName: row.canvas_name,
        type: row.type,
        creatorName: row.creator_name,
        assetId: row.asset_id,
        parentNodeId: row.parent_node_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        intent,
      });
      if (intents.length >= limit) break;
    }
    return intents;
  }

  expireCanvasIntentClaims(timeoutMs: number, now = Date.now()): number {
    const rows = this.db
      .query("SELECT * FROM canvas_nodes ORDER BY updated_at ASC")
      .all() as CanvasNodeRow[];
    let expired = 0;
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }
      const intent = readCanvasIntent(parsed);
      if (intent?.status !== "active") continue;
      const claimedAt = intent.claimedAt ?? row.updated_at;
      if (now - claimedAt <= timeoutMs) continue;

      parsed.intent = {
        ...intent,
        status: "pending",
        claimedBy: undefined,
        claimedAt: undefined,
      };
      if (this.updateNodeDataIfUnchanged(row, JSON.stringify(parsed), now)) expired++;
    }
    return expired;
  }

  claimCanvasIntent(
    idOrPrefix: string,
    claimantName: string,
    now = Date.now(),
  ): CanvasIntentClaimResult {
    const node = this.resolveCanvasNode(idOrPrefix);
    if (!node) return { ok: false, reason: "not_found" };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(node.data);
    } catch {
      return { ok: false, reason: "no_intent" };
    }

    const intent = readCanvasIntent(parsed);
    if (!intent) return { ok: false, reason: "no_intent" };
    if (intent.status !== "pending") {
      return { ok: false, reason: "not_pending", status: intent.status };
    }

    const claimed: CanvasIntentData = {
      ...intent,
      status: "active",
      claimedBy: claimantName,
      claimedAt: now,
    };
    parsed.intent = claimed;

    if (!this.updateNodeDataIfUnchanged(node, JSON.stringify(parsed), now)) {
      const latest = this.getNode(node.id);
      const latestIntent = latest ? parseCanvasIntent(latest.data) : undefined;
      return {
        ok: false,
        reason: latestIntent ? "not_pending" : "no_intent",
        status: latestIntent?.status,
      };
    }

    const updated = this.getNode(node.id) ?? node;
    return { ok: true, node: updated, intent: claimed };
  }

  completeCanvasIntent(
    idOrPrefix: string,
    params: {
      result: string;
      resultType?: string;
      resultData?: Record<string, unknown>;
      completerName: string;
      now?: number;
    },
  ): CanvasIntentCompleteResult {
    const now = params.now ?? Date.now();
    const node = this.resolveCanvasNode(idOrPrefix);
    if (!node) return { ok: false, reason: "not_found" };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(node.data);
    } catch {
      return { ok: false, reason: "no_intent" };
    }

    const intent = readCanvasIntent(parsed);
    if (!intent) return { ok: false, reason: "no_intent" };
    if (intent.status !== "active") {
      return { ok: false, reason: "not_active", status: intent.status };
    }

    const resultNodeId = crypto.randomUUID();
    const resultType = params.resultType ?? "text";
    let ok = false;
    try {
      this.db.transaction(() => {
        const baseResultData = params.resultData ?? { body: params.result };
        const resultData = {
          ...baseResultData,
          author: params.completerName,
          feedType: "intent_result",
          sourceNodeId: node.id,
          sourcePrompt: intent.prompt,
        };
        this.createNode({
          id: resultNodeId,
          canvasId: node.canvas_id,
          type: resultType,
          data: resultData,
          creatorName: params.completerName,
          parentNodeId: node.id,
        });

        parsed.intent = { ...intent, status: "done", result: params.result, resultNodeId };
        ok = this.updateNodeDataIfUnchanged(node, JSON.stringify(parsed), now);
        if (!ok) {
          throw new Error("canvas_intent_conflict");
        }
      })();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "canvas_intent_conflict") {
        throw error;
      }
    }

    if (!ok) {
      const latest = this.getNode(node.id);
      const latestIntent = latest ? parseCanvasIntent(latest.data) : undefined;
      return {
        ok: false,
        reason: latestIntent ? "not_active" : "no_intent",
        status: latestIntent?.status,
      };
    }

    return {
      ok: true,
      node: this.getNode(node.id) ?? node,
      intent: { ...intent, status: "done", result: params.result, resultNodeId },
      resultNode: this.getNode(resultNodeId)!,
    };
  }

  failCanvasIntent(idOrPrefix: string, reason: string, now = Date.now()): CanvasIntentFailResult {
    const node = this.resolveCanvasNode(idOrPrefix);
    if (!node) return { ok: false, reason: "not_found" };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(node.data);
    } catch {
      return { ok: false, reason: "no_intent" };
    }

    const intent = readCanvasIntent(parsed);
    if (!intent) return { ok: false, reason: "no_intent" };
    if (intent.status !== "active") {
      return { ok: false, reason: "not_active", status: intent.status };
    }

    const failed: CanvasIntentData = { ...intent, status: "failed", failReason: reason };
    parsed.intent = failed;
    if (!this.updateNodeDataIfUnchanged(node, JSON.stringify(parsed), now)) {
      const latest = this.getNode(node.id);
      const latestIntent = latest ? parseCanvasIntent(latest.data) : undefined;
      return {
        ok: false,
        reason: latestIntent ? "not_active" : "no_intent",
        status: latestIntent?.status,
      };
    }

    return { ok: true, node: this.getNode(node.id) ?? node, intent: failed };
  }

  resolveCanvasNode(idOrPrefix: string): CanvasNodeRow | undefined {
    const node = this.getNode(idOrPrefix);
    if (node) return node;
    if (idOrPrefix.length < 4) return undefined;
    const escapedPrefix = idOrPrefix
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    return (
      (this.db
        .query(
          "SELECT * FROM canvas_nodes WHERE id LIKE ? ESCAPE '\\' ORDER BY created_at ASC LIMIT 1",
        )
        .get(`${escapedPrefix}%`) as CanvasNodeRow | null) ?? undefined
    );
  }

  private updateNodeDataIfUnchanged(node: CanvasNodeRow, data: string, now: number): boolean {
    const result = this.db.run(
      "UPDATE canvas_nodes SET data = ?, updated_at = ? WHERE id = ? AND data = ?",
      [data, now, node.id, node.data],
    );
    if ((result.changes ?? 0) === 0) return false;
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

  /** Drop shell_log rows older than `keepMs`. Returns rows removed. Mirrors
   *  trimFeedEvents — bounds the gated-exec audit trail so it can't grow
   *  unbounded for the life of the DB. (idx_shell_log_created makes this cheap.) */
  trimShellLog(keepMs: number): number {
    const cutoff = Date.now() - keepMs;
    const res = this.db.run("DELETE FROM shell_log WHERE created_at < ?", [cutoff]);
    return res.changes;
  }

  // ─── Coding Sessions ───────────────────────────────────────────────────

  createCodingSession(session: {
    id: string;
    title: string;
    workspaceRoot: string;
    status?: string;
    mode?: string;
    createdBy: string;
  }): CodingSessionRow {
    const now = Date.now();
    const row: CodingSessionRow = {
      id: session.id,
      title: session.title,
      workspace_root: session.workspaceRoot,
      status: session.status ?? "active",
      mode: session.mode ?? "ask",
      created_by: session.createdBy,
      created_at: now,
      updated_at: now,
      writer: null,
      agent: null,
      driver: null,
      execution_target: "local",
      worktree_path: null,
      worktree_branch: null,
    };
    this.db.run(
      `INSERT INTO coding_sessions
        (id, title, workspace_root, status, mode, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.title,
        row.workspace_root,
        row.status,
        row.mode,
        row.created_by,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }

  getCodingSession(id: string): CodingSessionRow | null {
    return this.db
      .query("SELECT * FROM coding_sessions WHERE id = ?")
      .get(id) as CodingSessionRow | null;
  }

  listCodingSessions(createdBy?: string, limit = 10): CodingSessionRow[] {
    if (createdBy) {
      return this.db
        .query(
          "SELECT * FROM coding_sessions WHERE created_by = ? ORDER BY updated_at DESC LIMIT ?",
        )
        .all(createdBy, limit) as CodingSessionRow[];
    }
    return this.db
      .query("SELECT * FROM coding_sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as CodingSessionRow[];
  }

  updateCodingSession(
    id: string,
    patch: Partial<{
      status: string;
      mode: string;
      title: string;
      writer: string | null;
      agent: string | null;
      driver: string | null;
      executionTarget: "local" | "flywheel";
      worktreePath: string | null;
      worktreeBranch: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.agent !== undefined) {
      sets.push("agent = ?");
      values.push(patch.agent);
    }
    if (patch.driver !== undefined) {
      sets.push("driver = ?");
      values.push(patch.driver);
    }
    if (patch.executionTarget !== undefined) {
      sets.push("execution_target = ?");
      values.push(patch.executionTarget);
    }
    if (patch.mode !== undefined) {
      sets.push("mode = ?");
      values.push(patch.mode);
    }
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.writer !== undefined) {
      sets.push("writer = ?");
      values.push(patch.writer);
    }
    if (patch.worktreePath !== undefined) {
      sets.push("worktree_path = ?");
      values.push(patch.worktreePath);
    }
    if (patch.worktreeBranch !== undefined) {
      sets.push("worktree_branch = ?");
      values.push(patch.worktreeBranch);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db.run(`UPDATE coding_sessions SET ${sets.join(", ")} WHERE id = ?`, values);
  }

  createCodingEvent(event: {
    id?: string;
    sessionId: string;
    actor: string;
    kind: string;
    payload: unknown;
  }): CodingEventRow {
    const row: CodingEventRow = {
      id: event.id ?? crypto.randomUUID(),
      session_id: event.sessionId,
      actor: event.actor,
      kind: event.kind,
      payload_json: JSON.stringify(event.payload ?? {}),
      created_at: Date.now(),
    };
    this.db.run(
      `INSERT INTO coding_events
        (id, session_id, actor, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.session_id, row.actor, row.kind, row.payload_json, row.created_at],
    );
    this.db.run("UPDATE coding_sessions SET updated_at = ? WHERE id = ?", [
      row.created_at,
      row.session_id,
    ]);
    return row;
  }

  listCodingEvents(sessionId: string, limit = 50): CodingEventRow[] {
    return this.db
      .query(
        `SELECT * FROM (
         SELECT * FROM coding_events
         WHERE session_id = ?
           ORDER BY created_at DESC
           LIMIT ?
         )
         ORDER BY created_at ASC`,
      )
      .all(sessionId, limit) as CodingEventRow[];
  }

  createCodingArtifact(artifact: {
    id?: string;
    sessionId: string;
    kind: string;
    title: string;
    status?: string;
    contentText: string;
    metadata?: unknown;
    createdBy: string;
  }): CodingArtifactRow {
    const now = Date.now();
    const idPrefix =
      artifact.kind === "patch" ? "patch" : artifact.kind.replace(/[^a-z0-9]+/gi, "_");
    const row: CodingArtifactRow = {
      id: artifact.id ?? `${idPrefix}_${crypto.randomUUID().slice(0, 12)}`,
      session_id: artifact.sessionId,
      kind: artifact.kind,
      title: artifact.title,
      status: artifact.status ?? "pending",
      content_text: artifact.contentText,
      metadata_json: JSON.stringify(artifact.metadata ?? {}),
      created_by: artifact.createdBy,
      applied_by: null,
      created_at: now,
      updated_at: now,
      applied_at: null,
    };
    this.db.run(
      `INSERT INTO coding_artifacts
        (id, session_id, kind, title, status, content_text, metadata_json, created_by,
         applied_by, created_at, updated_at, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.session_id,
        row.kind,
        row.title,
        row.status,
        row.content_text,
        row.metadata_json,
        row.created_by,
        row.applied_by,
        row.created_at,
        row.updated_at,
        row.applied_at,
      ],
    );
    this.db.run("UPDATE coding_sessions SET updated_at = ? WHERE id = ?", [now, row.session_id]);
    return row;
  }

  getCodingArtifact(id: string): CodingArtifactRow | null {
    return this.db
      .query("SELECT * FROM coding_artifacts WHERE id = ?")
      .get(id) as CodingArtifactRow | null;
  }

  listCodingArtifacts(sessionId: string, limit = 20): CodingArtifactRow[] {
    return this.db
      .query("SELECT * FROM coding_artifacts WHERE session_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(sessionId, limit) as CodingArtifactRow[];
  }

  updateCodingArtifact(
    id: string,
    patch: Partial<{
      appliedAt: number | null;
      appliedBy: string | null;
      metadata: unknown;
      status: string;
    }>,
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.appliedBy !== undefined) {
      sets.push("applied_by = ?");
      values.push(patch.appliedBy);
    }
    if (patch.appliedAt !== undefined) {
      sets.push("applied_at = ?");
      values.push(patch.appliedAt);
    }
    if (patch.metadata !== undefined) {
      sets.push("metadata_json = ?");
      values.push(JSON.stringify(patch.metadata));
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(Date.now(), id);
    this.db.run(`UPDATE coding_artifacts SET ${sets.join(", ")} WHERE id = ?`, values);
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

  getTraitHistory(name: string, limit = 10): EditHistoryRow[] {
    return agentsDb.getTraitHistory(this.db, name, limit);
  }

  getRoleHistory(name: string, limit = 10): EditHistoryRow[] {
    return agentsDb.getRoleHistory(this.db, name, limit);
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
    supports?: AgentSupports;
  }): void {
    agentsDb.saveAgentConfig(this.db, opts);
    const parent =
      principalsDb.getPrincipal(this.reader, "agent", opts.spawnedBy) ??
      principalsDb.getPrincipal(this.reader, "human", opts.spawnedBy);
    principalsDb.ensurePrincipal(this.db, {
      type: "agent",
      displayName: opts.name,
      ownerPrincipalId: parent?.principal_id,
      lineageParentId: parent?.principal_type === "agent" ? parent.principal_id : null,
    });
  }
  getAgentConfig(name: string): AgentConfigRow | undefined {
    return agentsDb.getAgentConfig(this.db, name);
  }
  getAllAgentConfigs(): AgentConfigRow[] {
    return agentsDb.getAllAgentConfigs(this.db);
  }

  ensurePrincipal(
    input: Parameters<typeof principalsDb.ensurePrincipal>[1],
  ): principalsDb.PrincipalRow {
    return principalsDb.ensurePrincipal(this.db, input);
  }

  getPrincipal(
    type: principalsDb.PrincipalType,
    displayName: string,
    homeWorld = "local",
  ): principalsDb.PrincipalRow | undefined {
    return principalsDb.getPrincipal(this.reader, type, displayName, homeWorld);
  }

  listPrincipals(): principalsDb.PrincipalRow[] {
    return principalsDb.listPrincipals(this.reader);
  }

  setPrincipalStatus(principalId: string, status: principalsDb.PrincipalStatus): boolean {
    return principalsDb.setPrincipalStatus(this.db, principalId, status);
  }

  issueWorkloadCredential(
    principalId: string,
    ttlMs?: number,
  ): principalsDb.IssuedWorkloadCredential {
    return principalsDb.issueWorkloadCredential(this.db, principalId, ttlMs);
  }

  verifyWorkloadCredential(token: string): principalsDb.PrincipalRow | undefined {
    return principalsDb.verifyWorkloadCredential(this.reader, token);
  }

  revokeWorkloadCredential(credentialId: string): boolean {
    return principalsDb.revokeWorkloadCredential(this.db, credentialId);
  }

  createWorldVariant(
    input: Parameters<typeof worldVariantsDb.createWorldVariant>[1],
  ): worldVariantsDb.WorldVariantRow {
    return worldVariantsDb.createWorldVariant(this.db, input);
  }

  getWorldVariant(id: string): worldVariantsDb.WorldVariantRow | undefined {
    return worldVariantsDb.getWorldVariant(this.reader, id);
  }

  listWorldVariants(): worldVariantsDb.WorldVariantRow[] {
    return worldVariantsDb.listWorldVariants(this.reader);
  }

  updateWorldVariant(
    id: string,
    patch: Parameters<typeof worldVariantsDb.updateWorldVariant>[2],
  ): worldVariantsDb.WorldVariantRow | undefined {
    return worldVariantsDb.updateWorldVariant(this.db, id, patch);
  }

  promoteWorldVariant(
    id: string,
    input: Parameters<typeof worldVariantsDb.promoteWorldVariant>[2],
  ): worldVariantsDb.WorldVariantRow | undefined {
    return this.db.transaction(() => {
      const promoted = worldVariantsDb.promoteWorldVariant(this.db, id, input);
      if (promoted?.promoted_at) {
        evidenceDb.appendEvidenceReceipt(this.db, {
          eventType: "world_variant_promoted",
          ref: `world-variant:${id}`,
          payload: {
            variantId: id,
            rationale: input.rationale,
            evidenceRefs: input.evidenceRefs,
            promotedBy: input.promotedBy,
            promotedAt: promoted.promoted_at,
          },
          createdAt: promoted.promoted_at,
        });
      }
      return promoted;
    })();
  }

  getOrCreateWorldId(): string {
    const existing = agentsDb.getSetting(this.db, "federation.world_id");
    if (existing) return existing;
    const worldId = crypto.randomUUID();
    agentsDb.setSetting(this.db, "federation.world_id", worldId);
    return worldId;
  }

  upsertFederationPeer(
    input: Parameters<typeof federationDb.upsertFederationPeer>[1],
  ): federationDb.FederationPeerRow {
    return federationDb.upsertFederationPeer(this.db, input);
  }

  listFederationPeers(): federationDb.FederationPeerRow[] {
    return federationDb.listFederationPeers(this.reader);
  }

  setFederationTrust(
    worldId: string,
    trust: federationDb.FederationTrust,
  ): federationDb.FederationPeerRow | undefined {
    return federationDb.setFederationTrust(this.db, worldId, trust);
  }
  getAgentConfigsBySpawnedBy(spawnedBy: string): AgentConfigRow[] {
    return agentsDb.getAgentConfigsBySpawnedBy(this.db, spawnedBy);
  }
  deleteAgentConfig(name: string): void {
    agentsDb.deleteAgentConfig(this.db, name);
  }
  updateAttentionPolicy(
    name: string,
    mode: "focused" | "balanced" | "open",
    threshold?: number,
  ): boolean {
    return agentsDb.updateAttentionPolicy(this.db, name, mode, threshold);
  }
  recordAttentionFeedback(name: string, feedback: "useful" | "noise"): AgentConfigRow | undefined {
    return agentsDb.recordAttentionFeedback(this.db, name, feedback);
  }
  recordAutomaticAttentionOutcome(
    name: string,
    outcome: "success" | "failure",
  ): AgentConfigRow | undefined {
    return agentsDb.recordAutomaticAttentionOutcome(this.db, name, outcome);
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
  listSettingsByPrefix(prefix: string): { key: string; value: string }[] {
    return agentsDb.listSettingsByPrefix(this.db, prefix);
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
  /** Encrypt any plaintext API-key rows once MARINA_KEY_SECRET is set. */
  migrateApiKeysToEncrypted(): number {
    return agentsDb.migrateApiKeysToEncrypted(this.db);
  }
  /** Count encrypted vs. currently-undecryptable API-key rows. */
  auditEncryptedKeys(): { encrypted: number; unreadable: number } {
    return agentsDb.auditEncryptedKeys(this.db);
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

export type FlywheelBindingState =
  | "creating"
  | "running"
  | "hibernated"
  | "unavailable"
  | "stopping";

export interface FlywheelBindingRow {
  entity_id: string;
  session_id: string;
  sandbox_id: string;
  image: string;
  keep_alive: number;
  state: FlywheelBindingState;
  published_url: string | null;
  active_project_id: string | null;
  guest_cwd: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  reconciled_at: number | null;
  network_profile: string;
  network_profile_enforced: number;
  last_activity_at: number | null;
  lifecycle_expires_at: number | null;
  hibernated_reason: string | null;
}

export interface FlywheelOperationSummary {
  operation: string;
  outcome: string;
  count: number;
  avg_duration_ms: number;
  byte_count: number;
}

export interface FlywheelCredentialBindingRow {
  id: string;
  entity_id: string;
  sandbox_id: string;
  profile_name: string;
  purpose: string;
  state: string;
  expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ExperimentRow {
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

export type EvolutionSessionStatus = "draft" | "active" | "paused" | "completed";

export interface EvolutionSessionRow {
  id: number;
  experiment_id: number;
  objective: string;
  protocol: string;
  status: EvolutionSessionStatus;
  created_by: string;
  created_at: number;
  started_at: number | null;
  paused_at: number | null;
  completed_at: number | null;
}

export interface EvolutionRunRow {
  id: number;
  session_id: number;
  sequence: number;
  parent_run_id: number | null;
  hypothesis: string;
  candidate_ref: string;
  proposed_by: string;
  status: "proposed" | "evaluated" | "accepted" | "rejected";
  evaluator_name: string | null;
  reviewer_name: string | null;
  evidence: string;
  decision: "accept" | "reject" | "inconclusive" | null;
  created_at: number;
  evaluated_at: number | null;
  decided_at: number | null;
}

export interface EvolutionActivitySummary {
  participants: string[];
  activeParticipants: number;
  meaningfulActions: number;
  communications: number;
  toolCalls: number;
  marinaToolCalls: number;
  averageToolLatencyMs: number | null;
  maximumToolLatencyMs: number | null;
  /** Reserved until provider-neutral per-session token attribution is durable. */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

function emptyEvolutionActivity(): EvolutionActivitySummary {
  return {
    participants: [],
    activeParticipants: 0,
    meaningfulActions: 0,
    communications: 0,
    toolCalls: 0,
    marinaToolCalls: 0,
    averageToolLatencyMs: null,
    maximumToolLatencyMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
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
  arm: string;
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

export interface CanvasNodeRow {
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

export type CanvasIntentStatus = "pending" | "active" | "done" | "failed";

export interface CanvasIntentData {
  prompt: string;
  status: CanvasIntentStatus;
  claimedBy?: string;
  claimedAt?: number;
  result?: string;
  resultNodeId?: string;
  failReason?: string;
}

export interface CanvasIntentSummary {
  nodeId: string;
  canvasId: string;
  canvasName: string;
  type: string;
  creatorName: string;
  assetId: string | null;
  parentNodeId: string | null;
  createdAt: number;
  updatedAt: number;
  intent: CanvasIntentData;
}

export type CanvasIntentClaimResult =
  | { ok: true; node: CanvasNodeRow; intent: CanvasIntentData }
  | {
      ok: false;
      reason: "not_found" | "no_intent" | "not_pending";
      status?: CanvasIntentStatus;
    };

export type CanvasIntentCompleteResult =
  | {
      ok: true;
      node: CanvasNodeRow;
      resultNode: CanvasNodeRow;
      intent: CanvasIntentData;
    }
  | {
      ok: false;
      reason: "not_found" | "no_intent" | "not_active";
      status?: CanvasIntentStatus;
    };

export type CanvasIntentFailResult =
  | { ok: true; node: CanvasNodeRow; intent: CanvasIntentData }
  | {
      ok: false;
      reason: "not_found" | "no_intent" | "not_active";
      status?: CanvasIntentStatus;
    };

export function parseCanvasIntent(data: string): CanvasIntentData | undefined {
  try {
    return readCanvasIntent(JSON.parse(data));
  } catch {
    return undefined;
  }
}

function readCanvasIntent(value: unknown): CanvasIntentData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const intent = (value as { intent?: unknown }).intent;
  if (!intent || typeof intent !== "object") return undefined;
  const raw = intent as Record<string, unknown>;
  if (typeof raw.prompt !== "string" || !raw.prompt.trim()) return undefined;
  if (!["pending", "active", "done", "failed"].includes(String(raw.status))) return undefined;
  return raw as unknown as CanvasIntentData;
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

export interface CodingSessionRow {
  id: string;
  title: string;
  workspace_root: string;
  status: string;
  mode: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  writer: string | null;
  /** The autonomous coding agent bound to this session (single-agent driver). */
  agent: string | null;
  /** Dispatch strategy: "single" (default) | "crew" | future multi-agent. */
  driver: string | null;
  /** Explicit execution provider. Existing sessions default to trusted local mode. */
  execution_target: "local" | "flywheel";
  /**
   * Marina-managed git worktree bound to this session (opt-in). NULL means the
   * session works directly in workspace_root (default, byte-identical to legacy).
   */
  worktree_path: string | null;
  /** The marina/session-<id> branch backing worktree_path, or NULL when off. */
  worktree_branch: string | null;
}

export interface CodingProjectRow {
  id: string;
  entity_id: string;
  sandbox_id: string;
  name: string;
  source_type: "empty" | "git" | "archive";
  source_locator: string | null;
  guest_path: string;
  active_branch: string | null;
  base_revision: string | null;
  dirty: number;
  has_unexported_changes: number;
  exported_fingerprint: string | null;
  last_status_at: number | null;
  last_exported_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CodingServiceRow {
  id: string;
  entity_id: string;
  sandbox_id: string;
  project_id: string | null;
  session_id: string;
  name: string;
  command_json: string;
  guest_cwd: string;
  log_path: string;
  pid: number | null;
  process_identity: string | null;
  port: number | null;
  status: string;
  restart_policy: string;
  published_url: string | null;
  published_subdomain: string | null;
  publication_expires_at: number | null;
  last_error: string | null;
  started_at: number | null;
  stopped_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CodingServiceProbeRow {
  id: string;
  service_id: string;
  entity_id: string;
  sandbox_id: string;
  path: string;
  http_status: number | null;
  duration_ms: number;
  success: number;
  error: string | null;
  created_at: number;
}

export interface CodingEventRow {
  id: string;
  session_id: string;
  actor: string;
  kind: string;
  payload_json: string;
  created_at: number;
}

export interface CodingArtifactRow {
  id: string;
  session_id: string;
  kind: string;
  title: string;
  status: string;
  content_text: string;
  metadata_json: string;
  created_by: string;
  applied_by: string | null;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
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
