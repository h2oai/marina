// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import type { DashboardEvent, WorldSnapshot, WSMessage } from "../lib/types";
import { ACTIVITY_EVENT_TYPES, useEntityActivity } from "./use-entity-activity";
import { FEED_EVENT_TYPES, loadFeedSnapshot, useFeedState } from "./use-feed-state";
import { GRAPH_EVENT_TYPES, loadGraphSnapshot, useGraphState } from "./use-graph-state";
import { useWorldState } from "./use-world-state";

/** High-frequency per-token streaming events that belong to the live-stream
 *  projection only, not the discrete event feed. */
const FEED_EXCLUDED_TYPES = new Set(["agent_text_delta", "agent_thinking_delta"]);

export function useDashboardWebSocket() {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const setSnapshot = useWorldState((s) => s.setSnapshot);
  const pushEvents = useWorldState((s) => s.pushEvents);
  const applyGraphEvent = useGraphState((s) => s.applyEvent);
  const applyFeedEvent = useFeedState((s) => s.applyEvent);
  const applyActivityEvent = useEntityActivity((s) => s.applyEvent);

  // Batching refs — accumulate between frames, flush once per rAF
  const pendingSnapshotRef = useRef<WorldSnapshot | null>(null);
  const pendingEventsRef = useRef<DashboardEvent[]>([]);
  const pendingGraphEventsRef = useRef<DashboardEvent[]>([]);
  const pendingFeedEventsRef = useRef<DashboardEvent[]>([]);
  const pendingActivityEventsRef = useRef<DashboardEvent[]>([]);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    let mounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function scheduleFlush() {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const snap = pendingSnapshotRef.current;
        const events = pendingEventsRef.current;
        const graphEvents = pendingGraphEventsRef.current;
        const feedEvents = pendingFeedEventsRef.current;
        const activityEvents = pendingActivityEventsRef.current;
        pendingSnapshotRef.current = null;
        pendingEventsRef.current = [];
        pendingGraphEventsRef.current = [];
        pendingFeedEventsRef.current = [];
        pendingActivityEventsRef.current = [];

        if (snap) setSnapshot(snap);
        if (events.length > 0) pushEvents(events);
        for (const ge of graphEvents) applyGraphEvent(ge);
        for (const fe of feedEvents) applyFeedEvent(fe);
        for (const ae of activityEvents) applyActivityEvent(ae);
      });
    }

    function connect() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}/dashboard-ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (mounted) {
          setConnected(true);
          // Prime graph + feed stores so the first frame isn't empty; WS
          // events then mutate from this baseline.
          loadGraphSnapshot().catch(() => {
            // Snapshot fetch is best-effort — WS events will eventually fill state
          });
          loadFeedSnapshot().catch(() => {
            // Same — timeline will fill in as events arrive
          });
        }
      };

      ws.onclose = () => {
        if (mounted) {
          setConnected(false);
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (e) => {
        try {
          const msg: WSMessage = JSON.parse(e.data);
          if (msg.type === "snapshot" || msg.type === "state") {
            pendingSnapshotRef.current = msg.data;
          } else if (msg.type === "event") {
            // Per-token streaming deltas are consumed below by the activity store
            // (the live snippet/stream). They must NOT enter the raw event feed —
            // at many tokens/sec they flood the Activity panel with "agent text
            // delta" rows and drown out discrete events.
            if (!FEED_EXCLUDED_TYPES.has(msg.data.type)) {
              pendingEventsRef.current.push(msg.data);
            }
            if (GRAPH_EVENT_TYPES.has(msg.data.type)) {
              pendingGraphEventsRef.current.push(msg.data);
            }
            if (FEED_EVENT_TYPES.has(msg.data.type)) {
              pendingFeedEventsRef.current.push(msg.data);
            }
            if (ACTIVITY_EVENT_TYPES.has(msg.data.type)) {
              pendingActivityEventsRef.current.push(msg.data);
            }
          }
          scheduleFlush();
        } catch {}
      };
    }

    connect();

    return () => {
      mounted = false;
      clearTimeout(reconnectTimer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      wsRef.current?.close();
    };
  }, [setSnapshot, pushEvents, applyGraphEvent, applyFeedEvent, applyActivityEvent]);

  const send = (data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  };

  return { connected, send, wsRef };
}
