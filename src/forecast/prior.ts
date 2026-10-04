// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Priors: the forecast a question already has before Marina reasons about it,
 * and how far Marina's own answer is pooled toward it. The arena's lesson in
 * general form — its `model:` forecasters are shrunk toward persistence,
 * because raw model forecasts lose mostly through a few large misses and a
 * strong baseline caps them.
 *
 * The prior is the best one available AT THE CUTOFF, in this order:
 *
 *   market         a market price the asker supplied (an adapter's own feed)
 *   community      a community forecast the asker supplied
 *   market-lookup  one priced market a lookup matched, for a yes/no question
 *   anchor         the freshest official reading of the quantity (a number)
 *   base-rate      how the question's reference class resolved in history
 *                  (per recurring option label for a choice, per class for a
 *                  multi-select), smoothed toward uniform
 *   type-default   uniform over a choice's options, 0.5 per multi-select option
 *
 * A supplied prior whose information time is after the cutoff is rejected
 * (and the rejection recorded) — a prior can never carry the future.
 *
 * Shrinkage pools the answer toward its prior: in log-odds for probabilities
 * (a geometric pool for a choice), linearly for a number. The weight is fitted
 * on resolved history (`./history.ts`) per (prior source, answer group) and
 * adopted only when it beats the default weight on held-out history by the
 * margin (`./fitting.ts`); the default is `priorWeight` for a supplied market or
 * community forecast and 0 (no shrink) for everything else, which must earn a
 * weight from evidence. Pure functions.
 */

import type { AnswerOption, AnswerSpec } from "./answer-types";
import { type Distribution, normalise } from "./distribution";
import {
  type AdoptionResult,
  adoptOnHoldout,
  clampP,
  gridArgmin,
  meanLoss,
  type ProperScore,
  poolDistribution,
  poolMarginals,
  poolNumber,
  round,
  uniform,
} from "./fitting";
import {
  answerGroup,
  type ForecastNumbers,
  labelKey,
  type PriorContext,
  type PriorSource,
  priorBucket,
  type ResolvedRecord,
} from "./history";
import type { LookupResult, NumericAnchor } from "./lookups";

/** A prior the asker supplies (an adapter's market price or community forecast). */
export interface SuppliedPrior {
  source: "market" | "community";
  /** Per option: a choice's probabilities, or a multi-select's per-option probabilities. */
  distribution?: Record<string, number>;
  /** A number's prior value (and spread). */
  value?: number;
  sd?: number;
  /** When it was observed (ISO). Must be at or before the evidence cutoff. */
  at: string;
  /** A short free label (venue, platform) kept on the audit trail. */
  label?: string;
  /** Market liquidity or volume in USD, when the venue reports it (the weight may depend on it). */
  liquidity?: number;
}

export interface ChosenPrior extends ForecastNumbers, PriorContext {
  source: PriorSource;
  /** Its information time, when it has one. */
  at?: string;
  detail: string;
}

export interface PriorChoice {
  prior?: ChosenPrior;
  /** Priors passed over and why (after the cutoff, malformed, …). */
  rejected?: Array<{ source: string; reason: string }>;
}

/** Fewest offers of a label (or class events) before a base rate counts. */
export const MIN_BASE_RATE_EVIDENCE = 10;
/** Pseudo-count pulling a base rate toward uniform. */
const BASE_RATE_PSEUDO = 4;

const YES = /^(yes|y|true)$/i;
const NO = /^(no|n|false)$/i;

/** The yes/no option ids of a two-option choice, if that is what it is. */
export function yesNo(spec: AnswerSpec): { yes: string; no: string } | undefined {
  if (spec.type !== "choice" || spec.options.length !== 2) return undefined;
  const text = (o: AnswerOption) => (o.label ?? o.id).trim();
  const yes = spec.options.find((o) => YES.test(text(o)) || YES.test(o.id));
  const no = spec.options.find((o) => NO.test(text(o)) || NO.test(o.id));
  return yes && no && yes !== no ? { yes: yes.id, no: no.id } : undefined;
}

export function choosePrior(input: {
  spec: AnswerSpec;
  cutoff: string;
  supplied?: SuppliedPrior[];
  lookups?: LookupResult[];
  anchor?: NumericAnchor;
  /** Visible resolved history (`visibleRecords`). */
  history?: ResolvedRecord[];
  category?: string;
}): PriorChoice {
  const { spec } = input;
  const rejected: Array<{ source: string; reason: string }> = [];
  const cutoff = Date.parse(input.cutoff);
  for (const source of ["market", "community"] as const) {
    for (const s of (input.supplied ?? []).filter((x) => x.source === source)) {
      const at = Date.parse(s.at);
      if (!Number.isFinite(at)) {
        rejected.push({ source, reason: "no information time" });
        continue;
      }
      if (at > cutoff) {
        rejected.push({ source, reason: `observed ${s.at}, after the cutoff` });
        continue;
      }
      const numbers = suppliedNumbers(spec, s);
      if ("error" in numbers) {
        rejected.push({ source, reason: numbers.error });
        continue;
      }
      return {
        prior: {
          source,
          ...numbers,
          ...(s.liquidity !== undefined && Number.isFinite(s.liquidity) && s.liquidity >= 0
            ? { liquidity: s.liquidity }
            : {}),
          at: new Date(at).toISOString(),
          detail: `${source}${s.label ? ` (${s.label.slice(0, 60)})` : ""} as of ${new Date(at).toISOString()}`,
        },
        ...(rejected.length ? { rejected } : {}),
      };
    }
  }
  const done = (prior?: ChosenPrior): PriorChoice => ({
    ...(prior ? { prior } : {}),
    ...(rejected.length ? { rejected } : {}),
  });
  const yn = yesNo(spec);
  if (yn) {
    const prices = (input.lookups ?? []).flatMap((l) => l.prices ?? []);
    const usable = prices.filter((p) => {
      const at = Date.parse(p.at);
      return Number.isFinite(at) && at <= cutoff && p.p > 0 && p.p < 1 && YES.test(p.outcome);
    });
    if (prices.length && usable.length !== 1) {
      rejected.push({
        source: "market-lookup",
        reason: `${usable.length} priced yes markets matched (a prior needs exactly one)`,
      });
    } else if (usable.length === 1) {
      const p = usable[0]!;
      return done({
        source: "market-lookup",
        distribution: { [yn.yes]: clampP(p.p), [yn.no]: clampP(1 - p.p) },
        at: p.at,
        detail: `${p.venue} price ${round(p.p, 3)} at ${p.at}`,
      });
    }
  }
  if (spec.type === "number" && input.anchor) {
    const a = input.anchor;
    if (Date.parse(a.asOf) <= cutoff) {
      return done({
        source: "anchor",
        value: a.value,
        ...(a.sd !== undefined ? { sd: a.sd } : {}),
        at: a.asOf,
        detail: `${a.source} ${a.series} ${a.value} on ${a.date}`,
      });
    }
    rejected.push({ source: "anchor", reason: "read after the cutoff" });
  }
  const base = baseRate(spec, input.history ?? [], input.category);
  if (base) return done(base);
  if (spec.type === "choice") {
    return done({
      source: "type-default",
      distribution: uniform(spec.options),
      detail: "uniform",
    });
  }
  if (spec.type === "multi") {
    return done({
      source: "type-default",
      distribution: Object.fromEntries(spec.options.map((o) => [o.id, 0.5])),
      detail: "0.5 per option",
    });
  }
  return done();
}

function suppliedNumbers(spec: AnswerSpec, s: SuppliedPrior): ForecastNumbers | { error: string } {
  if (spec.type === "number") {
    if (s.value === undefined || !Number.isFinite(s.value)) return { error: "no value" };
    return {
      value: s.value,
      ...(s.sd !== undefined && Number.isFinite(s.sd) && s.sd > 0 ? { sd: s.sd } : {}),
    };
  }
  if (spec.type !== "choice" && spec.type !== "multi") {
    return { error: `no prior for a ${spec.type} answer` };
  }
  const raw = s.distribution ?? {};
  const d: Distribution = {};
  for (const o of spec.options) {
    const p = Number(raw[o.id]);
    if (Number.isFinite(p) && p >= 0 && p <= 1) d[o.id] = p;
  }
  if (spec.type === "choice") {
    // A binary question priced on one side only gets the complement.
    if (Object.keys(d).length === 1 && spec.options.length === 2) {
      const [k] = Object.keys(d);
      const other = spec.options.find((o) => o.id !== k)!.id;
      d[other] = 1 - d[k!]!;
    }
    if (Object.keys(d).length !== spec.options.length) {
      return { error: "does not price every option" };
    }
    const n = normalise(d);
    return n ? { distribution: n } : { error: "all zero" };
  }
  if (Object.keys(d).length === 0) return { error: "prices no option" };
  const m: Distribution = {};
  for (const [k, p] of Object.entries(d)) m[k] = round(clampP(p));
  return { distribution: m };
}

/**
 * The reference class's base rate: per recurring option label for a choice
 * (how often a question offering that label resolved to it), per class for a
 * multi-select (how often an option resolved true) — the asker's category
 * first, else every record of the type. Smoothed toward uniform; undefined
 * with too little evidence.
 */
export function baseRate(
  spec: AnswerSpec,
  history: ResolvedRecord[],
  category?: string,
): ChosenPrior | undefined {
  if (spec.type !== "choice" && spec.type !== "multi") return undefined;
  const ofType = history.filter((r) => r.answerType === spec.type);
  const pools: Array<[string, ResolvedRecord[]]> = [];
  if (category) pools.push([`class ${category}`, ofType.filter((r) => r.category === category)]);
  pools.push([`all ${spec.type} questions`, ofType]);
  for (const [name, records] of pools) {
    if (spec.type === "multi") {
      let events = 0;
      let hits = 0;
      for (const r of records) {
        const truth = new Set(r.outcome.options ?? []);
        for (const o of r.resolvedOptions ?? Object.keys(r.raw.distribution ?? {})) {
          events++;
          if (truth.has(o)) hits++;
        }
      }
      if (events < MIN_BASE_RATE_EVIDENCE) continue;
      const rate = (hits + 0.5 * BASE_RATE_PSEUDO) / (events + BASE_RATE_PSEUDO);
      return {
        source: "base-rate",
        distribution: Object.fromEntries(spec.options.map((o) => [o.id, round(clampP(rate))])),
        detail: `${name}: ${hits}/${events} options resolved true`,
      };
    }
    const n = spec.options.length;
    const raw: Distribution = {};
    let evidence = 0;
    for (const o of spec.options) {
      const key = labelKey(o.label ?? o.id);
      let offered = 0;
      let won = 0;
      for (const r of records) {
        const id = Object.entries(r.labels ?? {}).find(([, k]) => k === key)?.[0];
        if (id === undefined || (r.outcome.options ?? []).length !== 1) continue;
        offered++;
        if (r.outcome.options![0] === id) won++;
      }
      evidence = Math.max(evidence, offered);
      raw[o.id] = (won + BASE_RATE_PSEUDO / n) / (offered + BASE_RATE_PSEUDO);
    }
    if (evidence < MIN_BASE_RATE_EVIDENCE) continue;
    const d = normalise(raw);
    if (!d) continue;
    return {
      source: "base-rate",
      distribution: d,
      detail: `${name}: option labels offered up to ${evidence}×`,
    };
  }
  return undefined;
}

// ─── Shrinkage toward the prior ──────────────────────────────────────────────

/** `f` pooled toward `prior` by weight `w` (0 = unchanged). */
export function shrink(
  type: AnswerSpec["type"],
  f: ForecastNumbers,
  prior: ForecastNumbers,
  w: number,
): ForecastNumbers {
  if (w <= 0) return f;
  if (type === "number") {
    if (f.value === undefined || prior.value === undefined) return f;
    return poolNumber(
      { value: f.value, ...(f.sd !== undefined ? { sd: f.sd } : {}) },
      { value: prior.value, ...(prior.sd !== undefined ? { sd: prior.sd } : {}) },
      w,
    );
  }
  if (!f.distribution || !prior.distribution) return f;
  return {
    distribution:
      type === "multi"
        ? poolMarginals(f.distribution, prior.distribution, w)
        : poolDistribution(f.distribution, prior.distribution, w),
  };
}

export const WEIGHT_GRID = Array.from({ length: 11 }, (_, i) => i / 10);

export interface ShrinkWeight extends AdoptionResult<number> {
  source: PriorSource;
  group: string;
  /** The time-to-close / liquidity bucket the weight was fitted in, when it had enough records. */
  bucket?: string;
}

/** The default weight before evidence: `priorWeight` for a supplied market/community forecast, else 0. */
export function defaultWeight(source: PriorSource, priorWeight: number): number {
  return source === "market" || source === "community" ? priorWeight : 0;
}

/**
 * The weight for pooling toward a prior of `source`, fitted on the visible
 * records of the same answer group that had a prior of the same source, and
 * adopted only on a held-out win over the default.
 */
export function fitShrinkWeight(input: {
  spec: AnswerSpec;
  source: PriorSource;
  history: ResolvedRecord[];
  priorWeight: number;
  margin: number;
  minRecords: number;
  score: ProperScore;
  /**
   * The current prior's context: with enough records in its time-to-close /
   * liquidity bucket, the weight is fitted there (a liquid market near its
   * close can earn more weight than a thin one far from it); else on all.
   */
  context?: PriorContext;
}): ShrinkWeight {
  const group = answerGroup(input.spec);
  const all = input.history.filter((r) => r.group === group && r.prior?.source === input.source);
  const bucket = input.context ? priorBucket(input.context) : undefined;
  const inBucket = bucket ? all.filter((r) => priorBucket(r.prior) === bucket) : [];
  const useBucket = bucket !== undefined && inBucket.length >= input.minRecords;
  const records = useBucket ? inBucket : all;
  const lossAt = (rs: ResolvedRecord[], w: number) =>
    meanLoss(rs, (r) => shrink(r.answerType, r.raw, r.prior!, w), input.score);
  const result = adoptOnHoldout(records, {
    fallback: defaultWeight(input.source, input.priorWeight),
    fit: (rs) => gridArgmin(WEIGHT_GRID, (w) => lossAt(rs, w).loss),
    loss: lossAt,
    margin: input.margin,
    minRecords: input.minRecords,
  });
  return { ...result, source: input.source, group, ...(useBucket ? { bucket } : {}) };
}
