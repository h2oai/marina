// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The forecast set file ForecastBench takes: `<due>.<organization>.<N>.json`
 * with `organization`, `model`, `model_organization`, `question_set` and
 * `forecasts`. At most three sets per round count (the first three by file
 * name), and a set needs ≥ 95 % of market AND ≥ 95 % of dataset forecasts to
 * be ranked; missing ones are imputed 0.5.
 */

import { createHash } from "node:crypto";
import { ATTRIBUTION } from "../forecasting/shared";
import { type FbQuestion, type FbQuestionSet, isMarket, resolutionDates } from "./dataset";
import type { FbForecast } from "./map";

export const MAX_SETS_PER_ROUND = 3;
export const MIN_COVERAGE = 0.95;

export interface SetIdentity {
  organization: string;
  model: string;
  model_organization: string;
  /** The organization as written in the file name (no dots, which would read as separators). */
  fileOrg: string;
}

export const DEFAULT_SET_IDENTITY: SetIdentity = {
  organization: ATTRIBUTION.organization,
  model: ATTRIBUTION.agent,
  model_organization: ATTRIBUTION.organization,
  fileOrg: ATTRIBUTION.organization.replace(/[^A-Za-z0-9-]+/g, "-"),
};

export function setFileName(due: string, id: SetIdentity, n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SETS_PER_ROUND) {
    throw new Error(`set number must be 1–${MAX_SETS_PER_ROUND}`);
  }
  return `${due}.${id.fileOrg}.${n}.json`;
}

export interface Coverage {
  market: { expected: number; given: number };
  dataset: { expected: number; given: number };
  ok: boolean;
}

/** Forecasts given vs required, per question type (fallbacks count as given). */
export function coverage(set: FbQuestionSet, forecasts: FbForecast[]): Coverage {
  const given = new Set(forecasts.map((f) => `${f.source}|${f.id}|${f.resolution_date ?? ""}`));
  const c = { market: { expected: 0, given: 0 }, dataset: { expected: 0, given: 0 } };
  for (const q of set.questions) {
    const keys = isMarket(q)
      ? [`${q.source}|${q.id}|`]
      : resolutionDates(q).map((d) => `${q.source}|${q.id}|${d}`);
    const bucket = isMarket(q) ? c.market : c.dataset;
    bucket.expected += keys.length;
    bucket.given += keys.filter((k) => given.has(k)).length;
  }
  const share = (b: { expected: number; given: number }) => (b.expected ? b.given / b.expected : 1);
  return { ...c, ok: share(c.market) >= MIN_COVERAGE && share(c.dataset) >= MIN_COVERAGE };
}

export function setBody(set: FbQuestionSet, id: SetIdentity, forecasts: FbForecast[]): string {
  return JSON.stringify(
    {
      organization: id.organization,
      model: id.model,
      model_organization: id.model_organization,
      question_set: set.question_set,
      forecasts,
    },
    null,
    1,
  );
}

/** Every forecast is in [0, 1], matches a question, and a dataset one names a listed date. */
export function validateForecasts(questions: FbQuestion[], forecasts: FbForecast[]): string[] {
  const byKey = new Map(questions.map((q) => [`${q.source}|${q.id}`, q]));
  const errors: string[] = [];
  for (const f of forecasts) {
    const q = byKey.get(`${f.source}|${f.id}`);
    if (!q) errors.push(`${f.source}/${f.id}: not in the question set`);
    else if (
      isMarket(q)
        ? f.resolution_date !== null
        : !resolutionDates(q).includes(f.resolution_date ?? "")
    ) {
      errors.push(`${f.source}/${f.id}: bad resolution_date ${f.resolution_date}`);
    }
    if (!(f.forecast >= 0 && f.forecast <= 1))
      errors.push(`${f.source}/${f.id}: forecast ${f.forecast}`);
  }
  return errors;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
