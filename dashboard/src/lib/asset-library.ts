// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Client contract for the asset library (`GET /api/assets?view=library`,
 * `GET|PATCH|DELETE /api/assets/:id`) and the react-query hooks the viewer,
 * the Library panel and the bulk actions share. Every key starts with
 * `["assets", …]` so the `asset_created|asset_updated|asset_deleted`
 * invalidation (use-realtime-invalidations.ts) rereads them under the
 * viewer's own credential; events never carry content.
 */

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { authFetch } from "./api";
import { apiOrigin } from "./api-origin";
import { stripSignature } from "./asset-url";

export const ASSET_TYPES = ["image", "video", "audio", "pdf", "document", "other"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const ASSET_SORTS = ["new", "old", "size", "name"] as const;
export type AssetSort = (typeof ASSET_SORTS)[number];

export interface LibraryThumb {
  url: string;
  /** Unix seconds; null = no expiry (a plain URL). */
  expiresAt: number | null;
  width: number | null;
  height: number | null;
}

export interface AssetProvenance {
  prompt?: string;
  model?: string;
  provider?: string;
  costUsd?: number;
  jobId?: string;
  source?: string;
}

export interface LibraryItem {
  id: string;
  filename: string;
  mime: string;
  type: AssetType;
  size: number;
  owner: string;
  origin: string;
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
  provenance: AssetProvenance | null;
  url: string;
  urlExpiresAt: number | null;
  thumbs: Partial<Record<"thumbnail-256" | "thumbnail-1024" | "poster" | "preview", LibraryThumb>>;
  thumb: LibraryThumb | null;
  placeholder: string | null;
  derivativeState: string | null;
  derivativeNote: string | null;
  derivedFrom: string | null;
}

export interface AssetLink {
  id: string;
  kind: string;
  filename: string;
  mime: string;
}

export interface LibraryDetail extends LibraryItem {
  metadata?: Record<string, unknown>;
  parents: AssetLink[];
  children: AssetLink[];
  usedIn: { canvasId: string; name: string; nodes: number }[];
}

export interface LibraryFacets {
  type: Record<string, number>;
  origin: Record<string, number>;
  owner: Record<string, number>;
  tag: Record<string, number>;
  total: number;
  truncated: boolean;
}

export interface LibraryPage {
  items: LibraryItem[];
  nextCursor: string | null;
  facets?: LibraryFacets;
}

export interface LibraryFilters {
  type?: AssetType;
  /** `me`, an entity name, or undefined/`all` for everyone visible. */
  owner?: string;
  origin?: string;
  tags?: string[];
  q?: string;
  sort?: AssetSort;
  /** Look-back window (`1d`, `7d`, `30d`) or epoch ms / ISO. */
  since?: string;
  canvas?: string;
}

/** Library page size. */
export const LIBRARY_PAGE_SIZE = 60;

/** Query string for one library page (stable order, empty filters omitted). */
export function libraryQueryString(
  filters: LibraryFilters,
  opts: { cursor?: string | null; facets?: boolean; limit?: number } = {},
): string {
  const p = new URLSearchParams({ view: "library" });
  if (filters.type) p.set("type", filters.type);
  if (filters.owner && filters.owner !== "all") p.set("owner", filters.owner);
  if (filters.origin) p.set("origin", filters.origin);
  for (const tag of filters.tags ?? []) if (tag.trim()) p.append("tag", tag.trim());
  if (filters.canvas) p.set("canvas", filters.canvas);
  if (filters.since) p.set("since", filters.since);
  if (filters.q?.trim()) p.set("q", filters.q.trim());
  if (filters.sort && filters.sort !== "new") p.set("sort", filters.sort);
  p.set("limit", String(opts.limit ?? LIBRARY_PAGE_SIZE));
  if (opts.cursor) p.set("cursor", opts.cursor);
  if (opts.facets) p.set("facets", "1");
  return p.toString();
}

/** An API failure carrying the server's `error` text and status. */
export class AssetApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<AssetApiError> {
  let message = `Request failed (${res.status})`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (body.error) message = body.error;
    code = body.code;
  } catch {
    // Not JSON — keep the status line.
  }
  if (res.status === 401) message = "Sign in to manage assets.";
  else if (res.status === 403 && !code) message = "Only the owner or an operator can change this.";
  return new AssetApiError(message, res.status, code);
}

