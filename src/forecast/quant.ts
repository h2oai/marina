// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The quantitative stage of a typed forecast (`MARINA_FORECAST_QUANT`,
 * default `off`). It is deterministic and costs no model money. It uses the
 * shared helpers in `src/quant/`:
 *
 *   series baseline  the freshest official series a lookup read (with its own
 *                    history) is fitted by `fitSeries` and projected to the
 *                    question's end time: a mean, an sd and quantiles.
 *   range buckets    a choice whose every option is a numeric range ("below
 *                    2.5%", "2.5% to 2.9%", "3.0% or higher") gets each
 *                    option's probability from a numeric predictive
 *                    distribution — the series baseline, else a supplied
 *                    numeric prior (value and sd) — via `bucketProbabilities`.
 *
 * `observe` computes and records both on the answer (`quant`) and changes
 * nothing a model sees or the answer. `on` also shows them to the runs (a
 * dossier line, as a reference class) and to the judge (an evidence chunk),
 * and, for a choice asked with probabilities, blends the bucket distribution
 * into the runs' distribution with weight `MARINA_FORECAST_QUANT_WEIGHT`
 * (default 0.25). Pure functions; typed.ts wires them in.
 */

import {
  type Bucket,
  bucketProbabilities,
  formatBucket,
  type Predictive,
  parseBucket,
} from "../quant/buckets";
import { type FitMethod, fitSeries, type SdBasis } from "../quant/series-fit";
import type { AnswerOption, AnswerSpec } from "./answer-types";
import type { Distribution } from "./distribution";
import type { Reading } from "./lookup-types";
import type { SuppliedPrior } from "./prior";

export type QuantMode = "off" | "observe" | "on";
export const QUANT_MODES: readonly QuantMode[] = ["off", "observe", "on"];
export const DEFAULT_QUANT_WEIGHT = 0.25;

/** `MARINA_FORECAST_QUANT`: `observe` or `on`; anything else (unset included) is `off`. */
export function quantModeFromEnv(env: NodeJS.ProcessEnv = process.env): QuantMode {
  const v = env.MARINA_FORECAST_QUANT?.trim().toLowerCase();
  return v === "observe" || v === "on" ? v : "off";
}

/** `MARINA_FORECAST_QUANT_WEIGHT` in [0, 1] (default 0.25); junk keeps the default. */
export function quantWeightFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARINA_FORECAST_QUANT_WEIGHT?.trim();
  const v = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_QUANT_WEIGHT;
}

export interface QuantBaseline {
  source: string;
  series: string;
  method: FitMethod;
  mean: number;
  sd: number;
  steps: number;
  sdBasis: SdBasis;
  /** Values the fit used (the reading's history plus the reading). */
  points: number;
  lastDate: string;
  target: string;
  /** 10 % and 90 % quantiles. */
  p10: number;
  p90: number;
}

export interface QuantBuckets {
  /** Where the predictive distribution came from. */
  source: "series" | "prior";
  predictive: { mean: number; sd: number };
  /** Each option's probability (renormalised over the options). */
  distribution: Distribution;
  best: string;
  /** Probability the options covered before renormalising (1 = a partition). */
  coverage: number;
  /** Displayed ranges with rounding gaps ("2.5–2.9", "3.0–3.4") were joined at the midpoints. */
  gapsClosed?: boolean;
  /** Each option's range as read. */
  ranges: Record<string, string>;
}

export interface QuantRecord {
  mode: Exclude<QuantMode, "off">;
  baseline?: QuantBaseline;
  buckets?: QuantBuckets;
  /** The runs and the judge saw the quant lines (mode `on` with something to show). */
  shown: boolean;
  /** The bucket blend into the runs' distribution: applied under `on`, what it would give under `observe`. */
  blend?: { weight: number; before: Distribution; after: Distribution; applied: boolean };
  /** Why a part produced nothing. */
  notes: string[];
}

const round = (x: number, d = 4) => Number(x.toPrecision(d));

