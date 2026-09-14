// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { formatBytes, sortTiers, tierColor } from "./format";

export interface TierBarSegment {
  tier: string;
  bytes: number;
  count?: number;
}

/**
 * Stacked horizontal bar: each tier's width is its byte share of the total
 * injected bytes; the unused remainder up to `budgetBytes` is left as track.
 * Each segment exposes its tier/bytes via `title` and a data attribute so tests
 * and hover both read the same numbers.
 */
export function TierBars({
  tiers,
  budgetBytes,
  className,
}: {
  tiers: readonly TierBarSegment[];
  budgetBytes?: number;
  className?: string;
}) {
  const ordered = sortTiers(tiers).filter((tier) => tier.bytes > 0);
  const used = ordered.reduce((sum, tier) => sum + tier.bytes, 0);
  const scale = Math.max(budgetBytes ?? 0, used, 1);
  return (
    <figure
      className={`m-0 flex h-2 w-full overflow-hidden rounded-sm border border-border bg-bg ${className ?? ""}`}
      aria-label="Memory tiers by bytes"
      data-testid="tier-bars"
    >
      {ordered.map((tier) => (
        <span
          key={tier.tier}
          data-tier={tier.tier}
          data-bytes={tier.bytes}
          title={`${tier.tier}: ${formatBytes(tier.bytes)}${
            typeof tier.count === "number"
              ? ` · ${tier.count} item${tier.count === 1 ? "" : "s"}`
              : ""
          }`}
          style={{ width: `${(tier.bytes / scale) * 100}%`, background: tierColor(tier.tier) }}
          className="h-full shrink-0"
        />
      ))}
    </figure>
  );
}

/** Small legend chips — tier swatch + count/bytes — rendered under a bar. */
export function TierLegend({ tiers }: { tiers: readonly TierBarSegment[] }) {
  const ordered = sortTiers(tiers);
  if (ordered.length === 0) return <span className="text-text-dim">no tiers injected</span>;
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-text-dim">
      {ordered.map((tier) => (
        <span key={tier.tier} className="inline-flex items-center gap-1">
          <span
            className="inline-block h-1.5 w-1.5 rounded-sm"
            style={{ background: tierColor(tier.tier) }}
          />
          <span className="text-text">{tier.tier}</span>
          {typeof tier.count === "number" && <span>×{tier.count}</span>}
          <span>{formatBytes(tier.bytes)}</span>
        </span>
      ))}
    </div>
  );
}