export async function fetchLibraryPage(
  filters: LibraryFilters,
  cursor?: string | null,
  facets = false,
  limit?: number,
): Promise<LibraryPage> {
  const res = await authFetch(
    `${apiOrigin()}/api/assets?${libraryQueryString(filters, { cursor, facets, limit })}`,
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as LibraryPage;
}

export async function fetchAssetDetail(id: string): Promise<LibraryDetail> {
  const res = await authFetch(`${apiOrigin()}/api/assets/${encodeURIComponent(id)}`);
  if (!res.ok) throw await readError(res);
  return (await res.json()) as LibraryDetail;
}

export interface AssetPatch {
  caption?: string | null;
  alt?: string | null;
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
}

export async function patchAsset(id: string, patch: AssetPatch): Promise<LibraryDetail> {
  const res = await authFetch(`${apiOrigin()}/api/assets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as LibraryDetail;
}

export async function deleteAsset(id: string): Promise<void> {
  const res = await authFetch(`${apiOrigin()}/api/assets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await readError(res);
}

/** Canvas node type for a MIME type (the canvas drop's mapping). */
export function canvasNodeTypeFor(mime: string): string {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  return "document";
}

export interface CanvasSummary {
  id: string;
  name: string;
}

export async function fetchCanvasList(): Promise<CanvasSummary[]> {
  const res = await authFetch(`${apiOrigin()}/api/canvases`);
  if (!res.ok) throw await readError(res);
  const list = (await res.json()) as { id: string; name: string }[];
  return list.map((c) => ({ id: c.id, name: c.name }));
}

/** Show an existing asset on a canvas as a new node (the asset is not copied). */
export async function addAssetToCanvas(
  canvasId: string,
  asset: { id: string; url: string; filename: string; mime: string },
  index = 0,
): Promise<void> {
  const res = await authFetch(`${apiOrigin()}/api/canvases/${encodeURIComponent(canvasId)}/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: canvasNodeTypeFor(asset.mime),
      asset_id: asset.id,
      x: 40 + (index % 4) * 320,
      y: 40 + Math.floor(index / 4) * 240,
      width: 300,
      height: 220,
      creator_name: "asset-library",
      data: { url: plainAssetUrl(asset.url), filename: asset.filename, mime: asset.mime },
    }),
  });
  if (!res.ok) throw await readError(res);
}

/** `url` without signature parameters — what canvases and copied links store. */
export const plainAssetUrl = stripSignature;

/** The asset id an `/assets/<id><ext>` URL addresses, else undefined. */
export function assetIdFromUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  let path: string;
  try {
    path = new URL(url, "http://x").pathname;
  } catch {
    return undefined;
  }
  const m = /^\/assets\/([^/]+)$/.exec(path);
  if (!m) return undefined;
  return decodeURIComponent(m[1]!).replace(/\.[^./]*$/, "");
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export const libraryKey = (filters: LibraryFilters) => ["assets", "library", filters] as const;
export const assetDetailKey = (id: string) => ["assets", "detail", id] as const;

/** Paged library listing; the first page also carries facet counts. */
export function useAssetLibrary(filters: LibraryFilters, enabled = true) {
  return useInfiniteQuery<
    LibraryPage,
    Error,
    InfiniteData<LibraryPage>,
    ReturnType<typeof libraryKey>,
    string | null
  >({
    queryKey: libraryKey(filters),
    queryFn: ({ pageParam }) => fetchLibraryPage(filters, pageParam, pageParam === null),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    // Keep the current grid and facet counts on screen while a new filter loads.
    placeholderData: keepPreviousData,
  });
}

export function useAssetDetail(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: assetDetailKey(id ?? ""),
    queryFn: () => fetchAssetDetail(id as string),
    enabled: !!id && enabled,
    retry: false,
  });
}

export function useCanvasList(enabled: boolean) {
  return useQuery({
    queryKey: ["canvases", "list"],
    queryFn: fetchCanvasList,
    enabled,
    staleTime: 15_000,
  });
}

/** Invalidate every assets query (after a local write; the server event does the same). */
export function useInvalidateAssets() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: ["assets"] }), [qc]);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Accessible text for an asset image: alt → caption → filename. */
export function assetAltText(item: {
  alt?: string | null;
  caption?: string | null;
  filename?: string;
  title?: string;
}): string {
  return item.alt?.trim() || item.caption?.trim() || item.filename || item.title || "asset";
}
