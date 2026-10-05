// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Imported `marina.learned.v1` bundles (migration 161, `src/learned/`).
 *
 * - `learned_artifacts`: one append-only row per imported artifact version
 *   (the downgrade check reads the highest generation).
 * - `learned_items`: the current state of each imported item — its local
 *   record, status and the local outcome that confirmed it.
 * - `upstream_default_seeds`: append-only; the latest row per slot is the
 *   upstream seed (`src/learned/upstream-seed.ts`). Never `benchmark_defaults`.
 * - `evidence_priors`: append-only, down-weighted pseudo-counts. Never ledger rows.
 * - `upstream_events`: append-only audit of every verify, import and item action.
 *
 * Read-only queries for the export side (lesson, convention and ledger
 * aggregates) live here too, so the facade stays free of inline SQL.
 */

import type { Database } from "bun:sqlite";

export interface LearnedArtifactRow {
  artifact_id: string;
  generation: number;
  version: string;
  manifest_digest: string;
  publisher_key_id: string;
  license: string;
  access_model: string;
  manifest_json: string;
  actor: string | null;
  imported_at: number;
}

export type LearnedItemStatus = "active" | "retired" | "revoked";

export interface LearnedItemRow {
  artifact_id: string;
  item_key: string;
  kind: string;
  content_hash: string;
  generation: number;
  local_ref: string | null;
  status: LearnedItemStatus;
  confirmed_by: string | null;
  updated_at: number;
}

export interface UpstreamDefaultSeedRow {
  id: number;
  slot: string;
  value_json: string;
  evidence_json: string | null;
  artifact_id: string;
  version: string;
  generation: number;
  item_key: string;
  created_at: number;
}

export interface EvidencePriorRow {
  id: number;
  artifact_id: string;
  version: string;
  generation: number;
  item_key: string;
  descriptor: string;
  family: string;
  benchmark: string | null;
  n: number;
  successes: number;
  weight: number;
  prior_n: number;
  prior_successes: number;
  created_at: number;
}

export type UpstreamEventOutcome = "ok" | "refused" | "dropped" | "skipped";

export interface UpstreamEventRow {
  id: number;
  action: string;
  outcome: UpstreamEventOutcome;
  artifact_id: string | null;
  version: string | null;
  generation: number | null;
  item_key: string | null;
  detail_json: string | null;
  actor: string | null;
  created_at: number;
}

export interface UpstreamEventInput {
  action: string;
  outcome: UpstreamEventOutcome;
  artifactId?: string | null;
  version?: string | null;
  generation?: number | null;
  itemKey?: string | null;
  detail?: Record<string, unknown> | null;
  actor?: string | null;
}

/** A canonical record in a named space, for the export allow-list readers. */
export interface LearnedSourceRecord {
  id: string;
  space: string;
  content: string;
  metadata: string;
  valid_from: number | null;
  created_at: number;
}

/** One ledger cell before the k-anonymity cut: completed runs × their items. */
export interface LedgerCellRow {
  benchmark: string;
  target_kind: string | null;
  target_json: string | null;
  n: number;
  successes: number;
  runs: number;
  replicate_groups: number;
  cost_items: number;
  cost_usd: number | null;
}