/** The option ranges of a numeric-range choice, aligned with its options, or undefined. */
export function optionRanges(
  options: readonly AnswerOption[],
): { buckets: Bucket[]; gapsClosed: boolean } | undefined {
  if (options.length < 2) return undefined;
  const parsed: Bucket[] = [];
  for (const o of options) {
    const b = parseBucket(o.label ?? o.id) ?? (o.label ? parseBucket(o.id) : undefined);
    if (!b) return undefined;
    parsed.push(b);
  }
  // An option that is one exact value ("0", "1", "2", "3 or more") makes the
  // question a count: with integer ends, every option is its set of integers,
  // each integer covering ±0.5 ("3-5" = 3, 4, 5; "< 3" = up to 2).
  const isPoint = (b: Bucket) => b.lo !== undefined && b.lo === b.hi;
  const ends = parsed.flatMap((b) => [b.lo, b.hi]).filter((x): x is number => x !== undefined);
  const counts = parsed.some(isPoint) && ends.every((x) => Number.isInteger(x));
  if (parsed.some(isPoint) && !counts) return undefined;
  const buckets = parsed.map((b): Bucket => {
    if (!counts) return { ...b };
    const out: Bucket = { label: b.label, loClosed: true, hiClosed: false };
    if (b.lo !== undefined) out.lo = (b.loClosed ?? true) ? b.lo - 0.5 : b.lo + 0.5;
    if (b.hi !== undefined) {
      // A displayed "a-b" range includes b; "< b" and "[a, b)" do not.
      out.hi = b.hiClosed !== false ? b.hi + 0.5 : b.hi - 0.5;
    }
    return out;
  });
  const list = buckets;
  // Sort by lower end to check overlaps and close rounding gaps.
  const order = list
    .map((b, i) => ({ b, i }))
    .sort(
      (x, y) =>
        (x.b.lo ?? Number.NEGATIVE_INFINITY) - (y.b.lo ?? Number.NEGATIVE_INFINITY) ||
        (x.b.hi ?? Number.POSITIVE_INFINITY) - (y.b.hi ?? Number.POSITIVE_INFINITY),
    );
  const widths = list
    .filter((b) => b.lo !== undefined && b.hi !== undefined)
    .map((b) => b.hi! - b.lo!);
  const minWidth = widths.length ? Math.min(...widths) : 0;
  let gapsClosed = false;
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1]!.b;
    const cur = order[k]!.b;
    if (prev.hi === undefined || cur.lo === undefined) return undefined; // overlapping open ends
    const gap = cur.lo - prev.hi;
    if (gap < 0) return undefined; // overlap: not one partition
    // Displayed with rounding ("2.5–2.9", "3.0–3.4", or integer "0-2", "3-5"):
    // the ranges meet halfway across the gap.
    if (gap > 0 && gap <= 0.5 * minWidth + 1e-12) {
      const mid = (prev.hi + cur.lo) / 2;
      prev.hi = mid;
      prev.hiClosed = false;
      cur.lo = mid;
      cur.loClosed = true;
      gapsClosed = true;
    }
  }
  return { buckets: list, gapsClosed };
}

/**
 * The freshest reading with at least two history points, fitted with `auto`
 * and projected to `target` (the question's end time, else the cutoff).
 */
export function seriesBaseline(
  readings: readonly Reading[],
  target: string,
): QuantBaseline | undefined {
  const usable = readings.filter((r) => (r.history?.length ?? 0) >= 2);
  const r = [...usable].sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!r) return undefined;
  const points = [...(r.history ?? [])];
  if (!points.some((p) => p.date === r.date)) points.push({ date: r.date, value: r.value });
  const fit = fitSeries(points, { target, levels: [0.1, 0.9] });
  if (!fit) return undefined;
  return {
    source: r.source,
    series: r.series,
    method: fit.method,
    mean: fit.mean,
    sd: fit.sd,
    steps: fit.steps,
    sdBasis: fit.sdBasis,
    points: fit.n,
    lastDate: r.date,
    target,
    p10: fit.quantiles[0]!.value,
    p90: fit.quantiles[1]!.value,
  };
}

/** The numeric prior a caller supplied with a value and sd, best source first. */
function numericPrior(priors: readonly SuppliedPrior[] | undefined, cutoff: string) {
  const at = Date.parse(cutoff);
  for (const source of ["market", "community", "statistical"] as const) {
    const p = priors?.find(
      (x) =>
        x.source === source &&
        typeof x.value === "number" &&
        Number.isFinite(x.value) &&
        typeof x.sd === "number" &&
        Number.isFinite(x.sd) &&
        x.sd >= 0 &&
        Date.parse(x.at) <= at,
    );
    if (p) return { mean: p.value!, sd: p.sd! };
  }
  return undefined;
}

