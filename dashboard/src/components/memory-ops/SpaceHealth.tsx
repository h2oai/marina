// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * SpaceHealth -- the "Spaces" section: one row per shared / institutional
 * memory space from `MemoryOverview.spaces.shared`, rendered in the order the
 * server delivered. Each row shows the writer mix (fresh-writer share as a
 * bar) because a space where most writers are new AND there are several of
 * them is Sybil-shaped — the row takes the warn tone so an operator sees it
 * before reputation-weighted retrieval has to.
 *
 * Clicking a row dispatches `marina:focus-space` on `window` with
 * `{ detail: { spaceId } }`. Nothing listens yet; the canvas MEMORY layer may
 * pick it up later to centre the space hull, exactly like the Admin hand-off
 * in `unified/lib/memory-map-admin-link.ts` works in the other direction.
 */

import { Box, Landmark } from "lucide-react";
import type { ReactNode } from "react";
import type { MemorySpaceHealth } from "../../lib/memory-observability-types";
import { formatAge } from "./format";
import { formatRatio } from "./RatiosSection";

export const FOCUS_SPACE_EVENT = "marina:focus-space";
export type FocusSpaceDetail = { spaceId: string };

/** Fresh-writer share at or above this, with at least `SYBIL_MIN_WRITERS`, warns. */
export const SYBIL_FRESH_SHARE = 0.5;
export const SYBIL_MIN_WRITERS = 3;

export function sybilSignal(space: Pick<MemorySpaceHealth, "writers" | "freshWriterShare">) {
  const share = space.freshWriterShare.value;
  return share !== null && share >= SYBIL_FRESH_SHARE && space.writers >= SYBIL_MIN_WRITERS;
}

export function focusSpace(spaceId: string): void {
  window.dispatchEvent(
    new CustomEvent<FocusSpaceDetail>(FOCUS_SPACE_EVENT, { detail: { spaceId } }),
  );
}

export function SpacesSection({ spaces }: { spaces: MemorySpaceHealth[] }) {
  if (spaces.length === 0) {
    return (
      <div className="rounded border border-border p-2 text-text-dim">
        No institutional spaces reported. <code>guide</code> is seeded on first boot and tradition
        pools are created lazily — if this stays empty after boot, check <code>readiness</code>.
      </div>
    );
  }
  return (
    <div className="grid gap-1 md:grid-cols-2" data-testid="space-health">
      {spaces.map((space) => (
        <SpaceRow key={space.id} space={space} />
      ))}
    </div>
  );
}

function SpaceRow({ space }: { space: MemorySpaceHealth }) {
  const warn = sybilSignal(space);
  const share = space.freshWriterShare.value;
  const sharePct = share === null ? 0 : Math.min(100, Math.round(share * 100));
  const writersTitle =
    share === null
      ? "No writers in the window."
      : `${space.freshWriters} of ${space.writers} writers are new in the window (${sharePct}%).${
          warn ? " Sybil-shaped: mostly fresh writers, several of them." : ""
        }`;
  return (
    <button
      type="button"
      onClick={() => focusSpace(space.id)}
      data-testid={`space-${space.id}`}
      data-warn={warn ? "true" : undefined}
      title={`Focus ${space.name} on the canvas (${space.id})`}
      className={`rounded border bg-bg/30 px-2 py-1 text-left transition-colors hover:border-primary/60 ${
        warn ? "border-warning/60" : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {space.institutional ? (
          <Landmark size={10} className="text-primary" />
        ) : (
          <Box size={10} className="text-text-dim" />
        )}
        <span className="text-text">{space.name}</span>
        {space.institutional && (
          <span className="rounded border border-emerald-400/60 px-1.5 py-0.5 text-[9px] uppercase text-emerald-400">
            institutional
          </span>
        )}
        <span className="text-[9px] text-text-dim">owner {space.ownerName}</span>
        <span
          className="ml-auto text-[9px] text-text-dim"
          title={
            space.lastWriteAt === null ? undefined : new Date(space.lastWriteAt).toLocaleString()
          }
        >
          {space.lastWriteAt === null
            ? "no writes yet"
            : `last write ${formatAge(space.lastWriteAt)} ago`}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-4 gap-1">
        <Stat label="records / ratified">
          {space.records} / <span className="text-emerald-400">{space.ratified}</span>
        </Stat>
        <Stat label="competing" tone={space.competing > 0 ? "warning" : "default"}>
          {space.competing}
        </Stat>
        <Stat label="resolutions 24h">{space.resolutions24h}</Stat>
        <Stat
          label="unresolved"
          tone={
            space.unresolvedContradictionRate.value !== null &&
            space.unresolvedContradictionRate.value >= 0.5
              ? "warning"
              : "default"
          }
          title={`${space.unresolvedContradictionRate.numerator} / ${space.unresolvedContradictionRate.denominator}`}
        >
          {formatRatio(space.unresolvedContradictionRate, "share")}
        </Stat>
      </div>
      <div className="mt-1" title={writersTitle} data-testid={`space-writers-${space.id}`}>
        <div className="flex items-center gap-1 text-[9px] text-text-dim">
          <span>
            writers <span className="text-text">{space.writers}</span>
          </span>
          <span>
            · <span className={warn ? "text-warning" : "text-text"}>{space.freshWriters}</span>{" "}
            fresh{share === null ? "" : ` (${sharePct}%)`}
          </span>
        </div>
        <div className="mt-0.5 h-1 w-full rounded bg-bg/60">
          <div
            className={`h-1 rounded ${warn ? "bg-warning" : "bg-primary"}`}
            style={{ width: `${sharePct}%` }}
            data-testid={`space-fresh-bar-${space.id}`}
          />
        </div>
      </div>
    </button>
  );
}

function Stat({
  label,
  children,
  tone = "default",
  title,
}: {
  label: string;
  children: ReactNode;
  tone?: "default" | "warning";
  title?: string;
}) {
  return (
    <div className="rounded border border-border bg-bg/40 p-1" title={title}>
      <div className="truncate text-[8px] uppercase text-text-dim">{label}</div>
      <strong className={tone === "warning" ? "text-warning" : "text-text-bright"}>
        {children}
      </strong>
    </div>
  );
}
