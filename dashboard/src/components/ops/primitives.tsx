// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Small presentational pieces shared by the Admin → Ops sections. `Section`
 * deliberately does NOT use the GlassPanel `title` prop: that header is the
 * react-grid-layout drag handle, so a titled GlassPanel inside the Admin body
 * would make every section header drag the Admin panel.
 */

import type { ReactNode } from "react";
import { GlassPanel } from "../GlassPanel";

export function Section({
  title,
  icon,
  children,
  extra,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <GlassPanel className="h-auto shrink-0">
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
          <span className="text-primary">{icon}</span>
          <h3 className="flex-1 font-display text-[11px] font-semibold tracking-wider text-primary uppercase">
            {title}
          </h3>
          {extra}
        </div>
        <div className="p-2">{children}</div>
      </GlassPanel>
    </section>
  );
}

export function Placeholder() {
  return <div className="text-text-dim">Waiting for the ops overview…</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-text-dim">{children}</div>;
}

export type Tone = "default" | "success" | "warning" | "danger";

const TONE_TEXT: Record<Tone, string> = {
  default: "text-text-bright",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export function Metric({
  label,
  value,
  tone = "default",
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <div className="rounded border border-border bg-bg/40 p-1.5" title={title}>
      <div className="truncate text-[8px] uppercase text-text-dim">{label}</div>
      <strong className={TONE_TEXT[tone]}>{value}</strong>
    </div>
  );
}

export function Chip({
  children,
  className = "border-border text-text",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1 py-px text-[9px] leading-tight ${className}`}
      title={title}
    >
      {children}
    </span>
  );
}

const BAR_FILL: Record<Tone, string> = {
  default: "bg-primary/70",
  success: "bg-success/80",
  warning: "bg-warning/80",
  danger: "bg-danger/80",
};

/**
 * Horizontal meter; `fraction` > 1 is clamped, `null` renders an empty track.
 * Decorative: every caller prints the number beside it, so it is hidden from
 * assistive tech and `label` only feeds the tooltip.
 */
export function Bar({
  fraction,
  tone = "default",
  label,
}: {
  fraction: number | null;
  tone?: Tone;
  label?: string;
}) {
  const pct = fraction === null ? 0 : Math.min(100, Math.max(0, fraction * 100));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded bg-border/60"
      aria-hidden="true"
      title={label}
    >
      <div className={`h-full ${BAR_FILL[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function OnOff({
  on,
  onLabel = "on",
  offLabel = "off",
}: {
  on: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <Chip
      className={
        on
          ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-400"
          : "border-border text-text-dim"
      }
    >
      {on ? onLabel : offLabel}
    </Chip>
  );
}
