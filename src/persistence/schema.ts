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
export { BASE_SCHEMA, type Migration as HistoricalMigration } from "./schema-history";

/** Append new versions after the baseline here. Do not rewrite the baseline or history. */
export interface Migration extends HistoricalMigration {
  apply?: (db: Database) => void;
}

/** Data conversions of migrations folded into the baseline, keyed by version.
 * They run with that version's SQL when an EXISTING database upgrades through
 * it, and once on an empty database when the baseline is generated (138 drops
 * the historical outbox; 143 finds no rows). */
const MIGRATION_HOOKS: Readonly<Partial<Record<number, (db: Database) => void>>> = {
  138: upgradeNumericMemory,
  143: hashMemApiKeySecrets,
};

export const FORWARD_MIGRATIONS: Migration[] = [
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
    apply: installMemoryKnownAt,
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
