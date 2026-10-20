// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Distribution → buckets: the probability that a numeric outcome lands in each
 * of a set of ranges, and the most likely range. Pure, dependency-free. Any
 * multiple-choice numeric question ("below 3%", "3–4%", "above 4%") is this
 * computation once the forecaster has a predictive distribution.
 *
 * Predictive distributions:
 *   normal     mean and sd; sd 0 is a point mass at the mean
 *   quantiles  (level, value) pairs; the CDF is linear between them, with
 *              exponential tails whose density matches the nearest segment.
 *              Equal values at different levels are an atom (a point mass).
 *
 * Buckets are intervals with optional ends (an absent end is open: −∞ / +∞)
 * and per-end inclusion; the default is [lo, hi). Inclusion only matters
 * where the distribution has an atom — a point mass or tied quantiles.
 */

import { normalCdf } from "./normal";

export type Predictive =
  | { kind: "normal"; mean: number; sd: number }
  | { kind: "quantiles"; quantiles: ReadonlyArray<{ level: number; value: number }> };

export interface Bucket {
  label?: string;
  /** Lower end; absent = −∞. */
  lo?: number;
  /** Upper end; absent = +∞. */
  hi?: number;
  /** Whether `lo` itself is in the bucket (default true). */
  loClosed?: boolean;
  /** Whether `hi` itself is in the bucket (default false). */
  hiClosed?: boolean;
}

export interface BucketProbability {
  label: string;
  lo?: number;
  hi?: number;
  loClosed: boolean;
  hiClosed: boolean;
  /** P(outcome in bucket). */
  p: number;
  /** `p` divided by the total over all buckets (equal to `p` when the buckets partition the line). */
  share: number;
}

export interface BucketResult {
  buckets: BucketProbability[];
  /** Index of the most likely bucket (the first on a tie). */
  best: number;
  /** Total probability across the buckets: 1 when they partition the line. */
  coverage: number;
  /** Buckets tied with the best (indices), including it. */
  ties: number[];
  warnings: string[];
}

/** P(X < x) and P(X ≤ x) — they differ only at an atom. */
interface Cdf {
  below(x: number): number;
  atMost(x: number): number;
  warnings: string[];
}

/** Probabilities this close are a tie. */
const TIE_EPS = 1e-12;

/** CDF of a predictive distribution. Throws RangeError on an invalid one. */
export function predictiveCdf(pred: Predictive): Cdf {
  if (pred.kind === "normal") {
    const { mean, sd } = pred;
    if (!Number.isFinite(mean)) throw new RangeError(`mean must be finite, got ${mean}`);
    if (!Number.isFinite(sd) || sd < 0)
      throw new RangeError(`sd must be finite and ≥ 0, got ${sd}`);
    if (sd === 0) {
      return {
        below: (x) => (x > mean ? 1 : 0),
        atMost: (x) => (x >= mean ? 1 : 0),
        warnings: ["sd is 0: the whole probability sits on the mean"],
      };
    }
    const f = (x: number) => normalCdf(x, mean, sd);
    return { below: f, atMost: f, warnings: [] };
  }
  return quantileCdf(pred.quantiles);
}

