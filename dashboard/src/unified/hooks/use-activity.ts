/**
 * Activity metrics Zustand store.
 *
 * Tracks events per room and per entity in a sliding 30-second window,
 * providing real-time metrics that drive animation speeds and visual
 * intensity in the unified canvas map.
 *
 * Room metrics: eventsPerSec, eventDiversity, lastEventAge
 * Entity metrics: lastActionAge (seconds since last action for an entity)
 * Global metrics: totalEventsPerSec (sum across all rooms)
 */

import { create } from "zustand";

/** Duration of the sliding activity window in seconds. */
const WINDOW_SECONDS = 30;

interface ActivityEntry {
  time: number;
  type: string;
  entity: string;
}

interface ActivityState {
  /** Raw event buckets keyed by room ID. */
  byRoom: Record<string, ActivityEntry[]>;

  /** Last action timestamp keyed by entity name. */
  entityLastAction: Record<string, number>;

  /** Timestamp of the most recent heartbeat sonar. */
  lastHeartbeat: number;

  /**
   * Log an activity event for a room and entity.
   * Called when WebSocket events arrive.
   */
  logActivity: (entity: string, roomId: string, type: string) => void;

  /**
   * Remove entries older than the sliding window.
   * Should be called periodically (e.g. every 5 seconds).
   */
  trimActivity: () => void;

  /** Get events per second for a given room within the sliding window. */
  eventsPerSec: (roomId: string) => number;

  /** Get the count of distinct event types for a room within the sliding window. */
  eventDiversity: (roomId: string) => number;

  /** Get seconds since the last event for a room. Returns 99999 if no events. */
  lastEventAge: (roomId: string) => number;

  /** Get seconds since the last action for an entity. Returns 99999 if none. */
  entityLastActionAge: (entityName: string) => number;

  /** Get total events per second across all rooms. */
  totalEventsPerSec: () => number;

  /** Get the room ID with the most recent activity. */
  mostActiveRoom: () => string | null;

  /** Set the last heartbeat timestamp. */
  setLastHeartbeat: (time: number) => void;
}

/** Activity metrics store for driving unified canvas animations. */
export const useActivity = create<ActivityState>((set, get) => ({
  byRoom: {},
  entityLastAction: {},
  lastHeartbeat: 0,

  logActivity: (entity: string, roomId: string, type: string) => {
    set((state) => {
      const bucket = state.byRoom[roomId] ?? [];
      const entry: ActivityEntry = { time: Date.now(), type, entity };
      return {
        byRoom: {
          ...state.byRoom,
          [roomId]: [...bucket, entry],
        },
        entityLastAction: {
          ...state.entityLastAction,
          [entity]: Date.now(),
        },
      };
    });
  },

  trimActivity: () => {
    const cutoff = Date.now() - WINDOW_SECONDS * 1000;
    set((state) => {
      const next: Record<string, ActivityEntry[]> = {};
      for (const [roomId, entries] of Object.entries(state.byRoom)) {
        const filtered = entries.filter((e) => e.time > cutoff);
        if (filtered.length > 0) {
          next[roomId] = filtered;
        }
      }
      return { byRoom: next };
    });
  },

  eventsPerSec: (roomId: string): number => {
    const bucket = get().byRoom[roomId];
    if (!bucket || bucket.length === 0) return 0;
    return bucket.length / WINDOW_SECONDS;
  },

  eventDiversity: (roomId: string): number => {
    const bucket = get().byRoom[roomId];
    if (!bucket || bucket.length === 0) return 0;
    const types = new Set(bucket.map((e) => e.type));
    return types.size;
  },

  lastEventAge: (roomId: string): number => {
    const bucket = get().byRoom[roomId];
    if (!bucket || bucket.length === 0) return 99999;
    const last = bucket[bucket.length - 1]!;
    return (Date.now() - last.time) / 1000;
  },

  entityLastActionAge: (entityName: string): number => {
    const ts = get().entityLastAction[entityName];
    if (!ts) return 99999;
    return (Date.now() - ts) / 1000;
  },

  totalEventsPerSec: (): number => {
    const { byRoom } = get();
    let total = 0;
    for (const entries of Object.values(byRoom)) {
      total += entries.length / WINDOW_SECONDS;
    }
    return total;
  },

  mostActiveRoom: (): string | null => {
    const { byRoom } = get();
    let best: string | null = null;
    let bestCount = 0;
    for (const [roomId, entries] of Object.entries(byRoom)) {
      if (entries.length > bestCount) {
        bestCount = entries.length;
        best = roomId;
      }
    }
    return best;
  },

  setLastHeartbeat: (time: number) => {
    set({ lastHeartbeat: time });
  },
}));
