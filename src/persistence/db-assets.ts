// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { buildFtsQuery, escapeLike } from "./fts";

// ─── Assets ────────────────────────────────────────────────────────────────

/** Where an asset came from (migration 168, `assets.origin`). */
export const ASSET_ORIGINS = ["upload", "generated", "request", "derived", "tool"] as const;
export type AssetOrigin = (typeof ASSET_ORIGINS)[number];

/** Coarse media classes the library filters and counts by (derived from `mime_type`). */
export const ASSET_TYPES = ["image", "video", "audio", "pdf", "document", "other"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** Generation / staging facts (`assets.provenance`, JSON). Never secrets. */
export interface AssetProvenance {
  prompt?: string;
  model?: string;
  provider?: string;
  costUsd?: number;
  jobId?: string;
  /** The request or tool that staged it, when not a person's upload. */
  source?: string;
}

export function isAssetOrigin(value: unknown): value is AssetOrigin {
  return typeof value === "string" && (ASSET_ORIGINS as readonly string[]).includes(value);
}

/** The library class of a MIME type. */
export function assetTypeOf(mime: string): AssetType {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/") || m === "application/json") return "document";
  return "other";
}

/** SQL predicate over `mime_type` for one library class (trusted constants only). */
function typePredicate(type: AssetType): string {
  switch (type) {
    case "image":
      return "a.mime_type LIKE 'image/%'";
    case "video":
      return "a.mime_type LIKE 'video/%'";
    case "audio":
      return "a.mime_type LIKE 'audio/%'";
    case "pdf":
      return "a.mime_type = 'application/pdf'";
    case "document":
      return "(a.mime_type LIKE 'text/%' OR a.mime_type = 'application/json')";
    default:
      return `NOT (a.mime_type LIKE 'image/%' OR a.mime_type LIKE 'video/%' OR a.mime_type LIKE 'audio/%'
                OR a.mime_type = 'application/pdf' OR a.mime_type LIKE 'text/%' OR a.mime_type = 'application/json')`;
  }
}

/** Provenance kept from legacy `metadata` fields when the writer did not pass one. */
function provenanceFromMetadata(meta: Record<string, unknown> | undefined): AssetProvenance {
  const out: AssetProvenance = {};
  if (!meta) return out;
  if (typeof meta.prompt === "string") out.prompt = meta.prompt;
  if (typeof meta.model === "string") out.model = meta.model;
  if (typeof meta.provider === "string") out.provider = meta.provider;
  if (typeof meta.jobId === "string") out.jobId = meta.jobId;
  if (typeof meta.costUsd === "number" && Number.isFinite(meta.costUsd)) out.costUsd = meta.costUsd;
  return out;
}

export interface CreateAssetInput {
  id: string;
  entityName: string;
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
  metadata?: Record<string, unknown>;
  /** Defaults to `metadata.origin` when that is a known origin, else `upload`. */
  origin?: AssetOrigin;
  /** Defaults to the prompt/model/provider found in `metadata`. */
  provenance?: AssetProvenance;
  sha256?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  pages?: number;
  /** The parent of a derivative (thumbnail, poster, preview): read check + cascade delete. */
  derivedFrom?: string;
}

export function createAsset(db: Database, asset: CreateAssetInput): void {
  const now = Date.now();
  const origin: AssetOrigin = asset.derivedFrom
    ? "derived"
    : (asset.origin ?? (isAssetOrigin(asset.metadata?.origin) ? asset.metadata.origin : "upload"));
  const provenance = asset.provenance ?? provenanceFromMetadata(asset.metadata);
  db.run(
    `INSERT INTO assets (id, entity_name, filename, mime_type, size, storage_key, metadata, created_at,
                         origin, provenance, sha256, width, height, duration_ms, pages, derived_from,
                         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      asset.id,
      asset.entityName,
      asset.filename,
      asset.mimeType,
      asset.size,
      asset.storageKey,
      JSON.stringify(asset.metadata ?? {}),
      now,
      origin,
      JSON.stringify(provenance),
      asset.sha256 ?? null,
      asset.width ?? null,
      asset.height ?? null,
      asset.durationMs ?? null,
      asset.pages ?? null,
      asset.derivedFrom ?? null,
      now,
    ],
  );
}

export function getAsset(db: Database, id: string): AssetRow | undefined {
  return (db.query("SELECT * FROM assets WHERE id = ?").get(id) as AssetRow | null) ?? undefined;
}

export function getAssetsByEntity(db: Database, entityName: string, limit = 50): AssetRow[] {
  return db
    .query(
      "SELECT * FROM assets WHERE entity_name = ? AND derived_from IS NULL ORDER BY created_at DESC LIMIT ?",
    )
    .all(entityName, limit) as AssetRow[];
}

/** Newest assets first (derivatives excluded — they are reached through their parent). */
export function listAssets(db: Database, opts?: { limit?: number; mime?: string }): AssetRow[] {
  if (opts?.mime) {
    return db
      .query(
        "SELECT * FROM assets WHERE mime_type LIKE ? AND derived_from IS NULL ORDER BY created_at DESC LIMIT ?",
      )
      .all(`${opts.mime}%`, opts?.limit ?? 50) as AssetRow[];
  }
  return db
    .query("SELECT * FROM assets WHERE derived_from IS NULL ORDER BY created_at DESC LIMIT ?")
    .all(opts?.limit ?? 50) as AssetRow[];
}

/** Assets of `origin` (column, or legacy `metadata.origin`), created before `before`, oldest first. */
export function listAssetsByOrigin(
  db: Database,
  origin: string,
  before: number,
  limit: number,
): AssetRow[] {
  return db
    .query(
      `SELECT * FROM assets WHERE created_at < ? AND derived_from IS NULL
          AND (origin = ? OR (json_valid(metadata) AND json_extract(metadata, '$.origin') = ?))
        ORDER BY created_at LIMIT ?`,
    )
    .all(before, origin, origin, limit) as AssetRow[];
}

/** Delete one asset row; its derivatives, tags and links go with it (FK cascade). */
export function deleteAsset(db: Database, id: string): boolean {
  const result = db.run("DELETE FROM assets WHERE id = ?", [id]);
  return result.changes > 0;
}

// ─── Facts, text, dedupe ──────────────────────────────────────────────────

/** Cheap facts recorded on write or by the backfill job. Undefined fields are left as they are. */
export interface AssetFacts {
  sha256?: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  pages?: number | null;
  placeholder?: string | null;
  derivativeState?: string | null;
  derivativeNote?: string | null;
}

const FACT_COLUMNS: Record<keyof AssetFacts, string> = {
  sha256: "sha256",
  width: "width",
  height: "height",
  durationMs: "duration_ms",
  pages: "pages",
  placeholder: "placeholder",
  derivativeState: "derivative_state",
  derivativeNote: "derivative_note",
};

export function updateAssetFacts(db: Database, id: string, facts: AssetFacts): boolean {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(FACT_COLUMNS) as [keyof AssetFacts, string][]) {
    const value = facts[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return false;
  values.push(id);
  return db.run(`UPDATE assets SET ${sets.join(", ")} WHERE id = ?`, values).changes > 0;
}

/** Set the reader-facing caption and/or alt text (`null` clears). Bumps `updated_at`. */
export function updateAssetText(
  db: Database,
  id: string,
  text: { caption?: string | null; alt?: string | null },
): boolean {
  const sets: string[] = ["updated_at = ?"];
  const values: (string | number | null)[] = [Date.now()];
  if (text.caption !== undefined) {
    sets.push("caption = ?");
    values.push(text.caption);
  }
  if (text.alt !== undefined) {
    sets.push("alt = ?");
    values.push(text.alt);
  }
  values.push(id);
  return db.run(`UPDATE assets SET ${sets.join(", ")} WHERE id = ?`, values).changes > 0;
}

/** The owner's existing asset of `origin` with the same content hash (upload dedupe). */
export function findAssetByHash(
  db: Database,
  entityName: string,
  sha256: string,
  origin: AssetOrigin,
): AssetRow | undefined {
  return (
    (db
      .query(
        `SELECT * FROM assets WHERE entity_name = ? AND sha256 = ? AND origin = ? AND derived_from IS NULL
          ORDER BY created_at LIMIT 1`,
      )
      .get(entityName, sha256, origin) as AssetRow | null) ?? undefined
  );
}

/** Assets still missing facts or derivatives (backfill), oldest first. Derivatives excluded. */
export function listAssetsNeedingFacts(db: Database, limit: number): AssetRow[] {
  return db
    .query(
      `SELECT * FROM assets WHERE derived_from IS NULL AND (sha256 IS NULL OR derivative_state IS NULL)
        ORDER BY created_at LIMIT ?`,
    )
    .all(limit) as AssetRow[];
}

// ─── Tags ─────────────────────────────────────────────────────────────────

/** Add and remove tags (already normalized by the caller). Returns the asset's tags after. */
export function setAssetTags(
  db: Database,
  id: string,
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const now = Date.now();
  db.transaction(() => {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO asset_tags (asset_id, tag, created_at) VALUES (?, ?, ?)",
    );
    const del = db.prepare("DELETE FROM asset_tags WHERE asset_id = ? AND tag = ?");
    for (const tag of remove) del.run(id, tag);
    for (const tag of add) ins.run(id, tag, now);
    db.run("UPDATE assets SET updated_at = ? WHERE id = ?", [now, id]);
  })();
  return getAssetTags(db, id);
}

export function getAssetTags(db: Database, id: string): string[] {
  return (
    db.query("SELECT tag FROM asset_tags WHERE asset_id = ? ORDER BY tag").all(id) as {
      tag: string;
    }[]
  ).map((r) => r.tag);
}

/** Tags for many assets in one query. */
export function getAssetTagsFor(db: Database, ids: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = db
    .query(
      `SELECT asset_id, tag FROM asset_tags WHERE asset_id IN (${ids.map(() => "?").join(",")})
        ORDER BY tag`,
    )
    .all(...ids) as { asset_id: string; tag: string }[];
  for (const r of rows) {
    const list = out.get(r.asset_id) ?? [];
    list.push(r.tag);
    out.set(r.asset_id, list);
  }
  return out;
}

// ─── Links (lineage + derivatives) ────────────────────────────────────────

/** Record that `fromId` was made from `toId` (`kind`: thumbnail-256, poster, edit, variation, …). */
export function linkAssets(db: Database, fromId: string, toId: string, kind: string): void {
  db.run(
    "INSERT OR IGNORE INTO asset_links (from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)",
    [fromId, toId, kind, Date.now()],
  );
}

/** One edge of an asset's lineage with the other end's row. */
export interface AssetLinkRow {
  from_id: string;
  to_id: string;
  kind: string;
  created_at: number;
  /** The OTHER end of the link. */
  asset: AssetRow;
}

/** Parents (`from_id = id`) and children (`to_id = id`) of an asset. */
export function getAssetLinks(
  db: Database,
  id: string,
): { parents: AssetLinkRow[]; children: AssetLinkRow[] } {
  const map = (
    rows: (AssetRow & { l_from: string; l_to: string; l_kind: string; l_at: number })[],
  ) =>
    rows.map(({ l_from, l_to, l_kind, l_at, ...asset }) => ({
      from_id: l_from,
      to_id: l_to,
      kind: l_kind,
      created_at: l_at,
      asset: asset as AssetRow,
    }));
  const parents = db
    .query(
      `SELECT a.*, l.from_id AS l_from, l.to_id AS l_to, l.kind AS l_kind, l.created_at AS l_at
         FROM asset_links l JOIN assets a ON a.id = l.to_id WHERE l.from_id = ? ORDER BY l.created_at`,
    )
    .all(id) as never[];
  const children = db
    .query(
      `SELECT a.*, l.from_id AS l_from, l.to_id AS l_to, l.kind AS l_kind, l.created_at AS l_at
         FROM asset_links l JOIN assets a ON a.id = l.from_id WHERE l.to_id = ? ORDER BY l.created_at`,
    )
    .all(id) as never[];
  return { parents: map(parents), children: map(children) };
}

/** Derivatives (rows with `derived_from` in `ids`) with their link kind, for many parents at once. */
export function listDerivatives(
  db: Database,
  ids: readonly string[],
): (AssetRow & { kind: string })[] {
  if (ids.length === 0) return [];
  return db
    .query(
      `SELECT a.*, coalesce(l.kind, 'derived') AS kind
         FROM assets a LEFT JOIN asset_links l ON l.from_id = a.id AND l.to_id = a.derived_from
        WHERE a.derived_from IN (${ids.map(() => "?").join(",")})
        ORDER BY a.created_at`,
    )
    .all(...ids) as (AssetRow & { kind: string })[];
}

/** Canvases whose nodes show the asset (name + scope, for the read-checked "used in"). */
export function listAssetCanvasUsage(
  db: Database,
  id: string,
): { canvas_id: string; name: string; scope: string; scope_id: string | null; nodes: number }[] {
  return db
    .query(
      `SELECT c.id AS canvas_id, c.name AS name, c.scope AS scope, c.scope_id AS scope_id,
              COUNT(*) AS nodes
         FROM canvas_nodes n JOIN canvases c ON c.id = n.canvas_id
        WHERE n.asset_id = ? GROUP BY c.id ORDER BY c.name`,
    )
    .all(id) as never[];
}

// ─── Library query ────────────────────────────────────────────────────────

export type AssetSort = "new" | "old" | "size" | "name";

/** Filters shared by the `asset` command and `GET /api/assets?view=library`. */
export interface AssetQuery {
  type?: AssetType;
  /** Exact owner name (case-insensitive). */
  owner?: string;
  origin?: AssetOrigin;
  /** Every listed tag must be present. */
  tags?: readonly string[];
  /** Canvas id or name the asset is shown on. */
  canvas?: string;
  /** Created at or after (epoch ms). */
  since?: number;
  /** Full-text query over filename, caption, alt, prompt and tags. */
  text?: string;
  /** Include derivatives (thumbnails etc.); default false, implied by `origin: derived`. */
  includeDerived?: boolean;
  sort?: AssetSort;
  /** Keyset cursor from a previous page (opaque to callers). */
  cursor?: string;
  limit?: number;
}

const SORTS: Record<AssetSort, { key: string; dir: "ASC" | "DESC" }> = {
  new: { key: "a.created_at", dir: "DESC" },
  old: { key: "a.created_at", dir: "ASC" },
  size: { key: "a.size", dir: "DESC" },
  name: { key: "a.filename COLLATE NOCASE", dir: "ASC" },
};

function sortValue(row: AssetRow, sort: AssetSort): string | number {
  if (sort === "size") return row.size;
  if (sort === "name") return row.filename;
  return row.created_at;
}

/** Opaque keyset cursor: the sort value and id of the last row returned. */
export function assetCursor(row: AssetRow, sort: AssetSort): string {
  return Buffer.from(JSON.stringify([sort, sortValue(row, sort), row.id])).toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  sort: AssetSort,
): { value: string | number; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed[0] !== sort || typeof parsed[2] !== "string") return;
    const value = parsed[1];
    if (typeof value !== "string" && typeof value !== "number") return;
    return { value, id: parsed[2] };
  } catch {
    return undefined;
  }
}

/** WHERE clause + params for a query (no sort/cursor), over alias `a`. */
function whereFor(q: AssetQuery): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (!(q.includeDerived || q.origin === "derived")) where.push("a.derived_from IS NULL");
  if (q.type) where.push(typePredicate(q.type));
  if (q.owner) {
    where.push("a.entity_name = ? COLLATE NOCASE");
    params.push(q.owner);
  }
  if (q.origin) {
    where.push("a.origin = ?");
    params.push(q.origin);
  }
  for (const tag of q.tags ?? []) {
    where.push("EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag = ?)");
    params.push(tag);
  }
  if (q.canvas) {
    where.push(
      `EXISTS (SELECT 1 FROM canvas_nodes n JOIN canvases c ON c.id = n.canvas_id
                WHERE n.asset_id = a.id AND (c.id = ? OR c.name = ?))`,
    );
    params.push(q.canvas, q.canvas);
  }
  if (q.since !== undefined) {
    where.push("a.created_at >= ?");
    params.push(q.since);
  }
  if (q.text !== undefined) {
    const match = buildFtsQuery(q.text, "and");
    if (match) {
      where.push("a.id IN (SELECT asset_id FROM assets_fts WHERE assets_fts MATCH ?)");
      params.push(match);
    } else {
      // No word characters: a plain substring over the filename.
      where.push("a.filename LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(q.text)}%`);
    }
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/**
 * One page of rows matching `q` in sort order, starting after `q.cursor`.
 * Rows are NOT read-checked here — the caller filters per viewer and pages on.
 */
export function queryAssets(db: Database, q: AssetQuery): AssetRow[] {
  const sort = q.sort ?? "new";
  const { key, dir } = SORTS[sort];
  const { sql, params } = whereFor(q);
  const clauses = sql ? [sql.slice("WHERE ".length)] : [];
  const after = decodeCursor(q.cursor, sort);
  if (after) {
    const op = dir === "DESC" ? "<" : ">";
    clauses.push(`(${key} ${op} ? OR (${key} = ? AND a.id ${op} ?))`);
    params.push(after.value, after.value, after.id);
  }
  const limit = Math.max(1, Math.min(q.limit ?? 50, 1000));
  return db
    .query(
      `SELECT a.* FROM assets a ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY ${key} ${dir}, a.id ${dir} LIMIT ?`,
    )
    .all(...params, limit) as AssetRow[];
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface AssetRow {
  id: string;
  entity_name: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_key: string;
  metadata: string;
  created_at: number;
  /** Migration 168 — see {@link ASSET_ORIGINS}. */
  origin: AssetOrigin;
  sha256: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  pages: number | null;
  alt: string | null;
  caption: string | null;
  /** JSON {@link AssetProvenance}. */
  provenance: string;
  /** The parent of a derivative; the derivative inherits its read check. */
  derived_from: string | null;
  /** A tiny `data:image/webp;base64,…` placeholder, when one could be made. */
  placeholder: string | null;
  /** `done` | `partial` | `unavailable` | `failed` | `none`; null = not attempted yet. */
  derivative_state: string | null;
  derivative_note: string | null;
  updated_at: number;
}
