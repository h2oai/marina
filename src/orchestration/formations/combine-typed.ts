// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The pure combiners of the typed forecast formations (catalogue entries
 * `ensemble`, `delphi`, `tournament`, `skeptic`): answers in, the combined
 * answer's fields out, per answer type. No model calls, no I/O, no clock —
 * the formation runner (`src/forecast/formations.ts`) asks the members
 * through the Score and hands their replies here.
 *
 *   ensemble    `combineAnswers` by type (`src/forecast/answer-types.ts`) and
 *               the critique — the typed pipeline's own combine
 *   delphi      the revisions' combination by type; per-option medians of
 *               their probabilities (a choice's renormalised); a number's
 *               spread pooled with the revisions' sds
 *   tournament  the champion's answer, probabilities and sd
 *   skeptic     the proposals' mean (geometric for a choice, log-odds per
 *               option for a multi-select, arithmetic for a number) moved back
 *               toward the informative prior by (1 − trust)
 */

import { picksFrom } from "../../forecast/adjust";
import {
  type AnswerOption,
  type AnswerSpec,
  type AnswerValue,
  type CombinedAnswer,
  combineAnswers,
  formatAnswer,
} from "../../forecast/answer-types";
import { argmax, combinedSd, type Distribution, normalise } from "../../forecast/distribution";
import {
  clampP,
  logit,
  poolDistribution,
  poolMarginals,
  round,
  sigmoid,
} from "../../forecast/fitting";
import { informative } from "../../forecast/history";
import { type ChosenPrior, shrink } from "../../forecast/prior";
import type { TypedRun } from "../../forecast/typed";

const SNIPPET = 160;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Per-option median; a choice's renormalised to sum 1. */
export function medianDistribution(
  options: AnswerOption[],
  ds: Distribution[],
  sumToOne: boolean,
): Distribution {
  const out: Distribution = {};
  for (const o of options) out[o.id] = median(ds.map((d) => d[o.id] ?? 0));
  if (sumToOne) return normalise(out) ?? out;
  return out;
}

// ─── Delphi ──────────────────────────────────────────────────────────────────

/** The anonymous panel summary: medians, ranges and reason snippets, never who said what. */
export function panelSummary(spec: AnswerSpec, runs: TypedRun[]): string {
  const lines: string[] = [`${runs.length} forecasters answered independently.`];
  const withDist = runs.filter((r) => r.distribution);
  if (withDist.length && "options" in spec) {
    for (const o of spec.options) {
      const ps = withDist.map((r) => r.distribution![o.id] ?? 0);
      lines.push(
        `  ${o.id}${o.label ? ` (${clip(o.label, 60)})` : ""}: median ${median(ps).toFixed(2)}, range ${Math.min(...ps).toFixed(2)}–${Math.max(...ps).toFixed(2)}`,
      );
    }
  } else if (spec.type === "number") {
    const xs = runs.map((r) => r.value as number);
    lines.push(`  median ${median(xs)}, range ${Math.min(...xs)}–${Math.max(...xs)}`);
  } else {
    const counts = new Map<string, number>();
    for (const r of runs) counts.set(r.formatted!, (counts.get(r.formatted!) ?? 0) + 1);
    for (const [a, n] of counts) lines.push(`  ${n}× ${clip(a, 80)}`);
  }
  const reasons = runs.map((r) => r.reason).filter((x): x is string => !!x);
  if (reasons.length) {
    lines.push("Reasons given (anonymous):");
    for (const r of reasons) lines.push(`  - ${clip(r, SNIPPET)}`);
  }
  return lines.join("\n");
}

/** One usable Delphi revision. */
export interface TypedRevision {
  value: AnswerValue;
  distribution?: Distribution;
  sd?: number;
}

/** The fields a Delphi combination sets on the answer, in the order it sets them. */
export interface TypedAnswerPatch {
  combined?: CombinedAnswer;
  prediction?: AnswerValue;
  formatted?: string;
  confidence?: number;
  distribution?: Distribution;
  uncertainty?: { sd: number };
}

