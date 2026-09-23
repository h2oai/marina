// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * CommandBar Events tab — the raw engine event stream (merged from the old
 * FeedPanel). Extracted from CommandBar.tsx.
 *
 * PERFORMANCE: this list does NOT subscribe to `useWorldState((s) => s.eventFeed)`
 * reactively. The store replaces the 200-item array on every WebSocket event,
 * which would re-render the whole CommandBar tree per event. Instead it reads
 * the feed imperatively (`getState()`) and subscribes with a non-rendering store
 * listener that batches into one `requestAnimationFrame` — the same pattern
 * WorldMap.tsx documents — so a burst of N events costs one render.
 */

import { memo, useEffect, useRef, useState } from "react";
import { useWorldState } from "../../../hooks/use-world-state";
import type { DashboardEvent } from "../../../lib/types";

function formatEventTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  say: "#06b6d4",
  tell: "#d946ef",
  shout: "#facc15",
  emote: "#22d3ee",
  broadcast: "#3b82f6",
  command: "#84cc16",
  move: "#f59e0b",
  goto: "#f59e0b",
  connect: "#22c55e",
  disconnect: "#6b7280",
  error: "#ef4444",
  command_error: "#ef4444",
  agent_error: "#ef4444",
  tick: "#333",
};

// ── Admin Tab Components ──────────────────────────────────────────────────

/**
 * Read the live event feed with rAF batching instead of a reactive selector.
 * Returns the latest array reference; identity changes at most once per frame.
 */
export function useBatchedEventFeed(): DashboardEvent[] {
  const [feed, setFeed] = useState<DashboardEvent[]>(() => useWorldState.getState().eventFeed);
  useEffect(() => {
    // `pending` (not the rAF id) is the guard: a synchronous rAF (tests) would
    // otherwise run the callback before the id is assigned and wedge the gate.
    let pending = false;
    let frame = 0;
    const flush = () => {
      pending = false;
      setFeed(useWorldState.getState().eventFeed);
    };
    const unsubscribe = useWorldState.subscribe((state, prev) => {
      if (state.eventFeed === prev.eventFeed || pending) return;
      pending = true;
      frame = requestAnimationFrame(flush);
    });
    // Catch anything that arrived between the initial read and the subscription.
    flush();
    return () => {
      unsubscribe();
      if (pending) cancelAnimationFrame(frame);
    };
  }, []);
  return feed;
}

export const EventsTab = memo(function EventsTab({
  onEntityClick,
}: {
  onEntityClick?: (name: string) => void;
}) {
  const eventFeed = useBatchedEventFeed();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new events
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [eventFeed.length]);

  if (eventFeed.length === 0) {
    return (
      <div
        style={{
          padding: "16px",
          textAlign: "center",
          color: "#888",
          fontSize: "clamp(15px, 1.05vw, 22px)",
        }}
      >
        No events yet — waiting for world activity...
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="uc-cmd-msgs">
      {eventFeed.slice(-100).map((event: DashboardEvent, i: number) => {
        if (event.type === "tick") return null;
        const typeColor = EVENT_TYPE_COLORS[event.type] ?? "#888";
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only event stream has no stable per-event id; timestamps can collide
            key={`${event.timestamp}-${i}`}
            style={{
              display: "flex",
              gap: "8px",
              padding: "3px 12px",
              fontSize: "clamp(14px, 0.95vw, 20px)",
              fontFamily: "'VT323', monospace",
              borderBottom: "1px solid rgba(255,255,255,0.03)",
              alignItems: "baseline",
            }}
          >
            <span style={{ color: "#666", flexShrink: 0, fontSize: "clamp(12px, 0.8vw, 16px)" }}>
              {formatEventTime(event.timestamp)}
            </span>
            {(event.entity || (event.type === "agent_error" && event.name)) && (
              <button
                type="button"
                onClick={() => {
                  const name = event.entity ?? event.name;
                  if (name) onEntityClick?.(name);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--color-primary)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: "inherit",
                  padding: 0,
                  fontWeight: "bold",
                  flexShrink: 0,
                }}
              >
                {event.entity ?? event.name}
              </button>
            )}
            <span style={{ color: typeColor, flexShrink: 0 }}>[{event.type}]</span>
            <span
              style={{
                color: "#bbb",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {event.type === "agent_error"
                ? (event.error ?? "unknown error")
                : (event.input ?? event.room ?? "")}
            </span>
          </div>
        );
      })}
    </div>
  );
});
