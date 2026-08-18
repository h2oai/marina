// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * FeedPanel -- Floating draggable panel showing a live activity event feed.
 *
 * Visual port of #fp-feed from 06-tiled.html mockup:
 * - Uses .fi layout: timestamp | entity name (clickable) | action
 * - Error events in red, timestamps in #444
 * - Rolled by default
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useWorldState } from "../../hooks/use-world-state";
import type { DashboardEvent } from "../../lib/types";
import { FloatingPanel } from "./FloatingPanel";

/** Event type color map matching CommandBar EventsTab. */
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
  agent_spawn: "#22c55e",
  agent_stop: "#f59e0b",
  entity_enter: "#06b6d4",
  entity_leave: "#6b7280",
  task_claimed: "#d946ef",
  task_submitted: "#3b82f6",
  task_approved: "#22c55e",
  task_rejected: "#ef4444",
  canvas_publish: "#06b6d4",
  canvas_intent: "#facc15",
  channel_message: "#d946ef",
  board_post: "#3b82f6",
};

/** Props for the FeedPanel component. */
export interface FeedPanelProps {
  /** Whether the panel is visible. */
  visible: boolean;
  /** Called when the close button is clicked. */
  onClose: () => void;
  /** Called when an entity name is clicked. */
  onEntityClick?: (name: string) => void;
}

/** Format a timestamp to HH:MM:SS. */
function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Determine whether an event represents an error. */
function isErrorEvent(event: DashboardEvent): boolean {
  return (
    event.type === "error" ||
    event.type === "command_error" ||
    event.type === "agent_error" ||
    (event.input?.toLowerCase().includes("fail") ?? false) ||
    (event.input?.toLowerCase().includes("error") ?? false)
  );
}

/** Single feed item row matching .fi from mockup. */
const FeedItem = memo(function FeedItem({
  event,
  onEntityClick,
  highlighted,
}: {
  event: DashboardEvent;
  onEntityClick?: (name: string) => void;
  highlighted?: boolean;
}) {
  const isError = isErrorEvent(event);
  const typeColor = isError ? "#ef4444" : (EVENT_TYPE_COLORS[event.type] ?? "#888");

  return (
    <div
      className="uc-feed-item"
      style={
        highlighted
          ? { background: "rgba(255,221,0,0.06)", outline: "1px solid rgba(255,221,0,0.15)" }
          : undefined
      }
    >
      <span className="uc-feed-time">{formatTime(event.timestamp)}</span>
      {(event.entity || (event.type === "agent_error" && event.name)) && (
        <button
          type="button"
          className="uc-feed-entity"
          style={{ background: "none", border: "none", fontFamily: "inherit", fontSize: "inherit" }}
          onClick={() => {
            const name = event.entity ?? event.name;
            if (name) onEntityClick?.(name);
          }}
        >
          {event.entity ?? event.name}
        </button>
      )}
      <span
        style={{
          color: typeColor,
          fontSize: "clamp(9px, 0.6vw, 12px)",
          flexShrink: 0,
          opacity: 0.7,
        }}
      >
        [{event.type.replace(/_/g, " ")}]
      </span>
      <span
        className={`uc-feed-action${isError ? " error" : ""}`}
        style={{ color: isError ? "#ef4444" : undefined }}
      >
        {event.type === "agent_error" ? `${event.error ?? "unknown"}` : (event.input ?? "")}
      </span>
    </div>
  );
});

/**
 * Floating activity feed panel. Shows recent events from the world.
 */
export const FeedPanel = memo(function FeedPanel({
  visible,
  onClose,
  onEntityClick,
}: FeedPanelProps) {
  const eventFeed = useWorldState((s) => s.eventFeed);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);
  const [selectedIdx, setSelectedIdx] = useState(-1);

  // Auto-scroll to bottom when new events arrive
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isAtBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: triggers scroll on new events
  useEffect(() => {
    if (isAtBottom.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [eventFeed.length]);

  const displayed = eventFeed.slice(0, 100);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((prev) => Math.min(prev + 1, displayed.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter" && selectedIdx >= 0) {
        const ev = displayed[selectedIdx];
        const name = ev?.entity ?? ev?.name;
        if (name) onEntityClick?.(name);
      } else if (e.key === "Escape") {
        setSelectedIdx(-1);
      }
    },
    [displayed, selectedIdx, onEntityClick],
  );

  return (
    <FloatingPanel
      title="Activity Feed"
      visible={visible}
      onClose={onClose}
      initialPosition={{ left: "12px", top: "clamp(390px, 52vh, 540px)" }}
      initialSize={{ width: "clamp(240px, 16vw, 340px)", height: "200px" }}
      defaultRolled
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: scrollable keyboard-navigable feed list — onScroll tracks position, onKeyDown drives arrow navigation; not a click target */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={handleKeyDown}
        style={{
          height: "100%",
          overflowY: "auto",
          scrollbarWidth: "thin",
          scrollbarColor: "#1a1a22 transparent",
          outline: "none",
        }}
      >
        {eventFeed.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "24px",
              color: "#555",
              fontSize: "clamp(15px, 1.05vw, 22px)",
              fontFamily: "'VT323', monospace",
            }}
          >
            No events yet
          </div>
        )}
        {displayed.map((event, i) => (
          <FeedItem
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only feed has no stable per-event id; timestamps can collide
            key={`${event.timestamp}-${i}`}
            event={event}
            onEntityClick={onEntityClick}
            highlighted={i === selectedIdx}
          />
        ))}
      </div>
    </FloatingPanel>
  );
});
