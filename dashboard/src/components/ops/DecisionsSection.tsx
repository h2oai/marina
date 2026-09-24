// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { OpsDecisions } from "../../lib/ops-types";
import { formatAgo } from "./format";
import { Chip, Metric } from "./primitives";

export const DECISIONS_OFF_TEXT =
  "No decision backend is configured (MARINA_DECISIONS). Route, gate and verify decisions appear here once one is.";
export const DECISIONS_EMPTY_TEXT = "No decisions in the last 24 h.";

const VERDICT_CLASS: Record<string, string> = {
  allow: "border-success/60 text-success",
  accept: "border-success/60 text-success",
  approved: "border-success/60 text-success",
  ask: "border-warning/60 text-warning",
  retry: "border-warning/60 text-warning",
  block: "border-danger/60 text-danger",
  denied: "border-danger/60 text-danger",
  timeout: "border-danger/60 text-danger",
};

function verdictClass(verdict: string): string {
  return VERDICT_CLASS[verdict] ?? "border-border text-text";
}

/** Top numbers from a decision's signals, e.g. "destructive 0.83 · unauthorized 0.10". */
export function signalSummary(signals: Record<string, number | string>, max = 3): string {
  return Object.entries(signals)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key, value]) => `${key} ${value.toFixed(2)}`)
    .join(" · ");
}

export function DecisionsSection({ decisions }: { decisions: OpsDecisions }) {
  if (!decisions.configured) return <div className="text-text-dim">{DECISIONS_OFF_TEXT}</div>;
  const total = (stage: string) =>
    Object.values(decisions.counts[stage] ?? {}).reduce((sum, n) => sum + n, 0);
  const held = (decisions.counts.gate?.ask ?? 0) + (decisions.counts.gate?.block ?? 0);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
        <Metric
          label="Backend"
          value={decisions.model ?? "—"}
          title={`${decisions.backend ?? ""}${decisions.calibrated === false ? " · uncalibrated (one threshold)" : ""}`}
          tone={decisions.calibrated === false ? "warning" : "default"}
        />
        <Metric
          label="Gate decisions"
          value={total("gate")}
          title={decisions.gate ? "MARINA_DECISION_GATE=on" : "gate off"}
        />
        <Metric label="Held or blocked" value={held} tone={held > 0 ? "warning" : "default"} />
        <Metric
          label="Routes · verifies"
          value={`${total("route")} · ${total("verify")}`}
          title={decisions.verify ? "MARINA_DECISION_VERIFY=on" : "verifier off"}
        />
      </div>
      {decisions.recent.length === 0 ? (
        <div className="text-text-dim">{DECISIONS_EMPTY_TEXT}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[10px]">
            <thead className="text-[8px] uppercase text-text-dim">
              <tr>
                <th className="py-0.5 pr-2">When</th>
                <th className="py-0.5 pr-2">Who</th>
                <th className="py-0.5 pr-2">Stage</th>
                <th className="py-0.5 pr-2">Verdict</th>
                <th className="py-0.5 pr-2">Subject</th>
                <th className="py-0.5">Signals</th>
              </tr>
            </thead>
            <tbody>
              {decisions.recent.map((row) => (
                <tr
                  key={`${row.timestamp}-${row.name}-${row.stage}-${row.subject}`}
                  className="border-t border-border/40"
                  title={row.error ? `${row.reason} — ${row.error}` : row.reason}
                >
                  <td className="py-0.5 pr-2 text-text-dim">{formatAgo(row.timestamp)}</td>
                  <td className="py-0.5 pr-2">{row.name}</td>
                  <td className="py-0.5 pr-2 text-text-dim">{row.stage}</td>
                  <td className="py-0.5 pr-2">
                    <Chip className={verdictClass(row.verdict)}>{row.verdict}</Chip>
                  </td>
                  <td className="py-0.5 pr-2 font-mono">{row.subject}</td>
                  <td className="py-0.5 tabular-nums text-text-dim">
                    {signalSummary(row.signals) || "—"}
                    {row.latencyMs !== undefined ? ` · ${row.latencyMs}ms` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
