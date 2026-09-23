// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentOperatorRow, OpsSpend } from "../../lib/ops-types";
import { capFraction, formatUsd, spendTone, topSpenders } from "./format";
import { Bar, Empty, Metric } from "./primitives";

export const SPEND_EMPTY_TEXT = "No provider-reported spend in the rolling hour.";
export const SPEND_CAPS_HINT =
  "MARINA_MAX_AGENT_COST_USD_PER_HOUR / MARINA_MAX_COST_USD_PER_HOUR set the caps.";

export function SpendSection({ spend, agents }: { spend: OpsSpend; agents: AgentOperatorRow[] }) {
  const globalTone = spendTone(spend.lastHourUsd, spend.caps.globalUsd);
  const globalFraction = capFraction(spend.lastHourUsd, spend.caps.globalUsd);
  const spenders = topSpenders(agents);
  const maxHour = Math.max(...spenders.map((a) => a.cost.lastHourUsd), 0);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
        <Metric label="Last hour" value={formatUsd(spend.lastHourUsd)} tone={globalTone} />
        <Metric label="Lifetime (running)" value={formatUsd(spend.totalUsd)} />
        <Metric
          label="Global cap / h"
          value={spend.caps.globalUsd === null ? "unlimited" : formatUsd(spend.caps.globalUsd)}
          title="MARINA_MAX_COST_USD_PER_HOUR"
        />
        <Metric
          label="Per-agent cap / h"
          value={spend.caps.perAgentUsd === null ? "unlimited" : formatUsd(spend.caps.perAgentUsd)}
          title="MARINA_MAX_AGENT_COST_USD_PER_HOUR"
        />
      </div>

      {spend.caps.globalUsd !== null && (
        <div>
          <div className="mb-0.5 flex justify-between text-[9px] text-text-dim">
            <span>Runtime-wide vs cap</span>
            <span className="tabular-nums">
              {globalFraction === null ? "" : `${Math.round(globalFraction * 100)}%`}
            </span>
          </div>
          <Bar
            fraction={globalFraction}
            tone={globalTone}
            label="Runtime spend against the global cap"
          />
        </div>
      )}

      {spenders.length === 0 ? (
        <Empty>
          {SPEND_EMPTY_TEXT}{" "}
          {spend.caps.globalUsd === null && spend.caps.perAgentUsd === null && (
            <span className="text-text-dim">{SPEND_CAPS_HINT}</span>
          )}
        </Empty>
      ) : (
        <div className="space-y-1">
          <div className="text-[8px] uppercase text-text-dim">Top spenders (rolling hour)</div>
          {spenders.map((a) => {
            const cap = spend.caps.perAgentUsd;
            const tone = spendTone(a.cost.lastHourUsd, cap);
            // Against the per-agent cap when there is one, else relative to the top spender.
            const fraction =
              cap !== null
                ? capFraction(a.cost.lastHourUsd, cap)
                : maxHour > 0
                  ? a.cost.lastHourUsd / maxHour
                  : 0;
            return (
              <div key={a.name} data-testid={`ops-spender-${a.name}`}>
                <div className="flex justify-between text-[10px]">
                  <span className="truncate text-text-bright">{a.name}</span>
                  <span className="tabular-nums">
                    <span
                      className={
                        tone === "default"
                          ? "text-text"
                          : tone === "warning"
                            ? "text-warning"
                            : "text-danger"
                      }
                    >
                      {formatUsd(a.cost.lastHourUsd)}
                    </span>
                    <span className="text-text-dim"> / {formatUsd(a.cost.totalUsd)} lifetime</span>
                  </span>
                </div>
                <Bar fraction={fraction} tone={tone} label={`${a.name} rolling-hour spend`} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