function quantileCdf(raw: ReadonlyArray<{ level: number; value: number }>): Cdf {
  const warnings: string[] = [];
  if (raw.length < 2) {
    throw new RangeError("give at least two quantiles (one quantile has no spread), or a normal");
  }
  for (const q of raw) {
    if (!(q.level >= 0 && q.level <= 1)) {
      throw new RangeError(`quantile level must be in [0, 1], got ${q.level}`);
    }
    if (!Number.isFinite(q.value))
      throw new RangeError(`quantile value must be finite, got ${q.value}`);
  }
  const byLevel = [...raw].sort((a, b) => a.level - b.level);
  for (let i = 1; i < byLevel.length; i++) {
    if (
      byLevel[i]!.level === byLevel[i - 1]!.level &&
      byLevel[i]!.value !== byLevel[i - 1]!.value
    ) {
      throw new RangeError(`two values for quantile level ${byLevel[i]!.level}`);
    }
  }
  const levels = byLevel.map((q) => q.level);
  let values = byLevel.map((q) => q.value);
  if (values.some((v, i) => i > 0 && v < values[i - 1]!)) {
    values = [...values].sort((a, b) => a - b);
    warnings.push("quantiles crossed (a higher level had a lower value); values were sorted");
  }
  const n = values.length;
  const lo = values[0]!;
  const hi = values[n - 1]!;
  if (lo === hi) {
    warnings.push("every quantile has the same value: the whole probability sits there");
    return {
      below: (x) => (x > lo ? 1 : 0),
      atMost: (x) => (x >= lo ? 1 : 0),
      warnings,
    };
  }
  // Densities of the outermost non-degenerate segments size the tails.
  let first = 0;
  while (values[first + 1] === values[first]) first++;
  let last = n - 1;
  while (values[last - 1] === values[last]) last--;
  const dLo = (levels[first + 1]! - levels[first]!) / (values[first + 1]! - values[first]!);
  const dHi = (levels[last]! - levels[last - 1]!) / (values[last]! - values[last - 1]!);
  const pLo = levels[0]!;
  const pHi = levels[n - 1]!;
  const lowerTail = (x: number) =>
    pLo === 0 ? 0 : dLo > 0 ? pLo * Math.exp((dLo * (x - lo)) / pLo) : 0;
  const upperTail = (x: number) =>
    pHi === 1 ? 1 : dHi > 0 ? 1 - (1 - pHi) * Math.exp((-dHi * (x - hi)) / (1 - pHi)) : 1;
  if (pLo > 0 && !(dLo > 0))
    warnings.push("no density to extend the lower tail: it is a point mass");
  if (pHi < 1 && !(dHi > 0))
    warnings.push("no density to extend the upper tail: it is a point mass");

  // Right-continuous: the largest knot ≤ x.
  const atMost = (x: number): number => {
    if (x < lo) return lowerTail(x);
    if (x >= hi) return x === hi ? pHi : upperTail(x);
    let i = 0;
    while (i + 1 < n && values[i + 1]! <= x) i++;
    return interpolate(i, x);
  };
  // Left limit: the smallest knot ≥ x.
  const below = (x: number): number => {
    if (x <= lo) return lowerTail(x);
    if (x > hi) return upperTail(x);
    let j = n - 1;
    while (j - 1 >= 0 && values[j - 1]! >= x) j--;
    return interpolate(j - 1, x);
  };
  const interpolate = (i: number, x: number): number => {
    const v0 = values[i]!;
    const v1 = values[i + 1]!;
    return levels[i]! + ((levels[i + 1]! - levels[i]!) * (x - v0)) / (v1 - v0);
  };
  return { below, atMost, warnings };
}

/** Buckets cut at sorted `thresholds`: (−∞, t1), [t1, t2), …, [tn, ∞) — or (…] with `closed: "upper"`. */
export function thresholdBuckets(
  thresholds: readonly number[],
  closed: "lower" | "upper" = "lower",
): Bucket[] {
  if (thresholds.length === 0) throw new RangeError("no thresholds given");
  for (const t of thresholds) {
    if (!Number.isFinite(t)) throw new RangeError(`threshold must be finite, got ${t}`);
  }
  const cuts = [...new Set(thresholds)].sort((a, b) => a - b);
  const loClosed = closed === "lower";
  const out: Bucket[] = [{ hi: cuts[0], loClosed, hiClosed: !loClosed }];
  for (let i = 1; i < cuts.length; i++) {
    out.push({ lo: cuts[i - 1], hi: cuts[i], loClosed, hiClosed: !loClosed });
  }
  out.push({ lo: cuts.at(-1), loClosed, hiClosed: !loClosed });
  return out;
}

