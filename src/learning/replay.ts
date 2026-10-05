// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline replay of lesson recall (design: memory admission ranking, "how to
 * measure"). No model spend for serving: a frozen pool snapshot is recalled
 * for held-out tasks under two arms over the SAME pool —
 *
 *   baseline  today's order: trust, then recency
 *   ranked    trust, then admission rank (below the floor last), then
 *             recency; lessons admission would have merged into another or
 *             superseded are gone, and contested lessons are never served
 *
 * — and each served set is scored:
 *
 *   distractor rate        share of served lessons irrelevant to the task:
 *                          mechanically, no category overlap or a family /
 *                          scope mismatch (a `label` callback — a fixed judge —
 *                          may replace the proxy)
 *   duplicate rate         share of served lessons that duplicate another lesson
 *                          in the same served set (normalised text, Jaccard ≥ 0.9,
 *                          or an observed merge pair)
 *   contradiction exposure share of served sets holding both sides of an
 *                          observed contradiction
 *   useful-hit rate        share of served lessons the task's later outcome
 *                          confirms: relevant AND of the same kind
 *                          (a failure lesson before a failure, a success lesson
 *                          before a success) — a mechanical proxy, labelled
 *   bytes per useful hit, and pool size vs unique clusters
 *
 * Tasks are the held-out lessons resolved after the snapshot cutoff (the
 * hashed `memory-ranking` holdout split): each stands for the work whose
 * outcome taught it, recalled with its category at the moment before its
 * outcome was known. The task's own text is never in the pool.
 */

import { itemSplit } from "../engine/benchmark-promotion";
import { DUPLICATE_JACCARD, normaliseText, tokenJaccard } from "../memory/admission-policy";
import { relevantToQuery } from "../memory/unified-context";
import {
  DEFAULT_RECALL_BYTES,
  DEFAULT_RECALL_LIMIT,
  type Lesson,
  lessonTokens,
  selectServed,
} from "./outcomes";
import type { RankRow } from "./rank-pass";

export const REPLAY_SLOT = "memory-ranking";

export interface ReplayTask {
  id: string;
  query: string;
  families: readonly string[];
  scope?: string;
  kind: Lesson["kind"];
  /** The work's cutoff: just before its outcome was known. */
  asOf: string;
}

export interface ArmMetrics {
  tasks: number;
  served: number;
  distractorRate: number;
  duplicateRate: number;
  contradictionExposure: number;
  usefulHitRate: number;
  bytesPerUsefulHit: number | null;
}

export interface ReplayReport {
  cutoff: string;
  pool: number;
  clusters: number;
  tasks: number;
  baseline: ArmMetrics;
  ranked: ArmMetrics;
  /** How distractors were labelled. */
  labels: "mechanical-proxy" | "judge";
}

/** The task a held-out lesson stands for: its category (else its first words). */
export function taskFor(l: Lesson): ReplayTask {
  const query =
    l.category ??
    normaliseText(l.text.replace(/^\[lesson[^\]]*\]/, ""))
      .split(" ")
      .slice(0, 6)
      .join(" ");
  return {
    id: l.id ?? l.text,
    query,
    families: l.families ?? [],
    ...(l.scope ? { scope: l.scope } : {}),
    kind: l.kind,
    asOf: new Date(Date.parse(l.resolvedAt) - 1).toISOString(),
  };
}

/** Mechanically relevant: category overlap, and no family / scope mismatch when both declare one. */
export function relevantFor(task: ReplayTask, l: Lesson): boolean {
  if (
    task.families.length &&
    l.families?.length &&
    !l.families.some((f) => task.families.includes(f))
  )
    return false;
  if (task.scope && l.scope && task.scope !== l.scope && l.scope === "case") return false;
  return relevantToQuery(`${l.category ?? ""} ${l.text}`, task.query);
}

const duplicates = (a: Lesson, b: Lesson) =>
  normaliseText(a.text) === normaliseText(b.text) ||
  tokenJaccard(a.text, b.text) >= DUPLICATE_JACCARD;

/** Connected components of the pool under duplicate / observed-merge edges. */
export function clusterCount(pool: readonly Lesson[], rows: ReadonlyMap<string, RankRow>): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const ids = pool.map((l) => l.id!).filter(Boolean);
  for (const id of ids) parent.set(id, id);
  const byNorm = new Map<string, string>();
  for (const l of pool) {
    if (!l.id) continue;
    const k = normaliseText(l.text);
    const seen = byNorm.get(k);
    if (seen) union(l.id, seen);
    else byNorm.set(k, l.id);
    const row = rows.get(l.id);
    if (row?.action === "merge" && row.target && parent.has(row.target)) union(l.id, row.target);
  }
  return new Set(ids.map(find)).size;
}

function recallFrom(pool: readonly Lesson[], task: ReplayTask, rankOrder: boolean): Lesson[] {
  const q = lessonTokens(task.query);
  const hits = pool
    .map((l) => ({
      l,
      hits: [...lessonTokens(`${l.text} ${l.category ?? ""}`)].filter((t) => q.has(t)).length,
    }))
    .filter((x) => x.hits > 0 || x.l.families?.some((f) => task.families.includes(f)))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 50)
    .map((x) => x.l);
  return selectServed(hits, task.asOf, {
    limit: DEFAULT_RECALL_LIMIT,
    maxBytes: DEFAULT_RECALL_BYTES,
    ...(rankOrder ? { rankOrder: true } : {}),
  });
}

