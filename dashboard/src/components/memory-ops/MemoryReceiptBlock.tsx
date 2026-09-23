// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MemoryReceiptAttribute } from "../../lib/memory-observability-types";
import { formatBytes, surfaceLabel } from "./format";
import { TierBars, TierLegend } from "./TierBars";

/**
 * The "Memory" block rendered inside a trace span when the span carries a
 * `marina.memory.receipt.v1` receipt. Mirrors what `trace show <id>` prints:
 * tiers with counts/bytes, used/budget, truncated, cache hit, degraded tiers,
 * plus the passthru `surface` the span was stamped with.
 */
export function MemoryReceiptBlock({
  receipt,
  cacheHit,
  surface,
}: {
  receipt: MemoryReceiptAttribute;
  cacheHit?: boolean;
  surface?: string;
}) {
  const segments = receipt.tiers.map((tier) => ({
    tier: tier.tier,
    bytes: tier.bytes,
    count: tier.ids.length,
  }));
  const pct =
    receipt.budgetBytes > 0 ? Math.round((receipt.usedBytes / receipt.budgetBytes) * 100) : 0;
  return (
    <section
      className="mt-1 rounded border border-border/70 bg-bg/40 px-2 py-1 text-[9px]"
      aria-label="Memory receipt"
    >
      <div className="mb-0.5 flex items-center gap-2">
        <span className="uppercase tracking-wider text-primary">Memory</span>
        <span className="text-text-dim">{receipt.entity}</span>
        {surface !== undefined && (
          <span
            className="rounded border border-cyan-400/60 px-1 text-cyan-300"
            title="passthru surface"
            data-testid="receipt-surface"
          >
            {surfaceLabel(surface)}
          </span>
        )}
        <span className="ml-auto text-text-dim">
          {formatBytes(receipt.usedBytes)} / {formatBytes(receipt.budgetBytes)} ({pct}%)
        </span>
        {receipt.truncated && <span className="text-amber-300">truncated</span>}
        {cacheHit === true && <span className="text-emerald-400">cache hit</span>}
        {cacheHit === false && <span className="text-text-dim">cache miss</span>}
      </div>
      <TierBars tiers={segments} budgetBytes={receipt.budgetBytes} className="mb-1" />
      <TierLegend tiers={segments} />
      {receipt.degraded.length > 0 && (
        <div className="mt-0.5 text-amber-300" title={receipt.degraded.join(", ")}>
          degraded: {receipt.degraded.join(", ")}
        </div>
      )}
    </section>
  );
}