/** "[a, b)", "< b", "≥ a", "= a" — a bucket written out. */
export function formatBucket(b: Bucket): string {
  const loClosed = b.loClosed ?? true;
  const hiClosed = b.hiClosed ?? false;
  if (b.lo === undefined && b.hi === undefined) return "any value";
  if (b.lo === undefined) return `${hiClosed ? "≤" : "<"} ${fmt(b.hi!)}`;
  if (b.hi === undefined) return `${loClosed ? "≥" : ">"} ${fmt(b.lo)}`;
  if (b.lo === b.hi) return `= ${fmt(b.lo)}`;
  return `${loClosed ? "[" : "("}${fmt(b.lo)}, ${fmt(b.hi)}${hiClosed ? "]" : ")"}`;
}

function fmt(x: number): string {
  return Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(10)));
}

/**
 * The probability of each bucket under `pred`, and the most likely one.
 * Buckets may overlap or leave gaps: `coverage` then differs from 1 and a
 * warning says so; `share` renormalises. Throws RangeError on an empty list,
 * an inverted bucket or an invalid distribution.
 */
export function bucketProbabilities(pred: Predictive, buckets: readonly Bucket[]): BucketResult {
  if (buckets.length === 0) throw new RangeError("no buckets given");
  const cdf = predictiveCdf(pred);
  const warnings = [...cdf.warnings];
  const rows = buckets.map((b, i) => {
    const loClosed = b.loClosed ?? true;
    const hiClosed = b.hiClosed ?? false;
    for (const end of [b.lo, b.hi]) {
      if (end !== undefined && Number.isNaN(end))
        throw new RangeError(`bucket ${i + 1} has a NaN end`);
    }
    const lo = b.lo === Number.NEGATIVE_INFINITY ? undefined : b.lo;
    const hi = b.hi === Number.POSITIVE_INFINITY ? undefined : b.hi;
    if (lo !== undefined && hi !== undefined && lo > hi) {
      throw new RangeError(`bucket ${i + 1} is inverted (${lo} > ${hi})`);
    }
    const upper = hi === undefined ? 1 : hiClosed ? cdf.atMost(hi) : cdf.below(hi);
    const lower = lo === undefined ? 0 : loClosed ? cdf.below(lo) : cdf.atMost(lo);
    const p = Math.min(1, Math.max(0, upper - lower));
    const label = b.label ?? formatBucket({ lo, hi, loClosed, hiClosed });
    return {
      label,
      ...(lo !== undefined ? { lo } : {}),
      ...(hi !== undefined ? { hi } : {}),
      loClosed,
      hiClosed,
      p,
    };
  });
  const coverage = rows.reduce((s, r) => s + r.p, 0);
  if (Math.abs(coverage - 1) > 1e-6) {
    warnings.push(
      `the buckets cover ${round(coverage * 100, 2)}% of the probability (gaps or overlaps); each bucket's share renormalises`,
    );
  }
  let best = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i]!.p > rows[best]!.p + TIE_EPS) best = i;
  const ties = rows.flatMap((r, i) => (Math.abs(r.p - rows[best]!.p) <= TIE_EPS ? [i] : []));
  if (ties.length > 1)
    warnings.push(`${ties.length} buckets tie for most likely; the first is picked`);
  return {
    buckets: rows.map((r) => ({ ...r, share: coverage > 0 ? r.p / coverage : 0 })),
    best,
    coverage,
    ties,
    warnings,
  };
}

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

// ─── Text form (the `quant buckets` command) ────────────────────────────────

const NUM = String.raw`[-+]?\$?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?%?|[-+]?inf(?:inity)?|∞|-∞`;

function num(s: string): number {
  const t = s.trim().toLowerCase().replace(/[$%]/g, "");
  if (t === "inf" || t === "+inf" || t === "infinity" || t === "+infinity" || t === "∞") {
    return Number.POSITIVE_INFINITY;
  }
  if (t === "-inf" || t === "-infinity" || t === "-∞") return Number.NEGATIVE_INFINITY;
  const n = Number(t);
  if (!Number.isFinite(n)) throw new RangeError(`not a number: "${s.trim()}"`);
  return n;
}

