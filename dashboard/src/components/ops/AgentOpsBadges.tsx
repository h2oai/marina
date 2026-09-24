// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-agent-row cost + pause badges shared by EntityRoster and
 * AgentLaunchContent, fed by the same `AgentOperatorRow` the Admin → Ops table
 * shows. Renders nothing until the ops overview has loaded (or when the row
 * is outside the caller's scope), so the rows never flash placeholders.
 */

import type { AgentOperatorRow } from "../../lib/ops-types";
import { formatUsd, PAUSE_KIND_CLASS, PAUSE_KIND_LABEL, resumeLabel } from "./format";

/** Rows keyed by agent name (case-preserving, as the runtime reports them). */
export function opsRowsByName(
  rows: readonly AgentOperatorRow[] | undefined,
): Record<string, AgentOperatorRow> {
  const out: Record<string, AgentOperatorRow> = {};
  for (const row of rows ?? []) out[row.name] = row;
  return out;
}

export function AgentOpsBadges({ row }: { row: AgentOperatorRow | undefined }) {
  if (!row) return null;
  return (
    <>
      {row.cost.lastHourUsd > 0 && (
        <span
          className="shrink-0 text-[9px] tabular-nums text-text-dim"
          title={`${formatUsd(row.cost.lastHourUsd)} in the last hour · ${formatUsd(row.cost.totalUsd)} lifetime`}
          data-testid={`ops-cost-${row.name}`}
        >
          {formatUsd(row.cost.lastHourUsd)}/h
        </span>
      )}
      {row.paused && (
        <span
          className={`shrink-0 rounded border px-1 text-[8px] uppercase leading-tight ${PAUSE_KIND_CLASS[row.paused.kind]}`}
          title={`${row.paused.reason} — ${resumeLabel(row.paused)}`}
          data-testid={`ops-paused-${row.name}`}
        >
          paused · {PAUSE_KIND_LABEL[row.paused.kind]}
        </span>
      )}
    </>
  );
}
