// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/forecast` — {question, kind?, resolveBy?, unit?} → the full,
 * auditable ForecastAnswer (src/forecast). With `answer` (a typed answer spec:
 * choice / multi / number / ranking / text) it runs the typed pipeline instead
 * — plan, research rounds, K runs, critique, combined by the operator's formation
 * (`MARINA_FORECAST_FORMATION`), with the lesson pool — through the same builder
 * as the `forecast` command (`src/forecast/surface.ts`) — and also takes `endTime`,
 * `asOf`, `context`, `runs`, `researchRounds` and `critique`. Models stay
 * operator-configured (env), never chosen by the caller. Behind the model
 * API's auth and per-IP limit like every /v1 route.
 */

import { dailyCapRefusal } from "../engine/spend-ledger";
import { parseAnswerSpec } from "../forecast/answer-types";
import {
  SUPPLIED_PRIOR_SOURCES,
  type SuppliedPrior,
  type SuppliedPriorSource,
} from "../forecast/prior";
import type { ForecastKind } from "../forecast/question";
import { type EvalContext, evalOption } from "../learning/eval-context";
import type { MarinaDB } from "../persistence/database";
import { errorJson, json } from "./model-api/shared";

export async function handleForecast(req: Request, db?: MarinaDB): Promise<Response> {
  let body: {
    question?: unknown;
    kind?: unknown;
    resolveBy?: unknown;
    unit?: unknown;
    answer?: unknown;
    endTime?: unknown;
    asOf?: unknown;
    context?: unknown;
    runs?: unknown;
    researchRounds?: unknown;
    critique?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return errorJson(400, "body must be JSON", { code: "invalid_request_error" });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question || question.length > 1_000) {
    return errorJson(400, "question must be a non-empty string of at most 1000 characters", {
      code: "invalid_request_error",
    });
  }
  if (body.answer !== undefined) return typed(body, question, db, evalOption(req));
  if (body.kind !== undefined && body.kind !== "probability" && body.kind !== "number") {
    return errorJson(400, 'kind must be "probability" or "number"', {
      code: "invalid_request_error",
    });
  }
  const [{ forecastQuestion }, { forecastDeps }] = await Promise.all([
    import("../forecast/question"),
    import("../forecast/service"),
  ]);
  const capped = dailyCapRefusal();
  if (capped) return errorJson(429, capped, { code: "spend_cap_reached" });
  const made = forecastDeps();
  if ("error" in made) return errorJson(503, made.error, { code: "forecast_unavailable" });
  const answer = await forecastQuestion(
    {
      question,
      ...(body.kind ? { kind: body.kind as ForecastKind } : {}),
      ...(typeof body.resolveBy === "string" ? { resolveBy: body.resolveBy } : {}),
      ...(typeof body.unit === "string" ? { unit: body.unit } : {}),
    },
    made.deps,
  );
  answer.costUsd = made.costUsd();
  return json({ ...answer, scale: made.scale });
}

const isoOrUndefined = (v: unknown) =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined;

/**
 * `priors`: up to four market or community forecasts the caller already has,
 * each with the ISO time it was observed (a prior observed after the evidence
 * cutoff is rejected by the forecaster, never used).
 */
export function parsePriors(raw: unknown): { priors: SuppliedPrior[] } | { error: string } {
  if (raw === undefined) return { priors: [] };
  if (!Array.isArray(raw) || raw.length > 4) {
    return { error: "priors must be an array of at most 4 objects" };
  }
  const priors: SuppliedPrior[] = [];
  for (const p of raw as Array<Record<string, unknown>>) {
    const source = p?.source;
    if (
      typeof source !== "string" ||
      !(SUPPLIED_PRIOR_SOURCES as readonly string[]).includes(source)
    ) {
      return {
        error: `each prior needs source ${SUPPLIED_PRIOR_SOURCES.map((s) => `"${s}"`).join(", ")}`,
      };
    }
    const at = isoOrUndefined(p.at);
    if (!at) return { error: "each prior needs `at`, the ISO time it was observed" };
    const dist = p.distribution;
    let distribution: Record<string, number> | undefined;
    if (dist !== undefined) {
      if (!dist || typeof dist !== "object" || Array.isArray(dist)) {
        return { error: "prior distribution must be an object of option id → probability" };
      }
      distribution = {};
      for (const [k, v] of Object.entries(dist as Record<string, unknown>).slice(0, 64)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          return { error: "prior probabilities must be numbers from 0 to 1" };
        }
        distribution[k.slice(0, 64)] = n;
      }
    }
    const liquidity = p.liquidity === undefined ? undefined : Number(p.liquidity);
    if (liquidity !== undefined && !(Number.isFinite(liquidity) && liquidity >= 0)) {
      return { error: "prior liquidity must be a non-negative number (USD)" };
    }
    const value = p.value === undefined ? undefined : Number(p.value);
    const sd = p.sd === undefined ? undefined : Number(p.sd);
    if ((value !== undefined && !Number.isFinite(value)) || (sd !== undefined && !(sd > 0))) {
      return { error: "prior value must be a number and sd a positive number" };
    }
    priors.push({
      source: source as SuppliedPriorSource,
      at,
      ...(distribution ? { distribution } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(sd !== undefined ? { sd } : {}),
      ...(liquidity !== undefined ? { liquidity } : {}),
      ...(typeof p.label === "string" && p.label.trim()
        ? { label: p.label.trim().slice(0, 60) }
        : {}),
    });
  }
  return { priors };
}

