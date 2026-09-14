// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * RatiosSection -- the continuous-hygiene dashboard: the ratios the memory
 * design says must be published beside any headline number. Every card shows
 * the value AND its numerator / denominator so an operator can check the
 * arithmetic; a zero denominator renders "n/a", never a fake 0 %.
 */

import type { MemoryHygieneRatios, MemoryRatio } from "../../lib/memory-observability-types";
import { formatBytes } from "./format";

type Direction = "lower" | "higher";

export interface RatioSpec {
  key: keyof Pick<
    MemoryHygieneRatios,
    | "redundancy"
    | "contradictionRate"
    | "unresolvedContradictionRate"
    | "provenanceCoverage"
    | "stalenessRatio"
    | "unsafeServedRate"
    | "reflectionRepetitionRate"
    | "consolidationRoi"
    | "repairSuccess"
  >;
  label: string;
  /** Which way is healthy. */
  better: Direction;
  /** Warn past this value (share), or below it when `better === "higher"`. */
  warnAt: number;
  /** `share` renders a percentage; `average` renders "x per lesson". */
  unit: "share" | "average";
  hint: string;
}

export const RATIO_SPECS: RatioSpec[] = [
  {
    key: "redundancy",
    label: "redundancy",
    better: "lower",
    warnAt: 0.1,
    unit: "share",
    hint: "Exact duplicates (case-folded) across fact-like notes and active records / all of them.",
  },
  {
    key: "contradictionRate",
    label: "contradiction",
    better: "lower",
    warnAt: 0.2,
    unit: "share",
    hint: "Records competing now or settled by a resolution in the window / records with a claim.",
  },
  {
    key: "unresolvedContradictionRate",
    label: "unresolved",
    better: "lower",
    warnAt: 0.5,
    unit: "share",
    hint: "Competing now / (competing now + settled in the window).",
  },
  {
    key: "provenanceCoverage",
    label: "provenance",
    better: "higher",
    warnAt: 0.5,
    unit: "share",
    hint: "Records and notes with at least one non-twin, non-envelope source / all of them.",
  },
  {
    key: "stalenessRatio",
    label: "stale",
    better: "lower",
    warnAt: 0.2,
    unit: "share",
    hint: "Records flagged stale by dependency review / active records.",
  },
  {
    key: "unsafeServedRate",
    label: "unsafe served",
    better: "lower",
    warnAt: 0.0001,
    unit: "share",
    hint: "Injected responses that cited a record already superseded, forgotten, expired or out of date at serve time / responses citing a record.",
  },
  {
    key: "reflectionRepetitionRate",
    label: "reflection repeat",
    better: "lower",
    warnAt: 0.2,
    unit: "share",
    hint: "Reflections in the window repeating an earlier reflection of the same entity / reflections in the window.",
  },
  {
    key: "consolidationRoi",
    label: "consolidation ROI",
    better: "higher",
    warnAt: 2,
    unit: "average",
    hint: "Inputs (dependencies + evidence sources) per adopted reflector lesson in the window.",
  },
  {
    key: "repairSuccess",
    label: "repair success",
    better: "higher",
    warnAt: 0.5,
    unit: "share",
    hint: "Hygiene / shared-write-review jobs answered AND followed by an adoption or resolution / such jobs that reached a final state.",
  },
];

export function formatRatio(r: MemoryRatio, unit: RatioSpec["unit"]): string {
  if (r.value === null) return "n/a";
  if (unit === "average") return `${r.value.toFixed(1)}×`;
  const pct = r.value * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

export function ratioTone(
  r: MemoryRatio,
  spec: Pick<RatioSpec, "better" | "warnAt">,
): "default" | "success" | "warning" {
  if (r.value === null) return "default";
  if (spec.better === "lower") return r.value >= spec.warnAt ? "warning" : "success";
  return r.value < spec.warnAt ? "warning" : "success";
}

const TONE_CLASS = {
  default: "text-text-bright",
  success: "text-success",
  warning: "text-warning",
} as const;

export function RatiosSection({ ratios }: { ratios: MemoryHygieneRatios }) {
  const hours = Math.round(ratios.windowMs / 3_600_000);
  return (
    <div className="space-y-2" data-testid="hygiene-ratios">
      <div className="flex items-center justify-between text-[9px] text-text-dim">
        <span>
          {ratios.scope === "all" ? "Whole instance" : "Your memory"} · windowed ratios over {hours}
          h · structural ratios over live state
        </span>
        <span title="Cross-scope reads or cancels refused since process start; cache hits cannot cross identities by construction.">
          leakage: {ratios.leakage.crossScopeAttempts} refused ·{" "}
          {ratios.leakage.crossScopeCacheHits} cache
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 sm:grid-cols-5">
        {RATIO_SPECS.map((spec) => {
          const r = ratios[spec.key];
          const tone = ratioTone(r, spec);
          return (
            <div
              key={spec.key}
              className="rounded border border-border bg-bg/40 p-1.5"
              title={spec.hint}
              data-testid={`ratio-${spec.key}`}
            >
              <div className="truncate text-[8px] uppercase text-text-dim">{spec.label}</div>
              <strong className={TONE_CLASS[tone]}>{formatRatio(r, spec.unit)}</strong>
              <div className="text-[8px] text-text-dim">
                {r.numerator} / {r.denominator}
              </div>
            </div>
          );
        })}
        <div
          className="rounded border border-border bg-bg/40 p-1.5"
          title="Injected responses in the window, average injected bytes, response-cache hit rate."
          data-testid="ratio-cost"
        >
          <div className="truncate text-[8px] uppercase text-text-dim">cost</div>
          <strong className="text-text-bright">
            {ratios.cost.avgInjectedBytes === null
              ? "n/a"
              : formatBytes(ratios.cost.avgInjectedBytes)}
          </strong>
          <div className="text-[8px] text-text-dim">
            {ratios.cost.receipts} injected · cache {formatRatio(ratios.cost.cacheHitRate, "share")}
          </div>
        </div>
      </div>
      {ratios.storage.length > 0 && (
        <div className="space-y-1" data-testid="storage-budget">
          <div className="text-[8px] uppercase text-text-dim">storage vs admission budget</div>
          {ratios.storage.map((row) => {
            const pct = row.utilization === null ? null : Math.min(100, row.utilization * 100);
            return (
              <div
                key={row.ownerName}
                className="rounded border border-border bg-bg/30 px-2 py-1"
                data-testid={`storage-${row.ownerName}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-text">{row.ownerName}</span>
                  <span className="ml-auto text-[9px] text-text-dim">
                    {formatBytes(row.logicalBytes)}
                    {row.maxBytes === null ? " · unlimited" : ` / ${formatBytes(row.maxBytes)}`} ·{" "}
                    {row.sources}
                    {row.maxSources === null ? "" : `/${row.maxSources}`} sources · {row.revisions}
                    {row.maxRevisions === null ? "" : `/${row.maxRevisions}`} revisions ·{" "}
                    {row.spaces}
                    {row.maxSpaces === null ? "" : `/${row.maxSpaces}`} spaces
                  </span>
                  {row.overLimit.length > 0 && (
                    <span className="rounded border border-danger px-1 text-[8px] uppercase text-danger">
                      over: {row.overLimit.join(", ")}
                    </span>
                  )}
                </div>
                {pct !== null && (
                  <div className="mt-1 h-1 w-full rounded bg-bg/60">
                    <div
                      className={`h-1 rounded ${pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-primary"}`}
                      style={{ width: `${Math.max(1, pct)}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
