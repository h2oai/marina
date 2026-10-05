// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The spec sheet (`spec.json`) of a learned bundle: what is in it and how well
 * it is evidenced, so a reader can judge it before importing. Phase 1 fills
 * counts, rank distribution, judge labels, confirmation rates, default
 * evidence summaries, scan audit counts and tier sizes. Parity results (this
 * version vs none, single-model arm included) are a later phase.
 */

import type { MarinaDB } from "../persistence/database";
import {
  ITEM_KINDS,
  type ItemKind,
  type LearnedItem,
  SPEC_SCHEMA,
  TIERS,
  type Tier,
} from "./format";
import type { BenchmarkTextIndex } from "./scan";

export interface SpecSheet {
  schema: typeof SPEC_SCHEMA;
  artifact_id: string;
  version: string;
  generation: number;
  min_marina_version: string;
  counts: {
    total: number;
    by_kind: Record<ItemKind, number>;
    by_domain: Record<string, number>;
    by_tier: Record<Tier, number>;
    by_trust_at_source: Record<string, number>;
  };
  /** Publisher ranks of lessons (judge scores), when any lesson carries one. */
  ranks: { n: number; mean: number; histogram: Record<string, number> } | null;
  judges: { label: string; calibrated: boolean; n: number }[];
  /**
   * Items the publisher itself imported and later confirmed by local outcomes
   * — the publisher's own record of how imported knowledge held up.
   */
  confirmation: { imported: number; confirmed: number; rate: number | null };
  defaults: {
    slot: string;
    outcome: string;
    n?: number;
    delta?: number;
    low?: number;
    high?: number;
    replicates?: number;
  }[];
  evidence: { cells: number; items: number; families: number };
  scan: {
    considered: number;
    exported: number;
    dropped: number;
    by_reason: Record<string, number>;
    benchmark_corpora: number;
    benchmark_texts: number;
  };
  tier_bytes: Record<Tier, number>;
  parity: null;
}

export function buildSpec(input: {
  db: MarinaDB;
  artifactId: string;
  version: string;
  generation: number;
  items: readonly LearnedItem[];
  dropped: readonly { reason: string }[];
  considered: number;
  benchmarkIndex?: BenchmarkTextIndex;
  minMarinaVersion: string;
  renderedBytes: (i: LearnedItem) => number;
}): SpecSheet {
  const { items } = input;
  const byKind = Object.fromEntries(ITEM_KINDS.map((k) => [k, 0])) as Record<ItemKind, number>;
  const byTier = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  const byDomain: Record<string, number> = {};
  const byTrust: Record<string, number> = {};
  const tierBytes = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  const tierOrder: Record<Tier, number> = { core: 0, standard: 1, full: 2 };
  for (const i of items) {
    byKind[i.kind]++;
    byTier[i.tier]++;
    byDomain[i.domain] = (byDomain[i.domain] ?? 0) + 1;
    if (i.kind === "lesson") byTrust[i.trust_at_source] = (byTrust[i.trust_at_source] ?? 0) + 1;
    const b = input.renderedBytes(i);
    for (const t of TIERS) if (tierOrder[i.tier] <= tierOrder[t]) tierBytes[t] += b;
  }
  const ranked = items.filter(
    (i): i is LearnedItem & { rank: number } => i.kind === "lesson" && typeof i.rank === "number",
  );
  const histogram: Record<string, number> = {};
  for (const i of ranked) {
    const lo = Math.min(4, Math.max(0, Math.floor(i.rank * 5)));
    const label = `${(lo / 5).toFixed(1)}-${((lo + 1) / 5).toFixed(1)}`;
    histogram[label] = (histogram[label] ?? 0) + 1;
  }
  const judges = new Map<string, { label: string; calibrated: boolean; n: number }>();
  for (const i of items) {
    if (i.kind !== "lesson" || !i.judge) continue;
    const j = judges.get(i.judge) ?? {
      label: i.judge,
      calibrated: !/uncalibrated/i.test(i.judge),
      n: 0,
    };
    j.n++;
    judges.set(i.judge, j);
  }
  let imported = 0;
  let confirmed = 0;
  try {
    for (const row of input.db.listLearnedItems({ limit: 100_000 })) {
      if (row.kind !== "lesson") continue;
      imported++;
      if (row.confirmed_by) confirmed++;
    }
  } catch {
    // allow-empty-catch: a database without migration 161 has imported nothing
  }
  const evidence = items.filter((i) => i.kind === "evidence");
  return {
    schema: SPEC_SCHEMA,
    artifact_id: input.artifactId,
    version: input.version,
    generation: input.generation,
    min_marina_version: input.minMarinaVersion,
    counts: {
      total: items.length,
      by_kind: byKind,
      by_domain: byDomain,
      by_tier: byTier,
      by_trust_at_source: byTrust,
    },
    ranks: ranked.length
      ? {
          n: ranked.length,
          mean: Math.round((ranked.reduce((s, i) => s + i.rank, 0) / ranked.length) * 1e4) / 1e4,
          histogram,
        }
      : null,
    judges: [...judges.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    confirmation: {
      imported,
      confirmed,
      rate: imported > 0 ? Math.round((confirmed / imported) * 1e4) / 1e4 : null,
    },
    defaults: items.flatMap((i) =>
      i.kind === "default"
        ? [
            {
              slot: i.slot,
              outcome: i.evidence?.outcome ?? "unknown",
              ...(i.evidence?.n !== undefined ? { n: i.evidence.n } : {}),
              ...(i.evidence?.delta !== undefined ? { delta: i.evidence.delta } : {}),
              ...(i.evidence?.low !== undefined ? { low: i.evidence.low } : {}),
              ...(i.evidence?.high !== undefined ? { high: i.evidence.high } : {}),
              ...(i.evidence?.replicates !== undefined
                ? { replicates: i.evidence.replicates }
                : {}),
            },
          ]
        : [],
    ),
    evidence: {
      cells: evidence.length,
      items: evidence.reduce((s, i) => s + (i.kind === "evidence" ? i.n : 0), 0),
      families: new Set(evidence.map((i) => (i.kind === "evidence" ? i.family : ""))).size,
    },
    scan: {
      considered: input.considered,
      exported: items.length,
      dropped: input.dropped.length,
      by_reason: input.dropped.reduce<Record<string, number>>((acc, d) => {
        acc[d.reason] = (acc[d.reason] ?? 0) + 1;
        return acc;
      }, {}),
      benchmark_corpora: input.benchmarkIndex?.corpora ?? 0,
      benchmark_texts: input.benchmarkIndex?.texts ?? 0,
    },
    tier_bytes: tierBytes,
    parity: null,
  };
}
