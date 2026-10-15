// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * WebChat's media timeline — pure derivation, no fetching.
 *
 * The durable source is the conversation's media, read under the viewer's
 * credential with `scope=chat`, which the SERVER resolves from the session
 * (src/net/media-scope.ts): the viewer, the agents it owns (spawn lineage)
 * and the agents in its current room. Library assets
 * (`GET /api/assets?view=library&scope=chat`) are read-checked row by row;
 * media jobs (`GET /api/media-jobs?scope=chat`) include a participant's job
 * only once its result asset is readable. Both survive a reload and any
 * delay, so a card stays where it appeared. Live feed events that carry a
 * canvas node (other canvas activity) stay a short-lived fallback: they
 * render only inside {@link LIVE_FALLBACK_WINDOW_MS} and never when a
 * persisted card already shows the same asset or job.
 */

import type { LibraryFilters, LibraryItem } from "./asset-library";
import type { FeedEvent, MediaJob } from "./types";

/** Library page size for chat cards (newest first; "Show earlier media" pages back). */
export const CHAT_MEDIA_PAGE_SIZE = 24;
/** Media jobs read per refresh (newest first). */
export const CHAT_MEDIA_JOB_LIMIT = 20;
/** Live canvas-node feed events older than this are not shown (they are not persisted per viewer). */
export const LIVE_FALLBACK_WINDOW_MS = 30 * 60 * 1000;
/** At most this many live fallback embeds. */
export const LIVE_FALLBACK_MAX = 40;

/** Library filters for the chat cards: the conversation scope, resolved server-side. */
export const CHAT_MEDIA_FILTERS: LibraryFilters = Object.freeze({ scope: "chat" as const });

/** The jobs endpoint for the chat cards: `scope=chat` is resolved from the session, never names. */
export function chatMediaJobsPath(limit = CHAT_MEDIA_JOB_LIMIT): string {
  return `/api/media-jobs?scope=chat&limit=${limit}`;
}

/** Job states that are still moving (drive the in-progress card). */
export const ACTIVE_JOB_STATES: ReadonlySet<MediaJob["status"]> = new Set(["pending", "running"]);

export interface LiveCanvasEvent {
  id: number | string;
  timestamp: number;
  canvasId: string;
  nodeId: string;
  summary?: string;
  actor?: string | null;
  kind: string;
}

export type ChatMediaEntry =
  | {
      type: "asset";
      key: string;
      timestamp: number;
      asset: LibraryItem;
      /** The generation job that produced it, when known (prompt/model fallback). */
      job?: MediaJob;
    }
  | { type: "job"; key: string; timestamp: number; job: MediaJob }
  | { type: "live"; key: string; timestamp: number; event: LiveCanvasEvent };

export interface ChatMediaSources {
  assets: readonly LibraryItem[];
  jobs: readonly MediaJob[];
  feed: readonly FeedEvent[];
  now?: number;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined;

/**
 * Merge the persisted sources (and the live fallback) into one ordered list.
 *
 * - An asset appears once (pages may overlap after an invalidation). It sits
 *   at the time its job was REQUESTED when a job produced it — where the
 *   in-progress card was — else at its upload time.
 * - A job appears on its own while it is pending/running/failed/blocked, or
 *   when it succeeded but its asset is not in the loaded pages yet (the
 *   library reread may land after the job's); a succeeded job whose asset is
 *   gone (`assetUrl` null) is dropped.
 * - A live feed event appears only inside the fallback window and only when
 *   no persisted entry covers its asset or job.
 */
export function deriveChatMedia({
  assets,
  jobs,
  feed,
  now = Date.now(),
}: ChatMediaSources): ChatMediaEntry[] {
  const jobByAsset = new Map<string, MediaJob>();
  const seenJobs = new Set<string>();
  for (const job of jobs) {
    if (seenJobs.has(job.id)) continue;
    seenJobs.add(job.id);
    if (job.assetId) jobByAsset.set(job.assetId, job);
  }

  const out: ChatMediaEntry[] = [];
  const assetIds = new Set<string>();
  for (const asset of assets) {
    if (assetIds.has(asset.id)) continue;
    assetIds.add(asset.id);
    const job = jobByAsset.get(asset.id);
    out.push({
      type: "asset",
      key: `asset-${asset.id}`,
      timestamp: job?.createdAt ?? asset.createdAt,
      asset,
      ...(job ? { job } : {}),
    });
  }

  const coveredJobs = new Set<string>();
  const listedJobs = new Set<string>();
  for (const job of jobs) {
    if (listedJobs.has(job.id)) continue;
    listedJobs.add(job.id);
    if (job.assetId && assetIds.has(job.assetId)) {
      coveredJobs.add(job.id);
      continue;
    }
    if (job.status === "succeeded" && !job.assetUrl) continue;
    coveredJobs.add(job.id);
    out.push({ type: "job", key: `job-${job.id}`, timestamp: job.createdAt, job });
  }

  const cutoff = now - LIVE_FALLBACK_WINDOW_MS;
  const live: ChatMediaEntry[] = [];
  const liveSeen = new Set<string>();
  for (const event of feed) {
    if (event.timestamp < cutoff) continue;
    const payload = event.payload;
    if (!payload) continue;
    const canvasId = str(payload.canvasId);
    const nodeId = str(payload.nodeId);
    if (!canvasId || !nodeId) continue;
    const assetId = str(payload.assetId);
    const jobId = str(payload.jobId) ?? (event.kind.startsWith("media_") ? event.ref : undefined);
    if (assetId && assetIds.has(assetId)) continue;
    if (jobId && coveredJobs.has(jobId)) continue;
    const dedupe = `${canvasId}:${nodeId}:${event.timestamp}`;
    if (liveSeen.has(dedupe)) continue;
    liveSeen.add(dedupe);
    live.push({
      type: "live",
      key: `live-${event.id}-${nodeId}`,
      timestamp: event.timestamp,
      event: {
        id: event.id,
        timestamp: event.timestamp,
        canvasId,
        nodeId,
        summary: event.summary,
        actor: event.entity ?? null,
        kind: event.kind,
      },
    });
  }
  live.sort((a, b) => a.timestamp - b.timestamp);
  out.push(...live.slice(-LIVE_FALLBACK_MAX));

  return out.sort((a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key));
}

/**
 * Merge an ordered media list into an ordered message list by timestamp
 * (stable: a message and a card at the same instant keep message first).
 */
export function mergeByTimestamp<M extends { timestamp: number }, C extends { timestamp: number }>(
  messages: readonly M[],
  media: readonly C[],
): (M | C)[] {
  const out: (M | C)[] = [];
  let i = 0;
  let j = 0;
  while (i < messages.length || j < media.length) {
    const m = messages[i];
    const c = media[j];
    if (c === undefined || (m !== undefined && m.timestamp <= c.timestamp)) {
      out.push(m as M);
      i++;
    } else {
      out.push(c);
      j++;
    }
  }
  return out;
}

/** True while any job still needs a status update. */
export function hasActiveJob(jobs: readonly MediaJob[] | undefined): boolean {
  return !!jobs?.some((job) => ACTIVE_JOB_STATES.has(job.status));
}
