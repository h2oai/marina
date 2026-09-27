// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Generated from immutable migration history by scripts/generate-schema-baseline.ts.
// Fresh databases install this atomically; existing databases replay pending upgrades.
export const SCHEMA_BASELINE_VERSION = 137;
export const SCHEMA_BASELINE = `
CREATE TABLE entities (
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

CREATE TABLE room_store (
  room_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (room_id, key)
);

CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
, granted_rank INTEGER);

CREATE TABLE schema_version (version INTEGER PRIMARY KEY);

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
  created_at INTEGER NOT NULL, score INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, entity_id)
);

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
, parent_task_id INTEGER REFERENCES tasks(id), priority INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0);

CREATE TABLE task_claims (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  submission_text TEXT,
  claimed_at INTEGER NOT NULL,
  submitted_at INTEGER,
  resolved_at INTEGER, heartbeat_at INTEGER, lease_expires_at INTEGER, release_reason TEXT,
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

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_login INTEGER NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,
  properties TEXT NOT NULL DEFAULT '{}'
, auth_subject TEXT, auth_email TEXT);

CREATE TABLE bans (
  name TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  banned_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE adapter_links (
  adapter TEXT NOT NULL,
  external_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (adapter, external_id)
);

CREATE VIRTUAL TABLE board_posts_fts USING fts5(title, body, tags, content=board_posts, content_rowid=id);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_name TEXT NOT NULL,
  room_id TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
, importance INTEGER NOT NULL DEFAULT 5, last_accessed INTEGER, note_type TEXT NOT NULL DEFAULT 'observation', pool_id TEXT, supersedes_id INTEGER REFERENCES notes(id), recall_count INTEGER NOT NULL DEFAULT 0, tier TEXT NOT NULL DEFAULT 'fact', confidence REAL NOT NULL DEFAULT 0.5, verification_status TEXT NOT NULL DEFAULT 'unverified', claim_key TEXT);

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
, arm TEXT NOT NULL DEFAULT '');

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

CREATE TABLE note_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES notes(id),
  target_id INTEGER NOT NULL REFERENCES notes(id),
  relationship TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, relationship)
);

CREATE TABLE memory_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  group_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

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
, budget_tokens INTEGER, budget_cost REAL, budget_duration_ms INTEGER, used_tokens INTEGER NOT NULL DEFAULT 0, used_cost REAL NOT NULL DEFAULT 0);

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

CREATE TABLE "macros" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  author_id TEXT NOT NULL,
  command TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(name, author_id)
);

CREATE TABLE entity_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_name TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  activity_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL, success_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(entity_name, activity_type, activity_key)
);

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
, parent_node_id TEXT REFERENCES canvas_nodes(id) ON DELETE SET NULL);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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

CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title, description, content=tasks, content_rowid=id
);

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

CREATE TABLE market_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  brier_score REAL NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  scored_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE markets_fts USING fts5(question, category, content=markets, content_rowid=rowid);

CREATE TABLE mem_api_keys (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL UNIQUE,
  agent_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE traits (
  name TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'general',
  prompt TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
, capabilities TEXT NOT NULL DEFAULT '{}');

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
, room TEXT NOT NULL DEFAULT '', supports TEXT NOT NULL DEFAULT '{"text":true}', attention_mode TEXT NOT NULL DEFAULT 'balanced', attention_threshold INTEGER NOT NULL DEFAULT 50, attention_useful INTEGER NOT NULL DEFAULT 0, attention_noise INTEGER NOT NULL DEFAULT 0, attention_auto_success INTEGER NOT NULL DEFAULT 0, attention_auto_failure INTEGER NOT NULL DEFAULT 0, thinking_level TEXT);

CREATE TABLE api_keys (
  name TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  is_encrypted INTEGER NOT NULL DEFAULT 0,
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE adapters (
  platform TEXT PRIMARY KEY,
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'disabled',
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE adapter_user_mappings (
  platform TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (platform, platform_user_id)
);

CREATE TABLE feed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity TEXT,
  ref TEXT,
  summary TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);

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

CREATE TABLE crew_members (
  crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'specialist',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (crew_id, agent_name)
);

CREATE TABLE "entity_standing" (
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

CREATE TABLE entity_standing_cache (
  entity_id TEXT PRIMARY KEY,
  standing REAL NOT NULL DEFAULT 0,
  last_recomputed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE entity_competence (
  entity_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  demonstrations INTEGER NOT NULL DEFAULT 0,
  last_demo_at INTEGER,
  supervised_only INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_id, gate)
);

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

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

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

CREATE TABLE coding_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, writer TEXT, agent TEXT, driver TEXT, execution_target TEXT NOT NULL DEFAULT 'local', worktree_path TEXT, worktree_branch TEXT);

CREATE TABLE coding_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES coding_sessions(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

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

CREATE TABLE trait_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);

CREATE TABLE role_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);

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

CREATE TABLE note_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  publisher TEXT,
  observed_at INTEGER,
  retrieved_at INTEGER NOT NULL,
  content_hash TEXT, source_type TEXT NOT NULL DEFAULT 'url', source_note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL, source_entity TEXT, captured_by TEXT, excerpt TEXT, credibility REAL NOT NULL DEFAULT 0.5, metadata TEXT,
  UNIQUE(note_id, url)
);

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
, attention_kind TEXT NOT NULL DEFAULT 'operational', source_entity TEXT, target_entity TEXT, assigned_to TEXT, action_label TEXT, action_ref TEXT, metadata TEXT, seen_at INTEGER, snoozed_until INTEGER, deadline_at INTEGER);

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
  metadata TEXT, prompt_version TEXT, start_input_tokens INTEGER NOT NULL DEFAULT 0, end_input_tokens INTEGER, start_output_tokens INTEGER NOT NULL DEFAULT 0, end_output_tokens INTEGER, start_cost_usd REAL NOT NULL DEFAULT 0, end_cost_usd REAL,
  UNIQUE(entity_id, task_id, started_at)
);

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
, prompt_version TEXT, risk_class TEXT, trust_sources TEXT);

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
, network_profile TEXT NOT NULL DEFAULT 'provider-default', network_profile_enforced INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER, lifecycle_expires_at INTEGER, hibernated_reason TEXT);

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
  updated_at INTEGER NOT NULL, process_identity TEXT, publication_expires_at INTEGER,
  UNIQUE(entity_id, name)
);

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

CREATE TABLE evidence_receipts (
  sequence INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  ref TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  previous_hash TEXT,
  entry_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

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
, promotion_rationale TEXT, promotion_evidence TEXT, promoted_by TEXT);

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

CREATE TABLE journeys (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  expression TEXT NOT NULL CHECK(length(trim(expression)) BETWEEN 1 AND 4000),
  created_at INTEGER NOT NULL
);

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

CREATE TABLE journey_witnesses (
  journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL,
  witnessed_event_id INTEGER NOT NULL DEFAULT 0,
  witnessed_at INTEGER NOT NULL,
  PRIMARY KEY (journey_id, viewer_id)
);

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

CREATE TABLE associations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
  purpose TEXT NOT NULL DEFAULT '' CHECK(length(purpose) <= 4000),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

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
  created_at INTEGER NOT NULL, seq INTEGER,
  CHECK((subject_kind IS NULL AND subject_ref IS NULL) OR
        (subject_kind IS NOT NULL AND subject_ref IS NOT NULL AND
         length(trim(subject_kind)) BETWEEN 1 AND 80 AND
         length(trim(subject_ref)) BETWEEN 1 AND 500))
);

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
, seq INTEGER);

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
, seq INTEGER);

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
, seq INTEGER);

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
, seq INTEGER);

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

CREATE TABLE simulation_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('started','intervention','observation','measure','completed','failed','gap')),
  source_ref TEXT,
  data_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
, seq INTEGER);

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
, seq INTEGER);

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

CREATE TABLE memory_spaces (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES principals(principal_id),
 name TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','forgotten')), created_at INTEGER NOT NULL
, retrieval_generation INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}');

CREATE TABLE memory_grants (
 space_id TEXT NOT NULL REFERENCES memory_spaces(id), principal_id TEXT NOT NULL REFERENCES principals(principal_id),
 role TEXT NOT NULL CHECK(role IN ('reader','writer')), PRIMARY KEY(space_id,principal_id)
);

CREATE TABLE memory_records (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 version INTEGER NOT NULL, current_note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
 subject TEXT, metadata TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
, valid_from INTEGER, valid_until INTEGER, stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)), stale_reason TEXT);

CREATE TABLE memory_record_versions (
 record_id TEXT NOT NULL REFERENCES memory_records(id), version INTEGER NOT NULL,
 note_id INTEGER NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE, attributes TEXT, PRIMARY KEY(record_id,version)
);

CREATE TABLE memory_sources (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 space_id TEXT NOT NULL REFERENCES memory_spaces(id), session_id TEXT,
 body TEXT NOT NULL, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);

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
 response TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER, retired_at INTEGER, PRIMARY KEY(principal_id,space_id,request_key)
);

CREATE TABLE memory_service_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 operation TEXT NOT NULL, reference_id TEXT, version INTEGER, actor_id TEXT NOT NULL, created_at INTEGER NOT NULL
);

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

CREATE TABLE memory_vectors (
 note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE, model TEXT NOT NULL,
 dimensions INTEGER NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(note_id,model)
);

CREATE TABLE memory_claims (
 record_id TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES memory_spaces(id), subject TEXT NOT NULL,
 predicate TEXT NOT NULL, object_json TEXT NOT NULL, object_entity TEXT
);

CREATE TABLE memory_source_text (
 seq INTEGER PRIMARY KEY REFERENCES memory_sources(seq) ON DELETE CASCADE, text TEXT NOT NULL
);

CREATE VIRTUAL TABLE memory_source_fts USING fts5(text,content=memory_source_text,content_rowid=seq);

CREATE TABLE memory_vocabularies (
 space_id TEXT NOT NULL REFERENCES memory_spaces(id), version INTEGER NOT NULL,
 definition TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(space_id,version)
);

CREATE TABLE memory_revision_dependencies (
 record_id TEXT NOT NULL REFERENCES memory_records(id), record_version INTEGER NOT NULL,
 depends_on_id TEXT NOT NULL REFERENCES memory_records(id), depends_on_version INTEGER,
 PRIMARY KEY(record_id,record_version,depends_on_id)
);

CREATE TABLE memory_storage_usage (
 space_id TEXT PRIMARY KEY REFERENCES memory_spaces(id) ON DELETE CASCADE,
 logical_bytes INTEGER NOT NULL DEFAULT 0, sources INTEGER NOT NULL DEFAULT 0,
 revisions INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE memory_storage_items (
 kind TEXT NOT NULL, ref TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
 bytes INTEGER NOT NULL CHECK(bytes>=0), PRIMARY KEY(kind,ref)
);

CREATE TABLE memory_cached_results (
 space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 principal_id TEXT NOT NULL,
 name TEXT NOT NULL,
 version INTEGER NOT NULL,
 data TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(space_id,principal_id,name)
);

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

CREATE TABLE memory_assistance_jobs (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 requester_id TEXT NOT NULL, credential_id TEXT NOT NULL, worker_id TEXT NOT NULL,
 role TEXT NOT NULL, parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
 lease_token TEXT, lease_until INTEGER, deadline INTEGER NOT NULL,
 remaining_operations INTEGER NOT NULL, input_source_id TEXT NOT NULL REFERENCES memory_sources(id) ON DELETE CASCADE,
 result_record_id TEXT, evidence TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);

CREATE TABLE memory_assistance_actions (
 job_id TEXT NOT NULL REFERENCES memory_assistance_jobs(id) ON DELETE CASCADE,
 principal_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 response TEXT NOT NULL, PRIMARY KEY(job_id,principal_id,request_key)
);

CREATE VIRTUAL TABLE notes_fts USING fts5(content, content=notes, content_rowid=id, tokenize='porter unicode61');

CREATE TABLE memory_resolutions (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 record_id TEXT NOT NULL, policy TEXT NOT NULL
  CHECK(policy IN ('last_writer_wins','evidence_weighted','await_confirmation','keep_both')),
 status TEXT NOT NULL CHECK(status IN ('applied','pending','confirmed','superseded','retired')),
 actor_id TEXT NOT NULL, request_key TEXT NOT NULL, rationale TEXT NOT NULL,
 input TEXT NOT NULL, output TEXT NOT NULL, deadline INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE memory_resolution_members (
 resolution_id TEXT NOT NULL REFERENCES memory_resolutions(id) ON DELETE CASCADE,
 record_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('winner','superseded','peer','pending')),
 retired_at INTEGER, PRIMARY KEY(resolution_id,record_id)
);

CREATE TABLE memory_hygiene_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  scope TEXT NOT NULL,
  ratios TEXT NOT NULL
);

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

CREATE TABLE routing_channel_receipts (
  session_id TEXT NOT NULL REFERENCES routing_sessions(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, client_message_id)
);

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

CREATE TABLE spend_daily (
  day TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model_api', 'agent', 'decision', 'forecast')),
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, source)
);

CREATE TABLE legacy_memory_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  args TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(operation, args)
);

CREATE TABLE memory_note_projections (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE
);

CREATE TABLE "arena_shadow" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT NOT NULL,
  forecaster TEXT NOT NULL,
  forecast TEXT NOT NULL,
  detail TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_event_log_type ON event_log(type);

CREATE INDEX idx_event_log_timestamp ON event_log(timestamp);

CREATE INDEX idx_entities_room ON entities(room);

CREATE INDEX idx_sessions_entity ON sessions(entity_id);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE INDEX idx_channel_messages_channel ON channel_messages(channel_id);

CREATE INDEX idx_channel_messages_created ON channel_messages(created_at);

CREATE INDEX idx_channel_members_entity ON channel_members(entity_id);

CREATE INDEX idx_board_posts_board ON board_posts(board_id);

CREATE INDEX idx_board_posts_author ON board_posts(author_id);

CREATE INDEX idx_board_votes_post ON board_votes(post_id);

CREATE INDEX idx_group_members_entity ON group_members(entity_id);

CREATE INDEX idx_tasks_status ON tasks(status);

CREATE INDEX idx_tasks_group ON tasks(group_id);

CREATE INDEX idx_task_claims_entity ON task_claims(entity_id);

CREATE INDEX idx_room_sources_room ON room_sources(room_id);

CREATE INDEX idx_users_name ON users(name);

CREATE INDEX idx_adapter_links_user ON adapter_links(user_id);

CREATE INDEX idx_notes_entity ON notes(entity_name);

CREATE INDEX idx_notes_room ON notes(room_id);

CREATE INDEX idx_exp_status ON experiments(status);

CREATE INDEX idx_expr_experiment ON experiment_results(experiment_id);

CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

CREATE INDEX idx_notes_pool ON notes(pool_id);

CREATE INDEX idx_notes_type ON notes(note_type);

CREATE INDEX idx_notes_importance ON notes(importance);

CREATE INDEX idx_note_links_source ON note_links(source_id);

CREATE INDEX idx_note_links_target ON note_links(target_id);

CREATE INDEX idx_projects_name ON projects(name);

CREATE INDEX idx_projects_status ON projects(status);

CREATE INDEX idx_dynamic_commands_name ON dynamic_commands(name);

CREATE INDEX idx_dynamic_command_history_cmd ON dynamic_command_history(command_id);

CREATE INDEX idx_connectors_name ON connectors(name);

CREATE INDEX idx_connectors_status ON connectors(status);

CREATE INDEX idx_macros_author ON macros(author_id);

CREATE INDEX idx_entity_activity_entity ON entity_activity(entity_name);

CREATE INDEX idx_entity_activity_type ON entity_activity(entity_name, activity_type);

CREATE INDEX idx_assets_entity ON assets(entity_name);

CREATE INDEX idx_assets_mime ON assets(mime_type);

CREATE INDEX idx_assets_created ON assets(created_at);

CREATE INDEX idx_canvases_scope ON canvases(scope, scope_id);

CREATE INDEX idx_canvas_nodes_canvas ON canvas_nodes(canvas_id);

CREATE INDEX idx_canvas_nodes_type ON canvas_nodes(type);

CREATE INDEX idx_shell_log_entity ON shell_log(entity_id);

CREATE INDEX idx_shell_log_created ON shell_log(created_at);

CREATE INDEX idx_gateways_name ON gateways(name);

CREATE INDEX idx_canvas_nodes_parent ON canvas_nodes(parent_node_id);

CREATE INDEX idx_markets_room ON markets(room_id);

CREATE INDEX idx_markets_status ON markets(status);

CREATE UNIQUE INDEX idx_positions_market_entity ON market_positions(market_id, entity_name);

CREATE INDEX idx_positions_entity ON market_positions(entity_name);

CREATE INDEX idx_scores_entity ON market_scores(entity_name);

CREATE INDEX idx_scores_market ON market_scores(market_id);

CREATE INDEX idx_mem_api_keys_secret ON mem_api_keys(secret);

CREATE INDEX idx_mem_api_keys_agent ON mem_api_keys(agent_name);

CREATE INDEX idx_traits_category ON traits(category);

CREATE INDEX idx_api_keys_provider ON api_keys(provider);

CREATE INDEX idx_feed_events_created_at ON feed_events (created_at DESC);

CREATE INDEX idx_feed_events_kind ON feed_events (kind, created_at DESC);

CREATE INDEX idx_feed_events_entity ON feed_events (entity, created_at DESC);

CREATE INDEX idx_canvas_edges_canvas ON canvas_edges (canvas_id);

CREATE INDEX idx_canvas_edges_source ON canvas_edges (source_id);

CREATE INDEX idx_canvas_edges_target ON canvas_edges (target_id);

CREATE INDEX idx_benchmark_runs_bench ON benchmark_runs (benchmark, score DESC);

CREATE INDEX idx_benchmark_runs_config ON benchmark_runs (benchmark, config_hash);

CREATE INDEX idx_benchmark_runs_started ON benchmark_runs (started_at DESC);

CREATE INDEX idx_benchmark_runs_agent ON benchmark_runs (agent_id, started_at DESC);

CREATE INDEX idx_notes_tier ON notes(tier);

CREATE INDEX idx_notes_entity_tier ON notes(entity_name, tier);

CREATE INDEX idx_crews_state ON crews(state);

CREATE INDEX idx_crews_owner ON crews(owner_id);

CREATE INDEX idx_crew_members_agent ON crew_members(agent_name);

CREATE UNIQUE INDEX idx_entity_standing_dedup
  ON "entity_standing"(entity_id, kind, ref);

CREATE INDEX idx_entity_standing_entity ON "entity_standing"(entity_id, earned_at DESC);

CREATE INDEX idx_entity_standing_kind ON "entity_standing"(kind, earned_at DESC);

CREATE INDEX idx_entity_competence_entity ON entity_competence(entity_id);

CREATE INDEX idx_chronicle_created_at ON chronicle(created_at DESC);

CREATE INDEX idx_chronicle_kind ON chronicle(kind, created_at DESC);

CREATE INDEX idx_chronicle_source ON chronicle(source, created_at DESC);

CREATE INDEX idx_chronicle_period ON chronicle(period);

CREATE UNIQUE INDEX idx_users_auth_subject ON users(auth_subject) WHERE auth_subject IS NOT NULL;

CREATE INDEX idx_media_jobs_entity ON media_jobs(entity_name, created_at DESC);

CREATE INDEX idx_media_jobs_status ON media_jobs(status, created_at DESC);

CREATE INDEX idx_coding_sessions_created_by ON coding_sessions(created_by, updated_at DESC);

CREATE INDEX idx_coding_events_session ON coding_events(session_id, created_at ASC);

CREATE INDEX idx_coding_artifacts_session ON coding_artifacts(session_id, created_at DESC);

CREATE INDEX idx_coding_artifacts_status ON coding_artifacts(status, updated_at DESC);

CREATE INDEX idx_trait_history_name ON trait_history(name, id DESC);

CREATE INDEX idx_role_history_name ON role_history(name, id DESC);

CREATE INDEX idx_task_claims_lease ON task_claims(status, lease_expires_at);

CREATE UNIQUE INDEX idx_direct_messages_correlation ON direct_messages(correlation_id);

CREATE INDEX idx_direct_messages_inbox ON direct_messages(target_id, status, created_at DESC);

CREATE INDEX idx_direct_messages_dedupe ON direct_messages(sender_id, target_id, dedupe_key, created_at DESC);

CREATE INDEX idx_notes_claim_key ON notes(entity_name, claim_key);

CREATE INDEX idx_notes_verification ON notes(entity_name, verification_status);

CREATE INDEX idx_note_sources_note ON note_sources(note_id);

CREATE INDEX idx_operational_alerts_status ON operational_alerts(status, severity, last_seen_at DESC);

CREATE INDEX idx_note_sources_source_note ON note_sources(source_note_id);

CREATE INDEX idx_note_verifications_note ON note_verifications(note_id, created_at DESC);

CREATE INDEX idx_contradiction_cases_status ON contradiction_cases(status, updated_at DESC);

CREATE INDEX idx_productivity_entity ON productivity_sessions(entity_name, completed_at DESC);

CREATE INDEX idx_productivity_outcome ON productivity_sessions(outcome, completed_at DESC);

CREATE INDEX idx_primitive_usage_actor ON primitive_usage(actor_name, created_at DESC);

CREATE INDEX idx_primitive_usage_source ON primitive_usage(source, created_at DESC);

CREATE INDEX idx_primitive_usage_meaningful ON primitive_usage(meaningful, created_at DESC);

CREATE INDEX idx_primitive_usage_prompt ON primitive_usage(prompt_version, created_at DESC);

CREATE INDEX idx_productivity_prompt ON productivity_sessions(prompt_version, completed_at DESC);

CREATE INDEX idx_crew_invitations_agent ON crew_invitations(agent_name, status, expires_at);

CREATE INDEX idx_crew_invitations_crew ON crew_invitations(crew_id, status);

CREATE INDEX idx_primitive_usage_risk ON primitive_usage(risk_class, created_at DESC);

CREATE INDEX idx_evolution_sessions_status ON evolution_sessions(status);

CREATE INDEX idx_evolution_runs_session ON evolution_runs(session_id, sequence);

CREATE INDEX idx_flywheel_bindings_state ON flywheel_bindings(state);

CREATE INDEX idx_coding_projects_entity ON coding_projects(entity_id, updated_at DESC);

CREATE INDEX idx_coding_services_entity ON coding_services(entity_id, status, updated_at DESC);

CREATE INDEX idx_coding_service_probes_service
  ON coding_service_probes(service_id, created_at DESC);

CREATE INDEX idx_flywheel_credential_bindings_entity
  ON flywheel_credential_bindings(entity_id, state, updated_at DESC);

CREATE INDEX idx_flywheel_operations_created
  ON flywheel_operations(created_at DESC);

CREATE INDEX idx_flywheel_operations_kind
  ON flywheel_operations(operation, outcome, created_at DESC);

CREATE INDEX idx_trace_judgments_trace
  ON trace_judgments(trace_id, created_at DESC);

CREATE INDEX idx_trace_judgments_evaluator
  ON trace_judgments(evaluator_entity, created_at DESC);

CREATE INDEX idx_structured_logs_time ON structured_logs(timestamp DESC, id DESC);

CREATE INDEX idx_structured_logs_level ON structured_logs(level, timestamp DESC);

CREATE INDEX idx_structured_logs_category ON structured_logs(category, timestamp DESC);

CREATE INDEX idx_structured_logs_trace ON structured_logs(trace_id, timestamp DESC);

CREATE INDEX idx_structured_logs_request ON structured_logs(request_id, timestamp DESC);

CREATE INDEX idx_operational_alerts_attention
  ON operational_alerts(status, snoozed_until, deadline_at, last_seen_at DESC);

CREATE INDEX idx_operational_alerts_assigned
  ON operational_alerts(assigned_to, status, last_seen_at DESC);

CREATE INDEX idx_evidence_receipts_ref ON evidence_receipts(ref, sequence DESC);

CREATE INDEX idx_evidence_receipts_type ON evidence_receipts(event_type, sequence DESC);

CREATE UNIQUE INDEX idx_principals_identity
  ON principals(principal_type, display_name COLLATE NOCASE, home_world);

CREATE INDEX idx_principals_owner ON principals(owner_principal_id, status);

CREATE INDEX idx_principals_lineage ON principals(lineage_parent_id, status);

CREATE INDEX idx_principal_credentials_principal
  ON principal_credentials(principal_id, revoked_at, expires_at DESC);

CREATE INDEX idx_principal_credentials_expiry
  ON principal_credentials(expires_at, revoked_at);

CREATE INDEX idx_world_variants_status ON world_variants(status, updated_at DESC);

CREATE INDEX idx_world_variants_parent ON world_variants(parent_variant_id, created_at DESC);

CREATE INDEX idx_federation_peers_trust
  ON federation_peers(trust_status, name COLLATE NOCASE);

CREATE INDEX idx_journeys_requester
  ON journeys(requester_id, created_at DESC);

CREATE INDEX idx_journey_links_journey
  ON journey_links(journey_id, created_at, id);

CREATE INDEX idx_journey_links_ref
  ON journey_links(kind, ref);

CREATE INDEX idx_journey_events_journey
  ON journey_events(journey_id, created_at, id);

CREATE INDEX idx_journey_events_ref
  ON journey_events(ref_kind, ref);

CREATE INDEX idx_journey_witnesses_viewer
  ON journey_witnesses(viewer_id, witnessed_at DESC);

CREATE INDEX idx_cognitive_events_journey ON cognitive_events(journey_id, sequence);

CREATE INDEX idx_cognitive_events_actor ON cognitive_events(actor_id, sequence);

CREATE INDEX idx_cognitive_events_trace ON cognitive_events(trace_id, sequence);

CREATE INDEX idx_intellect_instances_intellect ON intellect_instances(intellect_id, created_at);

CREATE INDEX idx_intellect_instances_principal ON intellect_instances(local_principal_id);

CREATE INDEX idx_intellect_events_intellect ON intellect_events(intellect_id, created_at, id);

CREATE INDEX idx_intellect_events_related ON intellect_events(related_intellect_id, created_at);

CREATE INDEX idx_associations_created ON associations(created_at DESC, id);

CREATE INDEX idx_association_events_association
  ON association_events(association_id, created_at, id);

CREATE INDEX idx_association_events_subject
  ON association_events(subject_kind, subject_ref, created_at);

CREATE INDEX idx_association_relations_association
  ON association_relations(association_id, created_at, id);

CREATE INDEX idx_association_relations_source
  ON association_relations(source_kind, source_ref, created_at);

CREATE INDEX idx_association_relations_target
  ON association_relations(target_kind, target_ref, created_at);

CREATE INDEX idx_association_links_association
  ON association_links(association_id, created_at, id);

CREATE INDEX idx_association_links_ref ON association_links(kind, ref, created_at);

CREATE INDEX idx_cognitive_reproductions_created ON cognitive_reproductions(created_at DESC, id);

CREATE INDEX idx_cognitive_reproduction_components
  ON cognitive_reproduction_components(reproduction_id, kind, created_at);

CREATE INDEX idx_marina_descendants_genome ON marina_descendants(genome_hash, created_at);

CREATE INDEX idx_marina_descendants_variant ON marina_descendants(world_variant_id);

CREATE INDEX idx_mesh_membership_world ON mesh_membership_events(mesh_id, world_id, created_at);

CREATE INDEX idx_mesh_events_mesh ON mesh_events(mesh_id, created_at, id);

CREATE INDEX idx_mesh_witnesses_event ON mesh_witnesses(event_id, created_at);

CREATE INDEX idx_mesh_translations_source ON mesh_translations(source_mesh_id, created_at);

CREATE INDEX idx_economic_contracts_goal ON economic_contracts(goal_ref, created_at);

CREATE INDEX idx_economic_events_contract ON economic_events(contract_id, created_at, id);

CREATE INDEX idx_economic_events_external ON economic_events(external_ref);

CREATE INDEX idx_simulation_runs_manifest ON simulation_runs(manifest_hash, created_at, id);

CREATE INDEX idx_simulation_events_run ON simulation_events(run_id, created_at, id);

CREATE INDEX idx_civilization_mutations_target ON civilization_mutations(domain, target_ref, created_at);

CREATE INDEX idx_civilization_mutations_descendant ON civilization_mutations(descendant_ref);

CREATE INDEX idx_association_events_seq ON association_events(association_id, seq);

CREATE INDEX idx_association_relations_seq ON association_relations(association_id, seq);

CREATE INDEX idx_association_links_seq ON association_links(association_id, seq);

CREATE INDEX idx_economic_events_seq ON economic_events(contract_id, seq);

CREATE INDEX idx_simulation_events_seq ON simulation_events(run_id, seq);

CREATE INDEX idx_civilization_mutations_seq ON civilization_mutations(domain, target_ref, seq);

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

CREATE INDEX idx_witness_attestations_open ON witness_attestations(status, gate, created_at);

CREATE INDEX idx_witness_attestations_entity ON witness_attestations(entity_id, gate, status, kind);

CREATE INDEX idx_memory_records_space ON memory_records(space_id,status,created_at,id);

CREATE INDEX idx_memory_sources_space ON memory_sources(space_id,seq);

CREATE INDEX idx_memory_service_events_space ON memory_service_events(space_id,seq);

CREATE INDEX idx_memory_index_jobs_pending ON memory_index_jobs(state,lease_until,created_at);

CREATE INDEX idx_memory_claims_subject ON memory_claims(space_id,subject,predicate,record_id);

CREATE INDEX idx_memory_claims_object ON memory_claims(space_id,object_entity,predicate,record_id);

CREATE INDEX idx_memory_records_id ON memory_records(space_id,status,id);

CREATE INDEX idx_memory_records_note ON memory_records(current_note_id);

CREATE INDEX idx_memory_records_subject ON memory_records(space_id,status,subject,id);

CREATE INDEX idx_memory_claims_predicate ON memory_claims(space_id,predicate,object_json,record_id);

CREATE INDEX idx_memory_claims_value ON memory_claims(space_id,object_json,predicate,record_id);

CREATE INDEX idx_memory_sources_session ON memory_sources(space_id,session_id,seq);

CREATE INDEX idx_memory_revision_dependency_target ON memory_revision_dependencies(depends_on_id,record_id,record_version);

CREATE INDEX idx_memory_spaces_owner ON memory_spaces(owner_id,status);

CREATE INDEX idx_memory_storage_space ON memory_storage_items(space_id);

CREATE INDEX idx_memory_requests_retention ON memory_requests(acknowledged_at) WHERE retired_at IS NULL;

CREATE INDEX idx_memory_review_stale ON memory_records(space_id,id) WHERE stale=1 AND status='active';

CREATE INDEX idx_memory_transfers_owner ON memory_transfers(principal_id,state);

CREATE INDEX idx_memory_transfers_space_owner_id ON memory_transfers(space_id,principal_id,id);

CREATE INDEX idx_memory_records_format ON memory_records(space_id,json_extract(metadata,'$.format'),created_at,id) WHERE status='active';

CREATE INDEX idx_memory_assistance_worker ON memory_assistance_jobs(worker_id,state,created_at);

CREATE INDEX idx_memory_assistance_requester ON memory_assistance_jobs(requester_id,created_at);

CREATE INDEX idx_memory_assistance_root ON memory_assistance_jobs(root_id);

CREATE UNIQUE INDEX idx_memory_assistance_source ON memory_assistance_jobs(input_source_id);

CREATE INDEX idx_memory_resolutions_space ON memory_resolutions(space_id,status,created_at);

CREATE INDEX idx_memory_resolutions_record ON memory_resolutions(record_id,created_at);

CREATE INDEX idx_memory_resolution_members_record ON memory_resolution_members(record_id,role,retired_at);

CREATE INDEX idx_memory_hygiene_snapshots_scope_at ON memory_hygiene_snapshots(scope, at);

CREATE INDEX idx_direct_messages_delivered_deadline
  ON direct_messages(deadline_at) WHERE status = 'delivered';

CREATE INDEX idx_notes_supersedes ON notes(supersedes_id);

CREATE INDEX idx_note_sources_url ON note_sources(url);

CREATE INDEX idx_entities_name ON entities(name);

CREATE INDEX idx_notes_dedup ON notes(entity_name, note_type, substr(content, 1, 64));

CREATE INDEX idx_routing_sessions_group ON routing_sessions(group_id, id);

CREATE INDEX idx_routing_events_retention ON routing_events(created_at);

CREATE INDEX idx_routing_messages_inbox ON routing_messages(target_id, status, created_at, id);

CREATE INDEX idx_routing_messages_retention ON routing_messages(status, acknowledged_at);

CREATE INDEX idx_routing_channel_receipts_retention ON routing_channel_receipts(created_at);

CREATE INDEX idx_routing_events_kind ON routing_events(session_id, kind, sequence);

CREATE INDEX idx_coding_run_lookup ON coding_artifacts(session_id, kind, status);

CREATE INDEX idx_coding_run_evidence ON coding_artifacts(json_extract(metadata_json, '$.runId'));

CREATE UNIQUE INDEX idx_coding_run_session_active ON coding_artifacts(session_id)
  WHERE kind = 'task_run' AND status = 'active';

CREATE UNIQUE INDEX idx_coding_run_worker_active ON coding_artifacts(json_extract(metadata_json, '$.workerKey'))
  WHERE kind = 'task_run' AND status = 'active';

CREATE INDEX idx_arena_submissions_round ON arena_submissions(entrant, round_id, id);

CREATE INDEX idx_judge_observations_claim ON judge_observations(task_id, claimant_name);

CREATE INDEX idx_judge_observations_evaluator ON judge_observations(evaluator, id);

CREATE INDEX idx_autonomy_pulse_at ON autonomy_pulse(at);

CREATE INDEX idx_memory_note_projections_record ON memory_note_projections(record_id);

CREATE INDEX idx_arena_shadow_round ON arena_shadow(round_id, forecaster, created_at);

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

CREATE TRIGGER memory_assistance_forget AFTER INSERT ON memory_service_events
WHEN new.operation IN ('memory.forgotten','forget.completed','space.forgotten') BEGIN
 UPDATE memory_assistance_jobs SET evidence='[]',lease_token=NULL,lease_until=NULL,
 state=CASE WHEN state IN ('pending','running') THEN 'cancelled' ELSE state END,
 version=version+1 WHERE space_id=new.space_id;
END;

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

CREATE TRIGGER legacy_memory_deleted BEFORE DELETE ON notes
WHEN OLD.entity_name NOT LIKE 'memory:%'
BEGIN
  INSERT OR IGNORE INTO legacy_memory_outbox(operation,args)
  SELECT 'retireDurableTwin',json_array(OLD.entity_name,OLD.id,
    json_object('recordId',p.record_id))
  FROM memory_note_projections p JOIN memory_records r ON r.id=p.record_id
  WHERE p.note_id=OLD.id AND r.status='active';
END;

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('curl', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('wget', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('ls', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('cat', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('head', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('tail', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('wc', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('grep', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('find', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('jq', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('echo', 'system', (strftime('%s','now') * 1000));

INSERT INTO "shell_allowlist" ("binary", "added_by", "added_at") VALUES ('date', 'system', (strftime('%s','now') * 1000));

INSERT INTO schema_version(version) VALUES (137);
`;
