// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { DashboardEvent } from "../lib/types";
import { useWorldState } from "./use-world-state";

/**
 * Realtime is a core tenet of Marina's dashboard. Any inspector that
 * only polls lies to the user about a multi-agent, multi-player world
 * whose state is constantly changing. This helper is the canonical way
 * to pair a `useQuery` with the WebSocket event stream: bootstrap fetch
 * via react-query, then invalidate the cached value whenever an event
 * matching `predicate` arrives.
 *
 * Events are matched against the newest slice of `eventFeed` — which is
 * newest-first in `useWorldState`. Invalidation is debounced so a burst
 * of 20 related events in the same frame becomes one refetch, not 20.
 *
 * @example
 * ```tsx
 * const { data } = useRoomDetail(roomId);
 * useInvalidateOnEvent(
 *   ["room", roomId],
 *   (e) => (e.type === "entity_enter" || e.type === "entity_leave") && e.room === roomId,
 * );
 * ```
 */
export function useInvalidateOnEvent(
  queryKey: readonly unknown[],
  predicate: (event: DashboardEvent) => boolean,
  debounceMs = 120,
): void {
  const queryClient = useQueryClient();
  const feed = useWorldState((s) => s.eventFeed);

  // Track the latest timestamp we've already observed so we don't
  // re-process old events on every render (selectors, unrelated state
  // changes, etc.).
  const lastSeenRef = useRef<number>(Number.NEGATIVE_INFINITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stabilize the queryKey dependency. Callers typically pass an inline
  // array like `["taskDetail", id]` — that's a fresh reference every
  // render. Serializing once per render gives a stable string dep so
  // the effect doesn't re-subscribe constantly. Cost is negligible
  // (tiny arrays) compared to the alternative of spreading the array
  // into deps (variable length → React warns / breaks the rules of hooks).
  const keySig = JSON.stringify(queryKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: predicate is intentionally not tracked — callers pass inline arrows closed over roomId/taskId; wrap them in useCallback (see RoomDetail, EntityRoster). queryKey captured via keySig for the same reason.
  useEffect(() => {
    if (feed.length === 0) return;
    const fresh: DashboardEvent[] = [];
    for (const e of feed) {
      if (e.timestamp <= lastSeenRef.current) break;
      fresh.push(e);
    }
    if (fresh.length === 0) return;
    lastSeenRef.current = fresh[0]!.timestamp;

    if (!fresh.some(predicate)) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      queryClient.invalidateQueries({ queryKey: [...queryKey] });
    }, debounceMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [feed, queryClient, debounceMs, keySig]);
}

/**
 * Return the subset of the live event feed whose events match `predicate`.
 * Use this to render a "live activity" section alongside a polled snapshot.
 *
 * The returned array is newest-first, capped at `limit`. Predicate
 * stability is the caller's responsibility.
 */
export function useFilteredEvents(
  predicate: (event: DashboardEvent) => boolean,
  limit = 20,
): DashboardEvent[] {
  const feed = useWorldState((s) => s.eventFeed);
  const result: DashboardEvent[] = [];
  for (const e of feed) {
    if (predicate(e)) {
      result.push(e);
      if (result.length >= limit) break;
    }
  }
  return result;
}
