// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TimelineStrip -- Thin, always-visible horizontal activity timeline.
 *
 * Lives at the bottom of the unified canvas viewport. Each dot is one
 * feed_event positioned on a time axis covering the last N minutes.
 * Dots are colored by kind; click a dot to inspect.
 *
 * Kept intentionally narrow (~70px tall) so it doesn't compete with the
 * canvas for screen real-estate. Collapse toggle removes it entirely.
 */

import { memo, useEffect, useMemo, useState } from "react";
import { useFeedState } from "../../hooks/use-feed-state";
import type { FeedEvent } from "../../lib/types";

const KIND_COLORS: Record<string, string> = {
  board_post: "#a855f7",
  pool_note: "#14b8a6",
  channel_message: "#06b6d4",
  task_claimed: "#22c55e",
  task_submitted: "#eab308",
  task_approved: "#22c55e",
  task_rejected: "#ef4444",
  market_position: "#f97316",
  market_consensus: "#3b82f6",
  market_resolution: "#8b5cf6",
  canvas_intent: "#ec4899",
  note_created: "#60a5fa",
  note_link_created: "#818cf8",
  model_request_received: "#94a3b8",
  model_request_routed: "#f59e0b",
  model_request_fast_path: "#22d3ee",
  model_request_completed: "#22c55e",
  model_request_failed: "#ef4444",
};

const WINDOW_MINUTES = 30;

function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? "#9ca3af";
}

export interface TimelineStripProps {
  /** Hide the strip entirely (driven by Feed layer toggle). */
  hidden?: boolean;
  /** Called when an event dot is clicked. */
  onEventClick?: (event: FeedEvent) => void;
  /**
   * When true, render as a full-width block that fills its parent (for use
   * as a panel back face). When false (default), render as the floating
   * strip positioned absolutely above the unified canvas bottom edge.
   */
  inline?: boolean;
}

