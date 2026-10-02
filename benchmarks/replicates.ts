// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Harness-side replicate helpers: `--replicates N` runs the same target N
 * times on the same items (same seed and slice) and the same judge; each run
 * keeps its own result file and is filed under one replicate group, and the
 * harness prints the pooled summary (`replicate-stats.ts`).
 */

import { type PooledGroup, poolGroup, type Replicate } from "./replicate-stats";
import type { BenchmarkResult } from "./types";

/** Most replicates one invocation may run. */
export const MAX_REPLICATES = 20;

/** Parse `--replicates`: an integer 1..MAX_REPLICATES (default 1). */
export function parseReplicates(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_REPLICATES) {
    throw new Error(`--replicates must be an integer from 1 to ${MAX_REPLICATES}, got "${raw}"`);
  }
  return n;
}

const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,119}$/;

/** The same rule the ledger applies to an explicit group key. */
export function validGroupKey(group: string): boolean {
  return GROUP_RE.test(group) && !group.startsWith("auto:");
}

/** A fresh group key for one multi-replicate invocation. */
export function defaultReplicateGroup(label: string, now: number): string {
  const safe = label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "run";
  return `rep:${safe}:${now.toString(36)}`;
}

/** Replicate i (1-based) of `total` writes `<base>.rep<i>.json`; a single run keeps `base`. */
export function replicateFilePath(base: string, rep: number, total: number): string {
  if (total <= 1) return base;
  const stem = base.endsWith(".json") ? base.slice(0, -".json".length) : base;
  return `${stem}.rep${rep}.json`;
}

/** One finished run as a replicate map (item id → correct). */
export function replicateFromResult(result: BenchmarkResult): Replicate {
  return new Map((result.items ?? []).map((i) => [i.id, i.correct === true]));
}

/** Pool finished runs of one target. */
export function poolResults(results: readonly BenchmarkResult[]): PooledGroup {
  return poolGroup(results.map(replicateFromResult));
}

/** The closing pooled line(s) for one set. Pure. */
export function formatPooled(name: string, pooled: PooledGroup): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const each = pooled.replicateAccuracies.map(pct).join(", ");
  return [
    `  ${name.padEnd(18)} pooled ${pct(pooled.meanAccuracy).padStart(6)} over ×${pooled.replicates} replicates on ${pooled.items} common items (majority ${pct(pooled.majorityAccuracy)})`,
    `  ${"".padEnd(18)} per run: ${each}; between-run SD ${(pooled.betweenSd * 100).toFixed(1)} pts; unanimous ${pct(pooled.unanimous)}; pairwise agreement ${pct(pooled.pairwiseAgreement)}`,
  ].join("\n");
}
