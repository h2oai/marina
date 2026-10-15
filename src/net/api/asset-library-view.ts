// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The asset library's REST projection (`GET /api/assets?view=library`,
 * `GET /api/assets/:id`): per-viewer read checks on every row, keyset pages,
 * facet counts over the viewer's visible set, and per-item URLs a browser
 * element can load (plain, or signed for the viewer — asset-signing.ts).
 * Derivatives (thumbnails, posters, previews) are reached through their
 * parent and are exactly as readable as it is.
 */

import {
  type CanvasAccessHost,
  type CanvasReader,
  mayReadAsset,
  mayReadCanvas,
} from "../../engine/canvas-access";
import { parseProvenance } from "../../engine/media/asset-library";
import type { MarinaDB } from "../../persistence/database";
import {
  ASSET_ORIGINS,
  ASSET_TYPES,
  type AssetOrigin,
  type AssetQuery,
  type AssetRow,
  type AssetSort,
  type AssetType,
  assetCursor,
  assetTypeOf,
  isAssetOrigin,
} from "../../persistence/db-assets";
import type { StorageProvider } from "../../storage/provider";
import { maySignFor, signedAssetUrl } from "./asset-signing";

/** Rows read (before the per-viewer check) per page request. */
export const LIBRARY_SCAN_MAX = 2000;
/** Rows read for facet counts; past it `facets.truncated` is true. */
export const FACET_SCAN_MAX = 5000;
export const LIBRARY_PAGE_MAX = 200;

/** Who is looking: the principal string (for signing) and its canvas reader. */
export interface LibraryViewer {
  principal?: string;
  reader?: CanvasReader;
  /** The viewer's entity name (`owner=me`). */
  name?: string;
  /**
   * Owner names for a server-resolved scope (`owner=me+agents` → `owned`,
   * `scope=chat` → `chat`; src/net/media-scope.ts). Absent ⇒ the scope is empty.
   */
  scopeOwners?: (scope: "owned" | "chat") => string[];
}

export interface LibraryContext {
  db: MarinaDB;
  storage: StorageProvider;
  host: CanvasAccessHost;
  viewer: LibraryViewer;
}

/** A URL an `<img>`/`<video>` element can load, and when it stops working (null = never). */
export interface ViewerUrl {
  url: string;
  expiresAt: number | null;
}

/** Same rule as `POST /api/assets/sign`: plain when anyone may read it, else signed for the viewer. */
export function viewerUrl(ctx: LibraryContext, row: AssetRow): ViewerUrl {
  const plain = ctx.storage.resolve(row.storage_key);
  const principal = ctx.viewer.principal;
  const open =
    !plain.startsWith("/assets/") ||
    !maySignFor(principal) ||
    mayReadAsset(ctx.host, row, undefined, "asset library url", { log: false });
  return open ? { url: plain, expiresAt: null } : signedAssetUrl(plain, row.id, principal);
}

export interface LibraryThumb extends ViewerUrl {
  width: number | null;
  height: number | null;
}

/** One library item (list and detail share it). */
export interface LibraryItem {
  id: string;
  filename: string;
  mime: string;
  type: AssetType;
  size: number;
  owner: string;
  origin: AssetOrigin;
  createdAt: number;
  updatedAt: number;
  sha256: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  pages: number | null;
  caption: string | null;
  alt: string | null;
  tags: string[];
  provenance: ReturnType<typeof parseProvenance>;
  url: string;
  urlExpiresAt: number | null;
  /** Derivatives by kind: `thumbnail-256`, `thumbnail-1024`, `poster`, `preview`. */
  thumbs: Record<string, LibraryThumb>;
  /** Best small image for a grid cell: thumbnail-256, else poster/preview, else the image itself. */
  thumb: LibraryThumb | null;
  /** Tiny inline `data:` placeholder to show while `thumb` loads. */
  placeholder: string | null;
  /** `done` | `partial` | `unavailable` | `failed` | `none` | `skipped` | null (pending). */
  derivativeState: string | null;
  derivativeNote: string | null;
  derivedFrom: string | null;
}