export const TimelineStrip = memo(function TimelineStrip({
  hidden,
  onEventClick,
  inline,
}: TimelineStripProps) {
  const events = useFeedState((s) => s.events);
  const kindFilter = useFeedState((s) => s.kindFilter);
  const setKindFilter = useFeedState((s) => s.setKindFilter);
  // Tick every 5s to force re-render so the rolling window slides left smoothly
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const windowStart = now - WINDOW_MINUTES * 60_000;

  // Filter events: show only the rolling window and respect the kind filter.
  // windowStart is recomputed every render (the `tick` interval above forces
  // a render every 5s), so the memo naturally slides its window.
  const visible = useMemo(() => {
    const out: FeedEvent[] = [];
    for (const e of events) {
      if (e.timestamp < windowStart) continue;
      if (kindFilter && e.kind !== kindFilter) continue;
      out.push(e);
    }
    return out;
  }, [events, kindFilter, windowStart]);

  // Build kind counts for filter chips
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) {
      if (e.timestamp < windowStart) continue;
      counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [events, windowStart]);

  if (hidden) return null;

  const containerStyle: React.CSSProperties = inline
    ? {
        width: "100%",
        height: "100%",
        background: "rgba(8, 8, 12, 0.4)",
        padding: "10px 14px",
        fontFamily: "'VT323', monospace",
        color: "#ccc",
        fontSize: 13,
        overflow: "auto",
      }
    : {
        position: "absolute",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: 80,
        width: "min(90%, 1200px)",
        background: "rgba(8, 8, 12, 0.82)",
        border: "1px solid rgba(255,221,0,0.2)",
        borderRadius: 4,
        padding: "6px 10px",
        fontFamily: "'VT323', monospace",
        color: "#ccc",
        fontSize: 13,
        zIndex: 50,
        pointerEvents: "auto",
      };

  // Events sharing request:<id> form one causal arc. The line makes receipt →
  // routing → completion legible at a glance instead of presenting unrelated dots.
  const requestArcs = new Map<string, FeedEvent[]>();
  for (const event of visible) {
    if (!event.ref?.startsWith("request:")) continue;
    const group = requestArcs.get(event.ref) ?? [];
    group.push(event);
    requestArcs.set(event.ref, group);
  }

  return (
    <div style={containerStyle}>
      {/* Filter chips */}
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 4,
          alignItems: "center",
        }}
      >
        <span style={{ color: "#FFDD00", letterSpacing: 1, fontSize: 11 }}>TIMELINE</span>
        <span style={{ color: "#666", fontSize: 11 }}>
          last {WINDOW_MINUTES}m · {visible.length} event{visible.length === 1 ? "" : "s"}
        </span>
        {kindFilter && (
          <button
            type="button"
            onClick={() => setKindFilter(null)}
            style={{
              marginLeft: "auto",
              padding: "1px 6px",
              background: "transparent",
              border: "1px solid #ef4444",
              borderRadius: 2,
              color: "#ef4444",
              fontFamily: "inherit",
              cursor: "pointer",
              fontSize: 10,
            }}
          >
            clear filter ({kindFilter}) ×
          </button>
        )}
      </div>
      {!kindFilter && kindCounts.length > 0 && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4 }}>
          {kindCounts.slice(0, 10).map(([kind, count]) => (
            <button
              key={kind}
              type="button"
              onClick={() => setKindFilter(kind)}
              style={{
                padding: "1px 5px",
                background: "transparent",
                border: `1px solid ${kindColor(kind)}`,
                borderRadius: 2,
                color: kindColor(kind),
                fontFamily: "inherit",
                cursor: "pointer",
                fontSize: 10,
                opacity: 0.75,
              }}
            >
              {kind}·{count}
            </button>
          ))}
        </div>
      )}
      {/* Dot track — 36px tall */}
      <svg
        width="100%"
        height={36}
        viewBox="0 0 1000 36"
        preserveAspectRatio="none"
        style={{ display: "block" }}
      >
        <title>Activity timeline — last {WINDOW_MINUTES} minutes</title>
        {/* Axis line */}
        <line x1={0} y1={28} x2={1000} y2={28} stroke="#333" strokeWidth={1} />
        {/* Minute ticks */}
        {Array.from({ length: WINDOW_MINUTES / 5 + 1 }).map((_, i) => {
          const minutesAgo = WINDOW_MINUTES - i * 5;
          const x = (i / (WINDOW_MINUTES / 5)) * 1000;
          return (
            <g key={`tick-${minutesAgo}`}>
              <line x1={x} y1={24} x2={x} y2={32} stroke="#555" strokeWidth={1} />
              <text
                x={x}
                y={14}
                textAnchor="middle"
                fontSize={9}
                fill="#666"
                fontFamily="'VT323', monospace"
              >
                -{minutesAgo}m
              </text>
            </g>
          );
        })}
        {/* "now" marker on the right */}
        <line x1={1000} y1={0} x2={1000} y2={36} stroke="#FFDD00" strokeWidth={1} opacity={0.5} />
        <text
          x={992}
          y={12}
          textAnchor="end"
          fontSize={9}
          fill="#FFDD00"
          fontFamily="'VT323', monospace"
        >
          NOW
        </text>
        {/* Causal request arcs */}
        {[...requestArcs.entries()].map(([ref, grouped]) => {
          if (grouped.length < 2) return null;
          const xs = grouped.map((event) => {
            const pct = 1 - (now - event.timestamp) / (WINDOW_MINUTES * 60_000);
            return Math.max(2, Math.min(998, pct * 1000));
          });
          return (
            <line
              key={ref}
              x1={Math.min(...xs)}
              x2={Math.max(...xs)}
              y1={20}
              y2={20}
              stroke="#22c55e"
              strokeWidth={2}
              opacity={0.45}
            />
          );
        })}
        {/* Event dots */}
        {visible.map((e) => {
          const age = now - e.timestamp;
          const pct = 1 - age / (WINDOW_MINUTES * 60_000);
          const x = Math.max(2, Math.min(998, pct * 1000));
          const color = kindColor(e.kind);
          const interactive = Boolean(onEventClick);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: SVG dot; role/tabIndex/keyboard are conditionally wired when interactive
            <g
              key={e.id}
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? `${e.kind}: ${e.summary}` : undefined}
              style={{ cursor: interactive ? "pointer" : undefined }}
              onClick={() => onEventClick?.(e)}
              onKeyDown={(ke) => {
                if ((ke.key === "Enter" || ke.key === " ") && onEventClick) {
                  ke.preventDefault();
                  onEventClick(e);
                }
              }}
            >
              <title>
                {e.summary}
                {"\n"}({e.kind} · {new Date(e.timestamp).toLocaleTimeString()})
              </title>
              <line x1={x} y1={20} x2={x} y2={28} stroke={color} strokeWidth={1.5} opacity={0.9} />
              <circle cx={x} cy={28} r={3} fill={color} opacity={0.95} />
            </g>
          );
        })}
      </svg>
    </div>
  );
});