/** Delphi: the revisions combined by type (at least one). */
export function combineDelphi(spec: AnswerSpec, ok: readonly TypedRevision[]): TypedAnswerPatch {
  const out: TypedAnswerPatch = {};
  const combined = combineAnswers(
    spec,
    ok.map((r) => ({ value: r.value, weight: 1 })),
  );
  if (combined) {
    out.combined = combined;
    out.prediction = combined.value;
    out.formatted = formatAnswer(combined.value);
    out.confidence = combined.agreement;
  }
  if ("options" in spec && ok.every((r) => r.distribution)) {
    const dist = medianDistribution(
      spec.options,
      ok.map((r) => r.distribution!),
      spec.type === "choice",
    );
    out.distribution = dist;
    if (spec.type === "choice") {
      const top = argmax(spec.options, dist);
      out.prediction = top;
      out.formatted = top;
      out.confidence = dist[top];
    }
  }
  if (spec.type === "number") {
    const sd = combinedSd(
      ok.map((r) => ({ ...(r.sd !== undefined ? { sd: r.sd } : {}), weight: 1 })),
      combined?.spread ?? 0,
    );
    if (sd !== undefined) out.uncertainty = { sd };
  }
  return out;
}

// ─── Tournament ──────────────────────────────────────────────────────────────

/** A tournament referee's reply → the winner (B only when it says B; anything else A). */
export function matchWinner(reply: Record<string, unknown> | undefined): {
  pick: string;
  winner: "a" | "b";
} {
  const pick = String(reply?.winner ?? "")
    .trim()
    .toUpperCase();
  return { pick, winner: pick === "B" ? "b" : "a" };
}

/** The champion's answer fields, before (`head`) and after (`tail`) the formation record. */
export function championAnswer(
  spec: AnswerSpec,
  champ: Pick<TypedRun, "value" | "formatted" | "confidence" | "distribution" | "sd">,
  fallbackSd: number | undefined,
): {
  head: { prediction: AnswerValue | undefined; formatted: string | undefined; confidence?: number };
  tail: TypedAnswerPatch;
} {
  const head = {
    prediction: champ.value,
    formatted: champ.formatted,
    ...(champ.confidence !== undefined ? { confidence: champ.confidence } : {}),
  };
  const tail: TypedAnswerPatch = {};
  if (champ.distribution) {
    tail.distribution = champ.distribution;
    if (spec.type === "choice") tail.confidence = champ.distribution[champ.formatted!];
  }
  if (spec.type === "number") {
    const sd = champ.sd ?? fallbackSd;
    if (sd !== undefined) tail.uncertainty = { sd };
  }
  return { head, tail };
}

// ─── Skeptic ─────────────────────────────────────────────────────────────────

/** A proposal further than this many start sds from the start forecast is a blowup. */
export const SKEPTIC_MAX_SD_MOVE = 4;

/** A number's proposals within `SKEPTIC_MAX_SD_MOVE` start sds of the start forecast. */
export function skepticProposals<R extends Pick<TypedRun, "value">>(
  spec: AnswerSpec,
  usable: R[],
  start: ChosenPrior | undefined,
): R[] {
  if (
    spec.type === "number" &&
    start?.value !== undefined &&
    start.sd !== undefined &&
    start.sd > 0
  )
    return usable.filter(
      (r) => Math.abs((r.value as number) - start.value!) <= SKEPTIC_MAX_SD_MOVE * start.sd!,
    );
  return usable;
}

/** The skeptic's reply → trust in [0, 1] (default 0.5) and a number's sd scale in [1, 2]. */
export function skepticTrust(
  spec: AnswerSpec,
  reply: Record<string, unknown> | undefined,
): { trust: number; sdScale: number } {
  let trust = 0.5;
  let sdScale = 1;
  const t = Number(reply?.trust);
  if (Number.isFinite(t)) trust = Math.min(1, Math.max(0, t));
  const s = Number(reply?.sd_scale);
  if (spec.type === "number" && Number.isFinite(s)) sdScale = Math.min(2, Math.max(1, s));
  return { trust, sdScale };
}

