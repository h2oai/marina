// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/forecast` — {question, kind?, resolveBy?, unit?} → the full,
 * auditable ForecastAnswer (src/forecast). With `answer` (a typed answer spec:
 * choice / multi / number / ranking / text) it runs the typed pipeline instead
 * — plan, research rounds, K runs, critique — and also takes `endTime`,
 * `asOf`, `context`, `runs`, `researchRounds` and `critique`. Models stay
 * operator-configured (env), never chosen by the caller. Behind the model
 * API's auth and per-IP limit like every /v1 route.
 */

import { dailyCapRefusal } from "../engine/spend-ledger";
import { parseAnswerSpec } from "../forecast/answer-types";
import type { ForecastKind } from "../forecast/question";
import { errorJson, json } from "./model-api/shared";

export async function handleForecast(req: Request): Promise<Response> {
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
  if (body.answer !== undefined) return typed(body, question);
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

async function typed(
  body: {
    answer?: unknown;
    endTime?: unknown;
    asOf?: unknown;
    context?: unknown;
    runs?: unknown;
    researchRounds?: unknown;
    critique?: unknown;
  },
  question: string,
): Promise<Response> {
  const parsed = parseAnswerSpec(body.answer);
  if ("error" in parsed) return errorJson(400, parsed.error, { code: "invalid_request_error" });
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
  const [{ forecastTyped }, { typedForecastDeps }] = await Promise.all([
    import("../forecast/typed"),
    import("../forecast/service"),
  ]);
  const capped = dailyCapRefusal();
  if (capped) return errorJson(429, capped, { code: "spend_cap_reached" });
  const made = typedForecastDeps(process.env, {
    ...(body.runs !== undefined ? { runs } : {}),
    ...(body.researchRounds !== undefined ? { researchRounds: rounds } : {}),
    ...(typeof body.critique === "boolean" ? { critique: body.critique } : {}),
  });
  if ("error" in made) return errorJson(503, made.error, { code: "forecast_unavailable" });
  const endTime = isoOrUndefined(body.endTime);
  const asOf = isoOrUndefined(body.asOf);
  const answer = await forecastTyped(
    {
      question,
      answer: parsed.spec,
      ...(endTime ? { endTime } : {}),
      ...(asOf ? { asOf } : {}),
      ...(typeof body.context === "string" && body.context.trim() ? { context: body.context } : {}),
    },
    made.deps,
  );
  answer.costUsd = made.costUsd();
  return json({ ...answer, scale: made.scale });
}
