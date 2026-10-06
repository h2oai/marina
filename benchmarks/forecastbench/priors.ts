// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Statistical priors for ForecastBench dataset questions — the thin part:
 * which series or reference class a question belongs to. The statistics are
 * Marina's own general ones:
 *
 *   fred / yfinance / dbnomics  the series ForecastBench names (its id, or the
 *                               DBnomics URL) → `seriesHistory` as of the
 *                               cutoff → `comparisonPrior` ("higher on the
 *                               resolution date than on the due date?")
 *   acled / wikipedia           nested reference classes (source → question
 *                               template → size bucket → horizon) → the base
 *                               rate of ForecastBench's own published
 *                               resolutions known before the cutoff
 *                               (`classRate`)
 *
 * The prior is supplied to the forecaster as a `statistical` prior (pooled
 * toward when the operator turns pooling on) and shown to the runs in the
 * question's context. Market questions keep their market price.
 */

import type { SuppliedPrior } from "../../src/forecast/prior";
import { classRate, classTotals, type PublishedOutcome } from "../../src/forecast/reference-class";
import type { SeriesHistory, SeriesRef } from "../../src/forecast/series-history";
import { comparisonPrior } from "../../src/forecast/series-prior";
import { type FbQuestion, type FbQuestionSet, type FbResolution, resolutionDates } from "./dataset";
import { dateOptionId } from "./map";

export interface DatasetPrior {
  prior: SuppliedPrior;
  /** Per resolution date, for the context line. */
  byDate: Record<string, number>;
  /** How it was made (method or reference class), for the context and the audit trail. */
  basis: string;
}

export type HistoryFn = (
  ref: SeriesRef,
  cutoff: Date,
) => Promise<SeriesHistory | { error: string }>;

const DAY_MS = 86_400_000;
const days = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** The series a dataset question compares (undefined for other sources). */
export function seriesRefFor(q: FbQuestion): SeriesRef | undefined {
  if (typeof q.id !== "string") return undefined;
  if (q.source === "fred") return { source: "fred", id: q.id };
  if (q.source === "yfinance") return { source: "yahoo", id: q.id };
  if (q.source === "dbnomics") {
    const m = /^https:\/\/db\.nomics\.world\/([^/]+\/[^/]+\/[^/?#]+)/.exec(q.url ?? "");
    return m ? { source: "dbnomics", id: m[1]! } : undefined;
  }
  return undefined;
}

function sizeBucket(v: string | undefined): string {
  const n = Number(v);
  if (!v?.trim() || !Number.isFinite(n)) return "?";
  return n === 0 ? "0" : n < 1 ? "<1" : n < 10 ? "<10" : n < 100 ? "<100" : "100+";
}

/** A question's text with names, quoted terms and numbers masked: its template. */
function template(text: string): string {
  return text
    .replace(/'[^']*'/g, "X")
    .replace(/\b[A-Z][\w.-]*(?: [A-Z][\w.-]*)*/g, "X")
    .replace(/\d+(?:\.\d+)?/g, "N")
    .slice(0, 90);
}

/**
 * Nested reference classes for an ACLED or Wikipedia question (broadest
 * first, without the horizon), or undefined for other sources.
 */
export function referenceClasses(q: FbQuestion): string[] | undefined {
  if (q.source === "acled") {
    const kind =
      /more (?:than ten times as many )?'([^']+)'/.exec(q.question)?.[1] ??
      (/fatalities/.test(q.question) ? "fatalities" : "?");
    const ten = /ten times/.test(q.question) ? "x10" : "x1";
    const t = `acled|${kind}|${ten}`;
    return ["acled", t, `${t}|${sizeBucket(q.freeze_datetime_value)}`];
  }
  if (q.source === "wikipedia") {
    return ["wikipedia", `wikipedia|${template(q.question)}`];
  }
  return undefined;
}

/** ForecastBench's published outcomes as reference-class records (horizon as the narrowest class). */
export function publishedOutcomes(
  rounds: Array<{ set: FbQuestionSet; resolutions: FbResolution[] }>,
): PublishedOutcome[] {
  const out: PublishedOutcome[] = [];
  for (const { set, resolutions } of rounds) {
    const byKey = new Map(set.questions.map((q) => [`${q.source}|${q.id}`, q]));
    for (const r of resolutions) {
      if (!r.resolved || typeof r.id !== "string" || !r.resolution_date) continue;
      const q = byKey.get(`${r.source}|${r.id}`);
      const classes = q && referenceClasses(q);
      if (!classes) continue;
      const h = days(set.forecast_due_date, r.resolution_date);
      out.push({
        classes: [...classes, `${classes.at(-1)}|h${h}`],
        resolvedOn: r.resolution_date,
        outcome: Number(r.resolved_to),
      });
    }
  }
  return out;
}

const r4 = (p: number) => Math.round(Math.min(0.99, Math.max(0.01, p)) * 1e4) / 1e4;

function supplied(byDate: Record<string, number>, cutoff: Date, label: string): SuppliedPrior {
  return {
    source: "statistical",
    distribution: Object.fromEntries(Object.entries(byDate).map(([d, p]) => [dateOptionId(d), p])),
    at: new Date(cutoff.getTime() - 1).toISOString(),
    label,
  };
}

/** Every dataset question's statistical prior as of the round's due date (00:00 UTC). */
export async function datasetPriors(
  set: FbQuestionSet,
  questions: FbQuestion[],
  deps: { history: HistoryFn; outcomes: PublishedOutcome[]; concurrency?: number },
): Promise<{ priors: Map<string, DatasetPrior>; errors: string[] }> {
  const due = set.forecast_due_date;
  const cutoff = new Date(`${due}T00:00:00.000Z`);
  const totals = classTotals(deps.outcomes, cutoff);
  const priors = new Map<string, DatasetPrior>();
  const errors: string[] = [];
  const jobs = questions.filter((q) => resolutionDates(q).length > 0);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const q = jobs[next++]!;
      const dates = resolutionDates(q);
      const key = `${q.source}|${q.id}`;
      const ref = seriesRefFor(q);
      if (ref) {
        const h = await deps.history(ref, cutoff);
        if ("error" in h) {
          errors.push(`${key}: ${h.error}`);
          continue;
        }
        const c = comparisonPrior(h.points, { baseline: due, targets: dates });
        if (!c) continue;
        const byDate = Object.fromEntries(dates.map((d) => [d, r4(c.probabilities[d] ?? 0.5)]));
        priors.set(key, {
          prior: supplied(byDate, cutoff, `${ref.source} ${ref.id} ${c.method}`),
          byDate,
          basis: `the series' own history before ${due}: ${c.detail}`,
        });
        continue;
      }
      const classes = referenceClasses(q);
      if (!classes) continue;
      const byDate: Record<string, number> = {};
      let basis = "";
      for (const d of dates) {
        const rate = classRate(totals, [...classes, `${classes.at(-1)}|h${days(due, d)}`]);
        if (!rate) continue;
        byDate[d] = r4(rate.p);
        basis ||= `how ${rate.n}+ similar ForecastBench questions resolved before ${due}`;
      }
      if (Object.keys(byDate).length !== dates.length) continue;
      priors.set(key, {
        prior: supplied(byDate, cutoff, classes[1] ?? classes[0]!),
        byDate,
        basis,
      });
    }
  };
  await Promise.all(Array.from({ length: deps.concurrency ?? 6 }, worker));
  return { priors, errors };
}

/** The prior as one context line for the runs. */
export function priorLine(p: DatasetPrior): string {
  const dates = Object.entries(p.byDate)
    .map(([d, v]) => `${d}: ${v}`)
    .join(", ");
  return `Statistical prior (${p.basis}): ${dates}. Start from it; move away only for specific evidence.`;
}
