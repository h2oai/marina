// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo } from "react";
import { useWorldState } from "../hooks/use-world-state";
import { PRESENCE_COLORS, presenceLabel } from "../lib/presence";

/**
 * An entity's name as `who` shows it: a supervised resident carries its
 * vendor tag (`Wren [claude]`), and any agent with a presence status carries
 * it as a small dot + label. Display only — commands always take the plain
 * name. Vendor and presence come from the world snapshot unless passed in.
 */
export const ResidentName = memo(function ResidentName({
  name,
  vendor,
  presence,
  showPresence = true,
}: {
  name: string;
  vendor?: string;
  presence?: string;
  showPresence?: boolean;
}) {
  const live = useWorldState((s) => s.entities.find((e) => e.name === name));
  const tag = (vendor ?? live?.vendor)?.trim();
  const status = presence ?? live?.presence;
  return (
    <span data-testid="resident-name" className="inline-flex min-w-0 items-baseline gap-1">
      <span className="truncate">{name}</span>
      {tag && (
        <span
          className="shrink-0 text-[0.8em] opacity-75"
          style={{ color: "var(--color-accent, #38bdf8)" }}
          title={`Supervised resident running ${tag}`}
        >
          [{tag}]
        </span>
      )}
      {showPresence && status && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 text-[0.75em]"
          style={{ color: PRESENCE_COLORS[status] ?? "var(--color-text-dim)" }}
          title={`Presence: ${presenceLabel(status)}`}
        >
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: PRESENCE_COLORS[status] ?? "currentColor" }}
          />
          {presenceLabel(status)}
        </span>
      )}
    </span>
  );
});
