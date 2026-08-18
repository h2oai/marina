// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import type { DashboardEvent, FeedEvent } from "../lib/types";

/**
 * The curated 30-minute timeline store. `FeedEvent`s are emitted by the
 * backend's `FeedPublisher` into both the `feed_events` DB table (for
 * historical bootstrap via `/api/feed`) and the WS as `feed_event`
 * messages (for live updates). Shape is `{id, kind, entity, ref,
 * summary, payload, timestamp}` — DB-stable IDs let consumers use them
 * as React keys and navigate to the source object.
 *
 * This is intentionally separate from `useWorldState.eventFeed` (raw
 * engine events, ephemeral). The two stores serve different purposes:
 *   - `eventFeed` answers "what just happened?" (reactor / formatter input)
 *   - `FeedState` answers "what's in the last 30 minutes?" (timeline)
 *
 * Merging them was considered and rejected 2026-04-20 — the split
 * matches two different backend data sources and preserves ID
 * stability for the timeline's click-to-inspect UX. See
 * `dashboard-redesign-plan.md` for the reasoning.
 */
export const FEED_EVENT_TYPES = new Set(["feed_event"]);

const MAX_FEED = 1000;

/** Fake ids for events that arrive via WS before they've been persisted + queried. Negative to avoid clashes. */
let wsIdCounter = -1;

interface FeedState {
  events: FeedEvent[];
  snapshotLoaded: boolean;
  /** Active kind filter (null = show all). */
  kindFilter: string | null;
  /** Active entity filter (null = show all). */
  entityFilter: string | null;

  setSnapshot: (events: FeedEvent[]) => void;
  applyEvent: (event: DashboardEvent) => void;
  setKindFilter: (kind: string | null) => void;
  setEntityFilter: (entity: string | null) => void;
  reset: () => void;
}

export const useFeedState = create<FeedState>((set) => ({
  events: [],
  snapshotLoaded: false,
  kindFilter: null,
  entityFilter: null,

  setSnapshot: (events) => set({ events: events.slice(0, MAX_FEED), snapshotLoaded: true }),

  applyEvent: (event) =>
    set((state) => {
      if (event.type !== "feed_event" || !event.kind || !event.summary) return state;
      const fe: FeedEvent = {
        id: wsIdCounter--,
        kind: event.kind,
        entity: event.entity ?? null,
        ref: event.ref ?? null,
        summary: event.summary,
        payload: event.payload ?? null,
        timestamp: event.timestamp,
      };
      return { events: [fe, ...state.events].slice(0, MAX_FEED) };
    }),

  setKindFilter: (kind) => set({ kindFilter: kind }),
  setEntityFilter: (entity) => set({ entityFilter: entity }),

  reset: () => set({ events: [], snapshotLoaded: false, kindFilter: null, entityFilter: null }),
}));

/** Pull initial timeline state from the backend — called once on WS connect. */
export async function loadFeedSnapshot(limit = 200): Promise<void> {
  const res = await fetch(`/api/feed?limit=${limit}`, { credentials: "same-origin" });
  if (!res.ok) return;
  const events = (await res.json()) as FeedEvent[];
  useFeedState.getState().setSnapshot(events);
}
