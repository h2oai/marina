// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Header spend chip: rolling-hour USD across the agents the caller may see,
 * red once the runtime is at ≥ 80 % of the global cap or any agent is at
 * ≥ 80 % of the per-agent cap. Hidden until the overview loads; shows even at
 * $0 when a cap is configured so the operator sees the ceiling exists.
 * Click opens Admin → Ops.
 */

import { Coins } from "lucide-react";
import { useOpsOverview } from "../../hooks/use-api";
import type { OpsOverview } from "../../lib/ops-types";
import { OPS_TAB, openAdminTab } from "./admin-link";
import { formatUsd, spendAtRisk } from "./format";

export function spendChipVisible(overview: OpsOverview): boolean {
  return (
    overview.spend.lastHourUsd > 0 ||
    overview.spend.caps.globalUsd !== null ||
    overview.spend.caps.perAgentUsd !== null
  );
}

export function SpendChip({ overview: override }: { overview?: OpsOverview } = {}) {
  const query = useOpsOverview();
  const overview = override ?? query.data;
  if (!overview || !spendChipVisible(overview)) return null;
  const atRisk = spendAtRisk(overview.spend, overview.agents);
  const cap = overview.spend.caps.globalUsd;
  return (
    <button
      type="button"
      onClick={() => openAdminTab(OPS_TAB)}
      className={`flex items-center gap-1.5 rounded border px-2 py-0.5 tabular-nums transition-colors ${
        atRisk
          ? "border-danger/50 bg-danger/10 text-danger hover:border-danger/70"
          : "border-border bg-bg/40 text-text-dim hover:border-primary/60 hover:text-primary"
      }`}
      title={
        atRisk
          ? "Spend is within 20 % of a cap — open Admin → Ops"
          : `Rolling-hour spend${cap !== null ? ` (cap ${formatUsd(cap)}/h)` : ""} — open Admin → Ops`
      }
      data-testid="spend-chip"
      data-at-risk={atRisk ? "true" : "false"}
    >
      <Coins size={11} className={atRisk ? "animate-pulse" : ""} />
      <span>{formatUsd(overview.spend.lastHourUsd)}/h</span>
    </button>
  );
}