export interface QuantStageInput {
  mode: Exclude<QuantMode, "off">;
  spec: AnswerSpec;
  readings: readonly Reading[];
  priors?: readonly SuppliedPrior[];
  cutoff: string;
  endTime?: string;
}

export interface QuantStage {
  record: QuantRecord;
  /** Dossier lines for the runs (empty unless mode `on`). */
  lines: string[];
  /** Evidence text for the judge (undefined unless mode `on`). */
  evidence?: string;
}

/** Compute the stage. Never throws: a failure becomes a note. */
export function quantStage(input: QuantStageInput): QuantStage {
  const record: QuantRecord = { mode: input.mode, shown: false, notes: [] };
  const target =
    input.endTime && Number.isFinite(Date.parse(input.endTime)) ? input.endTime : input.cutoff;
  try {
    const baseline = seriesBaseline(input.readings, target);
    if (baseline) record.baseline = baseline;
    else record.notes.push("no official series with history to fit");
  } catch (err) {
    record.notes.push(`series fit failed: ${(err as Error).message}`.slice(0, 160));
  }

  if (input.spec.type === "choice") {
    const ranges = optionRanges(input.spec.options);
    if (!ranges) {
      record.notes.push("the options are not numeric ranges");
    } else {
      const fromSeries = record.baseline
        ? { mean: record.baseline.mean, sd: record.baseline.sd }
        : undefined;
      const fromPrior = fromSeries ? undefined : numericPrior(input.priors, input.cutoff);
      const predictive = fromSeries ?? fromPrior;
      if (!predictive) {
        record.notes.push("no numeric predictive distribution (series or numeric prior)");
      } else {
        try {
          const pred: Predictive = { kind: "normal", ...predictive };
          const result = bucketProbabilities(pred, ranges.buckets);
          const distribution: Distribution = {};
          const shown: Record<string, string> = {};
          input.spec.options.forEach((o, i) => {
            distribution[o.id] = result.buckets[i]!.share;
            shown[o.id] = formatBucket(ranges.buckets[i]!);
          });
          record.buckets = {
            source: fromSeries ? "series" : "prior",
            predictive: { mean: predictive.mean, sd: predictive.sd },
            distribution,
            best: input.spec.options[result.best]!.id,
            coverage: result.coverage,
            ...(ranges.gapsClosed ? { gapsClosed: true } : {}),
            ranges: shown,
          };
        } catch (err) {
          record.notes.push(`bucket probabilities failed: ${(err as Error).message}`.slice(0, 160));
        }
      }
    }
  }

  const lines: string[] = [];
  if (input.mode === "on") {
    if (record.baseline) lines.push(baselineLine(record.baseline));
    if (record.buckets) lines.push(bucketsLine(record.buckets, input.spec));
    record.shown = lines.length > 0;
  }
  return {
    record,
    lines,
    ...(lines.length ? { evidence: lines.map((l) => l.replace(/^- /, "")).join("\n") } : {}),
  };
}

export function baselineLine(b: QuantBaseline): string {
  const basis =
    b.sdBasis === "rolling-origin"
      ? "its own past misses at that horizon"
      : "a short history (treat the spread as rough)";
  return `- QUANT BASELINE — a statistical fit (${b.method}) of ${b.source} ${b.series}'s own ${b.points} readings to ${b.lastDate} projects ${round(b.mean, 6)} for ${b.target.slice(0, 10)} (~${b.steps} step${b.steps === 1 ? "" : "s"} ahead; sd ${round(b.sd)} from ${basis}; 80% range ${round(b.p10, 6)}–${round(b.p90, 6)}). It knows only the series' past: use it as the reference class, and move from it for specific dated evidence.`;
}

export function bucketsLine(q: QuantBuckets, spec: AnswerSpec): string {
  const labels = spec.type === "choice" ? spec.options : [];
  const parts = labels.map(
    (o) => `${o.id} (${q.ranges[o.id]}) ${(100 * (q.distribution[o.id] ?? 0)).toFixed(1)}%`,
  );
  const from = q.source === "series" ? "the series baseline" : "the supplied numeric prior";
  return `- QUANT RANGES — under a normal with mean ${round(q.predictive.mean, 6)} and sd ${round(q.predictive.sd)} (${from}), each option's probability is: ${parts.join("; ")}. Most likely: ${q.best}. A mechanical computation, not a forecast: weigh it against the evidence.`;
}
