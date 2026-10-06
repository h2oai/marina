// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The forecast a question's best prior makes on its own — no model call, no
 * research, no cost. It is the baseline a model configuration has to beat
 * (a configuration that loses to its own prior is adding noise), and a
 * labelled answer when a board must be filed without models.
 */

import { type AnswerSpec, type AnswerValue, formatAnswer } from "./answer-types";
import type { Distribution } from "./distribution";
import { informative } from "./history";
import { choosePrior } from "./prior";
import type { TypedForecastAnswer, TypedForecastRequest } from "./typed";

export function priorAnswer(
  req: TypedForecastRequest,
  now: Date = new Date(),
): TypedForecastAnswer {
  const at = req.asOf ?? now.toISOString();
  const chosen = choosePrior({
    spec: req.answer,
    cutoff: at,
    ...(req.priors ? { supplied: req.priors } : {}),
    ...(req.category ? { category: req.category } : {}),
  });
  // Only an informative prior answers; the uniform type default is no forecast (a fallback).
  const p = chosen.prior && informative(chosen.prior.source) ? chosen.prior : undefined;
  const prediction = p?.distribution ? predictionFrom(req.answer, p.distribution) : undefined;
  return {
    question: req.question,
    answer: req.answer,
    ...(p?.distribution ? { distribution: p.distribution } : {}),
    ...(prediction !== undefined ? { prediction, formatted: formatAnswer(prediction) } : {}),
    runs: [],
    research: [],
    cutoff: { at, basis: req.asOf ? "asOf" : "now", pastCutoff: Date.parse(at) < now.getTime() },
    sources: [],
    costUsd: 0,
    latencyMs: 0,
    caveat: p ? `prior only: ${p.detail}` : "prior only: no informative prior for this question",
  };
}

/** The prior's own answer: a choice's most probable option, a multi-select's options at ≥ 0.5. */
function predictionFrom(spec: AnswerSpec, d: Distribution): AnswerValue | undefined {
  if (spec.type === "choice") {
    const best = spec.options
      .filter((o) => d[o.id] !== undefined)
      .sort((a, b) => d[b.id]! - d[a.id]!)[0];
    return best?.id;
  }
  if (spec.type === "multi")
    return spec.options.filter((o) => (d[o.id] ?? 0) >= 0.5).map((o) => o.id);
  return undefined;
}
