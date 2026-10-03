// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Metaculus questions ⇄ Marina's general typed forecaster:
 *
 *   binary          → a choice of Yes / No with probabilities  → probability_yes
 *   multiple_choice → a choice over the options with probabilities
 *                                                        → probability_yes_per_category
 *   numeric/discrete → a number with its uncertainty (sd)  → continuous_cdf
 *
 * Nothing here forecasts; it only maps.
 */

import type { AnswerOption, AnswerSpec } from "../../src/forecast/answer-types";
import type { TypedForecastAnswer, TypedForecastRequest } from "../../src/forecast/typed";
import { ATTRIBUTION, reasoningText } from "../forecasting/shared";
import type { ForecastPayload, MetaculusQuestion } from "./api";
import { type CdfQuestion, continuousCdf, quantileOf } from "./cdf";

export const SUPPORTED_TYPES = ["binary", "multiple_choice", "numeric", "discrete"] as const;

const P_MIN = 0.001;
const P_MAX = 0.999;
const clampP = (p: number) => Math.min(P_MAX, Math.max(P_MIN, p));

/** Option ids for a multiple-choice question: A, B, C, … (O1, O2, … past 26). */
export function optionsFor(q: MetaculusQuestion): AnswerOption[] {
  const labels = q.options ?? [];
  return labels.map((label, i) => ({
    id: labels.length <= 26 ? String.fromCharCode(65 + i) : `O${i + 1}`,
    label,
  }));
}

export function specFor(q: MetaculusQuestion): AnswerSpec | undefined {
  switch (q.type) {
    case "binary":
      return {
        type: "choice",
        options: [
          { id: "Yes", label: "Yes" },
          { id: "No", label: "No" },
        ],
        probabilities: true,
      };
    case "multiple_choice": {
      const options = optionsFor(q);
      return options.length >= 2 ? { type: "choice", options, probabilities: true } : undefined;
    }
    case "numeric":
    case "discrete":
      if (q.scaling?.range_min == null || q.scaling?.range_max == null) return undefined;
      return {
        type: "number",
        ...(q.unit ? { unit: q.unit } : {}),
        ...(q.type === "discrete" ? { integer: true } : {}),
      };
    default:
      return undefined;
  }
}

export function cdfQuestion(q: MetaculusQuestion): CdfQuestion | undefined {
  const s = q.scaling;
  if (!s || s.range_min == null || s.range_max == null) return undefined;
  const cdfSize =
    q.type === "discrete" && s.inbound_outcome_count ? s.inbound_outcome_count + 1 : 201;
  return {
    rangeMin: s.range_min,
    rangeMax: s.range_max,
    zeroPoint: s.zero_point ?? null,
    openLower: !!q.open_lower_bound,
    openUpper: !!q.open_upper_bound,
    cdfSize,
  };
}

const clip = (s: string | undefined | null, n: number) =>
  !s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** The general forecast request for one question; evidence is frozen at now (live). */