export function recordLearnedArtifact(
  db: Database,
  row: Omit<LearnedArtifactRow, "imported_at"> & { imported_at?: number },
): void {
  db.run(
    `INSERT INTO learned_artifacts (artifact_id, generation, version, manifest_digest,
       publisher_key_id, license, access_model, manifest_json, actor, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.artifact_id,
      row.generation,
      row.version,
      row.manifest_digest,
      row.publisher_key_id,
      row.license,
      row.access_model,
      row.manifest_json,
      row.actor,
      row.imported_at ?? Date.now(),
    ],
  );
}

export function latestLearnedArtifact(
  reader: Database,
  artifactId: string,
): LearnedArtifactRow | undefined {
  return (reader
    .query("SELECT * FROM learned_artifacts WHERE artifact_id = ? ORDER BY generation DESC LIMIT 1")
    .get(artifactId) ?? undefined) as LearnedArtifactRow | undefined;
}

export function listLearnedArtifacts(reader: Database): LearnedArtifactRow[] {
  return reader
    .query(
      "SELECT * FROM learned_artifacts ORDER BY imported_at DESC, artifact_id, generation DESC",
    )
    .all() as LearnedArtifactRow[];
}

export function upsertLearnedItem(
  db: Database,
  row: Omit<LearnedItemRow, "updated_at" | "confirmed_by"> & { updated_at?: number },
): void {
  db.run(
    `INSERT INTO learned_items (artifact_id, item_key, kind, content_hash, generation, local_ref,
       status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artifact_id, item_key) DO UPDATE SET kind = excluded.kind,
       content_hash = excluded.content_hash, generation = excluded.generation,
       local_ref = excluded.local_ref, status = excluded.status, updated_at = excluded.updated_at,
       confirmed_by = CASE WHEN learned_items.content_hash = excluded.content_hash
         THEN learned_items.confirmed_by ELSE NULL END`,
    [
      row.artifact_id,
      row.item_key,
      row.kind,
      row.content_hash,
      row.generation,
      row.local_ref,
      row.status,
      row.updated_at ?? Date.now(),
    ],
  );
}

export function setLearnedItemStatus(
  db: Database,
  artifactId: string,
  itemKey: string,
  status: LearnedItemStatus,
): void {
  db.run(
    "UPDATE learned_items SET status = ?, updated_at = ? WHERE artifact_id = ? AND item_key = ?",
    [status, Date.now(), artifactId, itemKey],
  );
}

export function confirmLearnedItem(
  db: Database,
  artifactId: string,
  itemKey: string,
  confirmedBy: string,
): boolean {
  const res = db.run(
    `UPDATE learned_items SET confirmed_by = ?, updated_at = ?
     WHERE artifact_id = ? AND item_key = ? AND status = 'active'`,
    [confirmedBy, Date.now(), artifactId, itemKey],
  );
  return res.changes > 0;
}

export function getLearnedItem(
  reader: Database,
  artifactId: string,
  itemKey: string,
): LearnedItemRow | undefined {
  return (reader
    .query("SELECT * FROM learned_items WHERE artifact_id = ? AND item_key = ?")
    .get(artifactId, itemKey) ?? undefined) as LearnedItemRow | undefined;
}

export function listLearnedItems(
  reader: Database,
  opts: { artifactId?: string; status?: LearnedItemStatus; limit?: number } = {},
): LearnedItemRow[] {
  return reader
    .query(
      `SELECT * FROM learned_items WHERE (?1 IS NULL OR artifact_id = ?1)
         AND (?2 IS NULL OR status = ?2) ORDER BY artifact_id, kind, item_key LIMIT ?3`,
    )
    .all(opts.artifactId ?? null, opts.status ?? null, opts.limit ?? 10_000) as LearnedItemRow[];
}

export function recordUpstreamDefaultSeed(
  db: Database,
  row: Omit<UpstreamDefaultSeedRow, "id" | "created_at"> & { created_at?: number },
): number {
  const res = db.run(
    `INSERT INTO upstream_default_seeds (slot, value_json, evidence_json, artifact_id, version,
       generation, item_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.slot,
      row.value_json,
      row.evidence_json,
      row.artifact_id,
      row.version,
      row.generation,
      row.item_key,
      row.created_at ?? Date.now(),
    ],
  );
  return Number(res.lastInsertRowid);
}

export function latestUpstreamDefaultSeed(
  reader: Database,
  slot: string,
): UpstreamDefaultSeedRow | undefined {
  return (reader
    .query(
      `SELECT s.* FROM upstream_default_seeds s
       JOIN learned_items li ON li.artifact_id = s.artifact_id AND li.item_key = s.item_key
       WHERE s.slot = ? AND li.status = 'active' ORDER BY s.id DESC LIMIT 1`,
    )
    .get(slot) ?? undefined) as UpstreamDefaultSeedRow | undefined;
}

export function listUpstreamDefaultSeeds(reader: Database): UpstreamDefaultSeedRow[] {
  return reader
    .query(
      `SELECT s.* FROM upstream_default_seeds s
       WHERE s.id = (SELECT max(t.id) FROM upstream_default_seeds t
                     JOIN learned_items li ON li.artifact_id = t.artifact_id
                       AND li.item_key = t.item_key AND li.status = 'active'
                     WHERE t.slot = s.slot)
       ORDER BY s.slot`,
    )
    .all() as UpstreamDefaultSeedRow[];
}

