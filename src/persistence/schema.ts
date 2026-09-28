// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
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
];
export const SCHEMA_VERSION = FORWARD_MIGRATIONS.at(-1)?.version ?? SCHEMA_BASELINE_VERSION;

/** Full upgrade history; fresh databases use SCHEMA_BASELINE in one transaction. */
export const MIGRATIONS: Migration[] = [...HISTORICAL_MIGRATIONS, ...FORWARD_MIGRATIONS];
