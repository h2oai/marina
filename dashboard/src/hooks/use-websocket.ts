// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import type { DashboardEvent, WorldSnapshot, WSMessage } from "../lib/types";
import { ACTIVITY_EVENT_TYPES, useEntityActivity } from "./use-entity-activity";
import { FEED_EVENT_TYPES, loadFeedSnapshot, useFeedState } from "./use-feed-state";
import { GRAPH_EVENT_TYPES, loadGraphSnapshot, useGraphState } from "./use-graph-state";
import { useWorldState } from "./use-world-state";
import { HIDDEN_FLUSH_MS, pushBounded, reconnectDelay } from "./ws-buffer";

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

  // Batching refs — accumulate between frames, flush once per rAF (or on the
  // fallback timer when the tab is hidden and rAF is paused). Each buffer is
  // bounded; overflow drops the oldest events and is counted in droppedRef.
  const pendingSnapshotRef = useRef<WorldSnapshot | null>(null);
  const pendingEventsRef = useRef<DashboardEvent[]>([]);
  const pendingGraphEventsRef = useRef<DashboardEvent[]>([]);
  const pendingFeedEventsRef = useRef<DashboardEvent[]>([]);
  const pendingActivityEventsRef = useRef<DashboardEvent[]>([]);
  const rafRef = useRef<number>(0);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const droppedRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let reconnectAttempt = 0;

    function flush() {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
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
    }

    function scheduleFlush() {
      if (rafRef.current || flushTimerRef.current) return;
      // rAF keeps visible-tab flushes frame-aligned; the timer guarantees a
      // flush in a hidden tab, where rAF never fires. Whichever runs first
      // cancels the other.
      if (typeof document === "undefined" || !document.hidden) {
        rafRef.current = requestAnimationFrame(flush);
      }
      flushTimerRef.current = setTimeout(flush, HIDDEN_FLUSH_MS);
    }

    function push(buffer: DashboardEvent[], event: DashboardEvent) {
      droppedRef.current += pushBounded(buffer, event);
    }

    function connect() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}/dashboard-ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (mounted) {
          reconnectAttempt = 0;
          setConnected(true);
          // Prime graph + feed stores so the first frame isn't empty; WS
          // events then mutate from this baseline. Both loaders record any
          // failure in their store's `error` field (rendered by the panels)
          // and never reject, so nothing is silently swallowed here.
          void loadGraphSnapshot();
          void loadFeedSnapshot();
        }
      };

      ws.onclose = () => {
        if (mounted) {
          setConnected(false);
          reconnectTimer = setTimeout(connect, reconnectDelay(reconnectAttempt));
          reconnectAttempt += 1;
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
              push(pendingEventsRef.current, msg.data);
            }
            if (GRAPH_EVENT_TYPES.has(msg.data.type)) {
              push(pendingGraphEventsRef.current, msg.data);
            }
            if (FEED_EVENT_TYPES.has(msg.data.type)) {
              push(pendingFeedEventsRef.current, msg.data);
            }
            if (ACTIVITY_EVENT_TYPES.has(msg.data.type)) {
              push(pendingActivityEventsRef.current, msg.data);
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
      rafRef.current = 0;
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
      wsRef.current?.close();
    };
  }, [setSnapshot, pushEvents, applyGraphEvent, applyFeedEvent, applyActivityEvent]);

  const send = (data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  };

  /** Events dropped because a pending buffer hit MAX_PENDING_EVENTS. */
  const droppedEvents = () => droppedRef.current;

  return { connected, send, wsRef, droppedEvents };
}
