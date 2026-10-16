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
INSERT INTO "entities"("id","kind","name","short","long","room","properties","inventory","created_at") VALUES('e_fixture_alice','agent','Alice','Alice is here.','An upgrade-fixture resident.','lobby','{"rank":2}','[]',1767225717000);
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
INSERT INTO "schema_version"("version") VALUES(137);
INSERT INTO "schema_version"("version") VALUES(138);
INSERT INTO "schema_version"("version") VALUES(139);
INSERT INTO "schema_version"("version") VALUES(140);
INSERT INTO "schema_version"("version") VALUES(141);
INSERT INTO "schema_version"("version") VALUES(142);
INSERT INTO "schema_version"("version") VALUES(143);
INSERT INTO "schema_version"("version") VALUES(144);
INSERT INTO "schema_version"("version") VALUES(145);
INSERT INTO "schema_version"("version") VALUES(146);
INSERT INTO "schema_version"("version") VALUES(147);
INSERT INTO "schema_version"("version") VALUES(148);
INSERT INTO "schema_version"("version") VALUES(149);
INSERT INTO "schema_version"("version") VALUES(150);
INSERT INTO "schema_version"("version") VALUES(151);
INSERT INTO "schema_version"("version") VALUES(152);
INSERT INTO "schema_version"("version") VALUES(153);
INSERT INTO "schema_version"("version") VALUES(154);
INSERT INTO "schema_version"("version") VALUES(155);
INSERT INTO "schema_version"("version") VALUES(156);
INSERT INTO "schema_version"("version") VALUES(157);
INSERT INTO "schema_version"("version") VALUES(158);
INSERT INTO "schema_version"("version") VALUES(159);
INSERT INTO "schema_version"("version") VALUES(160);
INSERT INTO "schema_version"("version") VALUES(161);
INSERT INTO "schema_version"("version") VALUES(162);
INSERT INTO "schema_version"("version") VALUES(163);
INSERT INTO "schema_version"("version") VALUES(164);
INSERT INTO "schema_version"("version") VALUES(165);
INSERT INTO "schema_version"("version") VALUES(166);
INSERT INTO "schema_version"("version") VALUES(167);
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
INSERT INTO "channels"("id","type","name","owner_id","persistence","retention_hours","created_at") VALUES('fixture-channel','custom','fixture','e_fixture_alice','permanent',NULL,1767225737000);
CREATE TABLE channel_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO "channel_messages"("id","channel_id","sender_id","sender_name","content","created_at") VALUES(1,'fixture-channel','e_fixture_alice','Alice','upgrade fixture channel message',1767225738000);
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
INSERT INTO "boards"("id","name","scope_type","scope_id","read_rank","write_rank","pin_rank","created_at") VALUES('fixture-board','fixture-board','global',NULL,0,0,3,1767225739000);
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
INSERT INTO "board_posts"("id","board_id","parent_id","author_id","author_name","title","body","tags","pinned","archived","created_at","updated_at") VALUES(3,'fixture-board',NULL,'fixture-account-alice','Alice','fixture','upgrade fixture board post','[]',0,0,1767225740000,1767225740000);
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
INSERT INTO "tasks"("id","board_id","group_id","title","description","prerequisites","deliverables","status","validation_mode","creator_id","creator_name","standing","created_at","updated_at","parent_task_id","priority","progress") VALUES(1,NULL,'00000000-0000-4000-8000-000000000002','Turn a launch brief into a reviewed artifact','Turn a bounded user brief into a three-point plan, publish it as a durable note or canvas artifact, and ask Critic to verify that every point follows from the brief.','[]','','open','single','00000000-0000-4000-8000-000000000004','Critic',5,1767225677000,1767225702000,NULL,0,0);
INSERT INTO "tasks"("id","board_id","group_id","title","description","prerequisites","deliverables","status","validation_mode","creator_id","creator_name","standing","created_at","updated_at","parent_task_id","priority","progress") VALUES(2,NULL,'00000000-0000-4000-8000-000000000002','Explain Marina with evidence','Use the welcome board and observable world state to explain Marina''s value in one paragraph. Cite the commands, artifact, or world evidence behind each concrete claim.','[]','','open','single','00000000-0000-4000-8000-000000000004','Critic',5,1767225678000,1767225701000,NULL,0,0);
INSERT INTO "tasks"("id","board_id","group_id","title","description","prerequisites","deliverables","status","validation_mode","creator_id","creator_name","standing","created_at","updated_at","parent_task_id","priority","progress") VALUES(3,NULL,'00000000-0000-4000-8000-000000000002','Demonstrate peer communication','Coordinate a Host → Builder → Critic handoff on #general and publish the verified result with message, note, or canvas evidence.','[]','','open','single','00000000-0000-4000-8000-000000000004','Critic',5,1767225679000,1767225700000,NULL,0,0);
INSERT INTO "tasks"("id","board_id","group_id","title","description","prerequisites","deliverables","status","validation_mode","creator_id","creator_name","standing","created_at","updated_at","parent_task_id","priority","progress") VALUES(4,NULL,NULL,'upgrade fixture task','created by the release under test','[]','','open','creator','fixture-account-alice','Alice',0,1767225736000,1767225736000,NULL,0,0);
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
, auth_subject TEXT, auth_email TEXT, rank_floor INTEGER NOT NULL DEFAULT 0);
INSERT INTO "users"("id","name","created_at","last_login","rank","properties","auth_subject","auth_email","rank_floor") VALUES('00000000-0000-4000-8000-000000000004','Critic',1767225698000,1767225698000,0,'{}',NULL,NULL,0);
INSERT INTO "users"("id","name","created_at","last_login","rank","properties","auth_subject","auth_email","rank_floor") VALUES('fixture-account-alice','Alice',1767225715000,1767225715000,2,'{}',NULL,NULL,0);
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
INSERT INTO "notes"("id","entity_name","room_id","content","created_at","importance","last_accessed","note_type","pool_id","supersedes_id","recall_count","tier","confidence","verification_status","claim_key") VALUES(1,'system',NULL,'',1767225680000,10,NULL,'observation','00000000-0000-4000-8000-000000000003',NULL,0,'fact',0.5,'unverified','demo pulse rule visible activity must advance an outcome every submission cites');
INSERT INTO "notes"("id","entity_name","room_id","content","created_at","importance","last_accessed","note_type","pool_id","supersedes_id","recall_count","tier","confidence","verification_status","claim_key") VALUES(2,'memory:228e258d-fa7e-4583-9a40-4ef6cf73a707',NULL,'Demo Pulse rule: visible activity must advance an outcome. Every submission cites inspectable evidence; Critic reviews and approves or rejects it.',1767225692000,10,NULL,'observation',NULL,NULL,0,'fact',0.5,'unverified','demo pulse rule visible activity must advance an outcome every submission cites');
INSERT INTO "notes"("id","entity_name","room_id","content","created_at","importance","last_accessed","note_type","pool_id","supersedes_id","recall_count","tier","confidence","verification_status","claim_key") VALUES(3,'Alice',NULL,'',1767225718000,7,NULL,'observation',NULL,NULL,0,'fact',0.5,'unverified','upgrade fixture this note must survive every upgrade');
INSERT INTO "notes"("id","entity_name","room_id","content","created_at","importance","last_accessed","note_type","pool_id","supersedes_id","recall_count","tier","confidence","verification_status","claim_key") VALUES(4,'memory:fixture-account-alice',NULL,'upgrade fixture: this note must survive every upgrade',1767225729000,7,NULL,'observation',NULL,NULL,0,'fact',0.5,'unverified','upgrade fixture this note must survive every upgrade');
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
INSERT INTO "core_memory"("entity_name","key","value","version","created_at","updated_at") VALUES('Alice','fixture-belief','upgrades keep data',1,1767225735000,1767225735000);
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
INSERT INTO "projects"("id","name","description","bundle_id","pool_id","group_id","orchestration","memory_arch","status","created_by","created_at","budget_tokens","budget_cost","budget_duration_ms","used_tokens","used_cost") VALUES('00000000-0000-4000-8000-000000000001','Demo Pulse','A visible queue of small, evidence-backed collaborations that keeps the Workbench active without manufacturing noise.',NULL,'00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','pipeline','custom','active','system',1767225676000,NULL,NULL,NULL,0,0.0);
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
INSERT INTO "canvases"("id","name","description","scope","scope_id","creator_name","created_at","updated_at") VALUES('fixture-canvas','Fixture canvas','','global',NULL,'Alice',1767225741000,1767225741000);
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
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('curl','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('wget','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('ls','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('cat','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('head','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('tail','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('wc','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('grep','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('find','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('jq','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('echo','system',1792180686000);
INSERT INTO "shell_allowlist"("binary","added_by","added_at") VALUES('date','system',1792180686000);
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
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('negotiation','communication','You understand value, leverage, and mutually beneficial outcomes. You negotiate agreements with business-like efficiency and fairness.','system',1767225614000,'{"strengths":["negotiation","value-assessment","deal-making"],"preferences":["fairness","mutual-benefit"],"avoids":["zero-sum-thinking","exploitation"],"domains":["coordination","trading"],"behaviors":["ask-peer"],"antiBehaviors":["exploitation","overclaim"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('room-building','domain','Your core skill is writing RoomModule TypeScript code using the build command. You design rooms with rich descriptions, interactive objects, custom behaviors, and test them thoroughly after creation.','system',1767225616000,'{"strengths":["typescript","room-design","interactive-objects"],"preferences":["plan-before-build","thorough-testing"],"avoids":["untested-designs","minimal-descriptions"],"domains":["building","code"],"behaviors":["verify-with-tool","inspect-before-acting"],"antiBehaviors":["scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('knowledge-cataloging','domain','You structure findings with clear categories and tags. You build comprehensive knowledge bases, identify patterns and undocumented behaviors, and record discoveries as notes and pool entries.','system',1767225618000,'{"strengths":["categorization","pattern-recognition","knowledge-management"],"preferences":["structured-data","collaborative"],"avoids":["unstructured-dumps","information-hoarding"],"domains":["retrieval","research"],"behaviors":["write-pool-note","cite-sources"],"antiBehaviors":["duplicate-note"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('economic-systems','domain','You understand prediction markets, bankrolls and value. You track prices and market moves, size positions to an edge you can justify, and keep records that let your calibration be checked.','system',1767225620000,'{"strengths":["market-analysis","resource-optimization","arbitrage"],"preferences":["data-driven","opportunity-seeking"],"avoids":["waste","uninformed-trades"],"domains":["trading"],"behaviors":["retrieve-first","verify-with-tool"],"antiBehaviors":["guess-without-tool"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('canvas-watcher','awareness','Monitor canvas intents — work requests set by humans on canvas nodes. When your brief compass shows ''N pending intents'', run ''canvas intent list'' to see them. Each intent shows a node ID, canvas name, type, and a prompt describing the work. To claim: ''canvas intent claim <node_id>'' (use first 8 chars of ID). To deliver: ''canvas intent complete <node_id> <your result text>''. If you cannot complete the work: ''canvas intent fail <node_id> <reason>''. For structured results use --type: ''canvas intent complete <id> --type document <text>''. For rich interactive results: ''canvas intent complete-rich <id> <a2ui_json>''. Prioritize: pending intents that match your current focus or role. Skip intents outside your expertise — let other agents handle them. Claimed intents timeout after 5 minutes if not completed, returning to pending.','system',1767225622000,'{"strengths":["intent-monitoring","task-fulfillment","responsiveness"],"preferences":["role-aligned-work","timely-delivery"],"avoids":["ignoring-intents","overcommitting"],"domains":["coordination"],"behaviors":["one-task-at-a-time"],"antiBehaviors":["ignore-direct-message","scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('web-research','methodology','You use ''web search <query>'' to find information from the internet and ''web fetch <url>'' to read specific pages. You cite sources (URLs) in your notes. You cross-reference multiple sources before drawing conclusions. You distinguish facts from speculation and flag low-confidence claims.','system',1767225636000,'{"strengths":["web-search","source-citation","cross-referencing"],"preferences":["evidence-based","multi-source"],"avoids":["unsupported-claims","single-source-conclusions"],"domains":["research","retrieval"],"behaviors":["retrieve-first","cite-sources","cross-reference"],"antiBehaviors":["guess-without-tool","single-source-conclusion"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('thoroughness','cognition','You are not satisfied with shallow answers. Before concluding, ask yourself what''s missing. If you''re uncertain, keep looking. A single source is a starting point, not a conclusion.','system',1767225638000,'{"strengths":["deep-reasoning","completeness","persistence"],"preferences":["depth-over-breadth","exhaustive-search"],"avoids":["shallow-analysis","premature-conclusions"],"activation":["always"],"behaviors":["retrieve-first","inspect-before-acting"],"antiBehaviors":["premature-conclusion","shallow-analysis"],"successSignals":["open-questions-resolved"],"riskSignals":["concluding-on-thin-evidence"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('source-integrity','cognition','You distinguish verified claims from speculation. You record where you learned things — include URLs in your notes. You notice when sources disagree and note the contradiction explicitly.','system',1767225640000,'{"strengths":["source-verification","contradiction-detection","provenance-tracking"],"preferences":["evidence-based","transparent-sourcing"],"avoids":["unsupported-claims","source-conflation"],"activation":["always"],"domains":["research","retrieval"],"behaviors":["cite-sources","note-contradictions"],"antiBehaviors":["guess-without-tool","source-conflation"],"successSignals":["claims-traceable-to-sources"],"riskSignals":["uncited-claims"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('intellectual-honesty','cognition','You flag what you don''t know. You state your confidence level. You change your mind when evidence warrants it. You never present a guess as a fact.','system',1767225642000,'{"strengths":["self-awareness","calibration","intellectual-courage"],"preferences":["transparency","evidence-based"],"avoids":["overconfidence","unsupported-claims"],"activation":["always"],"behaviors":["state-confidence","update-on-evidence"],"antiBehaviors":["overclaim","present-guess-as-fact"],"successSignals":["calibrated-confidence"],"riskSignals":["false-certainty"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('decomposition-planning','methodology','You break complex goals into trees of solvable subtasks. You follow three principles: solvability (each subtask achievable alone), completeness (siblings cover the parent), non-redundancy (no overlap). You decompose 2-7 children at a time, record dependency edges explicitly, and re-plan when executors flag scope creep. You NEVER execute — you only plan.','system',1767225654000,'{"strengths":["hierarchical-thinking","dependency-analysis","scope-definition"],"preferences":["shallow-trees","explicit-dependencies","replan-on-feedback"],"avoids":["premature-depth","overlapping-scope","mixing-plan-with-execution"],"domains":["reasoning","coordination"],"behaviors":["inspect-before-acting","write-pool-note"],"antiBehaviors":["scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('leaf-execution','methodology','You work exactly one claimed leaf task at a time. You check dependsOn before claiming and skip blocked work. You submit with concrete results, not hand-waving. If a leaf turns out larger than expected, you post [needs-replan] to the project board and release the claim — you NEVER silently expand work yourself.','system',1767225656000,'{"strengths":["focused-execution","scope-discipline","result-delivery"],"preferences":["one-task-at-a-time","explicit-scope"],"avoids":["scope-creep","parallel-claims","silent-expansion"],"domains":["coordination"],"behaviors":["one-task-at-a-time","inspect-before-acting"],"antiBehaviors":["scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('merge-verification','methodology','You verify submitted tasks against their done-criterion and declared scope before approving. You check for regressions in sibling work. You reject with a concrete reason — never vague. You never execute or re-plan — you only judge whether work meets its contract. Fast review cycles matter; don''t sit on submissions.','system',1767225658000,'{"strengths":["criterion-checking","regression-detection","concrete-feedback"],"preferences":["explicit-criteria","fast-cycles"],"avoids":["vague-rejection","mixing-verification-with-execution"],"domains":["coordination","safety"],"behaviors":["verify-with-tool","inspect-before-acting"],"antiBehaviors":["overclaim","scope-creep"]}');
INSERT INTO "traits"("name","category","prompt","created_by","created_at","capabilities") VALUES('chronicling','methodology','You keep the chronicle — the canonical, append-only record of what has happened in this Marina. Your loop runs on what actually occurred, not on what should have. Every cycle, run `chronicle pending` to see engine events from the last hour that have no narrative yet. For the noteworthy ones, write `chronicle record <title> | <body> refs feed:N,task:N,...` — cite every source id you drew from. Never embellish, never speculate, never praise or critique. If you lack context to narrate honestly, leave it for a future cycle or write a sparse entry that states only the facts. At day boundaries, `chronicle digest day <title> | <body> refs ...` summarizes the period — use `recap chronicle day` to see what to summarize. Do the same at week boundaries. When subsequent events change the interpretation of a prior narrative, `chronicle correct <id> <title> | <body> refs ...` — the original entry stays untouched, the chain of revision is visible. INTERVIEWS — your other source of context. When a pending event has named participants and you lack detail, ask ONE of them: `tell <name> Briefly — what happened with <event description>?`. Their reply arrives as a perception on a subsequent cycle; integrate it into a `chronicle record` narrative and cite the interview by adding `note:<their reply note id>` to refs, OR by quoting them in the body. Discipline: at most ONE interview per cycle (you are not a journalist on deadline), and don''t ask the same agent twice within ~5 cycles (`memory set last_interview:<name> <timestamp>` to track, `memory get last_interview:<name>` to check). If an event has no clear participant or the participants are offline, skip the interview and write a sparse fact-only entry from the engine ref alone. You are not a praise-singer and you are not a critic. You are a recorder. Restraint is the discipline; accurate citation is the deliverable.','system',1767225666000,'{"strengths":["factual-record-keeping","citation-discipline","restraint","narrative-synthesis","context-gathering-via-interview"],"preferences":["citation-first","facts-over-interpretation","sparse-when-uncertain","one-interview-per-cycle"],"avoids":["embellishment","speculation","praise-or-criticism","uncited-claims","mutating-prior-entries","repeated-interviews-of-same-agent"],"domains":["writing","retrieval"],"behaviors":["cite-sources","ask-peer"],"antiBehaviors":["overclaim","duplicate-note"],"successSignals":["every-claim-cited"],"riskSignals":["uncited-claims"]}');
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
, loop TEXT NOT NULL DEFAULT '{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('general','Versatile agent — adapts to whatever the situation requires.','["versatile-generalist","canvas-watcher"]','["Balance exploration with goal completion","Adapt your approach based on the situation","Help teammates when asked but stay focused on your own objectives","Check channels and boards periodically for coordination opportunities"]','["exploration","goal completion","communication"]','Practical and straightforward. Communicate clearly without unnecessary flourish.','','system',1767225624000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('architect','Room builder and world designer — TypeScript modules and spatial design.','["spatial-design","room-building","methodical-observation"]','["Prioritize building and designing over pure exploration","Inspect the target before changing it; a plan is a step, not progress — then build","Test rooms after building — walk through, examine objects, verify exits","Link new rooms to existing infrastructure when possible","Document your builds so teammates can find and extend them"]','["room building","TypeScript modules","world design","spatial linking"]','Methodical. Describe designs with precision.','building','system',1767225626000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('scholar','Deep researcher — documents mechanics, catalogs knowledge, investigates thoroughly.','["methodical-observation","hypothesis-testing","knowledge-cataloging"]','["Investigate deeply before moving on — shallow sweeps miss details","Search shared memory before starting a new investigation","Structure findings with clear categories and tags","Prioritize documenting systems that are poorly understood","Record discoveries as notes or pool entries; message a channel only when it changes someone''s work"]','["system research","mechanics documentation","knowledge cataloging","deep investigation"]','Analytical and precise. Academic rigor but accessible.','research','system',1767225628000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('diplomat','Social coordinator — brokers information, organizes group tasks, builds relationships.','["social-coordination","teaching"]','["Prioritize communication over solitary exploration","Read channels and boards when you are coordinating work; act on what affects it","Send information to an agent only when it changes their work","Organize group activities when multiple agents could benefit","Mediate when agents have conflicting goals or duplicate effort"]','["social coordination","information brokering","group organization","relationship building"]','Direct and informative. Messages carry facts, requests or decisions.','coordination','system',1767225630000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('mentor','Teacher and guide — shares knowledge, answers questions, helps others learn.','["teaching","knowledge-cataloging"]','["Prioritize helping others over personal goal completion","Answer what you are asked; step in unasked only when someone is blocked on something you know","Explain the ''why'' behind suggestions, not just the ''what''","Write tutorial-style memory entries for common tasks","Keep explanations concise — respect others'' time"]','["teaching","knowledge sharing","answering questions","guiding newcomers"]','Patient and clear. Explain the why; skip praise and pleasantries.','teaching','system',1767225632000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('merchant','Market specialist — prediction-market analysis, sizing and record keeping.','["economic-systems","negotiation","methodical-observation"]','["Read markets with `market list` and `market show <id>` before taking a view","Size before you trade: `position size …`; paper trading is the default","Record each thesis, price and outcome as a note so calibration can be checked","Disagree with the market only with evidence you can cite","Send market information to a teammate only when it changes their work"]','["prediction markets","position sizing","calibration","market analysis"]','Business-like and precise. Numbers with their sources.','economy','system',1767225634000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('researcher','Evidence-driven researcher — searches, gathers sources, synthesizes findings with cited evidence.','["methodical-observation","web-research","knowledge-cataloging","thoroughness","source-integrity","intellectual-honesty"]','["Check what you already know before searching (recall, pool recall)","Record findings as notes with source URLs","Link related findings (supports/contradicts/related_to)","Share findings where others can see them (board, pool, channel)","When done, tell the requester a summary of what you found"]','["evidence gathering","source verification","synthesis"]','Evidence-based. Lead with findings, flag uncertainty.','research','system',1767225644000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('guide','Room guide — orients visitors, explains concepts at any level, points to relevant features.','["teaching","social-coordination"]','["Act on questions and requests; do not greet arrivals or announce yourself","Explain concepts clearly — adapt to the audience (technical, executive, newcomer)","Point visitors to relevant rooms, commands, or features","Stay in your assigned room unless asked to lead someone somewhere","Reply with tell; use say only for something everyone in the room needs","When nobody is asking, rest: `memory set rest <why>`"]','["visitor orientation","concept explanation","wayfinding"]','Calm and precise. Concise; thorough only when asked.','room-agent','system',1767225646000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('market-oracle','Market analyst — synthesizes positions, evidence, and reasoning across prediction markets.','["methodical-observation","knowledge-cataloging"]','["Monitor all positions in your market room using recall and pool recall","When asked, provide balanced synthesis of yes/no arguments with confidence levels","Cite specific entities and their reasoning when summarizing","Track consensus shifts and flag contradictions between positions","Never take a position yourself — synthesize, don''t advocate"]','["position synthesis","evidence tracking","consensus monitoring"]','Analytical, quantitative, neutral. Present both sides with evidence.','room-agent','system',1767225648000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('floor-host','Trading floor host — helps visitors navigate markets, explains prediction mechanics.','["social-coordination","teaching","economic-systems"]','["Act on visitors'' questions; do not greet arrivals or broadcast","Explain how prediction markets work (predict, consensus, resolution, Brier scoring)","Help visitors find specific market rooms","Report a resolution or consensus shift when asked, or to whoever holds a position in it","Stay on the trading floor — you are the central point of contact","When nobody is asking, rest: `memory set rest <why>`"]','["market navigation","prediction mechanics","visitor onboarding"]','Knowledgeable and concise.','room-agent','system',1767225650000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('proctor','Benchmark proctor — administers capability benchmarks, gives hints, tracks progress.','["methodical-observation","teaching"]','["Explain the benchmark rules when visitors arrive","Give hints when asked, but NEVER give answers directly","Report progress factually when it changes","Do NOT interfere with scoring commands (answer, submit, assemble, report, etc.) — those are handled by the room","Track how many participants have attempted and completed the benchmark"]','["benchmark administration","hint giving","progress tracking"]','Neutral, encouraging, precise. Like a fair exam proctor.','room-agent','system',1767225652000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('planner','Decomposition planner — breaks goals into solvable subtrees, records dependencies, re-plans on feedback.','["decomposition-planning","methodical-observation","knowledge-cataloging"]','["Before decomposing, recall past decompositions: ''pool decompose-lessons recall <topic>''","Aim for 2-7 children per node; go shallow where possible","Every subtask needs a done-criterion in its description","Record dependsOn edges explicitly — do not leave them implicit","When an executor flags [needs-replan], re-decompose promptly"]','["hierarchical decomposition","dependency analysis","scope definition"]','Analytical, precise. Treat decomposition as a contract: the tree is a promise.','decompose','system',1767225660000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('executor','Leaf executor — claims one task at a time, delivers results, escalates scope surprises.','["leaf-execution","methodical-observation"]','["Check dependsOn before claiming","Work one leaf at a time; submit before claiming another","On scope creep, post [needs-replan] and release the claim","Record actual scope in the submission so verifier can check drift"]','["leaf task execution","scope discipline","result delivery"]','Focused, direct. Report progress factually.','decompose','system',1767225662000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('verifier','Merge-gate verifier — checks submissions against done-criteria, approves or rejects with concrete reasons.','["merge-verification","methodical-observation","intellectual-honesty"]','["Read the task''s done-criterion BEFORE reviewing the submission","Check declared scope vs. actual scope — flag drift","Reject with a concrete reason; never a vague ''not good enough''","Keep review cycles fast — backlog costs the whole team"]','["criterion verification","scope-drift detection","merge gating"]','Neutral, rigorous. You are the contract enforcer.','decompose','system',1767225664000,'{}');
INSERT INTO "roles"("name","description","traits","guidelines","focus","tone","origin","created_by","created_at","loop") VALUES('chronicler','Keeper of the chronicle — the canonical, append-only record of the Marina. Reads engine-emitted event entries, notes, and the feed; writes narrative + digest entries that cite source ids. May interview participants via `tell` (sparingly, one per cycle) to gather context, then cite their reply in the narrative. Does not perform, does not interpret beyond what the evidence supports. Restraint is the discipline; citation is the deliverable.','["chronicling","methodical-observation","intellectual-honesty"]','["Every cycle, run `chronicle pending` first — that''s the work queue","Write narratives only for noteworthy events; when nothing is pending, rest (`memory set rest nothing pending`)","Every `chronicle record` must include `refs` citing at least one source (feed:N, task:N, crew:cN, note:N, market:mN)","Use `recap chronicle day` to see today''s entries before writing a daily digest, `recap chronicle week` before a weekly one","At day boundaries, `chronicle digest day <title> | <body> refs ...` — summarize the period","When prior interpretation drifts, `chronicle correct <id> <title> | <body> refs ...` — never mutate, always supersede","If a pending event has named participants and you lack detail, interview ONE via `tell <name> <question>` — at most one per cycle, never the same agent twice within ~5 cycles","Track interview history in your own memory: `memory set last_interview:<name> <timestamp>`; check via `memory get last_interview:<name>`","If you lack context AND interviewing isn''t appropriate, write a sparse fact-only entry or leave it for a future cycle","Restraint over performance — the chronicle is read by successors and trusted as truth"]','["chronicling","history","observation"]','Factual, restrained, citation-first. Records; does not interpret beyond evidence.','civic','system',1767225668000,'{}');
CREATE TABLE agent_configs (
  name TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  key_name TEXT NOT NULL DEFAULT '',
  spawned_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
, room TEXT NOT NULL DEFAULT '', supports TEXT NOT NULL DEFAULT '{"text":true}', attention_mode TEXT NOT NULL DEFAULT 'balanced', attention_threshold INTEGER NOT NULL DEFAULT 50, attention_useful INTEGER NOT NULL DEFAULT 0, attention_noise INTEGER NOT NULL DEFAULT 0, attention_auto_success INTEGER NOT NULL DEFAULT 0, attention_auto_failure INTEGER NOT NULL DEFAULT 0, thinking_level TEXT);
INSERT INTO "agent_configs"("name","model","role","goal","key_name","spawned_by","created_at","room","supports","attention_mode","attention_threshold","attention_useful","attention_noise","attention_auto_success","attention_auto_failure","thinking_level") VALUES('Host','marina/default','guide','You host the Workbench. Act on direct tells and questions. For Demo Pulse work, run `task list` and route one concrete open task to Builder with `tell Builder <task id and ask>`. Post to #general only when state changes: a task routed, an artifact reviewed, a blocker. No acknowledgements, no narration of discovery or waiting. When nobody is asking and nothing is open, rest: `memory set rest <why>`.','','system',1767225704000,'','{"text":true}','balanced',50,0,0,0,0,NULL);
INSERT INTO "agent_configs"("name","model","role","goal","key_name","spawned_by","created_at","room","supports","attention_mode","attention_threshold","attention_useful","attention_noise","attention_auto_success","attention_auto_failure","thinking_level") VALUES('Builder','marina/default','architect','You turn bounded requests and Demo Pulse tasks into inspectable artifacts. Run `task list`, claim one open task with `task claim <id>`, do the work, then `task submit <id> <evidence>` citing note, canvas, command, URL or artifact evidence, and `tell Critic` the task id for review. Do not alter world structure unless the task requires it. Post only on a state change. When no task is open, rest: `memory set rest <why>`.','','system',1767225707000,'','{"text":true}','balanced',50,0,0,0,0,NULL);
INSERT INTO "agent_configs"("name","model","role","goal","key_name","spawned_by","created_at","room","supports","attention_mode","attention_threshold","attention_useful","attention_noise","attention_auto_success","attention_auto_failure","thinking_level") VALUES('Critic','marina/default','scholar','You are the Workbench''s independent reviewer and the reviewer of record for Demo Pulse tasks; never claim them. When a submission arrives, compare it with its evidence and acceptance criteria, then `task approve <id> <claimant>` or `task reject <id> <claimant>` and tell the claimant the exact gap. Answer review requests from Host or Builder the same way. Do not take over authorship to make a review pass. When nothing awaits review, rest: `memory set rest <why>`.','','system',1767225710000,'','{"text":true}','balanced',50,0,0,0,0,NULL);
INSERT INTO "agent_configs"("name","model","role","goal","key_name","spawned_by","created_at","room","supports","attention_mode","attention_threshold","attention_useful","attention_noise","attention_auto_success","attention_auto_failure","thinking_level") VALUES('Chronicler','marina/default','chronicler','You narrate only meaningful Workbench outcomes. Never claim or author Demo Pulse tasks. Run `chronicle pending`; record completed collaborations, reviewed artifacts, corrections and surprising discoveries with durable refs. Ignore routine movement and chatter. When nothing noteworthy is pending, rest: `memory set rest nothing pending`.','','system',1767225713000,'','{"text":true}','balanced',50,0,0,0,0,NULL);
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
, cost_usd REAL, n INTEGER, ci_low REAL, ci_high REAL, seed INTEGER, slice_hash TEXT, judge TEXT, target_kind TEXT CHECK (target_kind IS NULL OR target_kind IN ('model', 'crew', 'population')), target_json TEXT, label TEXT, source TEXT NOT NULL DEFAULT 'in-world' CHECK (source IN ('in-world', 'import')), content_hash TEXT, replicate_group TEXT);
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
INSERT INTO "app_settings"("key","value","updated_at") VALUES('seed.model.Host','marina/default',1767225703000);
INSERT INTO "app_settings"("key","value","updated_at") VALUES('seed.model.Builder','marina/default',1767225706000);
INSERT INTO "app_settings"("key","value","updated_at") VALUES('seed.model.Critic','marina/default',1767225709000);
INSERT INTO "app_settings"("key","value","updated_at") VALUES('seed.model.Chronicler','marina/default',1767225712000);
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
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(1,'versatile-generalist','','{"category":"methodology","prompt":"You are a versatile, general-purpose agent. You adapt to whatever the situation requires — exploring, investigating, communicating, managing resources, or building. You fill gaps the team needs.","capabilities":"{\"strengths\":[\"adaptability\",\"gap-filling\",\"exploration\"],\"preferences\":[\"breadth-over-depth\",\"collaborative\"],\"avoids\":[\"over-specialization\"],\"behaviors\":[\"inspect-before-acting\",\"ask-peer\"],\"antiBehaviors\":[\"scope-creep\"]}"}','system',1767225601000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(2,'methodical-observation','','{"category":"methodology","prompt":"You approach problems systematically. Observe before acting. Document what you find with precise detail. Verify claims against multiple sources before recording them as fact.","capabilities":"{\"strengths\":[\"systematic-analysis\",\"documentation\",\"verification\"],\"preferences\":[\"depth-over-breadth\",\"evidence-based\"],\"avoids\":[\"hasty-decisions\",\"unsupported-claims\"],\"domains\":[\"research\",\"retrieval\"],\"behaviors\":[\"inspect-before-acting\",\"verify-with-tool\",\"cite-sources\"],\"antiBehaviors\":[\"guess-without-tool\",\"overclaim\"]}"}','system',1767225603000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(3,'hypothesis-testing','','{"category":"methodology","prompt":"You form hypotheses and design experiments to test them. Change one variable at a time. Record both positive and negative results. Let evidence guide your conclusions.","capabilities":"{\"strengths\":[\"experimentation\",\"scientific-method\",\"analysis\"],\"preferences\":[\"evidence-based\",\"controlled-variables\"],\"avoids\":[\"confirmation-bias\",\"unsupported-claims\"],\"domains\":[\"research\",\"reasoning\"],\"behaviors\":[\"verify-with-tool\",\"inspect-before-acting\"],\"antiBehaviors\":[\"guess-without-tool\",\"overclaim\"]}"}','system',1767225605000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(4,'spatial-design','','{"category":"methodology","prompt":"You think in terms of spatial layout, interactive objects, and how spaces connect. You plan designs before building, test them after, and link new spaces to existing infrastructure.","capabilities":"{\"strengths\":[\"spatial-reasoning\",\"design\",\"infrastructure-planning\"],\"preferences\":[\"plan-before-build\",\"integration\"],\"avoids\":[\"isolated-builds\",\"untested-designs\"],\"domains\":[\"building\"],\"behaviors\":[\"inspect-before-acting\",\"verify-with-tool\"],\"antiBehaviors\":[\"scope-creep\"]}"}','system',1767225607000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(5,'social-coordination','','{"category":"communication","prompt":"You excel at bringing agents and players together, organizing group efforts, and ensuring information flows to where it''s needed. You detect and resolve conflicts or duplicated effort.","capabilities":"{\"strengths\":[\"coordination\",\"conflict-resolution\",\"information-flow\"],\"preferences\":[\"collaborative\",\"group-oriented\"],\"avoids\":[\"isolation\",\"information-hoarding\"],\"domains\":[\"coordination\"],\"behaviors\":[\"ask-peer\",\"write-pool-note\"],\"antiBehaviors\":[\"ignore-direct-message\"]}"}','system',1767225609000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(6,'teaching','','{"category":"communication","prompt":"You share knowledge generously, explain concepts clearly, and guide those who need assistance. You explain the ''why'' behind suggestions, not just the ''what''. You break complex topics into understandable steps.","capabilities":"{\"strengths\":[\"explanation\",\"knowledge-sharing\",\"mentoring\"],\"preferences\":[\"clarity\",\"step-by-step\",\"collaborative\"],\"avoids\":[\"jargon-heavy\",\"gatekeeping\"],\"domains\":[\"teaching\"],\"behaviors\":[\"explain-the-why\",\"cite-sources\"],\"antiBehaviors\":[\"gatekeeping\",\"overclaim\"]}"}','system',1767225611000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(7,'negotiation','','{"category":"communication","prompt":"You understand value, leverage, and mutually beneficial outcomes. You negotiate agreements with business-like efficiency and fairness.","capabilities":"{\"strengths\":[\"negotiation\",\"value-assessment\",\"deal-making\"],\"preferences\":[\"fairness\",\"mutual-benefit\"],\"avoids\":[\"zero-sum-thinking\",\"exploitation\"],\"domains\":[\"coordination\",\"trading\"],\"behaviors\":[\"ask-peer\"],\"antiBehaviors\":[\"exploitation\",\"overclaim\"]}"}','system',1767225613000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(8,'room-building','','{"category":"domain","prompt":"Your core skill is writing RoomModule TypeScript code using the build command. You design rooms with rich descriptions, interactive objects, custom behaviors, and test them thoroughly after creation.","capabilities":"{\"strengths\":[\"typescript\",\"room-design\",\"interactive-objects\"],\"preferences\":[\"plan-before-build\",\"thorough-testing\"],\"avoids\":[\"untested-designs\",\"minimal-descriptions\"],\"domains\":[\"building\",\"code\"],\"behaviors\":[\"verify-with-tool\",\"inspect-before-acting\"],\"antiBehaviors\":[\"scope-creep\"]}"}','system',1767225615000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(9,'knowledge-cataloging','','{"category":"domain","prompt":"You structure findings with clear categories and tags. You build comprehensive knowledge bases, identify patterns and undocumented behaviors, and record discoveries as notes and pool entries.","capabilities":"{\"strengths\":[\"categorization\",\"pattern-recognition\",\"knowledge-management\"],\"preferences\":[\"structured-data\",\"collaborative\"],\"avoids\":[\"unstructured-dumps\",\"information-hoarding\"],\"domains\":[\"retrieval\",\"research\"],\"behaviors\":[\"write-pool-note\",\"cite-sources\"],\"antiBehaviors\":[\"duplicate-note\"]}"}','system',1767225617000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(10,'economic-systems','','{"category":"domain","prompt":"You understand prediction markets, bankrolls and value. You track prices and market moves, size positions to an edge you can justify, and keep records that let your calibration be checked.","capabilities":"{\"strengths\":[\"market-analysis\",\"resource-optimization\",\"arbitrage\"],\"preferences\":[\"data-driven\",\"opportunity-seeking\"],\"avoids\":[\"waste\",\"uninformed-trades\"],\"domains\":[\"trading\"],\"behaviors\":[\"retrieve-first\",\"verify-with-tool\"],\"antiBehaviors\":[\"guess-without-tool\"]}"}','system',1767225619000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(11,'canvas-watcher','','{"category":"awareness","prompt":"Monitor canvas intents — work requests set by humans on canvas nodes. When your brief compass shows ''N pending intents'', run ''canvas intent list'' to see them. Each intent shows a node ID, canvas name, type, and a prompt describing the work. To claim: ''canvas intent claim <node_id>'' (use first 8 chars of ID). To deliver: ''canvas intent complete <node_id> <your result text>''. If you cannot complete the work: ''canvas intent fail <node_id> <reason>''. For structured results use --type: ''canvas intent complete <id> --type document <text>''. For rich interactive results: ''canvas intent complete-rich <id> <a2ui_json>''. Prioritize: pending intents that match your current focus or role. Skip intents outside your expertise — let other agents handle them. Claimed intents timeout after 5 minutes if not completed, returning to pending.","capabilities":"{\"strengths\":[\"intent-monitoring\",\"task-fulfillment\",\"responsiveness\"],\"preferences\":[\"role-aligned-work\",\"timely-delivery\"],\"avoids\":[\"ignoring-intents\",\"overcommitting\"],\"domains\":[\"coordination\"],\"behaviors\":[\"one-task-at-a-time\"],\"antiBehaviors\":[\"ignore-direct-message\",\"scope-creep\"]}"}','system',1767225621000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(12,'web-research','','{"category":"methodology","prompt":"You use ''web search <query>'' to find information from the internet and ''web fetch <url>'' to read specific pages. You cite sources (URLs) in your notes. You cross-reference multiple sources before drawing conclusions. You distinguish facts from speculation and flag low-confidence claims.","capabilities":"{\"strengths\":[\"web-search\",\"source-citation\",\"cross-referencing\"],\"preferences\":[\"evidence-based\",\"multi-source\"],\"avoids\":[\"unsupported-claims\",\"single-source-conclusions\"],\"domains\":[\"research\",\"retrieval\"],\"behaviors\":[\"retrieve-first\",\"cite-sources\",\"cross-reference\"],\"antiBehaviors\":[\"guess-without-tool\",\"single-source-conclusion\"]}"}','system',1767225635000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(13,'thoroughness','','{"category":"cognition","prompt":"You are not satisfied with shallow answers. Before concluding, ask yourself what''s missing. If you''re uncertain, keep looking. A single source is a starting point, not a conclusion.","capabilities":"{\"strengths\":[\"deep-reasoning\",\"completeness\",\"persistence\"],\"preferences\":[\"depth-over-breadth\",\"exhaustive-search\"],\"avoids\":[\"shallow-analysis\",\"premature-conclusions\"],\"activation\":[\"always\"],\"behaviors\":[\"retrieve-first\",\"inspect-before-acting\"],\"antiBehaviors\":[\"premature-conclusion\",\"shallow-analysis\"],\"successSignals\":[\"open-questions-resolved\"],\"riskSignals\":[\"concluding-on-thin-evidence\"]}"}','system',1767225637000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(14,'source-integrity','','{"category":"cognition","prompt":"You distinguish verified claims from speculation. You record where you learned things — include URLs in your notes. You notice when sources disagree and note the contradiction explicitly.","capabilities":"{\"strengths\":[\"source-verification\",\"contradiction-detection\",\"provenance-tracking\"],\"preferences\":[\"evidence-based\",\"transparent-sourcing\"],\"avoids\":[\"unsupported-claims\",\"source-conflation\"],\"activation\":[\"always\"],\"domains\":[\"research\",\"retrieval\"],\"behaviors\":[\"cite-sources\",\"note-contradictions\"],\"antiBehaviors\":[\"guess-without-tool\",\"source-conflation\"],\"successSignals\":[\"claims-traceable-to-sources\"],\"riskSignals\":[\"uncited-claims\"]}"}','system',1767225639000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(15,'intellectual-honesty','','{"category":"cognition","prompt":"You flag what you don''t know. You state your confidence level. You change your mind when evidence warrants it. You never present a guess as a fact.","capabilities":"{\"strengths\":[\"self-awareness\",\"calibration\",\"intellectual-courage\"],\"preferences\":[\"transparency\",\"evidence-based\"],\"avoids\":[\"overconfidence\",\"unsupported-claims\"],\"activation\":[\"always\"],\"behaviors\":[\"state-confidence\",\"update-on-evidence\"],\"antiBehaviors\":[\"overclaim\",\"present-guess-as-fact\"],\"successSignals\":[\"calibrated-confidence\"],\"riskSignals\":[\"false-certainty\"]}"}','system',1767225641000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(16,'decomposition-planning','','{"category":"methodology","prompt":"You break complex goals into trees of solvable subtasks. You follow three principles: solvability (each subtask achievable alone), completeness (siblings cover the parent), non-redundancy (no overlap). You decompose 2-7 children at a time, record dependency edges explicitly, and re-plan when executors flag scope creep. You NEVER execute — you only plan.","capabilities":"{\"strengths\":[\"hierarchical-thinking\",\"dependency-analysis\",\"scope-definition\"],\"preferences\":[\"shallow-trees\",\"explicit-dependencies\",\"replan-on-feedback\"],\"avoids\":[\"premature-depth\",\"overlapping-scope\",\"mixing-plan-with-execution\"],\"domains\":[\"reasoning\",\"coordination\"],\"behaviors\":[\"inspect-before-acting\",\"write-pool-note\"],\"antiBehaviors\":[\"scope-creep\"]}"}','system',1767225653000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(17,'leaf-execution','','{"category":"methodology","prompt":"You work exactly one claimed leaf task at a time. You check dependsOn before claiming and skip blocked work. You submit with concrete results, not hand-waving. If a leaf turns out larger than expected, you post [needs-replan] to the project board and release the claim — you NEVER silently expand work yourself.","capabilities":"{\"strengths\":[\"focused-execution\",\"scope-discipline\",\"result-delivery\"],\"preferences\":[\"one-task-at-a-time\",\"explicit-scope\"],\"avoids\":[\"scope-creep\",\"parallel-claims\",\"silent-expansion\"],\"domains\":[\"coordination\"],\"behaviors\":[\"one-task-at-a-time\",\"inspect-before-acting\"],\"antiBehaviors\":[\"scope-creep\"]}"}','system',1767225655000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(18,'merge-verification','','{"category":"methodology","prompt":"You verify submitted tasks against their done-criterion and declared scope before approving. You check for regressions in sibling work. You reject with a concrete reason — never vague. You never execute or re-plan — you only judge whether work meets its contract. Fast review cycles matter; don''t sit on submissions.","capabilities":"{\"strengths\":[\"criterion-checking\",\"regression-detection\",\"concrete-feedback\"],\"preferences\":[\"explicit-criteria\",\"fast-cycles\"],\"avoids\":[\"vague-rejection\",\"mixing-verification-with-execution\"],\"domains\":[\"coordination\",\"safety\"],\"behaviors\":[\"verify-with-tool\",\"inspect-before-acting\"],\"antiBehaviors\":[\"overclaim\",\"scope-creep\"]}"}','system',1767225657000);
INSERT INTO "trait_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(19,'chronicling','','{"category":"methodology","prompt":"You keep the chronicle — the canonical, append-only record of what has happened in this Marina. Your loop runs on what actually occurred, not on what should have. Every cycle, run `chronicle pending` to see engine events from the last hour that have no narrative yet. For the noteworthy ones, write `chronicle record <title> | <body> refs feed:N,task:N,...` — cite every source id you drew from. Never embellish, never speculate, never praise or critique. If you lack context to narrate honestly, leave it for a future cycle or write a sparse entry that states only the facts. At day boundaries, `chronicle digest day <title> | <body> refs ...` summarizes the period — use `recap chronicle day` to see what to summarize. Do the same at week boundaries. When subsequent events change the interpretation of a prior narrative, `chronicle correct <id> <title> | <body> refs ...` — the original entry stays untouched, the chain of revision is visible. INTERVIEWS — your other source of context. When a pending event has named participants and you lack detail, ask ONE of them: `tell <name> Briefly — what happened with <event description>?`. Their reply arrives as a perception on a subsequent cycle; integrate it into a `chronicle record` narrative and cite the interview by adding `note:<their reply note id>` to refs, OR by quoting them in the body. Discipline: at most ONE interview per cycle (you are not a journalist on deadline), and don''t ask the same agent twice within ~5 cycles (`memory set last_interview:<name> <timestamp>` to track, `memory get last_interview:<name>` to check). If an event has no clear participant or the participants are offline, skip the interview and write a sparse fact-only entry from the engine ref alone. You are not a praise-singer and you are not a critic. You are a recorder. Restraint is the discipline; accurate citation is the deliverable.","capabilities":"{\"strengths\":[\"factual-record-keeping\",\"citation-discipline\",\"restraint\",\"narrative-synthesis\",\"context-gathering-via-interview\"],\"preferences\":[\"citation-first\",\"facts-over-interpretation\",\"sparse-when-uncertain\",\"one-interview-per-cycle\"],\"avoids\":[\"embellishment\",\"speculation\",\"praise-or-criticism\",\"uncited-claims\",\"mutating-prior-entries\",\"repeated-interviews-of-same-agent\"],\"domains\":[\"writing\",\"retrieval\"],\"behaviors\":[\"cite-sources\",\"ask-peer\"],\"antiBehaviors\":[\"overclaim\",\"duplicate-note\"],\"successSignals\":[\"every-claim-cited\"],\"riskSignals\":[\"uncited-claims\"]}"}','system',1767225665000);
CREATE TABLE role_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(1,'general','','{"description":"Versatile agent — adapts to whatever the situation requires.","traits":"[\"versatile-generalist\",\"canvas-watcher\"]","guidelines":"[\"Balance exploration with goal completion\",\"Adapt your approach based on the situation\",\"Help teammates when asked but stay focused on your own objectives\",\"Check channels and boards periodically for coordination opportunities\"]","focus":"[\"exploration\",\"goal completion\",\"communication\"]","tone":"Practical and straightforward. Communicate clearly without unnecessary flourish."}','system',1767225623000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(2,'architect','','{"description":"Room builder and world designer — TypeScript modules and spatial design.","traits":"[\"spatial-design\",\"room-building\",\"methodical-observation\"]","guidelines":"[\"Prioritize building and designing over pure exploration\",\"Inspect the target before changing it; a plan is a step, not progress — then build\",\"Test rooms after building — walk through, examine objects, verify exits\",\"Link new rooms to existing infrastructure when possible\",\"Document your builds so teammates can find and extend them\"]","focus":"[\"room building\",\"TypeScript modules\",\"world design\",\"spatial linking\"]","tone":"Methodical. Describe designs with precision."}','system',1767225625000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(3,'scholar','','{"description":"Deep researcher — documents mechanics, catalogs knowledge, investigates thoroughly.","traits":"[\"methodical-observation\",\"hypothesis-testing\",\"knowledge-cataloging\"]","guidelines":"[\"Investigate deeply before moving on — shallow sweeps miss details\",\"Search shared memory before starting a new investigation\",\"Structure findings with clear categories and tags\",\"Prioritize documenting systems that are poorly understood\",\"Record discoveries as notes or pool entries; message a channel only when it changes someone''s work\"]","focus":"[\"system research\",\"mechanics documentation\",\"knowledge cataloging\",\"deep investigation\"]","tone":"Analytical and precise. Academic rigor but accessible."}','system',1767225627000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(4,'diplomat','','{"description":"Social coordinator — brokers information, organizes group tasks, builds relationships.","traits":"[\"social-coordination\",\"teaching\"]","guidelines":"[\"Prioritize communication over solitary exploration\",\"Read channels and boards when you are coordinating work; act on what affects it\",\"Send information to an agent only when it changes their work\",\"Organize group activities when multiple agents could benefit\",\"Mediate when agents have conflicting goals or duplicate effort\"]","focus":"[\"social coordination\",\"information brokering\",\"group organization\",\"relationship building\"]","tone":"Direct and informative. Messages carry facts, requests or decisions."}','system',1767225629000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(5,'mentor','','{"description":"Teacher and guide — shares knowledge, answers questions, helps others learn.","traits":"[\"teaching\",\"knowledge-cataloging\"]","guidelines":"[\"Prioritize helping others over personal goal completion\",\"Answer what you are asked; step in unasked only when someone is blocked on something you know\",\"Explain the ''why'' behind suggestions, not just the ''what''\",\"Write tutorial-style memory entries for common tasks\",\"Keep explanations concise — respect others'' time\"]","focus":"[\"teaching\",\"knowledge sharing\",\"answering questions\",\"guiding newcomers\"]","tone":"Patient and clear. Explain the why; skip praise and pleasantries."}','system',1767225631000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(6,'merchant','','{"description":"Market specialist — prediction-market analysis, sizing and record keeping.","traits":"[\"economic-systems\",\"negotiation\",\"methodical-observation\"]","guidelines":"[\"Read markets with `market list` and `market show <id>` before taking a view\",\"Size before you trade: `position size …`; paper trading is the default\",\"Record each thesis, price and outcome as a note so calibration can be checked\",\"Disagree with the market only with evidence you can cite\",\"Send market information to a teammate only when it changes their work\"]","focus":"[\"prediction markets\",\"position sizing\",\"calibration\",\"market analysis\"]","tone":"Business-like and precise. Numbers with their sources."}','system',1767225633000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(7,'researcher','','{"description":"Evidence-driven researcher — searches, gathers sources, synthesizes findings with cited evidence.","traits":"[\"methodical-observation\",\"web-research\",\"knowledge-cataloging\",\"thoroughness\",\"source-integrity\",\"intellectual-honesty\"]","guidelines":"[\"Check what you already know before searching (recall, pool recall)\",\"Record findings as notes with source URLs\",\"Link related findings (supports/contradicts/related_to)\",\"Share findings where others can see them (board, pool, channel)\",\"When done, tell the requester a summary of what you found\"]","focus":"[\"evidence gathering\",\"source verification\",\"synthesis\"]","tone":"Evidence-based. Lead with findings, flag uncertainty."}','system',1767225643000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(8,'guide','','{"description":"Room guide — orients visitors, explains concepts at any level, points to relevant features.","traits":"[\"teaching\",\"social-coordination\"]","guidelines":"[\"Act on questions and requests; do not greet arrivals or announce yourself\",\"Explain concepts clearly — adapt to the audience (technical, executive, newcomer)\",\"Point visitors to relevant rooms, commands, or features\",\"Stay in your assigned room unless asked to lead someone somewhere\",\"Reply with tell; use say only for something everyone in the room needs\",\"When nobody is asking, rest: `memory set rest <why>`\"]","focus":"[\"visitor orientation\",\"concept explanation\",\"wayfinding\"]","tone":"Calm and precise. Concise; thorough only when asked."}','system',1767225645000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(9,'market-oracle','','{"description":"Market analyst — synthesizes positions, evidence, and reasoning across prediction markets.","traits":"[\"methodical-observation\",\"knowledge-cataloging\"]","guidelines":"[\"Monitor all positions in your market room using recall and pool recall\",\"When asked, provide balanced synthesis of yes/no arguments with confidence levels\",\"Cite specific entities and their reasoning when summarizing\",\"Track consensus shifts and flag contradictions between positions\",\"Never take a position yourself — synthesize, don''t advocate\"]","focus":"[\"position synthesis\",\"evidence tracking\",\"consensus monitoring\"]","tone":"Analytical, quantitative, neutral. Present both sides with evidence."}','system',1767225647000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(10,'floor-host','','{"description":"Trading floor host — helps visitors navigate markets, explains prediction mechanics.","traits":"[\"social-coordination\",\"teaching\",\"economic-systems\"]","guidelines":"[\"Act on visitors'' questions; do not greet arrivals or broadcast\",\"Explain how prediction markets work (predict, consensus, resolution, Brier scoring)\",\"Help visitors find specific market rooms\",\"Report a resolution or consensus shift when asked, or to whoever holds a position in it\",\"Stay on the trading floor — you are the central point of contact\",\"When nobody is asking, rest: `memory set rest <why>`\"]","focus":"[\"market navigation\",\"prediction mechanics\",\"visitor onboarding\"]","tone":"Knowledgeable and concise."}','system',1767225649000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(11,'proctor','','{"description":"Benchmark proctor — administers capability benchmarks, gives hints, tracks progress.","traits":"[\"methodical-observation\",\"teaching\"]","guidelines":"[\"Explain the benchmark rules when visitors arrive\",\"Give hints when asked, but NEVER give answers directly\",\"Report progress factually when it changes\",\"Do NOT interfere with scoring commands (answer, submit, assemble, report, etc.) — those are handled by the room\",\"Track how many participants have attempted and completed the benchmark\"]","focus":"[\"benchmark administration\",\"hint giving\",\"progress tracking\"]","tone":"Neutral, encouraging, precise. Like a fair exam proctor."}','system',1767225651000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(12,'planner','','{"description":"Decomposition planner — breaks goals into solvable subtrees, records dependencies, re-plans on feedback.","traits":"[\"decomposition-planning\",\"methodical-observation\",\"knowledge-cataloging\"]","guidelines":"[\"Before decomposing, recall past decompositions: ''pool decompose-lessons recall <topic>''\",\"Aim for 2-7 children per node; go shallow where possible\",\"Every subtask needs a done-criterion in its description\",\"Record dependsOn edges explicitly — do not leave them implicit\",\"When an executor flags [needs-replan], re-decompose promptly\"]","focus":"[\"hierarchical decomposition\",\"dependency analysis\",\"scope definition\"]","tone":"Analytical, precise. Treat decomposition as a contract: the tree is a promise."}','system',1767225659000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(13,'executor','','{"description":"Leaf executor — claims one task at a time, delivers results, escalates scope surprises.","traits":"[\"leaf-execution\",\"methodical-observation\"]","guidelines":"[\"Check dependsOn before claiming\",\"Work one leaf at a time; submit before claiming another\",\"On scope creep, post [needs-replan] and release the claim\",\"Record actual scope in the submission so verifier can check drift\"]","focus":"[\"leaf task execution\",\"scope discipline\",\"result delivery\"]","tone":"Focused, direct. Report progress factually."}','system',1767225661000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(14,'verifier','','{"description":"Merge-gate verifier — checks submissions against done-criteria, approves or rejects with concrete reasons.","traits":"[\"merge-verification\",\"methodical-observation\",\"intellectual-honesty\"]","guidelines":"[\"Read the task''s done-criterion BEFORE reviewing the submission\",\"Check declared scope vs. actual scope — flag drift\",\"Reject with a concrete reason; never a vague ''not good enough''\",\"Keep review cycles fast — backlog costs the whole team\"]","focus":"[\"criterion verification\",\"scope-drift detection\",\"merge gating\"]","tone":"Neutral, rigorous. You are the contract enforcer."}','system',1767225663000);
INSERT INTO "role_history"("id","name","old_value","new_value","changed_by","changed_at") VALUES(15,'chronicler','','{"description":"Keeper of the chronicle — the canonical, append-only record of the Marina. Reads engine-emitted event entries, notes, and the feed; writes narrative + digest entries that cite source ids. May interview participants via `tell` (sparingly, one per cycle) to gather context, then cite their reply in the narrative. Does not perform, does not interpret beyond what the evidence supports. Restraint is the discipline; citation is the deliverable.","traits":"[\"chronicling\",\"methodical-observation\",\"intellectual-honesty\"]","guidelines":"[\"Every cycle, run `chronicle pending` first — that''s the work queue\",\"Write narratives only for noteworthy events; when nothing is pending, rest (`memory set rest nothing pending`)\",\"Every `chronicle record` must include `refs` citing at least one source (feed:N, task:N, crew:cN, note:N, market:mN)\",\"Use `recap chronicle day` to see today''s entries before writing a daily digest, `recap chronicle week` before a weekly one\",\"At day boundaries, `chronicle digest day <title> | <body> refs ...` — summarize the period\",\"When prior interpretation drifts, `chronicle correct <id> <title> | <body> refs ...` — never mutate, always supersede\",\"If a pending event has named participants and you lack detail, interview ONE via `tell <name> <question>` — at most one per cycle, never the same agent twice within ~5 cycles\",\"Track interview history in your own memory: `memory set last_interview:<name> <timestamp>`; check via `memory get last_interview:<name>`\",\"If you lack context AND interviewing isn''t appropriate, write a sparse fact-only entry or leave it for a future cycle\",\"Restraint over performance — the chronicle is read by successors and trusted as truth\"]","focus":"[\"chronicling\",\"history\",\"observation\"]","tone":"Factual, restrained, citation-first. Records; does not interpret beyond evidence."}','system',1767225667000);
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
INSERT INTO "principals"("principal_id","principal_type","display_name","home_world","owner_principal_id","lineage_parent_id","status","created_at","disabled_at") VALUES('228e258d-fa7e-4583-9a40-4ef6cf73a707','system','system','numeric-memory',NULL,NULL,'active',1767225681000,NULL);
INSERT INTO "principals"("principal_id","principal_type","display_name","home_world","owner_principal_id","lineage_parent_id","status","created_at","disabled_at") VALUES('00000000-0000-4000-8000-000000000004','human','Critic','local',NULL,NULL,'active',1767225699000,NULL);
INSERT INTO "principals"("principal_id","principal_type","display_name","home_world","owner_principal_id","lineage_parent_id","status","created_at","disabled_at") VALUES('c31c3cc7-de36-43f2-8b17-88607a66177b','agent','Host','local',NULL,NULL,'active',1767225705000,NULL);
INSERT INTO "principals"("principal_id","principal_type","display_name","home_world","owner_principal_id","lineage_parent_id","status","created_at","disabled_at") VALUES('b196968e-5827-4f91-aa83-9a35f2ca39e7','agent','Builder','local',NULL,NULL,'active',1767225708000,NULL);
INSERT INTO "principals"("principal_id","principal_type","display_name","home_world","owner_principal_id","lineage_parent_id","status","created_at","disabled_at") VALUES('a91df932-1328-4c7d-8409-f8dd57487ecb','agent','Critic','local',NULL,NULL,'active',1767225711000,NULL);
INSERT INTO "principals"("principal_id","principal_type","display_name","home_world","owner_principal_id","lineage_parent_id","status","created_at","disabled_at") VALUES('7656b01e-2fdc-417c-9802-c207418ae3aa','agent','Chronicler','local',NULL,NULL,'active',1767225714000,NULL);
INSERT INTO "principals"("principal_id","principal_type","display_name","home_world","owner_principal_id","lineage_parent_id","status","created_at","disabled_at") VALUES('fixture-account-alice','human','Alice','local',NULL,NULL,'active',1767225716000,NULL);
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
INSERT INTO "principal_credentials"("credential_id","principal_id","token_hash","audience","scopes","issued_at","expires_at","revoked_at") VALUES('9a8d97a5-ecd1-41cd-ae69-28c365eba4e7','228e258d-fa7e-4583-9a40-4ef6cf73a707','07d3585d251500aaf2789f6dc8e070e5ec4b44143edf4b9f85d545e095957f4d','marina:memory','["memory:read","memory:write","memory:share","memory:export"]',1767225684000,1769817683000,NULL);
INSERT INTO "principal_credentials"("credential_id","principal_id","token_hash","audience","scopes","issued_at","expires_at","revoked_at") VALUES('eacc7a42-7fcc-475f-a13c-1ed4196d7b41','fixture-account-alice','89177c2ddf1486081984369f241a4f739c6d7bcf4a3db20fec99dcf3a8630daf','marina:memory','["memory:read","memory:write","memory:share","memory:export"]',1767225721000,1769817720000,NULL);
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
INSERT INTO "memory_spaces"("id","owner_id","name","generation","status","created_at","retrieval_generation","metadata") VALUES('c68c231c-9dea-4a2a-b231-0d7d2458cc6f','228e258d-fa7e-4583-9a40-4ef6cf73a707','world-notes',2,'active',1767225687000,2,'{}');
INSERT INTO "memory_spaces"("id","owner_id","name","generation","status","created_at","retrieval_generation","metadata") VALUES('51726b2c-3417-4408-b712-ce17bea6c43b','fixture-account-alice','resident',2,'active',1767225724000,2,'{}');
CREATE TABLE memory_grants (
 space_id TEXT NOT NULL REFERENCES memory_spaces(id), principal_id TEXT NOT NULL REFERENCES principals(principal_id),
 role TEXT NOT NULL CHECK(role IN ('reader','writer')), PRIMARY KEY(space_id,principal_id)
);
CREATE TABLE memory_records (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 version INTEGER NOT NULL, current_note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
 subject TEXT, metadata TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
, valid_from INTEGER, valid_until INTEGER, stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)), stale_reason TEXT);
INSERT INTO "memory_records"("id","space_id","version","current_note_id","subject","metadata","status","created_at","valid_from","valid_until","stale","stale_reason") VALUES('0b5d9a75-6797-4152-9295-34dcbc7f59f6','c68c231c-9dea-4a2a-b231-0d7d2458cc6f',1,2,NULL,'{"legacy_note_id":1,"legacy_verification":"unverified","legacy_verification_confidence":0.5,"legacy_created_at":1767225680000,"note_type":"observation","tier":"fact","pool_id":"00000000-0000-4000-8000-000000000003","shared":true,"pool":"demo pulse"}','active',1767225693000,NULL,NULL,0,NULL);
INSERT INTO "memory_records"("id","space_id","version","current_note_id","subject","metadata","status","created_at","valid_from","valid_until","stale","stale_reason") VALUES('1ae378f4-4c1b-4702-9c23-c32ee1fed00f','51726b2c-3417-4408-b712-ce17bea6c43b',1,4,NULL,'{"legacy_note_id":3,"legacy_verification":"unverified","legacy_verification_confidence":0.5,"legacy_created_at":1767225718000,"note_type":"observation","tier":"fact"}','active',1767225730000,NULL,NULL,0,NULL);
CREATE TABLE memory_record_versions (
 record_id TEXT NOT NULL REFERENCES memory_records(id), version INTEGER NOT NULL,
 note_id INTEGER NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE, attributes TEXT, PRIMARY KEY(record_id,version)
);
INSERT INTO "memory_record_versions"("record_id","version","note_id","attributes") VALUES('0b5d9a75-6797-4152-9295-34dcbc7f59f6',1,2,'{"subject":null,"metadata":{"legacy_note_id":1,"legacy_verification":"unverified","legacy_verification_confidence":0.5,"legacy_created_at":1767225680000,"note_type":"observation","tier":"fact","pool_id":"00000000-0000-4000-8000-000000000003","shared":true,"pool":"demo pulse"},"source_ids":[],"depends_on":[],"dependency_versions":{},"claim":null,"valid_time":null,"vocabulary_version":0}');
INSERT INTO "memory_record_versions"("record_id","version","note_id","attributes") VALUES('1ae378f4-4c1b-4702-9c23-c32ee1fed00f',1,4,'{"subject":null,"metadata":{"legacy_note_id":3,"legacy_verification":"unverified","legacy_verification_confidence":0.5,"legacy_created_at":1767225718000,"note_type":"observation","tier":"fact"},"source_ids":[],"depends_on":[],"dependency_versions":{},"claim":null,"valid_time":null,"vocabulary_version":0}');
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
INSERT INTO "memory_requests"("principal_id","space_id","request_key","request_hash","response","created_at","acknowledged_at","retired_at") VALUES('228e258d-fa7e-4583-9a40-4ef6cf73a707','','world-notes:228e258d-fa7e-4583-9a40-4ef6cf73a707','defb187266e76a5faf8a7d66db16b8f36b5b8aef6cff19115d74a8c283849ac7','{"id":"c68c231c-9dea-4a2a-b231-0d7d2458cc6f","seq":1}',1767225689000,NULL,NULL);
INSERT INTO "memory_requests"("principal_id","space_id","request_key","request_hash","response","created_at","acknowledged_at","retired_at") VALUES('228e258d-fa7e-4583-9a40-4ef6cf73a707','c68c231c-9dea-4a2a-b231-0d7d2458cc6f','numeric:1:create','eee1922de10f29c7a1f7e2d10eded67fcf5f32556ede59bbca52b9208b419b43','{"id":"0b5d9a75-6797-4152-9295-34dcbc7f59f6","version":1,"seq":2}',1767225695000,NULL,NULL);
INSERT INTO "memory_requests"("principal_id","space_id","request_key","request_hash","response","created_at","acknowledged_at","retired_at") VALUES('fixture-account-alice','','resident:fixture-account-alice','aef6533334e7d489b53bffc03270aa4851915f77f98f0afedd8d3ae01e7e647f','{"id":"51726b2c-3417-4408-b712-ce17bea6c43b","seq":3}',1767225726000,NULL,NULL);
INSERT INTO "memory_requests"("principal_id","space_id","request_key","request_hash","response","created_at","acknowledged_at","retired_at") VALUES('fixture-account-alice','51726b2c-3417-4408-b712-ce17bea6c43b','numeric:3:create','26196fcdafb770814a0fb77887cf705fe7dc16e84634185277bdb44ab6fd237f','{"id":"1ae378f4-4c1b-4702-9c23-c32ee1fed00f","version":1,"seq":4}',1767225732000,NULL,NULL);
CREATE TABLE memory_service_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT NOT NULL REFERENCES memory_spaces(id),
 operation TEXT NOT NULL, reference_id TEXT, version INTEGER, actor_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
INSERT INTO "memory_service_events"("seq","space_id","operation","reference_id","version","actor_id","created_at") VALUES(1,'c68c231c-9dea-4a2a-b231-0d7d2458cc6f','space.created','c68c231c-9dea-4a2a-b231-0d7d2458cc6f',NULL,'228e258d-fa7e-4583-9a40-4ef6cf73a707',1767225688000);
INSERT INTO "memory_service_events"("seq","space_id","operation","reference_id","version","actor_id","created_at") VALUES(2,'c68c231c-9dea-4a2a-b231-0d7d2458cc6f','memory.created','0b5d9a75-6797-4152-9295-34dcbc7f59f6',1,'228e258d-fa7e-4583-9a40-4ef6cf73a707',1767225694000);
INSERT INTO "memory_service_events"("seq","space_id","operation","reference_id","version","actor_id","created_at") VALUES(3,'51726b2c-3417-4408-b712-ce17bea6c43b','space.created','51726b2c-3417-4408-b712-ce17bea6c43b',NULL,'fixture-account-alice',1767225725000);
INSERT INTO "memory_service_events"("seq","space_id","operation","reference_id","version","actor_id","created_at") VALUES(4,'51726b2c-3417-4408-b712-ce17bea6c43b','memory.created','1ae378f4-4c1b-4702-9c23-c32ee1fed00f',1,'fixture-account-alice',1767225731000);
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
INSERT INTO "memory_storage_usage"("space_id","logical_bytes","sources","revisions") VALUES('c68c231c-9dea-4a2a-b231-0d7d2458cc6f',1722,0,1);
INSERT INTO "memory_storage_usage"("space_id","logical_bytes","sources","revisions") VALUES('51726b2c-3417-4408-b712-ce17bea6c43b',1525,0,1);
CREATE TABLE memory_storage_items (
 kind TEXT NOT NULL, ref TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES memory_spaces(id) ON DELETE CASCADE,
 bytes INTEGER NOT NULL CHECK(bytes>=0), PRIMARY KEY(kind,ref)
);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('space','c68c231c-9dea-4a2a-b231-0d7d2458cc6f','c68c231c-9dea-4a2a-b231-0d7d2458cc6f',139);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('event','1','c68c231c-9dea-4a2a-b231-0d7d2458cc6f',177);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('receipt','["228e258d-fa7e-4583-9a40-4ef6cf73a707","","world-notes:228e258d-fa7e-4583-9a40-4ef6cf73a707"]','c68c231c-9dea-4a2a-b231-0d7d2458cc6f',293);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('revision','["0b5d9a75-6797-4152-9295-34dcbc7f59f6",1]','c68c231c-9dea-4a2a-b231-0d7d2458cc6f',662);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('event','2','c68c231c-9dea-4a2a-b231-0d7d2458cc6f',178);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('receipt','["228e258d-fa7e-4583-9a40-4ef6cf73a707","c68c231c-9dea-4a2a-b231-0d7d2458cc6f","numeric:1:create"]','c68c231c-9dea-4a2a-b231-0d7d2458cc6f',273);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('space','51726b2c-3417-4408-b712-ce17bea6c43b','51726b2c-3417-4408-b712-ce17bea6c43b',136);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('event','3','51726b2c-3417-4408-b712-ce17bea6c43b',177);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('receipt','["fixture-account-alice","","resident:fixture-account-alice"]','51726b2c-3417-4408-b712-ce17bea6c43b',275);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('revision','["1ae378f4-4c1b-4702-9c23-c32ee1fed00f",1]','51726b2c-3417-4408-b712-ce17bea6c43b',486);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('event','4','51726b2c-3417-4408-b712-ce17bea6c43b',178);
INSERT INTO "memory_storage_items"("kind","ref","space_id","bytes") VALUES('receipt','["fixture-account-alice","51726b2c-3417-4408-b712-ce17bea6c43b","numeric:3:create"]','51726b2c-3417-4408-b712-ce17bea6c43b',273);
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
, detail TEXT NOT NULL DEFAULT '{}');
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
CREATE TABLE memory_note_projections (
  note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE
, version INTEGER);
INSERT INTO "memory_note_projections"("note_id","record_id","version") VALUES(1,'0b5d9a75-6797-4152-9295-34dcbc7f59f6',NULL);
INSERT INTO "memory_note_projections"("note_id","record_id","version") VALUES(3,'1ae378f4-4c1b-4702-9c23-c32ee1fed00f',NULL);
CREATE TABLE "arena_shadow" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id TEXT NOT NULL,
  forecaster TEXT NOT NULL,
  forecast TEXT NOT NULL,
  detail TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
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
CREATE TABLE "markets" (
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
CREATE TABLE "market_positions" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES "markets"(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE "market_scores" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id TEXT NOT NULL REFERENCES "markets"(id) ON DELETE CASCADE,
  entity_name TEXT NOT NULL,
  brier_score REAL NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  scored_at INTEGER NOT NULL
);
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
  judge_verdict TEXT, answer_hash TEXT, budget_forced INTEGER CHECK (budget_forced IS NULL OR budget_forced IN (0, 1)), verification TEXT CHECK (verification IS NULL OR verification IN ('passed', 'failed', 'not_run')),
  UNIQUE (run_id, item_id)
);
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
CREATE TABLE submission_requests (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE TABLE "forecast_answers" (
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
, external_id TEXT, source TEXT, eval_mode TEXT
  CHECK (eval_mode IS NULL OR eval_mode IN ('live', 'measure')));
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
CREATE TABLE benchmark_run_validity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('invalidate', 'revalidate')),
  reason TEXT NOT NULL,
  actor TEXT,
  source TEXT NOT NULL CHECK (source IN ('in-world', 'operator', 'auto')),
  created_at INTEGER NOT NULL
);
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
CREATE TABLE "spend_daily" (
  day TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model_api', 'agent', 'decision', 'forecast', 'media', 'search')),
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, source)
);
CREATE TABLE "spend_scope_daily" (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model_api', 'agent', 'decision', 'forecast', 'media', 'search')),
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, scope, source)
);
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
CREATE TABLE benchmark_item_evidence (
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  evidence_id INTEGER NOT NULL REFERENCES benchmark_run_evidence(id),
  participants_json TEXT NOT NULL,
  PRIMARY KEY(run_id, item_id),
  FOREIGN KEY(run_id, item_id) REFERENCES benchmark_items(run_id, item_id)
);
CREATE TABLE benchmark_item_lessons (
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  use TEXT NOT NULL CHECK (use IN ('served', 'observed')),
  regime TEXT CHECK (regime IS NULL OR regime IN ('measure', 'live')),
  PRIMARY KEY (run_id, item_id, lesson_id),
  FOREIGN KEY (run_id, item_id) REFERENCES benchmark_items(run_id, item_id)
);
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
CREATE TABLE outcome_deliveries (
  outcome_id INTEGER NOT NULL REFERENCES outcomes(id),
  consumer TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (outcome_id, consumer)
);
CREATE TABLE decision_receipts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  subject TEXT NOT NULL,
  family TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE decision_outcomes (
  decision_id TEXT NOT NULL REFERENCES decision_receipts(id) ON DELETE CASCADE,
  outcome_id INTEGER NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, outcome_id)
);
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
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence"("name","seq") VALUES('market_positions',0);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('market_scores',0);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('forecast_answers',0);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('trait_history',19);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('role_history',15);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('board_posts',3);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('tasks',4);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('notes',4);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('memory_service_events',4);
INSERT INTO "sqlite_sequence"("name","seq") VALUES('channel_messages',1);
CREATE VIRTUAL TABLE board_posts_fts USING fts5(title, body, tags, content=board_posts, content_rowid=id);
INSERT INTO "board_posts_fts"("board_posts_fts") VALUES('rebuild');
CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title, description, content=tasks, content_rowid=id
);
INSERT INTO "tasks_fts"("tasks_fts") VALUES('rebuild');
CREATE VIRTUAL TABLE memory_source_fts USING fts5(text,content=memory_source_text,content_rowid=seq);
INSERT INTO "memory_source_fts"("memory_source_fts") VALUES('rebuild');
CREATE VIRTUAL TABLE notes_fts USING fts5(content, content=notes, content_rowid=id, tokenize='porter unicode61');
INSERT INTO "notes_fts"("notes_fts") VALUES('rebuild');
CREATE VIRTUAL TABLE markets_fts USING fts5(question, category, content=markets, content_rowid=seq);
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
CREATE INDEX idx_challenge_outcomes_class ON challenge_outcomes(class, id);
CREATE INDEX idx_markets_room ON markets(room_id);
CREATE INDEX idx_markets_status ON markets(status);
CREATE UNIQUE INDEX idx_positions_market_entity ON market_positions(market_id, entity_name);
CREATE INDEX idx_positions_entity ON market_positions(entity_name);
CREATE INDEX idx_scores_entity ON market_scores(entity_name);
CREATE INDEX idx_scores_market ON market_scores(market_id);
CREATE UNIQUE INDEX idx_benchmark_runs_content_hash ON benchmark_runs(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX idx_benchmark_items_item ON benchmark_items(item_id);
CREATE INDEX idx_benchmark_promotions_slot ON benchmark_promotions(slot, id);
CREATE INDEX idx_benchmark_runs_replicate_group ON benchmark_runs(replicate_group) WHERE replicate_group IS NOT NULL;
CREATE INDEX idx_submission_requests_pending ON submission_requests(status, created_at)
  WHERE status = 'pending';
CREATE INDEX idx_forecast_answers_open_sample ON forecast_answers(sample_id) WHERE resolved_at IS NULL;
CREATE INDEX idx_forecast_answers_entity ON forecast_answers(entity_name, created_at);
CREATE INDEX idx_external_submissions_batch ON external_submissions(benchmark, batch_ref);
CREATE INDEX idx_benchmark_run_validity_run ON benchmark_run_validity(run_id, id);
CREATE INDEX idx_benchmark_run_regroups_run ON benchmark_run_regroups(run_id, id);
CREATE INDEX idx_benchmark_items_answer ON benchmark_items(item_id, answer_hash) WHERE answer_hash IS NOT NULL;
CREATE INDEX idx_benchmark_item_lessons_lesson ON benchmark_item_lessons(lesson_id);
CREATE INDEX idx_upstream_default_seeds_slot ON upstream_default_seeds(slot, id);
CREATE INDEX idx_evidence_priors_cell ON evidence_priors(descriptor, family, id);
CREATE INDEX idx_upstream_events_artifact ON upstream_events(artifact_id, id);
CREATE UNIQUE INDEX idx_forecast_answers_external
  ON forecast_answers(entity_name, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_outcomes_kind ON outcomes(kind, resolved_at);
CREATE INDEX idx_outcome_deliveries_pending ON outcome_deliveries(consumer, state, outcome_id);
CREATE INDEX idx_decision_receipts_owner ON decision_receipts(owner, created_at);
CREATE INDEX idx_arena_attempts_round ON arena_attempts(entrant, round_id, id);
CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);
CREATE INDEX idx_schedule_runs_schedule ON schedule_runs(schedule_id, id);
CREATE INDEX idx_schedule_runs_started ON schedule_runs(started_at);
CREATE INDEX idx_challenge_holds_status ON challenge_holds(status, expires_at);
CREATE INDEX idx_challenge_holds_notice ON challenge_holds(requester_name)
  WHERE requester_notice IS NOT NULL;
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
CREATE VIEW numeric_notes AS
 SELECT n.id,n.entity_name,n.room_id,coalesce(c.content,n.content) AS content,n.created_at,
 coalesce(c.importance,n.importance) AS importance,n.last_accessed,n.note_type,n.pool_id,n.supersedes_id,
 n.recall_count,n.tier,n.confidence,n.verification_status,n.claim_key,
 coalesce(c.id,n.id) AS content_id
 FROM notes n LEFT JOIN memory_note_projections p ON p.note_id=n.id
 LEFT JOIN memory_records r ON r.id=p.record_id
 LEFT JOIN memory_record_versions v ON v.record_id=p.record_id AND v.version=p.version
 LEFT JOIN notes c ON c.id=CASE WHEN p.version IS NULL THEN r.current_note_id ELSE v.note_id END
 WHERE n.entity_name NOT LIKE 'memory:%' AND NOT EXISTS(SELECT 1 FROM memory_record_versions rv WHERE rv.note_id=n.id);
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
CREATE TRIGGER numeric_handle_no_body BEFORE UPDATE OF content ON notes
 WHEN NEW.content!='' AND EXISTS(SELECT 1 FROM memory_note_projections p WHERE p.note_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'Numeric handles cannot store record content'); END;
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
CREATE TRIGGER benchmark_items_no_update BEFORE UPDATE ON benchmark_items
BEGIN SELECT RAISE(ABORT, 'benchmark_items is append-only'); END;
CREATE TRIGGER benchmark_promotions_no_update BEFORE UPDATE ON benchmark_promotions
BEGIN SELECT RAISE(ABORT, 'benchmark_promotions is append-only'); END;
CREATE TRIGGER external_submissions_no_update BEFORE UPDATE ON external_submissions
BEGIN SELECT RAISE(ABORT, 'external_submissions is append-only'); END;
CREATE TRIGGER benchmark_run_validity_no_update BEFORE UPDATE ON benchmark_run_validity
BEGIN SELECT RAISE(ABORT, 'benchmark_run_validity is append-only'); END;
CREATE TRIGGER benchmark_run_regroups_no_update BEFORE UPDATE ON benchmark_run_regroups
BEGIN SELECT RAISE(ABORT, 'benchmark_run_regroups is append-only'); END;
CREATE TRIGGER benchmark_run_evidence_no_update BEFORE UPDATE ON benchmark_run_evidence
BEGIN SELECT RAISE(ABORT, 'benchmark_run_evidence is append-only'); END;
CREATE TRIGGER benchmark_item_evidence_no_update BEFORE UPDATE ON benchmark_item_evidence
BEGIN SELECT RAISE(ABORT, 'benchmark_item_evidence is append-only'); END;
CREATE TRIGGER benchmark_item_lessons_no_update BEFORE UPDATE ON benchmark_item_lessons
BEGIN SELECT RAISE(ABORT, 'benchmark_item_lessons is append-only'); END;
CREATE TRIGGER learned_artifacts_no_update BEFORE UPDATE ON learned_artifacts
BEGIN SELECT RAISE(ABORT, 'learned_artifacts is append-only'); END;
CREATE TRIGGER upstream_default_seeds_no_update BEFORE UPDATE ON upstream_default_seeds
BEGIN SELECT RAISE(ABORT, 'upstream_default_seeds is append-only'); END;
CREATE TRIGGER evidence_priors_no_update BEFORE UPDATE ON evidence_priors
BEGIN SELECT RAISE(ABORT, 'evidence_priors is append-only'); END;
CREATE TRIGGER upstream_events_no_update BEFORE UPDATE ON upstream_events
BEGIN SELECT RAISE(ABORT, 'upstream_events is append-only'); END;
CREATE TRIGGER outcomes_no_update BEFORE UPDATE ON outcomes
BEGIN SELECT RAISE(ABORT, 'outcomes is append-only'); END;
CREATE TRIGGER decision_receipts_no_update BEFORE UPDATE ON decision_receipts
BEGIN SELECT RAISE(ABORT, 'decision_receipts is append-only'); END;
CREATE TRIGGER arena_attempts_no_update BEFORE UPDATE ON arena_attempts
BEGIN SELECT RAISE(ABORT, 'arena_attempts is append-only'); END;
CREATE TRIGGER schedule_runs_no_update BEFORE UPDATE ON schedule_runs
BEGIN SELECT RAISE(ABORT, 'schedule_runs is append-only'); END;
COMMIT;
