// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolved Metaculus questions as held-out backtest items for configuration
 * selection (`../forecasting/select.ts`): each is forecast as of its own
 * opening time and scored like a filed forecast — 1 − Brier for binary,
 * 1 − Brier/2 across options for multiple choice, and for a number how
 * central the outcome fell in the forecast distribution. An unusable answer
 * scores what the bot would have filed in its place (nothing ⇒ the floor).
 */

import type { TypedForecastAnswer } from "../../src/forecast/typed";
import type { BacktestItem } from "../forecasting/select";
import type { MetaculusPost, MetaculusQuestion } from "./api";
import { type ForecastMeta, outcomeScore } from "./bot";
import { cdfQuestion, numericSd, payloadFor, requestFor } from "./map";

/** The resolution as `outcomeScore` reads it (a number just past an open bound for "above/below"). */
export function resolutionValue(q: MetaculusQuestion): string | number | undefined {
  const r = q.resolution;
  if (r == null) return undefined;
  const c = cdfQuestion(q);
  if (c && typeof r === "string") {
    const span = Math.abs(c.rangeMax - c.rangeMin);
    if (/above_upper_bound/i.test(r)) return c.rangeMax + span * 0.05;
    if (/below_lower_bound/i.test(r)) return c.rangeMin - span * 0.05;
  }
  return r;
}

/** The forecast's score against the resolution (0–1, higher better). */
export function scoreAgainst(
  q: MetaculusQuestion,
  answer: TypedForecastAnswer | undefined,
): number {
  const resolution = resolutionValue(q);
  if (resolution === undefined) return 0;
  const made = answer ? payloadFor(q, answer) : undefined;
  const meta: ForecastMeta = {
    postId: 0,
    questionId: q.id,
    type: q.type,
    cutoff: "",
    runs: 0,
  };
  if (made && "payload" in made) {
    if (made.payload.probability_yes !== null) meta.probabilityYes = made.payload.probability_yes;
    if (made.payload.probability_yes_per_category) {
      meta.perCategory = made.payload.probability_yes_per_category;
    }
    if (typeof answer?.prediction === "number") {
      meta.mean = answer.prediction;
      const c = cdfQuestion(q);
      if (c) meta.sd = numericSd(c, answer.prediction, answer);
    }
  } else if (q.type === "binary") {
    meta.probabilityYes = 0.5;
  } else if (q.type === "multiple_choice" && q.options?.length) {
    meta.perCategory = Object.fromEntries(q.options.map((o) => [o, 1 / q.options!.length]));
  } else {
    return 0;
  }
  return outcomeScore(meta, resolution) ?? 0;
}

/** Resolved, supported, not annulled, with an opening time: one item each. */
export function backtestItems(posts: MetaculusPost[]): BacktestItem[] {
  const out: BacktestItem[] = [];
  for (const p of posts) {
    const q = p.question;
    if (q?.status !== "resolved" || !q.open_time) continue;
    if (/^(annulled|ambiguous)$/i.test(String(q.resolution ?? "annulled"))) continue;
    const req = requestFor(q);
    if (!req || !Number.isFinite(Date.parse(q.open_time))) continue;
    const asOf = new Date(q.open_time).toISOString();
    out.push({
      id: `metaculus:q${q.id}`,
      request: { ...req, asOf },
      score: (answer) => scoreAgainst(q, answer),
    });
  }
  return out;
}
