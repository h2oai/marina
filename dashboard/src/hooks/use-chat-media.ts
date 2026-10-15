// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * WebChat's persisted media: the conversation's library assets and media jobs
 * (`scope=chat`, resolved server-side: the viewer, its agents and the agents
 * in its room), read under the viewer's credential and kept live by invalidation — the
 * `["assets", …]` key rereads on `asset_created|updated|deleted`, the
 * `["media-jobs", …]` key on `media_*` feed events (use-realtime-invalidations.ts).
 * A slow poll runs only while a job is still pending/running, as a safety net
 * for a dropped socket; nothing polls otherwise.
 */

import { type InfiniteData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchApi } from "../lib/api";
import { fetchLibraryPage, type LibraryItem, type LibraryPage } from "../lib/asset-library";
import {
  CHAT_MEDIA_FILTERS,
  CHAT_MEDIA_PAGE_SIZE,
  chatMediaJobsPath,
  hasActiveJob,
  normalizeMediaJobs,
} from "../lib/chat-media";
import type { MediaJob } from "../lib/types";

/** Safety-net refresh while a job is in progress (events normally arrive first). */
export const ACTIVE_JOB_POLL_MS = 60_000;

export const chatMediaAssetsKey = (viewer: string | null) =>
  ["assets", "chat-media", viewer ?? ""] as const;
export const chatMediaJobsKey = (viewer: string | null) =>
  ["media-jobs", "me", viewer ?? ""] as const;

export interface ChatMedia {
  assets: LibraryItem[];
  jobs: MediaJob[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => void;
}

/**
 * `viewer` is the logged-in entity name: it scopes the cache so a different
 * login never sees the previous viewer's cards, and gates the reads (nothing
 * is fetched before login).
 */
export function useChatMedia(viewer: string | null, enabled = true): ChatMedia {
  const on = enabled && !!viewer;
  const library = useInfiniteQuery<
    LibraryPage,
    Error,
    InfiniteData<LibraryPage>,
    ReturnType<typeof chatMediaAssetsKey>,
    string | null
  >({
    queryKey: chatMediaAssetsKey(viewer),
    queryFn: ({ pageParam }) =>
      fetchLibraryPage(CHAT_MEDIA_FILTERS, pageParam, false, CHAT_MEDIA_PAGE_SIZE),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: on,
    retry: false,
  });
  const jobs = useQuery({
    queryKey: chatMediaJobsKey(viewer),
    queryFn: async () => normalizeMediaJobs(await fetchApi<unknown>(chatMediaJobsPath())),
    enabled: on,
    retry: false,
    refetchInterval: (query) =>
      hasActiveJob(query.state.data as MediaJob[] | undefined) ? ACTIVE_JOB_POLL_MS : false,
  });

  const pages = library.data?.pages;
  const assets = useMemo(() => pages?.flatMap((p) => p.items) ?? [], [pages]);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = library;
  return {
    assets: on ? assets : EMPTY_ASSETS,
    jobs: on ? (jobs.data ?? EMPTY_JOBS) : EMPTY_JOBS,
    hasEarlier: on && !!hasNextPage,
    loadingEarlier: isFetchingNextPage,
    loadEarlier: () => void fetchNextPage(),
  };
}

const EMPTY_ASSETS: LibraryItem[] = [];
const EMPTY_JOBS: MediaJob[] = [];
