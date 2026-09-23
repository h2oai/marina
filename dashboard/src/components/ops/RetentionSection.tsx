// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { OpsRetention } from "../../lib/ops-types";
import {
  formatAgo,
  formatDuration,
  neverPruned,
  RETENTION_KIND_CLASS,
  totalDeleted,
} from "./format";
import { Chip, Metric } from "./primitives";

export const RETENTION_NO_PASS_TEXT = "No retention pass has run in this process yet (hourly).";

export function RetentionSection({ retention }: { retention: OpsRetention }) {
  const report = retention.lastReport;
  const untouched = neverPruned(retention);
  const deletedTables = report ? Object.entries(report.deleted).sort((a, b) => b[1] - a[1]) : [];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-4">
        <Metric
          label="Last pass"
          value={report ? formatAgo(report.at) : "never"}
          tone={report ? "default" : "warning"}
          title={report ? new Date(report.at).toISOString() : RETENTION_NO_PASS_TEXT}
        />
        <Metric label="Duration" value={report ? formatDuration(report.durationMs) : "—"} />
        <Metric label="Rows deleted" value={report ? totalDeleted(report).toLocaleString() : "—"} />
        <Metric
          label="Skipped tables"
          value={report ? report.skipped.length : "—"}
          title={report?.skipped.join(", ") || "Tables or columns missing from this database"}
        />
      </div>
      {!report && <div className="text-text-dim">{RETENTION_NO_PASS_TEXT}</div>}

      {deletedTables.length > 0 && (
        <div>
          <div className="text-[8px] uppercase text-text-dim">Deleted in the last pass</div>
          <div className="flex flex-wrap gap-1 pt-0.5">
            {deletedTables.map(([table, n]) => (
              <Chip key={table} className="border-border text-text">
                {table} <span className="tabular-nums text-text-dim">{n.toLocaleString()}</span>
              </Chip>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-[10px]">
          <thead className="text-[8px] uppercase text-text-dim">
            <tr>
              <th className="py-0.5 pr-2">Table</th>
              <th className="py-0.5 pr-2">Kind</th>
              <th className="py-0.5 pr-2">Keep</th>
              <th className="py-0.5 pr-2">Override</th>
              <th className="py-0.5">Note</th>
            </tr>
          </thead>
          <tbody>
            {retention.policies.map((p) => (
              <tr key={p.table} className="border-t border-border/60">
                <td className="py-0.5 pr-2 font-mono text-text-bright">{p.table}</td>
                <td className="py-0.5 pr-2">
                  <Chip className={RETENTION_KIND_CLASS[p.kind]}>{p.kind}</Chip>
                </td>
                <td className="py-0.5 pr-2 tabular-nums">{p.keep}</td>
                <td className="py-0.5 pr-2">
                  {p.overridden ? (
                    <Chip
                      className="border-amber-400/60 text-amber-300"
                      title="MARINA_RETENTION_OVERRIDES"
                    >
                      overridden
                    </Chip>
                  ) : (
                    <span className="text-text-dim">—</span>
                  )}
                </td>
                <td className="py-0.5 text-text-dim">{p.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {untouched.length > 0 && (
        <div className="text-[9px] text-text-dim">
          <span className="uppercase">Never pruned{report ? " (last pass)" : ""}:</span>{" "}
          {untouched.join(", ")}
        </div>
      )}
    </div>
  );
}
