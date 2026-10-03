// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Replicate groups in the benchmark ledger: repeated runs of ONE
 * configuration — the same target, item slice and judge — that are pooled so a
 * conclusion never rests on a single noisy draw.
 *
 * A run belongs to the group it names (`replicate_group`, migration 148: set
 * by `--group` on the harness / import, `replicateGroup` on
 * `POST /v1/benchmarks/runs`, or regrouped by the operator); a run that names
 * none belongs to the automatic group of its (benchmark, target, slice, judge)
 * identity. Pre-ledger runs with no target or slice have no automatic group:
 * each is its own one-replicate group.
 *
 * The statistics live in `benchmarks/replicate-stats.ts` (pure); this module
 * only resolves groups from ledger rows and adapts them.
 */

import { createHash } from "node:crypto";
import {
  comparePooled,
  type PooledComparison,
  type PooledGroup,
  poolGroup,
  type Replicate,
  seedFromIds,
} from "../../benchmarks/replicate-stats";
import { validGroupKey } from "../../benchmarks/replicates";
import type { BenchmarkItemRow, BenchmarkRunRow } from "../persistence/db-benchmarks";
import type { BenchmarksStore } from "../persistence/interfaces/benchmarks-store";

/** Fewest replicates of a challenger a promotion accepts (`MARINA_PROMOTION_MIN_REPLICATES`). */
export const DEFAULT_PROMOTION_MIN_REPLICATES = 2;

/** `MARINA_PROMOTION_MIN_REPLICATES`: an integer ≥ 1; anything else is the default. */
export function promotionMinReplicates(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARINA_PROMOTION_MIN_REPLICATES?.trim();
  if (!raw) return DEFAULT_PROMOTION_MIN_REPLICATES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : DEFAULT_PROMOTION_MIN_REPLICATES;
}

/** A valid explicit group key (labels, not free text) — the harness applies the same rule. */
export function validReplicateGroup(group: string): boolean {
  return validGroupKey(group);
}

/** JSON with object keys sorted, so equal targets hash equally whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The automatic group of a run's identity — benchmark, target, slice and
 * judge — or null when the run lacks the target or slice to have one.
 */
export function autoReplicateGroup(run: BenchmarkRunRow): string | null {
  if (!run.target_json || !run.slice_hash) return null;
  let target: unknown = run.target_json;
  try {
    target = JSON.parse(run.target_json) as unknown;
  } catch {
    // allow-empty-catch: a non-JSON target is hashed as the raw string
  }
  const key = [run.benchmark, canonicalJson(target), run.slice_hash, run.judge ?? ""].join("\n");
  return `auto:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** The group a run belongs to: the one it names, else its automatic group, else its own id. */
export function replicateGroupOf(run: BenchmarkRunRow): string {
  return run.replicate_group ?? autoReplicateGroup(run) ?? `run:${run.id}`;
}

type ReplicateStore = Pick<
  BenchmarksStore,
  "getBenchmarkRun" | "getBenchmarkItems" | "queryBenchmarkRuns"
>;

/**
 * Every completed run in the same replicate group as `run` (including it),
 * oldest first. Groups never cross benchmarks.
 */
export function replicatesOf(db: ReplicateStore, run: BenchmarkRunRow): BenchmarkRunRow[] {
  const group = replicateGroupOf(run);
  if (group.startsWith("run:")) return [run];
  const peers = db
    .queryBenchmarkRuns({ benchmark: run.benchmark, status: "completed", limit: 500 })
    .filter((r) => replicateGroupOf(r) === group);
  if (!peers.some((r) => r.id === run.id)) peers.push(run);
  return peers.sort((x, y) => x.started_at - y.started_at || x.id.localeCompare(y.id));
}

/** One run's items as a replicate map (item id → correct). */
export function replicateFromItems(items: readonly BenchmarkItemRow[]): Replicate {
  return new Map(items.map((i) => [i.item_id, Boolean(i.correct)]));
}

/** Differences between replicates that should be identical (target, slice, judge). */
export function groupInconsistencies(runs: readonly BenchmarkRunRow[]): string[] {
  const out: string[] = [];
  const distinct = (f: (r: BenchmarkRunRow) => string | null | undefined) =>
    new Set(runs.map((r) => f(r) ?? "")).size;
  if (distinct((r) => r.target_json) > 1) out.push("replicates record different targets");
  if (distinct((r) => r.slice_hash) > 1) out.push("replicates answered different item slices");
  if (distinct((r) => r.judge) > 1) out.push("replicates were graded by different judges");
  return out;
}

export interface LoadedGroup {
  group: string;
  runs: BenchmarkRunRow[];
  replicates: Replicate[];
  warnings: string[];
}

/**
 * Load a run's replicate group with every replicate's item outcomes. An
 * `invalid` run never counts as a replicate — not even of its own group.
 */
export function loadReplicateGroup(db: ReplicateStore, run: BenchmarkRunRow): LoadedGroup {
  const runs = replicatesOf(db, run).filter(
    (r) => r.status === "completed" || (r.id === run.id && r.status !== "invalid"),
  );
  const loaded = runs
    .map((r) => ({ run: r, items: db.getBenchmarkItems(r.id) }))
    .filter((x) => x.items.length > 0);
  return {
    group: replicateGroupOf(run),
    runs: loaded.map((x) => x.run),
    replicates: loaded.map((x) => replicateFromItems(x.items)),
    warnings: groupInconsistencies(loaded.map((x) => x.run)),
  };
}

/** Pool one loaded group on its common items. */
export function pooledSummary(g: LoadedGroup): PooledGroup {
  return poolGroup(g.replicates);
}

/** Compare two loaded groups (A − B) with the two-stage bootstrap. */
export function comparePooledGroups(
  a: LoadedGroup,
  b: LoadedGroup,
  opts: { resamples?: number; itemFilter?: (itemId: string) => boolean } = {},
): PooledComparison {
  const filter = opts.itemFilter;
  const restrict = (reps: Replicate[]) =>
    filter ? reps.map((r) => new Map([...r].filter(([id]) => filter(id))) as Replicate) : reps;
  return comparePooled(restrict(a.replicates), restrict(b.replicates), {
    ...(opts.resamples !== undefined ? { resamples: opts.resamples } : {}),
    seed: seedFromIds([...a.runs.map((r) => r.id), ...b.runs.map((r) => r.id)]),
  });
}
