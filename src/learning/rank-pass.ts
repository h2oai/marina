// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The observe-mode rank pass over an existing lesson pool (`bun run lessons
 * rank`): every current, non-rejected lesson is admitted against the lessons
 * of its pool written BEFORE it (by `resolvedAt`, then id), exactly as
 * admission would have seen it at write time. Nothing is written: the pass
 * reports the actions admission WOULD take (duplicates merged, refinements
 * superseded, contradictions contested) and one row per lesson for the replay
 * harness (`./replay.ts`).
 */

import type { DecisionProvider } from "../decisions/types";
import { rankWeights } from "../memory/admission";
import { RANK_FLOOR } from "../memory/admission-policy";
import { admitLesson, type LessonEvidenceReader } from "./admission";
import type { Lesson, LessonSink, LessonTrust, OutcomeDomain } from "./outcomes";

/** One lesson's observed admission (a JSONL row of the rank report). */
export interface RankRow {
  id: string;
  domain: OutcomeDomain;
  trust: LessonTrust;
  kind: Lesson["kind"];
  resolvedAt: string;
  category?: string;
  scope?: string;
  families?: string[];
  action: "new" | "merge" | "supersede" | "contest" | "skipped";
  target?: string;
  targetTrust?: LessonTrust | "imported";
  mechanical?: boolean;
  autoResolve?: boolean;
  reason: string;
  relation?: string;
  rank?: number;
  skipped?: string;
}

export interface RankPassCounts {
  lessons: number;
  rejected: number;
  ranked: number;
  mechanicalMerges: number;
  judgedMerges: number;
  supersedes: number;
  contests: number;
  autoResolvable: number;
  new: number;
  skipped: Record<string, number>;
  belowFloor: number;
  rankSum: number;
}

export interface RankPassReport {
  domains: Partial<Record<OutcomeDomain, RankPassCounts>>;
  rows: RankRow[];
}

const emptyCounts = (): RankPassCounts => ({
  lessons: 0,
  rejected: 0,
  ranked: 0,
  mechanicalMerges: 0,
  judgedMerges: 0,
  supersedes: 0,
  contests: 0,
  autoResolvable: 0,
  new: 0,
  skipped: {},
  belowFloor: 0,
  rankSum: 0,
});

/** Admit every current lesson of `domains` against its earlier pool mates; write nothing. */
export async function rankPass(
  sink: LessonSink,
  opts: {
    domains: readonly OutcomeDomain[];
    judge?: DecisionProvider;
    env?: NodeJS.ProcessEnv;
    db?: LessonEvidenceReader;
    limit?: number;
    concurrency?: number;
    onRow?: (row: RankRow) => void;
  },
): Promise<RankPassReport> {
  if (!sink.find || !sink.neighbours) throw new Error("this lesson store cannot list neighbours");
  const report: RankPassReport = { domains: {}, rows: [] };
  const weights = rankWeights(opts.db);
  let budget = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const domain of opts.domains) {
    const counts = emptyCounts();
    report.domains[domain] = counts;
    const pool = (await sink.find(domain, {}, 100_000)).sort(
      (a, b) =>
        Date.parse(a.resolvedAt) - Date.parse(b.resolvedAt) ||
        (a.id ?? "").localeCompare(b.id ?? ""),
    );
    const order = new Map(pool.map((l, i) => [l.id!, i]));
    const queue = pool.map((l, i) => ({ l, i }));
    const take = () => {
      if (budget <= 0) return undefined;
      const next = queue.shift();
      if (next) budget--;
      return next;
    };
    const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, async () => {
      for (let item = take(); item; item = take()) {
        const { l, i } = item;
        counts.lessons++;
        if (l.trust === "rejected" || !l.id) {
          counts.rejected++;
          continue;
        }
        const keep = (n: Lesson) =>
          n.id ? (order.get(n.id) ?? Number.POSITIVE_INFINITY) < i : false;
        let row: RankRow;
        try {
          const { result } = await admitLesson(l, sink, {
            ...(opts.judge ? { judge: opts.judge } : {}),
            ...(opts.env ? { env: opts.env } : {}),
            ...(opts.db ? { db: opts.db } : {}),
            keep,
            weights,
          });
          row = {
            id: l.id,
            domain,
            trust: l.trust,
            kind: l.kind,
            resolvedAt: l.resolvedAt,
            ...(l.category ? { category: l.category } : {}),
            ...(l.scope ? { scope: l.scope } : {}),
            ...(l.families?.length ? { families: l.families } : {}),
            action: result.skipped ? "skipped" : result.action,
            ...(result.target
              ? { target: result.target.id, targetTrust: result.target.trust }
              : {}),
            ...(result.mechanical ? { mechanical: true } : {}),
            ...(result.autoResolve ? { autoResolve: true } : {}),
            reason: result.reason,
            ...(result.relation
              ? {
                  relation: `${result.relation.kind}${result.relation.index === undefined ? "" : `_N${result.relation.index + 1}`} p${Math.round(result.relation.p * 100) / 100}`,
                }
              : {}),
            ...(result.rank ? { rank: result.rank.score } : {}),
            ...(result.skipped ? { skipped: result.skipped } : {}),
          };
        } catch (err) {
          row = {
            id: l.id,
            domain,
            trust: l.trust,
            kind: l.kind,
            resolvedAt: l.resolvedAt,
            action: "skipped",
            reason: (err as Error).message,
            skipped: "error",
          };
        }
        tally(counts, row);
        report.rows.push(row);
        opts.onRow?.(row);
      }
    });
    await Promise.all(workers);
  }
  return report;
}

function tally(c: RankPassCounts, row: RankRow): void {
  if (row.rank !== undefined) {
    c.ranked++;
    c.rankSum += row.rank;
    if (row.rank < RANK_FLOOR) c.belowFloor++;
  }
  switch (row.action) {
    case "merge":
      if (row.mechanical) c.mechanicalMerges++;
      else c.judgedMerges++;
      break;
    case "supersede":
      c.supersedes++;
      break;
    case "contest":
      c.contests++;
      if (row.autoResolve) c.autoResolvable++;
      break;
    case "new":
      c.new++;
      break;
    default:
      c.skipped[row.skipped ?? "unknown"] = (c.skipped[row.skipped ?? "unknown"] ?? 0) + 1;
  }
}
