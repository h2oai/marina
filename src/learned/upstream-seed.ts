// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The upstream-seed layer of default resolution — the small interface between
 * imported learned bundles and `resolveDefault` (precedence: env > local
 * per-board slot > local family slot > UPSTREAM SEED > built-in).
 *
 * A seed answers only for an EMPTY slot: when a local `benchmark_defaults`
 * row exists for the slot this returns undefined, whatever was imported. Only
 * seeds whose imported item is still active count (a retired or revoked item
 * stops seeding). An install that never imported anything has no seeds, so
 * this is always undefined there.
 */

import type { LearnedStore } from "../persistence/interfaces";
import type { BenchmarksStore } from "../persistence/interfaces/benchmarks-store";

export interface UpstreamSeed {
  slot: string;
  value: unknown;
  /** `upstream:<artifact_id>@<version>` — what an answering-layer event names. */
  source: string;
  artifactId: string;
  version: string;
  itemKey: string;
  /** The publisher's evidence summary (numbers only), when it shipped one. */
  evidence: unknown;
}

export type UpstreamSeedLookup = (slot: string) => UpstreamSeed | undefined;

export function upstreamSeedFor(
  db: Pick<LearnedStore, "latestUpstreamDefaultSeed"> &
    Pick<BenchmarksStore, "getBenchmarkDefault">,
  slot: string,
): UpstreamSeed | undefined {
  try {
    if (db.getBenchmarkDefault(slot)) return undefined;
    const row = db.latestUpstreamDefaultSeed(slot);
    if (!row) return undefined;
    return {
      slot,
      value: JSON.parse(row.value_json) as unknown,
      source: `upstream:${row.artifact_id}@${row.version}`,
      artifactId: row.artifact_id,
      version: row.version,
      itemKey: row.item_key,
      evidence: row.evidence_json ? (JSON.parse(row.evidence_json) as unknown) : null,
    };
  } catch {
    // allow-empty-catch: no migration 160/147, or an unreadable value — no seed (built-ins apply)
    return undefined;
  }
}

/** A lookup bound to one database, for `resolveDefault`'s upstream-seed hook. */
export function upstreamSeedLookup(
  db: Pick<LearnedStore, "latestUpstreamDefaultSeed"> &
    Pick<BenchmarksStore, "getBenchmarkDefault">,
): UpstreamSeedLookup {
  return (slot) => upstreamSeedFor(db, slot);
}
