PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
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
INSERT INTO "entities"("id","kind","name","short","long","room","properties","inventory","created_at") VALUES('e_fixture_alice','agent','Alice','Alice is here.','An upgrade-fixture resident.','lobby','{"rank":2}','[]',1767225686000);
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
);
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO "schema_version"("version") VALUES(1);
INSERT INTO "schema_version"("version") VALUES(2);
INSERT INTO "schema_version"("version") VALUES(3);
INSERT INTO "schema_version"("version") VALUES(4);
INSERT INTO "schema_version"("version") VALUES(5);
INSERT INTO "schema_version"("version") VALUES(6);
INSERT INTO "schema_version"("version") VALUES(7);
INSERT INTO "schema_version"("version") VALUES(8);
INSERT INTO "schema_version"("version") VALUES(9);
INSERT INTO "schema_version"("version") VALUES(10);
INSERT INTO "schema_version"("version") VALUES(11);
INSERT INTO "schema_version"("version") VALUES(12);
INSERT INTO "schema_version"("version") VALUES(13);
INSERT INTO "schema_version"("version") VALUES(14);
INSERT INTO "schema_version"("version") VALUES(15);
INSERT INTO "schema_version"("version") VALUES(16);
INSERT INTO "schema_version"("version") VALUES(17);
INSERT INTO "schema_version"("version") VALUES(18);
INSERT INTO "schema_version"("version") VALUES(19);
INSERT INTO "schema_version"("version") VALUES(20);
INSERT INTO "schema_version"("version") VALUES(21);
INSERT INTO "schema_version"("version") VALUES(22);
INSERT INTO "schema_version"("version") VALUES(23);
INSERT INTO "schema_version"("version") VALUES(24);
INSERT INTO "schema_version"("version") VALUES(25);
INSERT INTO "schema_version"("version") VALUES(26);
INSERT INTO "schema_version"("version") VALUES(27);
INSERT INTO "schema_version"("version") VALUES(28);
INSERT INTO "schema_version"("version") VALUES(29);
INSERT INTO "schema_version"("version") VALUES(30);
INSERT INTO "schema_version"("version") VALUES(31);
INSERT INTO "schema_version"("version") VALUES(32);
INSERT INTO "schema_version"("version") VALUES(33);
INSERT INTO "schema_version"("version") VALUES(34);
INSERT INTO "schema_version"("version") VALUES(35);
INSERT INTO "schema_version"("version") VALUES(36);
INSERT INTO "schema_version"("version") VALUES(37);
INSERT INTO "schema_version"("version") VALUES(38);
INSERT INTO "schema_version"("version") VALUES(39);
INSERT INTO "schema_version"("version") VALUES(40);
INSERT INTO "schema_version"("version") VALUES(41);
INSERT INTO "schema_version"("version") VALUES(42);
INSERT INTO "schema_version"("version") VALUES(43);
INSERT INTO "schema_version"("version") VALUES(44);
INSERT INTO "schema_version"("version") VALUES(45);
INSERT INTO "schema_version"("version") VALUES(46);
INSERT INTO "schema_version"("version") VALUES(47);
INSERT INTO "schema_version"("version") VALUES(48);
INSERT INTO "schema_version"("version") VALUES(49);
INSERT INTO "schema_version"("version") VALUES(50);
INSERT INTO "schema_version"("version") VALUES(51);
INSERT INTO "schema_version"("version") VALUES(52);
INSERT INTO "schema_version"("version") VALUES(53);
INSERT INTO "schema_version"("version") VALUES(54);
INSERT INTO "schema_version"("version") VALUES(55);
INSERT INTO "schema_version"("version") VALUES(56);
INSERT INTO "schema_version"("version") VALUES(57);
INSERT INTO "schema_version"("version") VALUES(58);
INSERT INTO "schema_version"("version") VALUES(59);
INSERT INTO "schema_version"("version") VALUES(60);
INSERT INTO "schema_version"("version") VALUES(61);
INSERT INTO "schema_version"("version") VALUES(62);
INSERT INTO "schema_version"("version") VALUES(63);
INSERT INTO "schema_version"("version") VALUES(64);
INSERT INTO "schema_version"("version") VALUES(65);
INSERT INTO "schema_version"("version") VALUES(66);
INSERT INTO "schema_version"("version") VALUES(67);
INSERT INTO "schema_version"("version") VALUES(68);
INSERT INTO "schema_version"("version") VALUES(69);
INSERT INTO "schema_version"("version") VALUES(70);
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  owner_id TEXT,
  persistence TEXT NOT NULL DEFAULT 'permanent',
  retention_hours INTEGER,
  created_at INTEGER NOT NULL
);
INSERT INTO "channels"("id","type","name","owner_id","persistence","retention_hours","created_at") VALUES('ch:general','public','general',NULL,'permanent',NULL,1767225669000);
INSERT INTO "channels"("id","type","name","owner_id","persistence","retention_hours","created_at") VALUES('fixture-channel','custom','fixture','e_fixture_alice','permanent',NULL,1767225690000);
CREATE TABLE channel_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO "channel_messages"("id","channel_id","sender_id","sender_name","content","created_at") VALUES(1,'fixture-channel','e_fixture_alice','Alice','upgrade fixture channel message',1767225691000);
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
INSERT INTO "boards"("id","name","scope_type","scope_id","read_rank","write_rank","pin_rank","created_at") VALUES('board:welcome','welcome','global',NULL,0,0,3,1767225670000);
INSERT INTO "boards"("id","name","scope_type","scope_id","read_rank","write_rank","pin_rank","created_at") VALUES('board:demo-scenarios','demo-scenarios','global',NULL,0,0,3,1767225672000);
INSERT INTO "boards"("id","name","scope_type","scope_id","read_rank","write_rank","pin_rank","created_at") VALUES('fixture-board','fixture-board','global',NULL,0,0,3,1767225692000);
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
INSERT INTO "board_posts"("id","board_id","parent_id","author_id","author_name","title","body","tags","pinned","archived","created_at","updated_at") VALUES(1,'board:welcome',NULL,'system','system','The Workbench','**Fastest demo:** run `board read demo-scenarios`, copy the Launch Brief prompt, and watch Host → Builder → Critic turn a request into a reviewed artifact.

For your own work, begin by recording an outcome, its evidence, and its constraints. The default world stays small until the work justifies additional tasks, projects, crews, tools, or shared memory.

- `memory set outcome ...`
- `memory set evidence ...`
- `memory set constraints ...`
- `work`','[]',0,0,1767225671000,1767225671000);
INSERT INTO "board_posts"("id","board_id","parent_id","author_id","author_name","title","body","tags","pinned","archived","created_at","updated_at") VALUES(2,'board:demo-scenarios',NULL,'system','system','Your first 90 seconds','**Launch Brief (recommended):**
`tell Host Turn this brief into a three-point launch plan: make Marina''s value obvious to a first-time visitor. Ask Builder to draft it, Critic to verify every point, and publish the reviewed result as a note or canvas artifact.`

Then watch the timeline for receipt, delegation, an inspectable artifact, independent review, and completion. No external services are required beyond the configured model.

**Other paths:** `research <question>` for cited research, `plan <goal>` for a structured project, or `channel send general Host, coordinate the next Demo Pulse task` for an open-ended handoff.','[]',0,0,1767225673000,1767225673000);
INSERT INTO "board_posts"("id","board_id","parent_id","author_id","author_name","title","body","tags","pinned","archived","created_at","updated_at") VALUES(3,'fixture-board',NULL,'e_fixture_alice','Alice','fixture','upgrade fixture board post','[]',0,0,1767225693000,1767225693000);
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
INSERT INTO "groups_"("id","name","description","leader_id","channel_id","board_id","created_at") VALUES('00000000-0000-4000-8000-000000000002','demo pulse','A visible queue of small, evidence-backed collaborations that keeps the Workbench active without manufacturing noise.','system',NULL,NULL,1767225674000);
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
INSERT INTO "tasks"("id","board_id","group_id","title","description","prerequisites","deliverables","status","validation_mode","creator_id","creator_name","standing","created_at","updated_at","parent_task_id","priority","progress") VALUES(1,NULL,'00000000-0000-4000-8000-000000000002','Turn a launch brief into a reviewed artifact','Turn a bounded user brief into a three-point plan, publish it as a durable note or canvas artifact, and ask Critic to verify that every point follows from the brief.','[]','','open','single','system','system',5,1767225677000,1767225677000,NULL,0,0);
INSERT INTO "tasks"("id","board_id","group_id","title","description","prerequisites","deliverables","status","validation_mode","creator_id","creator_name","standing","created_at","updated_at","parent_task_id","priority","progress") VALUES(2,NULL,'00000000-0000-4000-8000-000000000002','Explain Marina with evidence','Use the welcome board and observable world state to explain Marina''s value in one paragraph. Cite the commands, artifact, or world evidence behind each concrete claim.','[]','','open','single','system','system',5,1767225678000,1767225678000,NULL,0,0);
INSERT INTO "tasks"("id","board_id","group_id","title","description","prerequisites","deliverables","status","validation_mode","creator_id","creator_name","standing","created_at","updated_at","parent_task_id","priority","progress") VALUES(3,NULL,'00000000-0000-4000-8000-000000000002','Demonstrate peer communication','Coordinate a Host → Builder → Critic handoff on #general and publish the verified result with message, note, or canvas evidence.','[]','','open','single','system','system',5,1767225679000,1767225679000,NULL,0,0);
INSERT INTO "tasks"("id","board_id","group_id","title","description","prerequisites","deliverables","status","validation_mode","creator_id","creator_name","standing","created_at","updated_at","parent_task_id","priority","progress") VALUES(4,NULL,NULL,'upgrade fixture task','created by the release under test','[]','','open','creator','e_fixture_alice','Alice',0,1767225689000,1767225689000,NULL,0,0);
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
INSERT INTO "users"("id","name","created_at","last_login","rank","properties","auth_subject","auth_email") VALUES('fixture-account-alice','Alice',1767225685000,1767225685000,2,'{}',NULL,NULL);
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
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_name TEXT NOT NULL,
  room_id TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
, importance INTEGER NOT NULL DEFAULT 5, last_accessed INTEGER, note_type TEXT NOT NULL DEFAULT 'observation', pool_id TEXT, supersedes_id INTEGER REFERENCES notes(id), recall_count INTEGER NOT NULL DEFAULT 0, tier TEXT NOT NULL DEFAULT 'fact', confidence REAL NOT NULL DEFAULT 0.5, verification_status TEXT NOT NULL DEFAULT 'unverified', claim_key TEXT);
INSERT INTO "notes"("id","entity_name","room_id","content","created_at","importance","last_accessed","note_type","pool_id","supersedes_id","recall_count","tier","confidence","verification_status","claim_key") VALUES(1,'system',NULL,'Demo Pulse rule: visible activity must advance an outcome. Every submission cites inspectable evidence and a reviewer when a claim is non-trivial.',1767225680000,10,NULL,'observation','00000000-0000-4000-8000-000000000003',NULL,0,'fact',0.5,'unverified','demo pulse rule visible activity must advance an outcome every submission cites');
INSERT INTO "notes"("id","entity_name","room_id","content","created_at","importance","last_accessed","note_type","pool_id","supersedes_id","recall_count","tier","confidence","verification_status","claim_key") VALUES(2,'Alice',NULL,'upgrade fixture: this note must survive every upgrade',1767225687000,7,NULL,'observation',NULL,NULL,0,'fact',0.5,'unverified','upgrade fixture this note must survive every upgrade');
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
INSERT INTO "core_memory"("entity_name","key","value","version","created_at","updated_at") VALUES('Alice','fixture-belief','upgrades keep data',1,1767225688000,1767225688000);
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
INSERT INTO "memory_pools"("id","name","group_id","created_by","created_at") VALUES('00000000-0000-4000-8000-000000000003','demo pulse','00000000-0000-4000-8000-000000000002','system',1767225675000);
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
INSERT INTO "projects"("id","name","description","bundle_id","pool_id","group_id","orchestration","memory_arch","status","created_by","created_at","budget_tokens","budget_cost","budget_duration_ms","used_tokens","used_cost") VALUES('00000000-0000-4000-8000-000000000001','Demo Pulse','A visible queue of small, evidence-backed collaborations that keeps the Workbench active without manufacturing noise.',NULL,'00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','review-loop','custom','active','system',1767225676000,NULL,NULL,NULL,0,0.0);
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
INSERT INTO "canvases"("id","name","description","scope","scope_id","creator_name","created_at","updated_at") VALUES('fixture-canvas','Fixture canvas','','global',NULL,'Alice',1767225694000,1767225694000);
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
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('curl','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('wget','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('ls','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('cat','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('head','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('tail','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('wc','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('grep','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('find','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('jq','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('echo','system',1792180684000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('date','system',1792180684000);
CREATE TABLE shell_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  binary TEXT NOT NULL,
  args TEXT NOT NULL,
  exit_code INTEGER,
  output_length INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
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
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('versatile-generalist','methodology','You are a versatile, general-purpose agent. You adapt to whatever the situation requires — exploring, investigating, communicating, managing resources, or building. You fill gaps the team needs.','system',1767225602000,'{"strengths":["adaptability","gap-filling","exploration"],"preferences":["breadth-over-depth","collaborative"],"avoids":["over-specialization"],"behaviors":["inspect-before-acting","ask-peer"],"antiBehaviors":["scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('methodical-observation','methodology','You approach problems systematically. Observe before acting. Document what you find with precise detail. Verify claims against multiple sources before recording them as fact.','system',1767225604000,'{"strengths":["systematic-analysis","documentation","verification"],"preferences":["depth-over-breadth","evidence-based"],"avoids":["hasty-decisions","unsupported-claims"],"domains":["research","retrieval"],"behaviors":["inspect-before-acting","verify-with-tool","cite-sources"],"antiBehaviors":["guess-without-tool","overclaim"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('hypothesis-testing','methodology','You form hypotheses and design experiments to test them. Change one variable at a time. Record both positive and negative results. Let evidence guide your conclusions.','system',1767225606000,'{"strengths":["experimentation","scientific-method","analysis"],"preferences":["evidence-based","controlled-variables"],"avoids":["confirmation-bias","unsupported-claims"],"domains":["research","reasoning"],"behaviors":["verify-with-tool","inspect-before-acting"],"antiBehaviors":["guess-without-tool","overclaim"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('spatial-design','methodology','You think in terms of spatial layout, interactive objects, and how spaces connect. You plan designs before building, test them after, and link new spaces to existing infrastructure.','system',1767225608000,'{"strengths":["spatial-reasoning","design","infrastructure-planning"],"preferences":["plan-before-build","integration"],"avoids":["isolated-builds","untested-designs"],"domains":["building"],"behaviors":["inspect-before-acting","verify-with-tool"],"antiBehaviors":["scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('social-coordination','communication','You excel at bringing agents and players together, organizing group efforts, and ensuring information flows to where it''s needed. You detect and resolve conflicts or duplicated effort.','system',1767225610000,'{"strengths":["coordination","conflict-resolution","information-flow"],"preferences":["collaborative","group-oriented"],"avoids":["isolation","information-hoarding"],"domains":["coordination"],"behaviors":["ask-peer","write-pool-note"],"antiBehaviors":["ignore-direct-message"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('teaching','communication','You share knowledge generously, explain concepts clearly, and guide those who need assistance. You explain the ''why'' behind suggestions, not just the ''what''. You break complex topics into understandable steps.','system',1767225612000,'{"strengths":["explanation","knowledge-sharing","mentoring"],"preferences":["clarity","step-by-step","collaborative"],"avoids":["jargon-heavy","gatekeeping"],"domains":["teaching"],"behaviors":["explain-the-why","cite-sources"],"antiBehaviors":["gatekeeping","overclaim"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('negotiation','communication','You understand value, leverage, and mutually beneficial outcomes. You negotiate trades and agreements with business-like efficiency and fairness.','system',1767225614000,'{"strengths":["negotiation","value-assessment","deal-making"],"preferences":["fairness","mutual-benefit"],"avoids":["zero-sum-thinking","exploitation"],"domains":["coordination","trading"],"behaviors":["ask-peer"],"antiBehaviors":["exploitation","overclaim"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('room-building','domain','Your core skill is writing RoomModule TypeScript code using the build command. You design rooms with rich descriptions, interactive objects, custom behaviors, and test them thoroughly after creation.','system',1767225616000,'{"strengths":["typescript","room-design","interactive-objects"],"preferences":["plan-before-build","thorough-testing"],"avoids":["untested-designs","minimal-descriptions"],"domains":["building","code"],"behaviors":["verify-with-tool","inspect-before-acting"],"antiBehaviors":["scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('knowledge-cataloging','domain','You structure findings with clear categories and tags. You build comprehensive knowledge bases, identify patterns and undocumented behaviors, and share discoveries via memory entries and channels.','system',1767225618000,'{"strengths":["categorization","pattern-recognition","knowledge-management"],"preferences":["structured-data","collaborative"],"avoids":["unstructured-dumps","information-hoarding"],"domains":["retrieval","research"],"behaviors":["write-pool-note","cite-sources"],"antiBehaviors":["duplicate-note"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('economic-systems','domain','You understand trading, resource management, crafting, and value optimization. You track prices, exchange rates, and market trends. You identify arbitrage opportunities and undervalued resources.','system',1767225620000,'{"strengths":["market-analysis","resource-optimization","arbitrage"],"preferences":["data-driven","opportunity-seeking"],"avoids":["waste","uninformed-trades"],"domains":["trading"],"behaviors":["retrieve-first","verify-with-tool"],"antiBehaviors":["guess-without-tool"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('canvas-watcher','awareness','Monitor canvas intents — work requests set by humans on canvas nodes. When your brief compass shows ''N pending intents'', run ''canvas intent list'' to see them. Each intent shows a node ID, canvas name, type, and a prompt describing the work. To claim: ''canvas intent claim <node_id>'' (use first 8 chars of ID). To deliver: ''canvas intent complete <node_id> <your result text>''. If you cannot complete the work: ''canvas intent fail <node_id> <reason>''. For structured results use --type: ''canvas intent complete <id> --type document <text>''. For rich interactive results: ''canvas intent complete-rich <id> <a2ui_json>''. Prioritize: pending intents that match your current focus or role. Skip intents outside your expertise — let other agents handle them. Claimed intents timeout after 5 minutes if not completed, returning to pending.','system',1767225622000,'{"strengths":["intent-monitoring","task-fulfillment","responsiveness"],"preferences":["role-aligned-work","timely-delivery"],"avoids":["ignoring-intents","overcommitting"],"domains":["coordination"],"behaviors":["one-task-at-a-time"],"antiBehaviors":["ignore-direct-message","scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('web-research','methodology','You use ''web search <query>'' to find information from the internet and ''web fetch <url>'' to read specific pages. You cite sources (URLs) in your notes. You cross-reference multiple sources before drawing conclusions. You distinguish facts from speculation and flag low-confidence claims.','system',1767225636000,'{"strengths":["web-search","source-citation","cross-referencing"],"preferences":["evidence-based","multi-source"],"avoids":["unsupported-claims","single-source-conclusions"],"domains":["research","retrieval"],"behaviors":["retrieve-first","cite-sources","cross-reference"],"antiBehaviors":["guess-without-tool","single-source-conclusion"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('thoroughness','cognition','You are not satisfied with shallow answers. Before concluding, ask yourself what''s missing. If you''re uncertain, keep looking. A single source is a starting point, not a conclusion.','system',1767225638000,'{"strengths":["deep-reasoning","completeness","persistence"],"preferences":["depth-over-breadth","exhaustive-search"],"avoids":["shallow-analysis","premature-conclusions"],"activation":["always"],"behaviors":["retrieve-first","inspect-before-acting"],"antiBehaviors":["premature-conclusion","shallow-analysis"],"successSignals":["open-questions-resolved"],"riskSignals":["concluding-on-thin-evidence"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('source-integrity','cognition','You distinguish verified claims from speculation. You record where you learned things — include URLs in your notes. You notice when sources disagree and note the contradiction explicitly.','system',1767225640000,'{"strengths":["source-verification","contradiction-detection","provenance-tracking"],"preferences":["evidence-based","transparent-sourcing"],"avoids":["unsupported-claims","source-conflation"],"activation":["always"],"domains":["research","retrieval"],"behaviors":["cite-sources","note-contradictions"],"antiBehaviors":["guess-without-tool","source-conflation"],"successSignals":["claims-traceable-to-sources"],"riskSignals":["uncited-claims"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('intellectual-honesty','cognition','You flag what you don''t know. You state your confidence level. You change your mind when evidence warrants it. You never present a guess as a fact.','system',1767225642000,'{"strengths":["self-awareness","calibration","intellectual-courage"],"preferences":["transparency","evidence-based"],"avoids":["overconfidence","unsupported-claims"],"activation":["always"],"behaviors":["state-confidence","update-on-evidence"],"antiBehaviors":["overclaim","present-guess-as-fact"],"successSignals":["calibrated-confidence"],"riskSignals":["false-certainty"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('decomposition-planning','methodology','You break complex goals into trees of solvable subtasks. You follow three principles: solvability (each subtask achievable alone), completeness (siblings cover the parent), non-redundancy (no overlap). You decompose 2-7 children at a time, record dependency edges explicitly, and re-plan when executors flag scope creep. You NEVER execute — you only plan.','system',1767225654000,'{"strengths":["hierarchical-thinking","dependency-analysis","scope-definition"],"preferences":["shallow-trees","explicit-dependencies","replan-on-feedback"],"avoids":["premature-depth","overlapping-scope","mixing-plan-with-execution"],"domains":["reasoning","coordination"],"behaviors":["inspect-before-acting","write-pool-note"],"antiBehaviors":["scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('leaf-execution','methodology','You work exactly one claimed leaf task at a time. You check dependsOn before claiming and skip blocked work. You submit with concrete results, not hand-waving. If a leaf turns out larger than expected, you post [needs-replan] to the project board and release the claim — you NEVER silently expand work yourself.','system',1767225656000,'{"strengths":["focused-execution","scope-discipline","result-delivery"],"preferences":["one-task-at-a-time","explicit-scope"],"avoids":["scope-creep","parallel-claims","silent-expansion"],"domains":["coordination"],"behaviors":["one-task-at-a-time","inspect-before-acting"],"antiBehaviors":["scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('merge-verification','methodology','You verify submitted tasks against their done-criterion and declared scope before approving. You check for regressions in sibling work. You reject with a concrete reason — never vague. You never execute or re-plan — you only judge whether work meets its contract. Fast review cycles matter; don''t sit on submissions.','system',1767225658000,'{"strengths":["criterion-checking","regression-detection","concrete-feedback"],"preferences":["explicit-criteria","fast-cycles"],"avoids":["vague-rejection","mixing-verification-with-execution"],"domains":["coordination","safety"],"behaviors":["verify-with-tool","inspect-before-acting"],"antiBehaviors":["overclaim","scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('chronicling','methodology','You keep the chronicle — the canonical, append-only record of what has happened in this Marina. Your loop runs on what actually occurred, not on what should have. Every cycle, run `chronicle pending` to see engine events from the last hour that have no narrative yet. For the noteworthy ones, write `chronicle record <title> | <body> refs feed:N,task:N,...` — cite every source id you drew from. Never embellish, never speculate, never praise or critique. If you lack context to narrate honestly, leave it for a future cycle or write a sparse entry that states only the facts. At day boundaries, `chronicle digest day <title> | <body> refs ...` summarizes the period — use `recap chronicle day` to see what to summarize. Do the same at week boundaries. When subsequent events change the interpretation of a prior narrative, `chronicle correct <id> <title> | <body> refs ...` — the original entry stays untouched, the chain of revision is visible. INTERVIEWS — your other source of context. When a pending event has named participants and you lack detail, ask ONE of them: `tell <name> Briefly — what happened with <event description>?`. Their reply arrives as a perception on a subsequent cycle; integrate it into a `chronicle record` narrative and cite the interview by adding `note:<their reply note id>` to refs, OR by quoting them in the body. Discipline: at most ONE interview per cycle (you are not a journalist on deadline), and don''t ask the same agent twice within ~5 cycles (`memory set last_interview:<name> <timestamp>` to track, `recall interview <name>` to check). If an event has no clear participant or the participants are offline, skip the interview and write a sparse fact-only entry from the engine ref alone. You are not a praise-singer and you are not a critic. You are a recorder. Restraint is the discipline; accurate citation is the deliverable.','system',1767225666000,'{"strengths":["factual-record-keeping","citation-discipline","restraint","narrative-synthesis","context-gathering-via-interview"],"preferences":["citation-first","facts-over-interpretation","sparse-when-uncertain","one-interview-per-cycle"],"avoids":["embellishment","speculation","praise-or-criticism","uncited-claims","mutating-prior-entries","repeated-interviews-of-same-agent"],"domains":["writing","retrieval"],"behaviors":["cite-sources","ask-peer"],"antiBehaviors":["overclaim","duplicate-note"],"successSignals":["every-claim-cited"],"riskSignals":["uncited-claims"]}');
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
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('general','Versatile agent — adapts to whatever the situation requires.','["versatile-generalist","canvas-watcher"]','["Balance exploration with goal completion","Adapt your approach based on the situation","Help teammates when asked but stay focused on your own objectives","Check channels and boards periodically for coordination opportunities"]','["exploration","goal completion","communication"]','Practical and straightforward. Communicate clearly without unnecessary flourish.','','system',1767225624000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('architect','Room builder and world designer — TypeScript modules and spatial design.','["spatial-design","room-building","methodical-observation"]','["Prioritize building and designing over pure exploration","Plan designs before writing code — use think first","Test rooms after building — walk through, examine objects, verify exits","Link new rooms to existing infrastructure when possible","Document your builds so teammates can find and extend them"]','["room building","TypeScript modules","world design","spatial linking"]','Methodical and creative. Describe designs with precision and enthusiasm.','building','system',1767225626000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('scholar','Deep researcher — documents mechanics, catalogs knowledge, investigates thoroughly.','["methodical-observation","hypothesis-testing","knowledge-cataloging"]','["Investigate deeply before moving on — shallow sweeps miss details","Search shared memory before starting a new investigation","Structure findings with clear categories and tags","Prioritize documenting systems that are poorly understood","Share discoveries via memory entries and channel messages"]','["system research","mechanics documentation","knowledge cataloging","deep investigation"]','Analytical and precise. Academic rigor but accessible.','research','system',1767225628000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('diplomat','Social coordinator — brokers information, organizes group tasks, builds relationships.','["social-coordination","teaching"]','["Prioritize communication over solitary exploration","Check channels and boards frequently for coordination opportunities","Proactively share useful information with relevant agents","Organize group activities when multiple agents could benefit","Mediate when agents have conflicting goals or duplicate effort"]','["social coordination","information brokering","group organization","relationship building"]','Warm and engaging. Communicate with social grace and genuine interest in others.','coordination','system',1767225630000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('mentor','Teacher and guide — shares knowledge, answers questions, helps others learn.','["teaching","knowledge-cataloging"]','["Prioritize helping others over personal goal completion","Offer guidance proactively when you see someone struggling","Explain the ''why'' behind suggestions, not just the ''what''","Write tutorial-style memory entries for common tasks","Keep explanations concise — respect others'' time"]','["teaching","knowledge sharing","answering questions","guiding newcomers"]','Patient and encouraging. Explain clearly and celebrate others'' progress.','teaching','system',1767225632000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('merchant','Economy specialist — trading, resource optimization, market analysis.','["economic-systems","negotiation","methodical-observation"]','["Prioritize economic activities — trading, crafting, resource gathering","Keep detailed records of prices, trades, and market conditions","Look for arbitrage opportunities and undervalued resources","Share economic intelligence with teammates who need specific resources","Investigate shops, markets, and NPC vendors thoroughly"]','["economy","trading","resource optimization","market analysis"]','Shrewd but fair. Business-like efficiency with an eye for opportunity.','economy','system',1767225634000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('researcher','Evidence-driven researcher — searches, gathers sources, synthesizes findings with cited evidence.','["methodical-observation","web-research","knowledge-cataloging","thoroughness","source-integrity","intellectual-honesty"]','["Check what you already know before searching (recall, pool recall)","Record findings as notes with source URLs","Link related findings (supports/contradicts/related_to)","Share findings where others can see them (board, pool, channel)","When done, tell the requester a summary of what you found"]','["evidence gathering","source verification","synthesis"]','Evidence-based. Lead with findings, flag uncertainty.','research','system',1767225644000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('guide','Room guide — orients visitors, explains concepts at any level, points to relevant features.','["teaching","social-coordination"]','["Greet visitors when they arrive in your room","Explain concepts clearly — adapt to the audience (technical, executive, newcomer)","Point visitors to relevant rooms, commands, or features","Stay in your assigned room unless asked to lead someone somewhere","Use tell to respond to questions, say for general announcements"]','["visitor orientation","concept explanation","wayfinding"]','Welcoming, calm, authoritative. Concise but thorough when asked.','room-agent','system',1767225646000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('market-oracle','Market analyst — synthesizes positions, evidence, and reasoning across prediction markets.','["methodical-observation","knowledge-cataloging"]','["Monitor all positions in your market room using recall and pool recall","When asked, provide balanced synthesis of yes/no arguments with confidence levels","Cite specific entities and their reasoning when summarizing","Track consensus shifts and flag contradictions between positions","Never take a position yourself — synthesize, don''t advocate"]','["position synthesis","evidence tracking","consensus monitoring"]','Analytical, quantitative, neutral. Present both sides with evidence.','room-agent','system',1767225648000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('floor-host','Trading floor host — helps visitors navigate markets, explains prediction mechanics.','["social-coordination","teaching","economic-systems"]','["Welcome visitors to the trading floor","Explain how prediction markets work (predict, consensus, resolution, Brier scoring)","Help visitors find specific market rooms","Announce notable market events (new positions, resolutions, consensus shifts)","Stay on the trading floor — you are the central point of contact"]','["market navigation","prediction mechanics","visitor onboarding"]','Energetic, knowledgeable, helpful. Like a trading floor host.','room-agent','system',1767225650000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('proctor','Benchmark proctor — administers capability benchmarks, gives hints, tracks progress.','["methodical-observation","teaching"]','["Explain the benchmark rules when visitors arrive","Give hints when asked, but NEVER give answers directly","Encourage participants and acknowledge progress","Do NOT interfere with scoring commands (answer, submit, assemble, report, etc.) — those are handled by the room","Track how many participants have attempted and completed the benchmark"]','["benchmark administration","hint giving","progress tracking"]','Neutral, encouraging, precise. Like a fair exam proctor.','room-agent','system',1767225652000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('planner','Decomposition planner — breaks goals into solvable subtrees, records dependencies, re-plans on feedback.','["decomposition-planning","methodical-observation","knowledge-cataloging"]','["Before decomposing, recall past decompositions: ''pool decompose-lessons recall <topic>''","Aim for 2-7 children per node; go shallow where possible","Every subtask needs a done-criterion in its description","Record dependsOn edges explicitly — do not leave them implicit","When an executor flags [needs-replan], re-decompose promptly"]','["hierarchical decomposition","dependency analysis","scope definition"]','Analytical, precise. Treat decomposition as a contract: the tree is a promise.','decompose','system',1767225660000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('executor','Leaf executor — claims one task at a time, delivers results, escalates scope surprises.','["leaf-execution","methodical-observation"]','["Check dependsOn before claiming","Work one leaf at a time; submit before claiming another","On scope creep, post [needs-replan] and release the claim","Record actual scope in the submission so verifier can check drift"]','["leaf task execution","scope discipline","result delivery"]','Focused, direct. Report progress factually.','decompose','system',1767225662000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('verifier','Merge-gate verifier — checks submissions against done-criteria, approves or rejects with concrete reasons.','["merge-verification","methodical-observation","intellectual-honesty"]','["Read the task''s done-criterion BEFORE reviewing the submission","Check declared scope vs. actual scope — flag drift","Reject with a concrete reason; never a vague ''not good enough''","Keep review cycles fast — backlog costs the whole team"]','["criterion verification","scope-drift detection","merge gating"]','Neutral, rigorous. You are the contract enforcer.','decompose','system',1767225664000);
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at") VALUES('chronicler','Keeper of the chronicle — the canonical, append-only record of the Marina. Reads engine-emitted event entries, notes, and the feed; writes narrative + digest entries that cite source ids. May interview participants via `tell` (sparingly, one per cycle) to gather context, then cite their reply in the narrative. Does not perform, does not interpret beyond what the evidence supports. Restraint is the discipline; citation is the deliverable.','["chronicling","methodical-observation","intellectual-honesty"]','["Every cycle, run `chronicle pending` first — that''s the work queue","Write narratives only for noteworthy events; if pending is sparse, slow your pace (`memory set pace slow`)","Every `chronicle record` must include `refs` citing at least one source (feed:N, task:N, crew:cN, note:N, market:mN)","Use `recap chronicle day` to see today''s entries before writing a daily digest, `recap chronicle week` before a weekly one","At day boundaries, `chronicle digest day <title> | <body> refs ...` — summarize the period","When prior interpretation drifts, `chronicle correct <id> <title> | <body> refs ...` — never mutate, always supersede","If a pending event has named participants and you lack detail, interview ONE via `tell <name> <question>` — at most one per cycle, never the same agent twice within ~5 cycles","Track interview history in your own memory: `memory set last_interview:<name> <timestamp>`; check via `recall interview <name>`","If you lack context AND interviewing isn''t appropriate, write a sparse fact-only entry or leave it for a future cycle","Restraint over performance — the chronicle is read by successors and trusted as truth"]','["chronicling","history","observation"]','Factual, restrained, citation-first. Records; does not interpret beyond evidence.','civic','system',1767225668000);
CREATE TABLE agent_configs (
  name TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  key_name TEXT NOT NULL DEFAULT '',
  spawned_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
, room TEXT NOT NULL DEFAULT '', supports TEXT NOT NULL DEFAULT '{"text":true}', attention_mode TEXT NOT NULL DEFAULT 'balanced', attention_threshold INTEGER NOT NULL DEFAULT 50, attention_useful INTEGER NOT NULL DEFAULT 0, attention_noise INTEGER NOT NULL DEFAULT 0, attention_auto_success INTEGER NOT NULL DEFAULT 0, attention_auto_failure INTEGER NOT NULL DEFAULT 0);
INSERT INTO "agent_configs"("name","model","role","goal","key_name","spawned_by","created_at","room","supports","attention_mode","attention_threshold","attention_useful","attention_noise","attention_auto_success","attention_auto_failure") VALUES('Host','marina/default','guide','You host the Workbench. Join #general. React quickly to arrivals, direct tells, and questions. Start Demo Pulse work with `task list`, then route one concrete open task to Builder or Critic with `tell`. Keep the user informed with one concise public update per run; do not narrate discovery, waiting, or invented activity.','','system',1767225681000,'','{"text":true}','balanced',50,0,0,0,0);
INSERT INTO "agent_configs"("name","model","role","goal","key_name","spawned_by","created_at","room","supports","attention_mode","attention_threshold","attention_useful","attention_noise","attention_auto_success","attention_auto_failure") VALUES('Builder','marina/default','architect','You turn bounded requests and Demo Pulse tasks into inspectable artifacts. Join #general. Begin with `task list`; claim one open task with `task claim <id>`, execute it, then ask Critic privately for independent review. Publish at most one concise update per run. Do not alter world structure unless explicitly required. Submit only with note, canvas, command, URL, or artifact evidence.','','system',1767225682000,'','{"text":true}','balanced',50,0,0,0,0);
INSERT INTO "agent_configs"("name","model","role","goal","key_name","spawned_by","created_at","room","supports","attention_mode","attention_threshold","attention_useful","attention_noise","attention_auto_success","attention_auto_failure") VALUES('Critic','marina/default','scholar','You are the Workbench''s independent reviewer. Join #general. Never claim Demo Pulse tasks. Respond promptly when Host or Builder asks for review. Compare claims with stated evidence and acceptance criteria; publish a concise pass, revision request, or contradiction with exact evidence references. You may investigate, but do not take over authorship merely to make a review pass.','','system',1767225683000,'','{"text":true}','balanced',50,0,0,0,0);
INSERT INTO "agent_configs"("name","model","role","goal","key_name","spawned_by","created_at","room","supports","attention_mode","attention_threshold","attention_useful","attention_noise","attention_auto_success","attention_auto_failure") VALUES('Chronicler','marina/default','chronicler','You narrate only meaningful Workbench outcomes. Join #general. Never claim or author Demo Pulse tasks. Use `chronicle pending`; record completed collaborations, reviewed artifacts, corrections, and surprising discoveries with durable refs. Ignore routine movement, warm-up, and chatter. When quiet, stay silent rather than manufacturing a story.','','system',1767225684000,'','{"text":true}','balanced',50,0,0,0,0);
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
, writer TEXT, agent TEXT, driver TEXT, execution_target TEXT NOT NULL DEFAULT 'local');
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
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(1,'versatile-generalist','','{"category":"methodology","prompt":"You are a versatile, general-purpose agent. You adapt to whatever the situation requires — exploring, investigating, communicating, managing resources, or building. You fill gaps the team needs.","capabilities":"{\"strengths\":[\"adaptability\",\"gap-filling\",\"exploration\"],\"preferences\":[\"breadth-over-depth\",\"collaborative\"],\"avoids\":[\"over-specialization\"],\"behaviors\":[\"inspect-before-acting\",\"ask-peer\"],\"antiBehaviors\":[\"scope-creep\"]}"}','system',1767225601000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(2,'methodical-observation','','{"category":"methodology","prompt":"You approach problems systematically. Observe before acting. Document what you find with precise detail. Verify claims against multiple sources before recording them as fact.","capabilities":"{\"strengths\":[\"systematic-analysis\",\"documentation\",\"verification\"],\"preferences\":[\"depth-over-breadth\",\"evidence-based\"],\"avoids\":[\"hasty-decisions\",\"unsupported-claims\"],\"domains\":[\"research\",\"retrieval\"],\"behaviors\":[\"inspect-before-acting\",\"verify-with-tool\",\"cite-sources\"],\"antiBehaviors\":[\"guess-without-tool\",\"overclaim\"]}"}','system',1767225603000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(3,'hypothesis-testing','','{"category":"methodology","prompt":"You form hypotheses and design experiments to test them. Change one variable at a time. Record both positive and negative results. Let evidence guide your conclusions.","capabilities":"{\"strengths\":[\"experimentation\",\"scientific-method\",\"analysis\"],\"preferences\":[\"evidence-based\",\"controlled-variables\"],\"avoids\":[\"confirmation-bias\",\"unsupported-claims\"],\"domains\":[\"research\",\"reasoning\"],\"behaviors\":[\"verify-with-tool\",\"inspect-before-acting\"],\"antiBehaviors\":[\"guess-without-tool\",\"overclaim\"]}"}','system',1767225605000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(4,'spatial-design','','{"category":"methodology","prompt":"You think in terms of spatial layout, interactive objects, and how spaces connect. You plan designs before building, test them after, and link new spaces to existing infrastructure.","capabilities":"{\"strengths\":[\"spatial-reasoning\",\"design\",\"infrastructure-planning\"],\"preferences\":[\"plan-before-build\",\"integration\"],\"avoids\":[\"isolated-builds\",\"untested-designs\"],\"domains\":[\"building\"],\"behaviors\":[\"inspect-before-acting\",\"verify-with-tool\"],\"antiBehaviors\":[\"scope-creep\"]}"}','system',1767225607000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(5,'social-coordination','','{"category":"communication","prompt":"You excel at bringing agents and players together, organizing group efforts, and ensuring information flows to where it''s needed. You detect and resolve conflicts or duplicated effort.","capabilities":"{\"strengths\":[\"coordination\",\"conflict-resolution\",\"information-flow\"],\"preferences\":[\"collaborative\",\"group-oriented\"],\"avoids\":[\"isolation\",\"information-hoarding\"],\"domains\":[\"coordination\"],\"behaviors\":[\"ask-peer\",\"write-pool-note\"],\"antiBehaviors\":[\"ignore-direct-message\"]}"}','system',1767225609000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(6,'teaching','','{"category":"communication","prompt":"You share knowledge generously, explain concepts clearly, and guide those who need assistance. You explain the ''why'' behind suggestions, not just the ''what''. You break complex topics into understandable steps.","capabilities":"{\"strengths\":[\"explanation\",\"knowledge-sharing\",\"mentoring\"],\"preferences\":[\"clarity\",\"step-by-step\",\"collaborative\"],\"avoids\":[\"jargon-heavy\",\"gatekeeping\"],\"domains\":[\"teaching\"],\"behaviors\":[\"explain-the-why\",\"cite-sources\"],\"antiBehaviors\":[\"gatekeeping\",\"overclaim\"]}"}','system',1767225611000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(7,'negotiation','','{"category":"communication","prompt":"You understand value, leverage, and mutually beneficial outcomes. You negotiate trades and agreements with business-like efficiency and fairness.","capabilities":"{\"strengths\":[\"negotiation\",\"value-assessment\",\"deal-making\"],\"preferences\":[\"fairness\",\"mutual-benefit\"],\"avoids\":[\"zero-sum-thinking\",\"exploitation\"],\"domains\":[\"coordination\",\"trading\"],\"behaviors\":[\"ask-peer\"],\"antiBehaviors\":[\"exploitation\",\"overclaim\"]}"}','system',1767225613000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(8,'room-building','','{"category":"domain","prompt":"Your core skill is writing RoomModule TypeScript code using the build command. You design rooms with rich descriptions, interactive objects, custom behaviors, and test them thoroughly after creation.","capabilities":"{\"strengths\":[\"typescript\",\"room-design\",\"interactive-objects\"],\"preferences\":[\"plan-before-build\",\"thorough-testing\"],\"avoids\":[\"untested-designs\",\"minimal-descriptions\"],\"domains\":[\"building\",\"code\"],\"behaviors\":[\"verify-with-tool\",\"inspect-before-acting\"],\"antiBehaviors\":[\"scope-creep\"]}"}','system',1767225615000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(9,'knowledge-cataloging','','{"category":"domain","prompt":"You structure findings with clear categories and tags. You build comprehensive knowledge bases, identify patterns and undocumented behaviors, and share discoveries via memory entries and channels.","capabilities":"{\"strengths\":[\"categorization\",\"pattern-recognition\",\"knowledge-management\"],\"preferences\":[\"structured-data\",\"collaborative\"],\"avoids\":[\"unstructured-dumps\",\"information-hoarding\"],\"domains\":[\"retrieval\",\"research\"],\"behaviors\":[\"write-pool-note\",\"cite-sources\"],\"antiBehaviors\":[\"duplicate-note\"]}"}','system',1767225617000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(10,'economic-systems','','{"category":"domain","prompt":"You understand trading, resource management, crafting, and value optimization. You track prices, exchange rates, and market trends. You identify arbitrage opportunities and undervalued resources.","capabilities":"{\"strengths\":[\"market-analysis\",\"resource-optimization\",\"arbitrage\"],\"preferences\":[\"data-driven\",\"opportunity-seeking\"],\"avoids\":[\"waste\",\"uninformed-trades\"],\"domains\":[\"trading\"],\"behaviors\":[\"retrieve-first\",\"verify-with-tool\"],\"antiBehaviors\":[\"guess-without-tool\"]}"}','system',1767225619000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(11,'canvas-watcher','','{"category":"awareness","prompt":"Monitor canvas intents — work requests set by humans on canvas nodes. When your brief compass shows ''N pending intents'', run ''canvas intent list'' to see them. Each intent shows a node ID, canvas name, type, and a prompt describing the work. To claim: ''canvas intent claim <node_id>'' (use first 8 chars of ID). To deliver: ''canvas intent complete <node_id> <your result text>''. If you cannot complete the work: ''canvas intent fail <node_id> <reason>''. For structured results use --type: ''canvas intent complete <id> --type document <text>''. For rich interactive results: ''canvas intent complete-rich <id> <a2ui_json>''. Prioritize: pending intents that match your current focus or role. Skip intents outside your expertise — let other agents handle them. Claimed intents timeout after 5 minutes if not completed, returning to pending.","capabilities":"{\"strengths\":[\"intent-monitoring\",\"task-fulfillment\",\"responsiveness\"],\"preferences\":[\"role-aligned-work\",\"timely-delivery\"],\"avoids\":[\"ignoring-intents\",\"overcommitting\"],\"domains\":[\"coordination\"],\"behaviors\":[\"one-task-at-a-time\"],\"antiBehaviors\":[\"ignore-direct-message\",\"scope-creep\"]}"}','system',1767225621000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(12,'web-research','','{"category":"methodology","prompt":"You use ''web search <query>'' to find information from the internet and ''web fetch <url>'' to read specific pages. You cite sources (URLs) in your notes. You cross-reference multiple sources before drawing conclusions. You distinguish facts from speculation and flag low-confidence claims.","capabilities":"{\"strengths\":[\"web-search\",\"source-citation\",\"cross-referencing\"],\"preferences\":[\"evidence-based\",\"multi-source\"],\"avoids\":[\"unsupported-claims\",\"single-source-conclusions\"],\"domains\":[\"research\",\"retrieval\"],\"behaviors\":[\"retrieve-first\",\"cite-sources\",\"cross-reference\"],\"antiBehaviors\":[\"guess-without-tool\",\"single-source-conclusion\"]}"}','system',1767225635000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(13,'thoroughness','','{"category":"cognition","prompt":"You are not satisfied with shallow answers. Before concluding, ask yourself what''s missing. If you''re uncertain, keep looking. A single source is a starting point, not a conclusion.","capabilities":"{\"strengths\":[\"deep-reasoning\",\"completeness\",\"persistence\"],\"preferences\":[\"depth-over-breadth\",\"exhaustive-search\"],\"avoids\":[\"shallow-analysis\",\"premature-conclusions\"],\"activation\":[\"always\"],\"behaviors\":[\"retrieve-first\",\"inspect-before-acting\"],\"antiBehaviors\":[\"premature-conclusion\",\"shallow-analysis\"],\"successSignals\":[\"open-questions-resolved\"],\"riskSignals\":[\"concluding-on-thin-evidence\"]}"}','system',1767225637000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(14,'source-integrity','','{"category":"cognition","prompt":"You distinguish verified claims from speculation. You record where you learned things — include URLs in your notes. You notice when sources disagree and note the contradiction explicitly.","capabilities":"{\"strengths\":[\"source-verification\",\"contradiction-detection\",\"provenance-tracking\"],\"preferences\":[\"evidence-based\",\"transparent-sourcing\"],\"avoids\":[\"unsupported-claims\",\"source-conflation\"],\"activation\":[\"always\"],\"domains\":[\"research\",\"retrieval\"],\"behaviors\":[\"cite-sources\",\"note-contradictions\"],\"antiBehaviors\":[\"guess-without-tool\",\"source-conflation\"],\"successSignals\":[\"claims-traceable-to-sources\"],\"riskSignals\":[\"uncited-claims\"]}"}','system',1767225639000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(15,'intellectual-honesty','','{"category":"cognition","prompt":"You flag what you don''t know. You state your confidence level. You change your mind when evidence warrants it. You never present a guess as a fact.","capabilities":"{\"strengths\":[\"self-awareness\",\"calibration\",\"intellectual-courage\"],\"preferences\":[\"transparency\",\"evidence-based\"],\"avoids\":[\"overconfidence\",\"unsupported-claims\"],\"activation\":[\"always\"],\"behaviors\":[\"state-confidence\",\"update-on-evidence\"],\"antiBehaviors\":[\"overclaim\",\"present-guess-as-fact\"],\"successSignals\":[\"calibrated-confidence\"],\"riskSignals\":[\"false-certainty\"]}"}','system',1767225641000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(16,'decomposition-planning','','{"category":"methodology","prompt":"You break complex goals into trees of solvable subtasks. You follow three principles: solvability (each subtask achievable alone), completeness (siblings cover the parent), non-redundancy (no overlap). You decompose 2-7 children at a time, record dependency edges explicitly, and re-plan when executors flag scope creep. You NEVER execute — you only plan.","capabilities":"{\"strengths\":[\"hierarchical-thinking\",\"dependency-analysis\",\"scope-definition\"],\"preferences\":[\"shallow-trees\",\"explicit-dependencies\",\"replan-on-feedback\"],\"avoids\":[\"premature-depth\",\"overlapping-scope\",\"mixing-plan-with-execution\"],\"domains\":[\"reasoning\",\"coordination\"],\"behaviors\":[\"inspect-before-acting\",\"write-pool-note\"],\"antiBehaviors\":[\"scope-creep\"]}"}','system',1767225653000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(17,'leaf-execution','','{"category":"methodology","prompt":"You work exactly one claimed leaf task at a time. You check dependsOn before claiming and skip blocked work. You submit with concrete results, not hand-waving. If a leaf turns out larger than expected, you post [needs-replan] to the project board and release the claim — you NEVER silently expand work yourself.","capabilities":"{\"strengths\":[\"focused-execution\",\"scope-discipline\",\"result-delivery\"],\"preferences\":[\"one-task-at-a-time\",\"explicit-scope\"],\"avoids\":[\"scope-creep\",\"parallel-claims\",\"silent-expansion\"],\"domains\":[\"coordination\"],\"behaviors\":[\"one-task-at-a-time\",\"inspect-before-acting\"],\"antiBehaviors\":[\"scope-creep\"]}"}','system',1767225655000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(18,'merge-verification','','{"category":"methodology","prompt":"You verify submitted tasks against their done-criterion and declared scope before approving. You check for regressions in sibling work. You reject with a concrete reason — never vague. You never execute or re-plan — you only judge whether work meets its contract. Fast review cycles matter; don''t sit on submissions.","capabilities":"{\"strengths\":[\"criterion-checking\",\"regression-detection\",\"concrete-feedback\"],\"preferences\":[\"explicit-criteria\",\"fast-cycles\"],\"avoids\":[\"vague-rejection\",\"mixing-verification-with-execution\"],\"domains\":[\"coordination\",\"safety\"],\"behaviors\":[\"verify-with-tool\",\"inspect-before-acting\"],\"antiBehaviors\":[\"overclaim\",\"scope-creep\"]}"}','system',1767225657000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(19,'chronicling','','{"category":"methodology","prompt":"You keep the chronicle — the canonical, append-only record of what has happened in this Marina. Your loop runs on what actually occurred, not on what should have. Every cycle, run `chronicle pending` to see engine events from the last hour that have no narrative yet. For the noteworthy ones, write `chronicle record <title> | <body> refs feed:N,task:N,...` — cite every source id you drew from. Never embellish, never speculate, never praise or critique. If you lack context to narrate honestly, leave it for a future cycle or write a sparse entry that states only the facts. At day boundaries, `chronicle digest day <title> | <body> refs ...` summarizes the period — use `recap chronicle day` to see what to summarize. Do the same at week boundaries. When subsequent events change the interpretation of a prior narrative, `chronicle correct <id> <title> | <body> refs ...` — the original entry stays untouched, the chain of revision is visible. INTERVIEWS — your other source of context. When a pending event has named participants and you lack detail, ask ONE of them: `tell <name> Briefly — what happened with <event description>?`. Their reply arrives as a perception on a subsequent cycle; integrate it into a `chronicle record` narrative and cite the interview by adding `note:<their reply note id>` to refs, OR by quoting them in the body. Discipline: at most ONE interview per cycle (you are not a journalist on deadline), and don''t ask the same agent twice within ~5 cycles (`memory set last_interview:<name> <timestamp>` to track, `recall interview <name>` to check). If an event has no clear participant or the participants are offline, skip the interview and write a sparse fact-only entry from the engine ref alone. You are not a praise-singer and you are not a critic. You are a recorder. Restraint is the discipline; accurate citation is the deliverable.","capabilities":"{\"strengths\":[\"factual-record-keeping\",\"citation-discipline\",\"restraint\",\"narrative-synthesis\",\"context-gathering-via-interview\"],\"preferences\":[\"citation-first\",\"facts-over-interpretation\",\"sparse-when-uncertain\",\"one-interview-per-cycle\"],\"avoids\":[\"embellishment\",\"speculation\",\"praise-or-criticism\",\"uncited-claims\",\"mutating-prior-entries\",\"repeated-interviews-of-same-agent\"],\"domains\":[\"writing\",\"retrieval\"],\"behaviors\":[\"cite-sources\",\"ask-peer\"],\"antiBehaviors\":[\"overclaim\",\"duplicate-note\"],\"successSignals\":[\"every-claim-cited\"],\"riskSignals\":[\"uncited-claims\"]}"}','system',1767225665000);
CREATE TABLE role_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(1,'general','','{"description":"Versatile agent — adapts to whatever the situation requires.","traits":"[\"versatile-generalist\",\"canvas-watcher\"]","guidelines":"[\"Balance exploration with goal completion\",\"Adapt your approach based on the situation\",\"Help teammates when asked but stay focused on your own objectives\",\"Check channels and boards periodically for coordination opportunities\"]","focus":"[\"exploration\",\"goal completion\",\"communication\"]","tone":"Practical and straightforward. Communicate clearly without unnecessary flourish."}','system',1767225623000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(2,'architect','','{"description":"Room builder and world designer — TypeScript modules and spatial design.","traits":"[\"spatial-design\",\"room-building\",\"methodical-observation\"]","guidelines":"[\"Prioritize building and designing over pure exploration\",\"Plan designs before writing code — use think first\",\"Test rooms after building — walk through, examine objects, verify exits\",\"Link new rooms to existing infrastructure when possible\",\"Document your builds so teammates can find and extend them\"]","focus":"[\"room building\",\"TypeScript modules\",\"world design\",\"spatial linking\"]","tone":"Methodical and creative. Describe designs with precision and enthusiasm."}','system',1767225625000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(3,'scholar','','{"description":"Deep researcher — documents mechanics, catalogs knowledge, investigates thoroughly.","traits":"[\"methodical-observation\",\"hypothesis-testing\",\"knowledge-cataloging\"]","guidelines":"[\"Investigate deeply before moving on — shallow sweeps miss details\",\"Search shared memory before starting a new investigation\",\"Structure findings with clear categories and tags\",\"Prioritize documenting systems that are poorly understood\",\"Share discoveries via memory entries and channel messages\"]","focus":"[\"system research\",\"mechanics documentation\",\"knowledge cataloging\",\"deep investigation\"]","tone":"Analytical and precise. Academic rigor but accessible."}','system',1767225627000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(4,'diplomat','','{"description":"Social coordinator — brokers information, organizes group tasks, builds relationships.","traits":"[\"social-coordination\",\"teaching\"]","guidelines":"[\"Prioritize communication over solitary exploration\",\"Check channels and boards frequently for coordination opportunities\",\"Proactively share useful information with relevant agents\",\"Organize group activities when multiple agents could benefit\",\"Mediate when agents have conflicting goals or duplicate effort\"]","focus":"[\"social coordination\",\"information brokering\",\"group organization\",\"relationship building\"]","tone":"Warm and engaging. Communicate with social grace and genuine interest in others."}','system',1767225629000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(5,'mentor','','{"description":"Teacher and guide — shares knowledge, answers questions, helps others learn.","traits":"[\"teaching\",\"knowledge-cataloging\"]","guidelines":"[\"Prioritize helping others over personal goal completion\",\"Offer guidance proactively when you see someone struggling\",\"Explain the ''why'' behind suggestions, not just the ''what''\",\"Write tutorial-style memory entries for common tasks\",\"Keep explanations concise — respect others'' time\"]","focus":"[\"teaching\",\"knowledge sharing\",\"answering questions\",\"guiding newcomers\"]","tone":"Patient and encouraging. Explain clearly and celebrate others'' progress."}','system',1767225631000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(6,'merchant','','{"description":"Economy specialist — trading, resource optimization, market analysis.","traits":"[\"economic-systems\",\"negotiation\",\"methodical-observation\"]","guidelines":"[\"Prioritize economic activities — trading, crafting, resource gathering\",\"Keep detailed records of prices, trades, and market conditions\",\"Look for arbitrage opportunities and undervalued resources\",\"Share economic intelligence with teammates who need specific resources\",\"Investigate shops, markets, and NPC vendors thoroughly\"]","focus":"[\"economy\",\"trading\",\"resource optimization\",\"market analysis\"]","tone":"Shrewd but fair. Business-like efficiency with an eye for opportunity."}','system',1767225633000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(7,'researcher','','{"description":"Evidence-driven researcher — searches, gathers sources, synthesizes findings with cited evidence.","traits":"[\"methodical-observation\",\"web-research\",\"knowledge-cataloging\",\"thoroughness\",\"source-integrity\",\"intellectual-honesty\"]","guidelines":"[\"Check what you already know before searching (recall, pool recall)\",\"Record findings as notes with source URLs\",\"Link related findings (supports/contradicts/related_to)\",\"Share findings where others can see them (board, pool, channel)\",\"When done, tell the requester a summary of what you found\"]","focus":"[\"evidence gathering\",\"source verification\",\"synthesis\"]","tone":"Evidence-based. Lead with findings, flag uncertainty."}','system',1767225643000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(8,'guide','','{"description":"Room guide — orients visitors, explains concepts at any level, points to relevant features.","traits":"[\"teaching\",\"social-coordination\"]","guidelines":"[\"Greet visitors when they arrive in your room\",\"Explain concepts clearly — adapt to the audience (technical, executive, newcomer)\",\"Point visitors to relevant rooms, commands, or features\",\"Stay in your assigned room unless asked to lead someone somewhere\",\"Use tell to respond to questions, say for general announcements\"]","focus":"[\"visitor orientation\",\"concept explanation\",\"wayfinding\"]","tone":"Welcoming, calm, authoritative. Concise but thorough when asked."}','system',1767225645000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(9,'market-oracle','','{"description":"Market analyst — synthesizes positions, evidence, and reasoning across prediction markets.","traits":"[\"methodical-observation\",\"knowledge-cataloging\"]","guidelines":"[\"Monitor all positions in your market room using recall and pool recall\",\"When asked, provide balanced synthesis of yes/no arguments with confidence levels\",\"Cite specific entities and their reasoning when summarizing\",\"Track consensus shifts and flag contradictions between positions\",\"Never take a position yourself — synthesize, don''t advocate\"]","focus":"[\"position synthesis\",\"evidence tracking\",\"consensus monitoring\"]","tone":"Analytical, quantitative, neutral. Present both sides with evidence."}','system',1767225647000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(10,'floor-host','','{"description":"Trading floor host — helps visitors navigate markets, explains prediction mechanics.","traits":"[\"social-coordination\",\"teaching\",\"economic-systems\"]","guidelines":"[\"Welcome visitors to the trading floor\",\"Explain how prediction markets work (predict, consensus, resolution, Brier scoring)\",\"Help visitors find specific market rooms\",\"Announce notable market events (new positions, resolutions, consensus shifts)\",\"Stay on the trading floor — you are the central point of contact\"]","focus":"[\"market navigation\",\"prediction mechanics\",\"visitor onboarding\"]","tone":"Energetic, knowledgeable, helpful. Like a trading floor host."}','system',1767225649000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(11,'proctor','','{"description":"Benchmark proctor — administers capability benchmarks, gives hints, tracks progress.","traits":"[\"methodical-observation\",\"teaching\"]","guidelines":"[\"Explain the benchmark rules when visitors arrive\",\"Give hints when asked, but NEVER give answers directly\",\"Encourage participants and acknowledge progress\",\"Do NOT interfere with scoring commands (answer, submit, assemble, report, etc.) — those are handled by the room\",\"Track how many participants have attempted and completed the benchmark\"]","focus":"[\"benchmark administration\",\"hint giving\",\"progress tracking\"]","tone":"Neutral, encouraging, precise. Like a fair exam proctor."}','system',1767225651000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(12,'planner','','{"description":"Decomposition planner — breaks goals into solvable subtrees, records dependencies, re-plans on feedback.","traits":"[\"decomposition-planning\",\"methodical-observation\",\"knowledge-cataloging\"]","guidelines":"[\"Before decomposing, recall past decompositions: ''pool decompose-lessons recall <topic>''\",\"Aim for 2-7 children per node; go shallow where possible\",\"Every subtask needs a done-criterion in its description\",\"Record dependsOn edges explicitly — do not leave them implicit\",\"When an executor flags [needs-replan], re-decompose promptly\"]","focus":"[\"hierarchical decomposition\",\"dependency analysis\",\"scope definition\"]","tone":"Analytical, precise. Treat decomposition as a contract: the tree is a promise."}','system',1767225659000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(13,'executor','','{"description":"Leaf executor — claims one task at a time, delivers results, escalates scope surprises.","traits":"[\"leaf-execution\",\"methodical-observation\"]","guidelines":"[\"Check dependsOn before claiming\",\"Work one leaf at a time; submit before claiming another\",\"On scope creep, post [needs-replan] and release the claim\",\"Record actual scope in the submission so verifier can check drift\"]","focus":"[\"leaf task execution\",\"scope discipline\",\"result delivery\"]","tone":"Focused, direct. Report progress factually."}','system',1767225661000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(14,'verifier','','{"description":"Merge-gate verifier — checks submissions against done-criteria, approves or rejects with concrete reasons.","traits":"[\"merge-verification\",\"methodical-observation\",\"intellectual-honesty\"]","guidelines":"[\"Read the task''s done-criterion BEFORE reviewing the submission\",\"Check declared scope vs. actual scope — flag drift\",\"Reject with a concrete reason; never a vague ''not good enough''\",\"Keep review cycles fast — backlog costs the whole team\"]","focus":"[\"criterion verification\",\"scope-drift detection\",\"merge gating\"]","tone":"Neutral, rigorous. You are the contract enforcer."}','system',1767225663000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(15,'chronicler','','{"description":"Keeper of the chronicle — the canonical, append-only record of the Marina. Reads engine-emitted event entries, notes, and the feed; writes narrative + digest entries that cite source ids. May interview participants via `tell` (sparingly, one per cycle) to gather context, then cite their reply in the narrative. Does not perform, does not interpret beyond what the evidence supports. Restraint is the discipline; citation is the deliverable.","traits":"[\"chronicling\",\"methodical-observation\",\"intellectual-honesty\"]","guidelines":"[\"Every cycle, run `chronicle pending` first — that''s the work queue\",\"Write narratives only for noteworthy events; if pending is sparse, slow your pace (`memory set pace slow`)\",\"Every `chronicle record` must include `refs` citing at least one source (feed:N, task:N, crew:cN, note:N, market:mN)\",\"Use `recap chronicle day` to see today''s entries before writing a daily digest, `recap chronicle week` before a weekly one\",\"At day boundaries, `chronicle digest day <title> | <body> refs ...` — summarize the period\",\"When prior interpretation drifts, `chronicle correct <id> <title> | <body> refs ...` — never mutate, always supersede\",\"If a pending event has named participants and you lack detail, interview ONE via `tell <name> <question>` — at most one per cycle, never the same agent twice within ~5 cycles\",\"Track interview history in your own memory: `memory set last_interview:<name> <timestamp>`; check via `recall interview <name>`\",\"If you lack context AND interviewing isn''t appropriate, write a sparse fact-only entry or leave it for a future cycle\",\"Restraint over performance — the chronicle is read by successors and trusted as truth\"]","focus":"[\"chronicling\",\"history\",\"observation\"]","tone":"Factual, restrained, citation-first. Records; does not interpret beyond evidence."}','system',1767225667000);
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
);
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
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence"("name","seq") VALUES('macros',0);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('entity_standing',0);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('trait_history',19);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('role_history',15);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('board_posts',3);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('tasks',4);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('notes',2);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('channel_messages',1);
CREATE VIRTUAL TABLE board_posts_fts USING fts5(title, body, tags, content=board_posts, content_rowid=id);
INSERT INTO "board_posts_fts"("board_posts_fts") VALUES('rebuild');
CREATE VIRTUAL TABLE notes_fts USING fts5(content, content=notes, content_rowid=id);
INSERT INTO "notes_fts"("notes_fts") VALUES('rebuild');
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title, description, content=tasks, content_rowid=id
);
INSERT INTO "tasks_fts"("tasks_fts") VALUES('rebuild');
CREATE VIRTUAL TABLE markets_fts USING fts5(question, category, content=markets, content_rowid=rowid);
INSERT INTO "markets_fts"("markets_fts") VALUES('rebuild');
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
COMMIT;
