// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline evaluation of intake triage (`src/forecast/triage.ts`) over stored
 * questions — no model call, no network, no cost:
 *
 *   distribution  the class mix of a question set at a chosen NOW (FutureX:
 *                 the row's end time minus a horizon, as the backtests ran)
 *   by class      for stored per-item scores (ledger runs, result files),
 *                 each class's item count, mean score and share of the total
 *                 loss — where Marina loses most
 *
 * Triage runs in deterministic mode at each item's own cutoff, so the class
 * uses nothing the forecast itself could not have seen.
 */

import type { AnswerSpec } from "../../src/forecast/answer-types";
import {
  classCounts,
  TRIAGE_CLASSES,
  type TriageClass,
  type TriageResult,
  triageQuestion,
} from "../../src/forecast/triage";
import type { FuturexRow } from "../futurex/dataset";
import { requestFor } from "../futurex/map";

export interface TriageItem {
  id: string;
  question: string;
  context?: string;
  answer?: AnswerSpec;
  endTime?: string;
  /** NOW for this item: its evidence cutoff. */
  now: string;
  level?: number;
}

export interface ScoredItem {
  id: string;
  score: number;
  /** The arm or run label the score belongs to. */
  variant: string;
}

export interface ClassScore {
  n: number;
  mean: number;
  /** Share of the summed loss (1 − score) that falls in this class. */
  lossShare: number;
}

/** A FutureX row as a triage item at `horizonDays` before its end time. */
export function futurexItem(row: FuturexRow, horizonDays: number): TriageItem | undefined {
  const req = requestFor(row);
  if (!req.endTime) return undefined;
  const now = new Date(Date.parse(req.endTime) - horizonDays * 86_400_000).toISOString();
  return {
    id: row.id,
    question: req.question,
    ...(req.context ? { context: req.context } : {}),
    answer: req.answer,
    endTime: req.endTime,
    now,
    level: row.level,
  };
}

/** Deterministic triage of one item at its own cutoff. */
export function triageItem(item: TriageItem): TriageResult {
  return triageQuestion({
    question: item.question,
    ...(item.context ? { context: item.context } : {}),
    ...(item.answer ? { answer: item.answer } : {}),
    ...(item.endTime ? { endTime: item.endTime } : {}),
    now: item.now,
  });
}

export interface Distribution {
  n: number;
  counts: Record<TriageClass, number>;
  /** Publication bases behind the lookups. */
  lookupBasis: Record<string, number>;
  /** Counts per FutureX level, when items carry one. */
  byLevel?: Record<string, Record<TriageClass, number>>;
}

export function distribution(items: readonly TriageItem[]): Distribution {
  const results = items.map((i) => ({ item: i, r: triageItem(i) }));
  const lookupBasis: Record<string, number> = {};
  const byLevel: Record<string, Record<TriageClass, number>> = {};
  for (const { item, r } of results) {
    if (r.class === "lookup") {
      const b = r.published.basis ?? "?";
      lookupBasis[b] = (lookupBasis[b] ?? 0) + 1;
    }
    if (item.level !== undefined) {
      const l = (byLevel[String(item.level)] ??= { lookup: 0, anchor: 0, list: 0, forecast: 0 });
      l[r.class]++;
    }
  }
  return {
    n: results.length,
    counts: classCounts(results.map((x) => x.r)),
    lookupBasis,
    ...(Object.keys(byLevel).length ? { byLevel } : {}),
  };
}

/** Mean score and loss share per class, over every scored item whose class is known. */
export function scoresByClass(
  scored: readonly ScoredItem[],
  classOf: (id: string) => TriageClass | undefined,
): Record<TriageClass, ClassScore> & { all: ClassScore } {
  const acc = Object.fromEntries(
    TRIAGE_CLASSES.map((c) => [c, { n: 0, sum: 0, loss: 0 }]),
  ) as Record<TriageClass, { n: number; sum: number; loss: number }>;
  let n = 0;
  let sum = 0;
  let loss = 0;
  for (const s of scored) {
    const c = classOf(s.id);
    if (!c || !Number.isFinite(s.score)) continue;
    const score = Math.min(1, Math.max(0, s.score));
    acc[c].n++;
    acc[c].sum += score;
    acc[c].loss += 1 - score;
    n++;
    sum += score;
    loss += 1 - score;
  }
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const out = {} as Record<TriageClass, ClassScore> & { all: ClassScore };
  for (const c of TRIAGE_CLASSES) {
    const a = acc[c];
    out[c] = {
      n: a.n,
      mean: a.n ? round(a.sum / a.n) : 0,
      lossShare: loss ? round(a.loss / loss) : 0,
    };
  }
  out.all = { n, mean: n ? round(sum / n) : 0, lossShare: 1 };
  return out;
}

/** A markdown table of class counts. */
export function distributionTable(rows: Array<{ label: string; d: Distribution }>): string {
  const head = `| set | n | ${TRIAGE_CLASSES.join(" | ")} | lookup bases |`;
  const sep = `|---|---|${TRIAGE_CLASSES.map(() => "---").join("|")}|---|`;
  const body = rows.map(({ label, d }) => {
    const cells = TRIAGE_CLASSES.map(
      (c) => `${d.counts[c]} (${d.n ? Math.round((100 * d.counts[c]) / d.n) : 0}%)`,
    );
    const bases =
      Object.entries(d.lookupBasis)
        .map(([b, k]) => `${b} ${k}`)
        .join(", ") || "—";
    return `| ${label} | ${d.n} | ${cells.join(" | ")} | ${bases} |`;
  });
  return [head, sep, ...body].join("\n");
}

/** A markdown table of scores per class. */
export function scoreTable(
  rows: Array<{ label: string; s: Record<TriageClass, ClassScore> & { all: ClassScore } }>,
): string {
  const head = `| scores | all (n, mean) | ${TRIAGE_CLASSES.map((c) => `${c} (n, mean, loss share)`).join(" | ")} |`;
  const sep = `|---|---|${TRIAGE_CLASSES.map(() => "---").join("|")}|`;
  const body = rows.map(({ label, s }) => {
    const cells = TRIAGE_CLASSES.map((c) =>
      s[c].n ? `${s[c].n}, ${s[c].mean.toFixed(3)}, ${(100 * s[c].lossShare).toFixed(0)}%` : "—",
    );
    return `| ${label} | ${s.all.n}, ${s.all.mean.toFixed(3)} | ${cells.join(" | ")} |`;
  });
  return [head, sep, ...body].join("\n");
}

/** Estimated cost of the optional fact model per item (input/output tokens × price). */
export function factModelCostPerItem(
  price: { inputPerM: number; outputPerM: number },
  tokens = { input: 700, output: 220 },
): number {
  return (tokens.input * price.inputPerM + tokens.output * price.outputPerM) / 1e6;
}
