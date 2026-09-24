// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers shared by the Admin → Memory tab and the TraceExplorer receipt
 * block. No React, no fetch — everything here is unit-testable in isolation.
 */

// Byte and trust-profile formatting is shared with the Ops tab.
export { formatBytes, trustProfileClass } from "../ops/format";

import type {
  MemoryJobMarker,
  MemoryJobState,
  MemoryReceiptAttribute,
} from "../../lib/memory-observability-types";

/**
 * The five unified-context tiers in their fixed injection order, plus the
 * world sections a receipt may also report. Colors are hard-coded hex so the
 * stacked bars read identically in light and dark themes (they sit on their
 * own track, not on the page ground).
 */
export const TIER_ORDER = ["skill", "trusted", "evidence", "proposal", "unverified"] as const;

export const TIER_COLORS: Record<string, string> = {
  skill: "#a855f7", // purple — worked examples
  trusted: "#22c55e", // green — strict legacy predicate
  evidence: "#06b6d4", // cyan — durable records + source excerpts
  proposal: "#f59e0b", // amber — finished assistance jobs
  unverified: "#6b7280", // gray — own notes, unverified
  pool: "#14b8a6",
  channel: "#0ea5e9",
  chronicle: "#8b5cf6",
};

const DEFAULT_TIER_COLOR = "#94a3b8";

export function tierColor(tier: string): string {
  return TIER_COLORS[tier] ?? DEFAULT_TIER_COLOR;
}

/** Sort tiers into injection order; unknown tiers trail in input order. */
export function sortTiers<T extends { tier: string }>(tiers: readonly T[]): T[] {
  const rank = (tier: string) => {
    const index = (TIER_ORDER as readonly string[]).indexOf(tier);
    return index === -1 ? TIER_ORDER.length : index;
  };
  return [...tiers].sort((a, b) => rank(a.tier) - rank(b.tier));
}

export const JOB_STATE_CLASS: Record<MemoryJobState, string> = {
  pending: "border-amber-400/60 bg-amber-400/10 text-amber-300",
  running: "border-cyan-400/60 bg-cyan-400/10 text-cyan-300",
  answered: "border-emerald-400/60 bg-emerald-400/10 text-emerald-400",
  abstained: "border-violet-400/60 bg-violet-400/10 text-violet-300",
  cancelled: "border-border text-text-dim",
};

export const JOB_MARKER_LABEL: Record<MemoryJobMarker, string> = {
  hygiene: "hygiene",
  accumulation: "accumulation",
  "shared-write-review": "shared-write review",
};

export const JOB_MARKER_CLASS: Record<MemoryJobMarker, string> = {
  hygiene: "border-teal-400/60 text-teal-300",
  accumulation: "border-indigo-400/60 text-indigo-300",
  "shared-write-review": "border-pink-400/60 text-pink-300",
};

export const RESOLUTION_POLICY_CLASS: Record<string, string> = {
  last_writer_wins: "border-amber-400/60 text-amber-300",
  evidence_weighted: "border-emerald-400/60 text-emerald-400",
  await_confirmation: "border-cyan-400/60 text-cyan-300",
  keep_both: "border-violet-400/60 text-violet-300",
};

export function resolutionPolicyClass(policy: string): string {
  return RESOLUTION_POLICY_CLASS[policy] ?? "border-border text-text";
}

/** "3s", "4m", "2h", "5d" — compact age for table cells. */
export function formatAge(epochMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - epochMs);
  if (!Number.isFinite(delta)) return "";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

/** Countdown to a deadline: "4m 12s left" or "overdue 30s". */
export function formatCountdown(deadline: number, now = Date.now()): string {
  const delta = deadline - now;
  if (!Number.isFinite(delta)) return "";
  const abs = Math.abs(delta);
  const minutes = Math.floor(abs / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1000);
  const body =
    minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : minutes > 0
        ? `${minutes}m ${seconds}s`
        : `${seconds}s`;
  return delta >= 0 ? `${body} left` : `overdue ${body}`;
}

export function cacheHitRate(cache: { hits: number; misses: number }): number {
  const total = cache.hits + cache.misses;
  return total > 0 ? cache.hits / total : 0;
}

export type HygieneStats = {
  stale: number;
  competing: number;
  pending: number;
  duplicates: number;
  overlong: number;
  unsupported: number;
};

export const HYGIENE_KEYS: (keyof HygieneStats)[] = [
  "stale",
  "competing",
  "pending",
  "duplicates",
  "overlong",
  "unsupported",
];

/**
 * Parse the hourly `[hygiene] stale=N competing=M [pending=P] duplicates=D
 * overlong=O unsupported=U` process note. Unknown keys are ignored; missing keys
 * read as 0 so the mini-stats grid is always complete.
 */
export function parseHygieneLine(line: string): HygieneStats {
  const stats: HygieneStats = {
    stale: 0,
    competing: 0,
    pending: 0,
    duplicates: 0,
    overlong: 0,
    unsupported: 0,
  };
  for (const match of line.matchAll(/\b([a-z]+)=(\d+)\b/g)) {
    const key = match[1] as keyof HygieneStats;
    if (key in stats) stats[key] = Number(match[2]);
  }
  return stats;
}

/**
 * Structural guard for the `attributes.memoryReceipt` JSON string on a trace
 * span. Returns undefined on any malformed payload so the TraceExplorer never
 * throws on a receipt from a newer or older server.
 */
export function parseReceiptAttribute(value: unknown): MemoryReceiptAttribute | undefined {
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const v = candidate as Partial<MemoryReceiptAttribute>;
  if (
    typeof v.requestId !== "string" ||
    typeof v.entity !== "string" ||
    typeof v.budgetBytes !== "number" ||
    typeof v.usedBytes !== "number" ||
    typeof v.truncated !== "boolean" ||
    !Array.isArray(v.tiers)
  ) {
    return undefined;
  }
  for (const tier of v.tiers) {
    if (
      !tier ||
      typeof tier !== "object" ||
      typeof tier.tier !== "string" ||
      typeof tier.bytes !== "number" ||
      !Array.isArray(tier.ids)
    ) {
      return undefined;
    }
  }
  return {
    schema: "marina.memory.receipt.v1",
    requestId: v.requestId,
    entity: v.entity,
    tiers: v.tiers,
    budgetBytes: v.budgetBytes,
    usedBytes: v.usedBytes,
    truncated: v.truncated,
    degraded: Array.isArray(v.degraded) ? v.degraded : [],
  };
}

/** Passthru surface chip text — `unknown` (or empty) renders as an em dash. */
export function surfaceLabel(surface: string | undefined | null): string {
  return !surface || surface === "unknown" ? "\u2014" : surface;
}

/**
 * Trace spans carry `memoryCacheHit` as the STRING "true" | "false" (span
 * attributes are stringly typed). Older servers stamped a boolean; accept both
 * and treat anything else as "not stamped".
 */
export function parseCacheHitAttribute(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function trustProfileLabel(trust: { profile: string; ungated: boolean }): string {
  const profile = trust.profile.toUpperCase();
  return trust.profile === "local" && trust.ungated ? `${profile} · ungated` : profile;
}