export function requestFor(q: MetaculusQuestion): TypedForecastRequest | undefined {
  const answer = specFor(q);
  if (!answer) return undefined;
  const bounds: string[] = [];
  const c = cdfQuestion(q);
  if (c && (q.type === "numeric" || q.type === "discrete")) {
    bounds.push(
      c.openLower
        ? `The range shown starts at ${c.rangeMin}, but the outcome may be lower.`
        : `The outcome cannot be lower than ${c.rangeMin}.`,
      c.openUpper
        ? `The range shown ends at ${c.rangeMax}, but the outcome may be higher.`
        : `The outcome cannot be higher than ${c.rangeMax}.`,
    );
  }
  const endTime = q.scheduled_resolve_time ?? q.scheduled_close_time ?? undefined;
  return {
    question: clip(q.title, 1_000),
    answer,
    ...(endTime ? { endTime } : {}),
    context: [
      q.resolution_criteria ? `Resolution criteria: ${clip(q.resolution_criteria, 2_500)}` : "",
      q.fine_print ? `Fine print: ${clip(q.fine_print, 1_500)}` : "",
      q.description ? `Background: ${clip(q.description, 2_500)}` : "",
      q.unit ? `Unit: ${q.unit}` : "",
      ...bounds,
      q.scheduled_close_time ? `Forecasting closes ${q.scheduled_close_time}.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** The forecast body for the API, or why there is none. */
export function payloadFor(
  q: MetaculusQuestion,
  answer: TypedForecastAnswer,
): { payload: ForecastPayload } | { skip: string } {
  const base = { question: q.id, source: "api" as const };
  if (q.type === "binary") {
    const p = answer.distribution?.Yes;
    if (p === undefined) return { skip: "no probability" };
    return {
      payload: {
        ...base,
        probability_yes: clampP(p),
        probability_yes_per_category: null,
        continuous_cdf: null,
      },
    };
  }
  if (q.type === "multiple_choice") {
    const d = answer.distribution;
    if (!d) return { skip: "no probabilities" };
    const options = optionsFor(q);
    const raw = options.map((o) => Math.max(P_MIN, d[o.id] ?? 0));
    const total = raw.reduce((s, p) => s + p, 0);
    const per: Record<string, number> = {};
    options.forEach((o, i) => {
      per[o.label!] = Math.round((raw[i]! / total) * 1e6) / 1e6;
    });
    // Rounding must not leave the sum off 1: the largest absorbs the remainder.
    const top = options.reduce((a, o) => (per[o.label!]! > per[a.label!]! ? o : a), options[0]!);
    const sum = Object.values(per).reduce((s, p) => s + p, 0);
    per[top.label!] = Math.round((per[top.label!]! + 1 - sum) * 1e6) / 1e6;
    return {
      payload: {
        ...base,
        probability_yes: null,
        probability_yes_per_category: per,
        continuous_cdf: null,
      },
    };
  }
  if (q.type === "numeric" || q.type === "discrete") {
    const c = cdfQuestion(q);
    const mean = typeof answer.prediction === "number" ? answer.prediction : undefined;
    if (!c || mean === undefined) return { skip: "no numeric answer" };
    const sd = numericSd(c, mean, answer);
    return {
      payload: {
        ...base,
        probability_yes: null,
        probability_yes_per_category: null,
        continuous_cdf: continuousCdf(c, mean, sd),
      },
    };
  }
  return { skip: `unsupported type ${q.type}` };
}

/**
 * The forecast's sd: its own combined uncertainty, else the anchor's horizon
 * spread, else a tenth of the value (never under 1 % of the range).
 */
export function numericSd(c: CdfQuestion, mean: number, answer: TypedForecastAnswer): number {
  const range = Math.abs(c.rangeMax - c.rangeMin);
  const own = answer.uncertainty?.sd;
  const sd = own ?? answer.anchor?.sd ?? Math.max(Math.abs(mean) * 0.1, range * 0.05);
  return Math.max(sd, range * 0.01);
}

const pct = (p: number) => `${(p * 100).toFixed(p < 0.1 || p > 0.9 ? 1 : 0)}%`;

/** The reasoning comment posted with every forecast (the tournament requires one). */
export function commentFor(
  q: MetaculusQuestion,
  answer: TypedForecastAnswer,
  payload: ForecastPayload,
  /** The configuration that produced it (`describeConfig`), disclosed. */
  configuration?: string,
): string {
  let headline = "";
  if (payload.probability_yes !== null) headline = `Forecast: ${pct(payload.probability_yes)} Yes.`;
  else if (payload.probability_yes_per_category) {
    headline = `Forecast: ${Object.entries(payload.probability_yes_per_category)
      .sort((a, b) => b[1] - a[1])
      .map(([label, p]) => `${clip(label, 60)} ${pct(p)}`)
      .join(", ")}.`;
  } else if (payload.continuous_cdf) {
    const c = cdfQuestion(q)!;
    const r = (x: number) => Number(x.toPrecision(4));
    headline = `Forecast: median ${r(quantileOf(c, payload.continuous_cdf, 0.5))}, 80% interval ${r(quantileOf(c, payload.continuous_cdf, 0.1))}–${r(quantileOf(c, payload.continuous_cdf, 0.9))}${q.unit ? ` ${q.unit}` : ""}.`;
  }
  const reasons = reasoningText(answer, { maxChars: 1_800 });
  const sources = answer.sources
    .slice(0, 6)
    .map((s) => `- ${s.url}`)
    .join("\n");
  return [
    headline,
    reasons ? `\nReasoning: ${reasons}` : "",
    sources ? `\nSources:\n${sources}` : "",
    `\nEvidence as of ${answer.cutoff.at.slice(0, 16).replace("T", " ")} UTC · ${answer.runs.length} independent runs${answer.critique?.applied ? ", revised by a critic" : ""}.`,
    configuration ? `Configuration: ${configuration}.` : "",
    `\n${ATTRIBUTION.organization} ${ATTRIBUTION.agent} — an open-source forecasting system; no human in the loop.`,
  ]
    .filter(Boolean)
    .join("\n");
}