function score(
  sets: Array<{ task: ReplayTask; served: Lesson[] }>,
  conflicts: ReadonlyArray<[string, string]>,
  merges: ReadonlyArray<[string, string]>,
  label: (task: ReplayTask, l: Lesson) => boolean,
): ArmMetrics {
  let served = 0;
  let distractors = 0;
  let dups = 0;
  let exposed = 0;
  let useful = 0;
  let bytes = 0;
  const mergePairs = new Set(merges.map(([a, b]) => [a, b].sort().join("\n")));
  for (const { task, served: set } of sets) {
    served += set.length;
    const ids = new Set(set.map((l) => l.id));
    if (conflicts.some(([a, b]) => ids.has(a) && ids.has(b))) exposed++;
    for (const [i, l] of set.entries()) {
      bytes += Buffer.byteLength(l.text);
      const relevant = label(task, l);
      if (!relevant) distractors++;
      else if (l.kind === task.kind) useful++;
      if (
        set.some(
          (o, j) =>
            j < i &&
            (duplicates(o, l) || mergePairs.has([o.id ?? "", l.id ?? ""].sort().join("\n"))),
        )
      )
        dups++;
    }
  }
  const rate = (n: number, d: number) => (d ? Math.round((n / d) * 10_000) / 10_000 : 0);
  return {
    tasks: sets.length,
    served,
    distractorRate: rate(distractors, served),
    duplicateRate: rate(dups, served),
    contradictionExposure: rate(exposed, sets.length),
    usefulHitRate: rate(useful, served),
    bytesPerUsefulHit: useful ? Math.round(bytes / useful) : null,
  };
}

export interface ReplayOptions {
  /** Snapshot cutoff (ISO). Default: the 70th percentile of `resolvedAt`. */
  cutoff?: string;
  /** Holdout fraction of post-cutoff lessons used as tasks (default 0.5). */
  holdout?: number;
  /** A fixed judge's relevance label (async labels are collected first). */
  label?: (task: ReplayTask, l: Lesson) => boolean;
  maxTasks?: number;
}

/**
 * Replay recall for held-out tasks over `lessons` (current lessons of one or
 * more pools, any trust) with the observed admission `rows` (`rankPass`).
 */
export function replayRecall(
  lessons: readonly Lesson[],
  rows: readonly RankRow[],
  opts: ReplayOptions = {},
): ReplayReport {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const times = lessons
    .map((l) => Date.parse(l.resolvedAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const cutoff =
    opts.cutoff ??
    new Date(
      times[Math.min(times.length - 1, Math.floor(times.length * 0.7))] ?? Date.now(),
    ).toISOString();
  const cut = Date.parse(cutoff);
  const pool = lessons.filter((l) => Date.parse(l.resolvedAt) <= cut);
  const tasks = lessons
    .filter(
      (l) =>
        Date.parse(l.resolvedAt) > cut &&
        l.trust !== "rejected" &&
        itemSplit(REPLAY_SLOT, l.id ?? l.text, opts.holdout ?? 0.5) === "holdout",
    )
    .slice(0, opts.maxTasks ?? 1_000)
    .map(taskFor);
  // The ranked arm: ranks attached; merged-away, superseded and contested lessons gone.
  const gone = new Set<string>();
  const held = new Set<string>();
  for (const r of rows) {
    if (r.action === "merge") gone.add(r.id);
    if (r.action === "supersede" && r.target) gone.add(r.target);
    if (r.action === "contest" && r.target) {
      if (r.autoResolve) gone.add(r.target);
      else held.add(r.id);
    }
  }
  const rankedPool = pool
    .filter((l) => !(l.id && gone.has(l.id)))
    .map((l) => {
      const row = l.id ? byId.get(l.id) : undefined;
      return {
        ...l,
        ...(row?.rank !== undefined ? { rank: { score: row.rank } } : {}),
        ...(l.id && held.has(l.id) ? { contested: true } : {}),
      };
    });
  const conflicts = rows
    .filter((r) => r.action === "contest" && r.target)
    .map((r) => [r.id, r.target!] as [string, string]);
  const merges = rows
    .filter((r) => r.action === "merge" && r.target)
    .map((r) => [r.id, r.target!] as [string, string]);
  const label = opts.label ?? relevantFor;
  const arm = (p: readonly Lesson[], rankOrder: boolean) =>
    score(
      tasks.map((task) => ({ task, served: recallFrom(p, task, rankOrder) })),
      conflicts,
      merges,
      label,
    );
  return {
    cutoff,
    pool: pool.length,
    clusters: clusterCount(pool, byId),
    tasks: tasks.length,
    baseline: arm(pool, false),
    ranked: arm(rankedPool, true),
    labels: opts.label ? "judge" : "mechanical-proxy",
  };
}
