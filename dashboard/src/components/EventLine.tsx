// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo } from "react";
import type { DashboardEvent } from "../lib/types";
import { cn, formatTime } from "../lib/utils";
import { formatEvent } from "./ActivityFeed";
import { WhoLink } from "./WhoLink";

/**
 * Shared one-line renderer for a content-bearing event row. Used by
 * ActivityFeed (global) and RoomDetail (room-scoped), so a message
 * appearing in the world feed and in the room inspector look the same.
 * Single formatter, single row shape — the only thing that varies is
 * density and interaction affordances.
 */
export interface EventLineProps {
  event: DashboardEvent;
  resolveEntityName: (id: string) => string | undefined;
  onEntityClick: (name: string) => void;
  /** `default` = 11px with hover bg (feed), `compact` = 10px flat (inspector). */
  variant?: "default" | "compact";
  /** Tag this row for keyboard navigation. */
  kbItem?: boolean;
  /** Show keyboard-focus ring (from useKeyboardNav). */
  highlighted?: boolean;
}

// Memoized: ActivityFeed re-renders whenever a single event is prepended, but
// every existing row receives the same props (event object identity is stable,
// resolveEntityName/onEntityClick are stable callbacks). Without memo all ~80
// rows re-run formatEvent every frame; with it only the new and highlighted
// rows re-render.
export const EventLine = memo(function EventLine({
  event,
  resolveEntityName,
  onEntityClick,
  variant = "default",
  kbItem = false,
  highlighted = false,
}: EventLineProps) {
  const { color, prefix, suffix } = formatEvent(event, resolveEntityName);
  const clickableName = prefix || undefined;
  const compact = variant === "compact";

  return (
    <div
      data-kb-item={kbItem ? "" : undefined}
      className={cn(
        "flex items-start leading-tight",
        compact
          ? "gap-1.5 text-[10px]"
          : "event-row gap-2 px-2 py-0.5 text-[11px] hover:bg-bg-hover",
        highlighted && !compact && "ring-1 ring-primary/40",
      )}
    >
      <span className={cn("shrink-0 text-text-dim", compact && "tabular-nums")}>
        {formatTime(event.timestamp)}
      </span>
      <span className={cn("truncate", color)}>
        {clickableName && (
          <>
            <button
              type="button"
              className="hover:underline"
              onClick={() => onEntityClick(clickableName)}
            >
              {clickableName}
            </button>
            <WhoLink name={clickableName} className="ml-1" size={9} />
          </>
        )}
        {suffix}
      </span>
    </div>
  );
});