const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => Bucket]> = [
  [
    new RegExp(String.raw`^([\[(])\s*(${NUM})\s*,\s*(${NUM})\s*([\])])$`, "i"),
    (m) => ({ lo: num(m[2]!), hi: num(m[3]!), loClosed: m[1] === "[", hiClosed: m[4] === "]" }),
  ],
  [
    new RegExp(String.raw`^(<=|≤|=<|<|below|under|less than|at most)\s*(${NUM})$`, "i"),
    (m) => ({ hi: num(m[2]!), hiClosed: /^(<=|≤|=<|at most)$/i.test(m[1]!) }),
  ],
  [
    new RegExp(String.raw`^(>=|≥|=>|>|above|over|more than|at least)\s*(${NUM})$`, "i"),
    (m) => ({ lo: num(m[2]!), loClosed: /^(>=|≥|=>|at least)$/i.test(m[1]!) }),
  ],
  [new RegExp(String.raw`^(${NUM})\s*\+$`, "i"), (m) => ({ lo: num(m[1]!), loClosed: true })],
  [
    new RegExp(String.raw`^(${NUM})\s+or\s+(more|higher|above|greater|over)$`, "i"),
    (m) => ({ lo: num(m[1]!), loClosed: true }),
  ],
  [
    new RegExp(String.raw`^(${NUM})\s+or\s+(less|lower|below|fewer|under)$`, "i"),
    (m) => ({ hi: num(m[1]!), hiClosed: true }),
  ],
  [
    new RegExp(String.raw`^between\s+(${NUM})\s+and\s+(${NUM})$`, "i"),
    (m) => ({ lo: num(m[1]!), hi: num(m[2]!) }),
  ],
  [
    new RegExp(String.raw`^(${NUM})\s*(?:-|–|—|\.\.|to)\s*(${NUM})$`, "i"),
    (m) => ({ lo: num(m[1]!), hi: num(m[2]!) }),
  ],
  [
    new RegExp(String.raw`^=?\s*(${NUM})$`, "i"),
    (m) => ({ lo: num(m[1]!), hi: num(m[1]!), loClosed: true, hiClosed: true }),
  ],
];

/** Split on `,` `;` `|` or newlines outside brackets. */
function splitItems(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;|\n]/.test(ch)) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Parse a bucket list such as `<10, 10-20, 20..30, >=30` or
 * `A: below 2; B: [2, 3); C: 3+`. Each item may carry a label (`A:`); ranges
 * written `a-b`, `a..b`, `a to b` are [a, b); `[a, b]`-style brackets set the
 * ends exactly; a bare number is a point bucket. `$` and `%` are ignored (the
 * numbers stay in the units written). Throws RangeError naming a bad item.
 */
export function parseBuckets(text: string): Bucket[] {
  const items = splitItems(text);
  if (items.length === 0) throw new RangeError("no buckets given");
  return items.map((item) => {
    const labelled = /^([A-Za-z0-9_]{1,16})\s*:\s*(.+)$/.exec(item);
    const b = readBucket((labelled ? labelled[2]! : item).trim());
    if (!b) throw new RangeError(`cannot read bucket "${item}"`);
    return labelled ? { ...b, label: labelled[1]! } : { ...b, label: item };
  });
}

function readBucket(body: string): Bucket | undefined {
  for (const [re, build] of PATTERNS) {
    const m = body.match(re);
    if (m) {
      const b = build(m);
      if (b.lo === Number.NEGATIVE_INFINITY) delete b.lo;
      if (b.hi === Number.POSITIVE_INFINITY) delete b.hi;
      return b;
    }
  }
  return undefined;
}

/**
 * One range written as a multiple-choice option might be ("3.0% to 3.4%",
 * "200,000 or more", "Between 2 and 3", "Less than 1.5%"), or undefined when
 * the text is not a numeric range. Thousands separators are accepted (outside
 * bracket notation) and trailing periods are ignored. The label is the text.
 */
export function parseBucket(text: string): Bucket | undefined {
  let body = text.trim().replace(/\.$/, "");
  if (!/^[[(]/.test(body)) body = body.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  const b = readBucket(body);
  return b ? { ...b, label: text.trim() } : undefined;
}
