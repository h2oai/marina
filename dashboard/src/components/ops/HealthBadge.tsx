// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compact capability-health badge for the header: `ok / degraded / off`
 * counts from `GET /api/readiness`, a hover/focus popover listing every
 * non-ok capability with its remediation, and a click that opens Admin →
 * Readiness (the `marina:open-admin` hand-off with `tab: "readiness"`).
 */

import { HeartPulse } from "lucide-react";
import { useId, useState } from "react";
import { useReadiness } from "../../hooks/use-api";
import type { ReadinessCheck, ReadinessReport } from "../../lib/types";
import { openAdminTab, READINESS_TAB } from "./admin-link";

export type HealthCounts = { ok: number; degraded: number; off: number };

export function healthCounts(checks: readonly ReadinessCheck[]): HealthCounts {
  const counts: HealthCounts = { ok: 0, degraded: 0, off: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

/** Degraded first, then off — the popover order. */
export function attentionChecks(checks: readonly ReadinessCheck[]): ReadinessCheck[] {
  return checks
    .filter((c) => c.status !== "ok")
    .sort((a, b) => (a.status === b.status ? 0 : a.status === "degraded" ? -1 : 1));
}

export function healthTone(counts: HealthCounts): "success" | "warning" | "danger" {
  if (counts.degraded > 0) return "warning";
  if (counts.off > 0 && counts.ok === 0) return "danger";
  return "success";
}

const TONE_CLASS = {
  success:
    "border-success/30 bg-success/5 text-success hover:border-success/60 hover:bg-success/10",
  warning: "border-warning/40 bg-warning/10 text-warning hover:border-warning/60",
  danger: "border-danger/50 bg-danger/10 text-danger hover:border-danger/70",
} as const;

const STATUS_CLASS: Record<ReadinessCheck["status"], string> = {
  ok: "text-success",
  degraded: "text-warning",
  off: "text-text-dim",
};

export function HealthBadge({ report: reportOverride }: { report?: ReadinessReport } = {}) {
  const query = useReadiness();
  const report = reportOverride ?? query.data;
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  if (!report) return null;

  const counts = healthCounts(report.checks);
  const attention = attentionChecks(report.checks);
  const tone = healthTone(counts);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => openAdminTab(READINESS_TAB)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-describedby={open ? popoverId : undefined}
        aria-label={`Capability health: ${counts.ok} ok, ${counts.degraded} degraded, ${counts.off} off`}
        className={`flex items-center gap-1.5 rounded border px-2 py-0.5 transition-colors ${TONE_CLASS[tone]}`}
        title="Capability readiness — click to open Admin → Readiness"
        data-testid="health-badge"
      >
        <HeartPulse size={11} className={tone === "danger" ? "animate-pulse" : ""} />
        <span className="tabular-nums">
          <span className="text-success">{counts.ok}</span>
          <span className="text-text-dim">/</span>
          <span className={counts.degraded ? "text-warning" : "text-text-dim"}>
            {counts.degraded}
          </span>
          <span className="text-text-dim">/</span>
          <span className={counts.off ? "text-text" : "text-text-dim"}>{counts.off}</span>
        </span>
        <span className="hidden xl:inline">health</span>
      </button>
      {/* Padding (not margin) bridges the gap so moving onto the popover keeps it open. */}
      {open && (
        <div
          id={popoverId}
          role="tooltip"
          className="absolute right-0 top-full z-50 w-72 pt-1"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          data-testid="health-popover"
        >
          <div className="glass-panel space-y-1 rounded border border-border p-2 text-left text-[10px] shadow-lg">
            <div className="text-text-dim">
              {counts.ok} ok · {counts.degraded} degraded · {counts.off} off
            </div>
            {attention.length === 0 ? (
              <div className="text-success">Every capability is ready.</div>
            ) : (
              <ul className="space-y-1">
                {attention.map((check) => (
                  <li
                    key={check.id}
                    className="border-t border-border/60 pt-1 first:border-t-0 first:pt-0"
                  >
                    <div className="flex items-center gap-1">
                      <span className={`uppercase text-[8px] ${STATUS_CLASS[check.status]}`}>
                        {check.status}
                      </span>
                      <span className="text-text-bright">{check.label}</span>
                    </div>
                    {check.remediation && (
                      <div className="text-text-dim">→ {check.remediation}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="text-text-dim">Click the badge for Admin → Readiness.</div>
          </div>
        </div>
      )}
    </div>
  );
}
