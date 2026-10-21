// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Presence statuses as `who` reports them (src/engine/presence.ts), with the
 * one color and label every dashboard surface uses for them.
 */
export const PRESENCE_COLORS: Record<string, string> = {
  working: "#22c55e",
  idle: "#9ca3af",
  blocked: "#ef4444",
  needs_you: "#f97316",
  resting: "#8b5cf6",
  offline: "#6b7280",
};

/** How a presence status reads (`needs_you` → `needs you`). */
export function presenceLabel(status: string): string {
  return status.replaceAll("_", " ");
}