export function recordEvidencePrior(
  db: Database,
  row: Omit<EvidencePriorRow, "id" | "created_at"> & { created_at?: number },
): number {
  const res = db.run(
    `INSERT INTO evidence_priors (artifact_id, version, generation, item_key, descriptor, family,
       benchmark, n, successes, weight, prior_n, prior_successes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.artifact_id,
      row.version,
      row.generation,
      row.item_key,
      row.descriptor,
      row.family,
      row.benchmark,
      row.n,
      row.successes,
      row.weight,
      row.prior_n,
      row.prior_successes,
      row.created_at ?? Date.now(),
    ],
  );
  return Number(res.lastInsertRowid);
}

/**
 * The latest prior per (artifact, item) whose imported item is still active —
 * what an observe-mode reader would use.
 */
export function listEvidencePriors(
  reader: Database,
  opts: { family?: string; limit?: number } = {},
): EvidencePriorRow[] {
  return reader
    .query(
      `SELECT p.* FROM evidence_priors p
       WHERE p.id = (SELECT max(id) FROM evidence_priors q
                     WHERE q.artifact_id = p.artifact_id AND q.item_key = p.item_key)
         AND EXISTS (SELECT 1 FROM learned_items li WHERE li.artifact_id = p.artifact_id
                     AND li.item_key = p.item_key AND li.status = 'active')
         AND (?1 IS NULL OR p.family = ?1)
       ORDER BY p.family, p.descriptor LIMIT ?2`,
    )
    .all(opts.family ?? null, opts.limit ?? 10_000) as EvidencePriorRow[];
}

export function recordUpstreamEvent(db: Database, event: UpstreamEventInput): number {
  const res = db.run(
    `INSERT INTO upstream_events (action, outcome, artifact_id, version, generation, item_key,
       detail_json, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.action,
      event.outcome,
      event.artifactId ?? null,
      event.version ?? null,
      event.generation ?? null,
      event.itemKey ?? null,
      event.detail ? JSON.stringify(event.detail) : null,
      event.actor ?? null,
      Date.now(),
    ],
  );
  return Number(res.lastInsertRowid);
}

export function listUpstreamEvents(
  reader: Database,
  opts: { artifactId?: string; limit?: number } = {},
): UpstreamEventRow[] {
  return reader
    .query(
      `SELECT * FROM upstream_events WHERE (?1 IS NULL OR artifact_id = ?1)
       ORDER BY id DESC LIMIT ?2`,
    )
    .all(opts.artifactId ?? null, opts.limit ?? 50) as UpstreamEventRow[];
}

// ─── Export allow-list readers (read-only) ──────────────────────────────────

/**
 * Current records in the spaces OWNED by the named account whose space name
 * starts with `prefix` — e.g. the lessons account's `lessons:*` spaces. A
 * record whose validity ended (a retired lesson) is excluded. Content is the
 * record's current canonical version.
 */
export function listOwnedSpaceRecords(
  reader: Database,
  ownerName: string,
  prefix: string,
  now = Date.now(),
): LearnedSourceRecord[] {
  return reader
    .query(
      `SELECT r.id AS id, s.name AS space, n.content AS content, r.metadata AS metadata,
              r.valid_from AS valid_from, r.created_at AS created_at
       FROM memory_records r
       JOIN memory_spaces s ON s.id = r.space_id
       JOIN users u ON u.id = s.owner_id
       JOIN notes n ON n.id = r.current_note_id
       WHERE u.name = ?1 AND s.status = 'active'
         AND substr(s.name, 1, length(?2)) = ?2
         AND r.status = 'active' AND (r.valid_until IS NULL OR r.valid_until > ?3)
       ORDER BY s.name, r.created_at, r.id`,
    )
    .all(ownerName, prefix, now) as LearnedSourceRecord[];
}

/** Current records in institutional spaces that carry `ratified_by`. */
export function listRatifiedInstitutionalRecords(
  reader: Database,
  now = Date.now(),
): LearnedSourceRecord[] {
  return reader
    .query(
      `SELECT r.id AS id, s.name AS space, n.content AS content, r.metadata AS metadata,
              r.valid_from AS valid_from, r.created_at AS created_at
       FROM memory_records r
       JOIN memory_spaces s ON s.id = r.space_id
       JOIN notes n ON n.id = r.current_note_id
       WHERE s.status = 'active' AND json_extract(s.metadata, '$.institutional') = 1
         AND r.status = 'active' AND (r.valid_until IS NULL OR r.valid_until > ?1)
         AND json_extract(r.metadata, '$.ratified_by') IS NOT NULL
       ORDER BY s.name, r.created_at, r.id`,
    )
    .all(now) as LearnedSourceRecord[];
}

/**
 * Ledger cells (benchmark × target) over completed runs: item counts and
 * successes only — never item ids, answers or run ids. The k-anonymity cut
 * is the caller's (`src/learned/export.ts`).
 */
export function listLedgerCells(reader: Database): LedgerCellRow[] {
  return reader
    .query(
      `SELECT r.benchmark AS benchmark, r.target_kind AS target_kind, r.target_json AS target_json,
              count(i.id) AS n, coalesce(sum(i.correct), 0) AS successes,
              count(DISTINCT r.id) AS runs,
              count(DISTINCT coalesce(r.replicate_group, r.config_hash)) AS replicate_groups,
              count(i.cost_usd) AS cost_items, sum(i.cost_usd) AS cost_usd
       FROM benchmark_runs r JOIN benchmark_items i ON i.run_id = r.id
       WHERE r.status = 'completed'
       GROUP BY r.benchmark, r.target_kind, r.target_json
       ORDER BY r.benchmark, r.target_kind, r.target_json`,
    )
    .all() as LedgerCellRow[];
}