export type SkepticCombined =
  | { kind: "number"; value: number; sd: number | undefined }
  | { kind: "choice"; distribution: Distribution; top: string }
  | { kind: "multi"; distribution: Distribution; picks: string[] }
  | { kind: "none"; note: string };

/**
 * The skeptic crew's deterministic aggregation: the proposals' mean moved
 * back toward the informative start forecast by (1 − trust). A choice or
 * multi-select shrinks only toward an INFORMATIVE prior (`unshrunk` says it
 * did not); a number widens by `sdScale`, never narrows.
 */
export function combineSkeptic(
  spec: Exclude<AnswerSpec, { type: "ranking" | "text" }>,
  proposals: ReadonlyArray<Pick<TypedRun, "value" | "sd" | "distribution">>,
  start: ChosenPrior | undefined,
  trust: number,
  sdScale: number,
): SkepticCombined & { unshrunk?: boolean } {
  if (spec.type === "number") {
    const values = proposals.map((r) => r.value as number);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sds = proposals.filter((r) => r.sd !== undefined).map((r) => r.sd!);
    const meanSd = sds.length ? sds.reduce((a, b) => a + b, 0) / sds.length : undefined;
    if (start?.value !== undefined) {
      const moved = shrink(
        "number",
        { value: mean, ...(meanSd !== undefined ? { sd: meanSd } : {}) },
        start,
        1 - trust,
      );
      const floor = start.sd !== undefined ? 0.5 * start.sd : 0;
      const sd = moved.sd !== undefined ? Math.max(floor, moved.sd) * sdScale : undefined;
      return { kind: "number", value: moved.value!, sd };
    }
    const spread = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
    const sd = combinedSd(
      proposals.map((r) => ({ ...(r.sd !== undefined ? { sd: r.sd } : {}), weight: 1 })),
      spread,
    );
    return { kind: "number", value: mean, sd: sd !== undefined ? sd * sdScale : undefined };
  }
  const dists = proposals.map((r) => r.distribution).filter((d): d is Distribution => !!d);
  if (dists.length === 0) return { kind: "none", note: "no proposal stated probabilities" };
  const ids = spec.options.map((o) => o.id);
  // The skeptic shrinks only toward an informative prior. Toward the uniform
  // default it would add to the hedging LLM forecasters already show; without
  // one the proposals' log-odds mean stands and extremity is calibration's job.
  const shrinkable = informative(start?.source) && !!start?.distribution;
  const unshrunk = shrinkable ? {} : { unshrunk: true };
  if (spec.type === "choice") {
    const mean: Distribution = {};
    for (const k of ids) {
      mean[k] = Math.exp(dists.reduce((s, d) => s + Math.log(clampP(d[k] ?? 0)), 0) / dists.length);
    }
    const m = normalise(mean) ?? dists[0]!;
    const final = shrinkable ? poolDistribution(m, start!.distribution!, 1 - trust) : m;
    return { kind: "choice", distribution: final, top: argmax(spec.options, final), ...unshrunk };
  }
  const mean: Distribution = {};
  for (const k of ids) {
    mean[k] = round(
      clampP(sigmoid(dists.reduce((s, d) => s + logit(d[k] ?? 0.5), 0) / dists.length)),
    );
  }
  const final = shrinkable ? poolMarginals(mean, start!.distribution!, 1 - trust) : mean;
  return { kind: "multi", distribution: final, picks: picksFrom(spec, final), ...unshrunk };
}

/** A number answer's value and sd as filed (integer or 6 decimals; no sd unless positive). */
export function numberFields(
  spec: Extract<AnswerSpec, { type: "number" }>,
  value: number,
  sd: number | undefined,
): { prediction: number; formatted: string; uncertainty?: { sd: number } } {
  const v = spec.integer ? Math.round(value) : round(value, 6);
  return {
    prediction: v,
    formatted: formatAnswer(v),
    ...(sd !== undefined && sd > 0 ? { uncertainty: { sd: round(sd, 6) } } : {}),
  };
}
