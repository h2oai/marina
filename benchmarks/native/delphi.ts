// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Delphi on a synthetic series.
 *
 * A seeded AR(1): x[t] = mu + phi (x[t-1] - mu) + sigma e, published rounded
 * to 2 decimals (each step conditions on the rounded value, so the published
 * series is the process). Members see different overlapping windows; only the
 * last window reaches x[T]. The ask is a normal {mean, sd} for x[T+1].
 *
 * Oracle: expected CRPS (the arena's closed-form `crpsNormal`) over stratified
 * draws from the true predictive N(mu + phi (x[T] - mu), sigma), against a
 * persistence baseline N(x[T], sd of first differences). Score = max(0, skill);
 * correct = skill > 0. Construction guarantees the true predictive has skill
 * ≥ 0.05, so the task is solvable.
 */

import { crpsNormal, skill } from "../../src/arena/score";
import { normalQuantile } from "../../src/arena/score-shapes";
import {
  DEFAULT_POOL,
  deliverableRe,
  depositClause,
  type GenerateOptions,
  makeRng,
  type NativeGenerator,
  type NativeInstance,
  type NativeScore,
  parseFields,
  parseNum,
  privateMap,
  resolveMembers,
  type SetupStep,
} from "./shared";

export interface DelphiOracle {
  tag: string;
  mu: number;
  phi: number;
  sigma: number;
  series: number[];
  predictive: { mean: number; sd: number };
  persistence: { mean: number; sd: number };
  persistenceCrps: number;
  optimalSkill: number;
  /** Member → [start, end) window (0-based indices). */
  windows: Record<string, [number, number]>;
}

const DRAWS = 1000;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Expected CRPS of N(mean, sd) under stratified draws from N(tm, ts). */
export function expectedCrps(mean: number, sd: number, tm: number, ts: number): number {
  let total = 0;
  for (let k = 0; k < DRAWS; k++)
    total += crpsNormal(mean, sd, normalQuantile(tm, ts, (k + 0.5) / DRAWS));
  return total / DRAWS;
}

function sdOf(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

export function generateDelphi(seed: number, opts?: GenerateOptions): NativeInstance<DelphiOracle> {
  const members = resolveMembers(opts);
  const pool = opts?.pool ?? DEFAULT_POOL;
  const tag = `DLP${seed}`;
  for (let attempt = 0; ; attempt++) {
    const rng = makeRng(seed, `delphi:${attempt}`);
    const mu = round2(rng.int(-500, 500) / 10);
    const phi = round2(0.25 + rng.next() * 0.5);
    const sigma = round2(0.5 + rng.next() * 2.5);
    const T = 48;
    const series: number[] = [];
    let prev = round2(mu + (sigma / Math.sqrt(1 - phi * phi)) * rng.normal());
    for (let t = 0; t < T; t++) {
      prev = round2(mu + phi * (prev - mu) + sigma * rng.normal());
      series.push(prev);
    }
    const last = series[T - 1]!;
    const predictive = { mean: mu + phi * (last - mu), sd: sigma };
    const diffs = series.slice(1).map((x, i) => x - series[i]!);
    const persistence = { mean: last, sd: sdOf(diffs) };
    const persistenceCrps = expectedCrps(persistence.mean, persistence.sd, predictive.mean, sigma);
    const optimalSkill = skill(
      expectedCrps(predictive.mean, sigma, predictive.mean, sigma),
      persistenceCrps,
    );
    if (optimalSkill < 0.05) continue;
    // Overlapping windows; the last member's window ends at x[T].
    const M = members.length;
    const span = M === 1 ? T : Math.ceil((T * 1.5) / M);
    const windows: Record<string, [number, number]> = {};
    members.forEach((mem, i) => {
      const end = M === 1 ? T : Math.round(span + ((T - span) * i) / (M - 1));
      windows[mem] = [Math.max(0, end - span), end];
    });
    const setup: SetupStep[] = members.map((mem) => {
      const [a, b] = windows[mem]!;
      return {
        kind: "private",
        member: mem,
        text: `PRIVATE ${tag} window x[${a + 1}..${b}] (yours only): ${series.slice(a, b).join(", ")}.`,
      };
    });
    const format = `${tag} FORECAST: mean=<m>; sd=<s>.`;
    const text =
      `TASK ${tag} (forecast): A stationary series x[1..${T}] is split into overlapping windows dealt to crew members by private Operator tells headed PRIVATE ${tag}. ` +
      `Forecast x[${T + 1}] as a normal distribution; scored by CRPS against a persistence baseline. ${depositClause(pool, format)}`;
    return {
      task: "delphi",
      seed,
      tag,
      shape: "delphi",
      text,
      privateMaterial: privateMap(setup),
      setup,
      pool,
      deliverableRe: deliverableRe(tag, "FORECAST"),
      answer: `${tag} FORECAST: mean=${round2(predictive.mean)}; sd=${round2(sigma)}`,
      oracle: {
        tag,
        mu,
        phi,
        sigma,
        series,
        predictive,
        persistence,
        persistenceCrps,
        optimalSkill,
        windows,
      },
    };
  }
}

export function scoreDelphi(deliverable: string, o: DelphiOracle): NativeScore {
  const fields = parseFields(deliverable, o.tag, "FORECAST");
  if (!fields) return { correct: false, score: 0, details: { error: "no FORECAST line" } };
  const mean = parseNum(fields.get("mean"));
  const sd = parseNum(fields.get("sd"));
  if (mean === null || sd === null || sd < 0)
    return { correct: false, score: 0, details: { error: "mean/sd unreadable", mean, sd } };
  const crps = expectedCrps(mean, sd, o.predictive.mean, o.predictive.sd);
  const s = skill(crps, o.persistenceCrps);
  return {
    correct: s > 0,
    score: Math.max(0, Math.min(1, s)),
    details: {
      mean,
      sd,
      crps,
      persistenceCrps: o.persistenceCrps,
      skill: s,
      optimalSkill: o.optimalSkill,
      /** skill / optimal skill: 1 = as good as the true predictive. */
      relativeSkill: s / o.optimalSkill,
    },
  };
}

export const delphiGenerator: NativeGenerator<DelphiOracle> = {
  id: "delphi",
  title: "Delphi on a synthetic series",
  shape: "delphi",
  generate: generateDelphi,
  score: scoreDelphi,
};