/** Project rows (already read-checked) to items, with tags and derivatives in two queries. */
export function libraryItems(ctx: LibraryContext, rows: readonly AssetRow[]): LibraryItem[] {
  const ids = rows.map((r) => r.id);
  const tags = ctx.db.getAssetTagsFor(ids);
  const derivatives = new Map<string, (AssetRow & { kind: string })[]>();
  for (const d of ctx.db.listDerivatives(ids)) {
    const list = derivatives.get(d.derived_from as string) ?? [];
    list.push(d);
    derivatives.set(d.derived_from as string, list);
  }
  return rows.map((row) => {
    const url = viewerUrl(ctx, row);
    const thumbs: Record<string, LibraryThumb> = {};
    for (const d of derivatives.get(row.id) ?? []) {
      thumbs[d.kind] = { ...viewerUrl(ctx, d), width: d.width, height: d.height };
    }
    const selfThumb =
      assetTypeOf(row.mime_type) === "image" && row.mime_type !== "image/svg+xml"
        ? { ...url, width: row.width, height: row.height }
        : null;
    return {
      id: row.id,
      filename: row.filename,
      mime: row.mime_type,
      type: assetTypeOf(row.mime_type),
      size: row.size,
      owner: row.entity_name,
      origin: row.origin,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
      sha256: row.sha256 || null,
      width: row.width,
      height: row.height,
      durationMs: row.duration_ms,
      pages: row.pages,
      caption: row.caption,
      alt: row.alt,
      tags: tags.get(row.id) ?? [],
      provenance: parseProvenance(row),
      url: url.url,
      urlExpiresAt: url.expiresAt,
      thumbs,
      thumb:
        thumbs["thumbnail-256"] ??
        thumbs.poster ??
        thumbs.preview ??
        thumbs["thumbnail-1024"] ??
        selfThumb,
      placeholder: row.placeholder,
      derivativeState: row.derivative_state,
      derivativeNote: row.derivative_note,
      derivedFrom: row.derived_from,
    };
  });
}

// ─── Query parsing ───────────────────────────────────────────────────────────

const SORTS: readonly AssetSort[] = ["new", "old", "size", "name"];
const DURATION_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** `since` as epoch ms, ISO date, or a look-back window (`30m`, `12h`, `7d`, `2w`). */
export function parseSince(raw: string | null | undefined, now = Date.now()): number | undefined {
  if (!raw) return undefined;
  const window = /^(\d+)([mhdw])$/i.exec(raw.trim());
  if (window) return now - Number(window[1]) * (DURATION_MS[window[2]!.toLowerCase()] as number);
  if (/^\d{10,}$/.test(raw.trim())) return Number(raw.trim());
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

/** Library filters from URL search params; a string is a 400 reason. */
export function parseLibraryQuery(
  params: URLSearchParams,
  viewer: LibraryViewer,
): (AssetQuery & { empty?: boolean }) | string {
  const q: AssetQuery & { empty?: boolean } = {};
  const type = params.get("type");
  if (type) {
    if (!(ASSET_TYPES as readonly string[]).includes(type))
      return `type must be one of ${ASSET_TYPES.join(", ")}`;
    q.type = type as AssetType;
  }
  const owner = params.get("owner");
  const scope = params.get("scope");
  if (scope) {
    // A conversation's media: the viewer, its agents and the agents in its
    // room — resolved from the session, never from client-sent names.
    if (scope !== "chat") return "scope must be chat";
    const owners = viewer.scopeOwners?.("chat") ?? [];
    if (owners.length) q.owners = owners;
    else q.empty = true;
  } else if (owner === "me+agents") {
    const owners = viewer.scopeOwners?.("owned") ?? [];
    if (owners.length) q.owners = owners;
    else q.empty = true;
  } else if (owner && owner !== "all") {
    if (owner === "me") {
      if (viewer.name) q.owner = viewer.name;
      else q.empty = true;
    } else q.owner = owner;
  }
  const origin = params.get("origin");
  if (origin) {
    if (!isAssetOrigin(origin)) return `origin must be one of ${ASSET_ORIGINS.join(", ")}`;
    q.origin = origin;
  }
  const tags = params
    .getAll("tag")
    .flatMap((t) => t.split(","))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tags.length) q.tags = tags;
  const canvas = params.get("canvas");
  if (canvas) q.canvas = canvas;
  const sinceRaw = params.get("since");
  if (sinceRaw) {
    const since = parseSince(sinceRaw);
    if (since === undefined) return "since must be epoch ms, an ISO date, or a window like 7d";
    q.since = since;
  }
  const text = params.get("q");
  if (text?.trim()) q.text = text.trim();
  const sort = params.get("sort");
  if (sort) {
    if (!(SORTS as readonly string[]).includes(sort))
      return `sort must be one of ${SORTS.join(", ")}`;
    q.sort = sort as AssetSort;
  }
  const cursor = params.get("cursor");
  if (cursor) q.cursor = cursor;
  q.limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), LIBRARY_PAGE_MAX);
  return q;
}

// ─── Pages and facets ────────────────────────────────────────────────────────

const readable = (ctx: LibraryContext, row: AssetRow) =>
  mayReadAsset(ctx.host, row, ctx.viewer.reader, "asset library", { log: false });