async function typed(
  body: {
    answer?: unknown;
    endTime?: unknown;
    asOf?: unknown;
    context?: unknown;
    runs?: unknown;
    researchRounds?: unknown;
    critique?: unknown;
    priors?: unknown;
    category?: unknown;
  },
  question: string,
  db: MarinaDB | undefined,
  measurement: { eval?: EvalContext } = {},
): Promise<Response> {
  const parsed = parseAnswerSpec(body.answer);
  if ("error" in parsed) return errorJson(400, parsed.error, { code: "invalid_request_error" });
  const priors = parsePriors(body.priors);
  if ("error" in priors) return errorJson(400, priors.error, { code: "invalid_request_error" });
  if (
    body.category !== undefined &&
    (typeof body.category !== "string" || !body.category.trim() || body.category.length > 120)
  ) {
    return errorJson(400, "category must be a non-empty string of at most 120 characters", {
      code: "invalid_request_error",
    });
  }
  for (const field of ["endTime", "asOf"] as const) {
    if (body[field] !== undefined && isoOrUndefined(body[field]) === undefined) {
      return errorJson(400, `${field} must be an ISO date-time`, { code: "invalid_request_error" });
    }
  }
  if (
    body.context !== undefined &&
    (typeof body.context !== "string" || body.context.length > 4_000)
  ) {
    return errorJson(400, "context must be a string of at most 4000 characters", {
      code: "invalid_request_error",
    });
  }
  const runs = Number(body.runs);
  const rounds = Number(body.researchRounds);
  if (body.runs !== undefined && !(Number.isInteger(runs) && runs >= 1 && runs <= 9)) {
    return errorJson(400, "runs must be an integer 1–9", { code: "invalid_request_error" });
  }
  if (
    body.researchRounds !== undefined &&
    !(Number.isInteger(rounds) && rounds >= 1 && rounds <= 4)
  ) {
    return errorJson(400, "researchRounds must be an integer 1–4", {
      code: "invalid_request_error",
    });
  }
  if (body.critique !== undefined && typeof body.critique !== "boolean") {
    return errorJson(400, "critique must be a boolean", { code: "invalid_request_error" });
  }
  const { typedForecastFor } = await import("../forecast/surface");
  const capped = dailyCapRefusal();
  if (capped) return errorJson(429, capped, { code: "spend_cap_reached" });
  const endTime = isoOrUndefined(body.endTime);
  const asOf = isoOrUndefined(body.asOf);
  // The same builder as the `forecast` command: operator formation and routing
  // (off = exactly that formation), the prior / recalibration stage, lessons.
  const made = await typedForecastFor(
    {
      question,
      answer: parsed.spec,
      ...(endTime ? { endTime } : {}),
      ...(asOf ? { asOf } : {}),
      ...(typeof body.context === "string" && body.context.trim() ? { context: body.context } : {}),
      ...(priors.priors.length ? { priors: priors.priors } : {}),
      ...(typeof body.category === "string" ? { category: body.category.trim() } : {}),
    },
    {
      ...(db ? { db } : {}),
      ...(body.runs !== undefined ? { runs } : {}),
      ...(body.researchRounds !== undefined ? { researchRounds: rounds } : {}),
      ...(typeof body.critique === "boolean" ? { critique: body.critique } : {}),
      // A caller measuring a board (`x-marina-eval`) never recalls that board's lessons.
      ...measurement,
    },
  );
  if ("error" in made) return errorJson(503, made.error, { code: "forecast_unavailable" });
  return json({ ...made.answer, scale: made.scale });
}
