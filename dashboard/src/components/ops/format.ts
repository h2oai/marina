// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers shared by the Admin → Ops tab, the header spend chip and the
 * agent rows in EntityRoster / AgentLaunchPanel. No React, no fetch —
 * everything here is unit-testable in isolation.
 */

import type {
  AgentOperatorRow,
  OpsAgentPauseKind,
  OpsOverview,
  OpsRetention,
  OpsSpend,
  ProviderProbeSummary,
} from "../../lib/ops-types";

// ── Money / numbers ─────────────────────────────────────────────────────────

/** Same rule as the backend `formatUsd`: two decimals from $1, four below. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.0000";
  return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
}

/** 1234 → "1.2k", 1_234_567 → "1.2M". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "850ms", "3.2s", "4m 5s", "2h 3m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "3s ago", "4m ago", "2h ago", "5d ago". */
export function formatAgo(epochMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - epochMs);
  if (!Number.isFinite(delta)) return "";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

// ── Spend ───────────────────────────────────────────────────────────────────

/** Fraction of a cap consumed; null when there is no cap. */
export function capFraction(usd: number, cap: number | null): number | null {
  if (cap === null || !(cap > 0)) return null;
  return Math.max(0, usd / cap);
}

export const SPEND_WARN_FRACTION = 0.8;

/**
 * Tone for a spend figure against a cap: `danger` at ≥ 80 % (the header chip
 * turns red), `warning` at ≥ 50 %, else `default`; `default` without a cap.
 */
export function spendTone(usd: number, cap: number | null): "default" | "warning" | "danger" {
  const fraction = capFraction(usd, cap);
  if (fraction === null) return "default";
  if (fraction >= SPEND_WARN_FRACTION) return "danger";
  if (fraction >= 0.5) return "warning";
  return "default";
}

/**
 * Whether the header chip should read red: the runtime total is at ≥ 80 % of
 * the global cap, OR any single agent is at ≥ 80 % of the per-agent cap.
 */
export function spendAtRisk(spend: OpsSpend, agents: readonly AgentOperatorRow[]): boolean {
  if (spendTone(spend.lastHourUsd, spend.caps.globalUsd) === "danger") return true;
  const perAgent = spend.caps.perAgentUsd;
  if (perAgent === null) return false;
  return agents.some((a) => spendTone(a.cost.lastHourUsd, perAgent) === "danger");
}

/** Rows ordered by rolling-hour spend, then lifetime spend; only rows that spent anything. */
export function topSpenders(agents: readonly AgentOperatorRow[], limit = 5): AgentOperatorRow[] {
  return agents
    .filter((a) => a.cost.lastHourUsd > 0 || a.cost.totalUsd > 0)
    .sort((a, b) => b.cost.lastHourUsd - a.cost.lastHourUsd || b.cost.totalUsd - a.cost.totalUsd)
    .slice(0, limit);
}

// ── Pauses ──────────────────────────────────────────────────────────────────

export const PAUSE_KIND_LABEL: Record<OpsAgentPauseKind, string> = {
  budget: "budget spent",
  "spend-cap": "spend cap",
  "upstream-errors": "upstream errors",
};

export const PAUSE_KIND_CLASS: Record<OpsAgentPauseKind, string> = {
  budget: "border-violet-400/60 bg-violet-400/10 text-violet-300",
  "spend-cap": "border-red-400/60 bg-red-400/10 text-red-300",
  "upstream-errors": "border-amber-400/60 bg-amber-400/10 text-amber-300",
};

/**
 * "resumes in 4m 5s" for a timed pause, "until cap clears" / "until stopped"
 * for an open-ended one.
 */
export function resumeLabel(
  paused: NonNullable<AgentOperatorRow["paused"]>,
  now = Date.now(),
): string {
  if (paused.until !== null) {
    const remaining = paused.until - now;
    return remaining > 0 ? `resumes in ${formatDuration(remaining)}` : "resuming";
  }
  if (paused.kind === "spend-cap") return "until the rolling hour drops below the cap";
  if (paused.kind === "budget") return "until stopped or respawned";
  return "until the cause clears";
}

