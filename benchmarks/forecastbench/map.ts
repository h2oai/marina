// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ForecastBench questions ⇄ Marina's general typed forecaster, one forecast
 * per question:
 *
 *   market  → a choice of Yes / No with probabilities (the market price at the
 *             freeze date is given as context, never copied);
 *   dataset → a multi-select over its resolution dates with each date's own
 *             probability ("is the statement true on that date?"), so all
 *             horizons share one research pass.
 *
 * Nothing here forecasts; it only maps.
 */

import type { AnswerSpec } from "../../src/forecast/answer-types";
import type { SuppliedPrior } from "../../src/forecast/prior";
import type { TypedForecastAnswer, TypedForecastRequest } from "../../src/forecast/typed";
import { type FbQuestion, isMarket, resolutionDates } from "./dataset";

export interface FbForecast {
  id: string;
  source: string;
  forecast: number;
  resolution_date: string | null;
  reasoning: string | null;
}

const clip = (s: string | undefined, n: number) =>
  !s || s === "N/A" ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s;

const P_MIN = 0.001;
const P_MAX = 0.999;
const clampP = (p: number) => Math.min(P_MAX, Math.max(P_MIN, p));

export const dateOptionId = (date: string) => `d${date}`;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export function specFor(q: FbQuestion, due: string): AnswerSpec {
  if (isMarket(q)) {
    return {
      type: "choice",
      options: [
        { id: "Yes", label: "Yes" },
        { id: "No", label: "No" },
      ],
      probabilities: true,
    };
  }
  return {
    type: "multi",
    options: resolutionDates(q).map((d) => ({
      id: dateOptionId(d),
      label: `${d} (${daysBetween(due, d)} days after ${due})`,
    })),
    minPicks: 0,
    probabilities: true,
  };
}

/** The question text with the round's dates filled in. */
export function questionText(q: FbQuestion, due: string): string {
  return q.question
    .replaceAll("{forecast_due_date}", due)
    .replaceAll("{resolution_date}", "the resolution date (each option below)");
}

/** A dataset question's statistical prior (`./priors.ts`), as the request carries it. */
export interface RequestPrior {
  prior: SuppliedPrior;
  line: string;
}

export function requestFor(q: FbQuestion, due: string, stat?: RequestPrior): TypedForecastRequest {
  const market = isMarket(q);
  const freeze = q.freeze_datetime?.slice(0, 10);
  const value = clip(q.freeze_datetime_value, 60);
  const close = clip(q.market_info_close_datetime, 40);
  const price = Number(q.freeze_datetime_value);
  const frozenAt = q.freeze_datetime ? Date.parse(q.freeze_datetime) : Number.NaN;
  return {
    question: clip(questionText(q, due), 1_500),
    answer: specFor(q, due),
    id: `forecastbench:${due}/${q.source}/${q.id}`,
    // The reference class for base rates and calibration evidence: market or dataset, by source.
    category: `forecastbench:${market ? "market" : "dataset"}:${q.source}`,
    // A market question's freeze-date price is its market prior (the forecaster
    // rejects a prior observed after its cutoff).
    ...(market &&
    q.freeze_datetime_value?.trim() &&
    Number.isFinite(price) &&
    price >= 0 &&
    price <= 1 &&
    Number.isFinite(frozenAt)
      ? {
          priors: [
            {
              source: "market" as const,
              distribution: { Yes: price, No: 1 - price },
              at: new Date(frozenAt).toISOString(),
              label: q.source,
            },
          ],
        }
      : stat
        ? { priors: [stat.prior] }
        : {}),
    ...(market && close && Number.isFinite(Date.parse(close)) ? { endTime: close } : {}),
    context: [
      clip(q.source_intro, 600),
      `Today is the forecast due date, ${due}.`,
      market
        ? "Give the probability the question resolves Yes (its final outcome, whenever it resolves)."
        : `For each resolution date, give the probability the statement is true on THAT date, compared with ${due}. Later dates are further out: weigh drift and base rates, not just the latest move.`,
      q.resolution_criteria ? `Resolution: ${clip(q.resolution_criteria, 1_200)}` : "",
      clip(q.market_info_resolution_criteria, 1_500)
        ? `Market rules: ${clip(q.market_info_resolution_criteria, 1_500)}`
        : "",
      value
        ? `On ${freeze ?? "the freeze date"}: ${value}${q.freeze_datetime_value_explanation ? ` — ${clip(q.freeze_datetime_value_explanation, 300)}` : ""}`
        : "",
      stat?.line ?? "",
      q.background ? `Background: ${clip(q.background, 2_500)}` : "",
      q.url ? `Source: ${q.url}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * A question's forecasts from an answer (one for a market question, one per
 * resolution date for a dataset question); undefined when the answer has no
 * probabilities.
 */
export function forecastsFrom(
  q: FbQuestion,
  answer: Pick<TypedForecastAnswer, "distribution">,
  reasoning: string | null,
): FbForecast[] | undefined {
  const d = answer.distribution;
  if (!d) return undefined;
  if (isMarket(q)) {
    if (d.Yes === undefined) return undefined;
    return [
      {
        id: q.id,
        source: q.source,
        forecast: round(clampP(d.Yes)),
        resolution_date: null,
        reasoning,
      },
    ];
  }
  const dates = resolutionDates(q);
  if (dates.some((date) => d[dateOptionId(date)] === undefined)) return undefined;
  return dates.map((date, i) => ({
    id: q.id,
    source: q.source,
    forecast: round(clampP(d[dateOptionId(date)]!)),
    resolution_date: date,
    // The reasoning once per question keeps the file small.
    reasoning: i === 0 ? reasoning : null,
  }));
}

/**
 * When a question could not be forecast: the market's own price at the freeze
 * date for a market question, a dataset question's statistical prior when it
 * has one, else 0.5 (what ForecastBench imputes anyway). Counted and reported
 * as a fallback, never passed off as a forecast.
 */
export function fallbackForecasts(q: FbQuestion, byDate?: Record<string, number>): FbForecast[] {
  const price = Number(q.freeze_datetime_value);
  if (isMarket(q)) {
    const p = Number.isFinite(price) && price >= 0 && price <= 1 ? price : 0.5;
    return [
      {
        id: q.id,
        source: q.source,
        forecast: round(clampP(p)),
        resolution_date: null,
        reasoning: "fallback: no forecast produced",
      },
    ];
  }
  return resolutionDates(q).map((date) => ({
    id: q.id,
    source: q.source,
    forecast: byDate?.[date] ?? 0.5,
    resolution_date: date,
    reasoning: null,
  }));
}

const round = (p: number) => Math.round(p * 10_000) / 10_000;