/**
 * One page of rows the viewer may read, in sort order. Reads at most
 * {@link LIBRARY_SCAN_MAX} rows; `nextCursor` continues after the last row
 * considered (a page may be short when many rows were hidden).
 */
export function libraryPage(
  ctx: LibraryContext,
  q: AssetQuery,
): { rows: AssetRow[]; nextCursor: string | null } {
  const sort = q.sort ?? "new";
  const limit = q.limit ?? 50;
  const out: AssetRow[] = [];
  let cursor = q.cursor;
  let scanned = 0;
  while (scanned < LIBRARY_SCAN_MAX) {
    const batch = Math.min(Math.max(limit * 2, 50), LIBRARY_SCAN_MAX - scanned);
    const rows = ctx.db.queryAssets({ ...q, cursor, limit: batch });
    for (const row of rows) {
      scanned++;
      cursor = assetCursor(row, sort);
      if (readable(ctx, row)) out.push(row);
      if (out.length === limit) return { rows: out, nextCursor: cursor };
    }
    if (rows.length < batch) return { rows: out, nextCursor: null };
  }
  return { rows: out, nextCursor: cursor ?? null };
}

export interface LibraryFacets {
  type: Record<string, number>;
  origin: Record<string, number>;
  owner: Record<string, number>;
  tag: Record<string, number>;
  /** Visible assets counted. */
  total: number;
  /** True when more than {@link FACET_SCAN_MAX} rows matched (counts are partial). */
  truncated: boolean;
}

/**
 * Counts by type, origin, owner and tag over the assets the viewer may read
 * that match the scoping filters (`q`, `canvas`, `since`) — the facet
 * dimensions themselves are not applied, so each count says what choosing
 * that value would show.
 */
export function libraryFacets(ctx: LibraryContext, q: AssetQuery): LibraryFacets {
  const scope: AssetQuery = {
    ...(q.text ? { text: q.text } : {}),
    ...(q.canvas ? { canvas: q.canvas } : {}),
    ...(q.since !== undefined ? { since: q.since } : {}),
  };
  const facets: LibraryFacets = {
    type: {},
    origin: {},
    owner: {},
    tag: {},
    total: 0,
    truncated: false,
  };
  const visible: string[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  for (;;) {
    const rows = ctx.db.queryAssets({ ...scope, cursor, limit: 500 });
    for (const row of rows) {
      if (scanned >= FACET_SCAN_MAX) {
        facets.truncated = true;
        break;
      }
      scanned++;
      if (!readable(ctx, row)) continue;
      visible.push(row.id);
      facets.total++;
      const type = assetTypeOf(row.mime_type);
      facets.type[type] = (facets.type[type] ?? 0) + 1;
      facets.origin[row.origin] = (facets.origin[row.origin] ?? 0) + 1;
      facets.owner[row.entity_name] = (facets.owner[row.entity_name] ?? 0) + 1;
    }
    if (facets.truncated || rows.length < 500) break;
    cursor = assetCursor(rows[rows.length - 1] as AssetRow, "new");
  }
  for (let i = 0; i < visible.length; i += 500) {
    for (const tags of ctx.db.getAssetTagsFor(visible.slice(i, i + 500)).values()) {
      for (const tag of tags) facets.tag[tag] = (facets.tag[tag] ?? 0) + 1;
    }
  }
  return facets;
}

// ─── Detail ──────────────────────────────────────────────────────────────────

export interface LibraryDetail extends LibraryItem {
  metadata: Record<string, unknown>;
  parents: { id: string; kind: string; filename: string; mime: string }[];
  children: { id: string; kind: string; filename: string; mime: string }[];
  usedIn: { canvasId: string; name: string; nodes: number }[];
}

/** The detail view of one (already read-checked) asset: lineage and canvases, each read-checked. */
export function libraryDetail(ctx: LibraryContext, row: AssetRow): LibraryDetail {
  const [item] = libraryItems(ctx, [row]) as [LibraryItem];
  const links = ctx.db.getAssetLinks(row.id);
  const brief = (l: { kind: string; asset: AssetRow }) => ({
    id: l.asset.id,
    kind: l.kind,
    filename: l.asset.filename,
    mime: l.asset.mime_type,
  });
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    ...item,
    metadata,
    parents: links.parents.filter((l) => readable(ctx, l.asset)).map(brief),
    children: links.children.filter((l) => readable(ctx, l.asset)).map(brief),
    usedIn: ctx.db
      .listAssetCanvasUsage(row.id)
      .filter((c) => mayReadCanvas(c, ctx.viewer.reader))
      .map((c) => ({ canvasId: c.canvas_id, name: c.name, nodes: c.nodes })),
  };
}