// ── Lineage (for the cascade confirmation) ──────────────────────────────────

/** Names of every visible row below `name` in the spawn lineage (children first). */
export function descendantsOf(agents: readonly AgentOperatorRow[], name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (parent: string) => {
    for (const row of agents) {
      if (row.spawnedBy !== parent || row.name === parent || seen.has(row.name)) continue;
      seen.add(row.name);
      walk(row.name);
      out.push(row.name);
    }
  };
  walk(name);
  return out;
}

export function stopConfirmText(name: string, children: readonly string[]): string {
  if (children.length === 0) return `Stop agent "${name}"?`;
  return `Stop agent "${name}" and the ${children.length} agent${children.length === 1 ? "" : "s"} it spawned (${children.join(", ")})?`;
}

// ── Retention ───────────────────────────────────────────────────────────────

export const RETENTION_KIND_CLASS: Record<OpsRetention["policies"][number]["kind"], string> = {
  telemetry: "border-cyan-400/60 text-cyan-300",
  ledger: "border-amber-400/60 text-amber-300",
  audit: "border-emerald-400/60 text-emerald-400",
  "append-only": "border-violet-400/60 text-violet-300",
};

/** Tables the last pass did not touch (never pruned: append-only, or nothing was old enough). */
export function neverPruned(retention: OpsRetention): string[] {
  const deleted = new Set(Object.keys(retention.lastReport?.deleted ?? {}));
  return retention.policies.filter((p) => !deleted.has(p.table)).map((p) => p.table);
}

export function totalDeleted(report: OpsRetention["lastReport"]): number {
  if (!report) return 0;
  return Object.values(report.deleted).reduce((n, v) => n + v, 0);
}

// ── Prompt budget ───────────────────────────────────────────────────────────

export type ToolProfileName = keyof OpsOverview["prompt"]["residentSchemaBytesByProfile"];
export const TOOL_PROFILE_ORDER: readonly ToolProfileName[] = ["full", "crew", "minimal"];

// ── Providers ───────────────────────────────────────────────────────────────

/**
 * One-word verdict per provider: `ok`, `fallback` (served by another provider),
 * `tools` (text fine, tool call failed), `text` (no usable text), `error`.
 */
export function providerVerdict(
  probe: ProviderProbeSummary,
): "ok" | "fallback" | "tools" | "text" | "error" {
  if (probe.servedBy && !probe.servedBy.startsWith(`${probe.provider}/`)) return "fallback";
  if (!probe.ok || probe.error) return probe.textOk && probe.systemHonored ? "error" : "text";
  if (probe.toolCallOk === false) return "tools";
  return "ok";
}

export const PROVIDER_VERDICT_CLASS: Record<ReturnType<typeof providerVerdict>, string> = {
  ok: "border-emerald-400/60 bg-emerald-400/10 text-emerald-400",
  fallback: "border-amber-400/60 bg-amber-400/10 text-amber-300",
  tools: "border-amber-400/60 bg-amber-400/10 text-amber-300",
  text: "border-red-400/60 bg-red-400/10 text-red-300",
  error: "border-red-400/60 bg-red-400/10 text-red-300",
};

// ── Security ────────────────────────────────────────────────────────────────

export function trustProfileClass(profile: OpsOverview["security"]["trustProfile"]): string {
  switch (profile) {
    case "local":
      return "border-emerald-400/60 bg-emerald-400/10 text-emerald-400";
    case "shared":
      return "border-amber-400/60 bg-amber-400/10 text-amber-300";
    case "public":
      return "border-red-400/60 bg-red-400/10 text-red-300";
  }
}

export function autonomyClass(autonomy: OpsOverview["security"]["autonomy"]): string {
  switch (autonomy) {
    case "guarded":
      return "border-emerald-400/60 bg-emerald-400/10 text-emerald-400";
    case "earned":
      return "border-amber-400/60 bg-amber-400/10 text-amber-300";
    case "open":
      return "border-red-400/60 bg-red-400/10 text-red-300";
  }
}
