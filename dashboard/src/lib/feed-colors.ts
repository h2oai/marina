// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for feed-event colorization. Used by the
 * per-type canvas renderers (TextNode border accent) and the timeline
 * (TimelineStrip dot color) so both surfaces speak the same visual
 * vocabulary.
 *
 * A node's `data.feedType` is set by FeedPublisher for every event it
 * publishes to the feed canvas. Direct user-published nodes (images,
 * documents) have no feedType — we fall back to the shape's own color.
 */

export const FEED_TYPE_COLORS: Record<string, string> = {
  board_post: "#a855f7", // purple — communal posts
  pool_note: "#14b8a6", // teal — generational memory
  channel_message: "#06b6d4", // cyan — ephemeral chatter
  task_event: "#eab308", // yellow — task lifecycle (generic)
  task_claimed: "#22c55e",
  task_submitted: "#eab308",
  task_approved: "#22c55e",
  task_rejected: "#ef4444",
  market_position: "#f97316", // orange — active forecasts
  market_consensus: "#3b82f6", // blue — agreement signal
  market_resolution: "#8b5cf6", // violet — terminal outcome
  canvas_intent: "#ec4899", // pink — work request
  intent_result: "#10b981", // emerald — intent fulfilled
  note_created: "#60a5fa", // light blue — knowledge
  note_link_created: "#818cf8", // indigo — linking
  rank_change: "#fbbf24", // gold — progression
};

/** Default color for nodes with no feedType (direct user-published items). */
export const DEFAULT_FEED_COLOR = "#8b5cf6";

export function feedTypeColor(feedType?: string): string {
  if (!feedType) return DEFAULT_FEED_COLOR;
  return FEED_TYPE_COLORS[feedType] ?? DEFAULT_FEED_COLOR;
}

/**
 * Deterministic color for an author name. Hash → hue on a fixed
 * saturation/lightness so names are visually distinct but not
 * screaming. Same name → same color forever.
 */
export function authorColor(name?: string): string {
  if (!name) return "#6b7280";
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 58%)`;
}

/**
 * "3m ago", "just now", etc. Kept short for badge use.
 */
export function shortAge(ms?: number, now: number = Date.now()): string {
  if (!ms) return "";
  const age = now - ms;
  if (age < 10_000) return "now";
  if (age < 60_000) return `${Math.floor(age / 1000)}s`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  return `${Math.floor(age / 86_400_000)}d`;
}

/**
 * Opacity for an age ring: recent events = bright (1.0), events older
 * than 5 minutes fade to 40%. Gives at-a-glance sense of what's live.
 */
export function ageOpacity(ms?: number, now: number = Date.now()): number {
  if (!ms) return 0.4;
  const age = now - ms;
  const fullFade = 5 * 60_000;
  if (age <= 0) return 1;
  if (age >= fullFade) return 0.4;
  return 1 - 0.6 * (age / fullFade);
}
