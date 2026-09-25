// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/forecast` — {question, kind?, resolveBy?, unit?} → the full,
 * auditable ForecastAnswer (src/forecast). Behind the model API's auth and
 * per-IP limit like every /v1 route.
 */

import type { ForecastKind } from "../forecast/question";
import { errorJson, json } from "./model-api/shared";

export async function handleForecast(req: Request): Promise<Response> {
  let body: { question?: unknown; kind?: unknown; resolveBy?: unknown; unit?: unknown };
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
  if (body.kind !== undefined && body.kind !== "probability" && body.kind !== "number") {
    return errorJson(400, 'kind must be "probability" or "number"', {
      code: "invalid_request_error",
    });
  }
  const [{ forecastQuestion }, { forecastDeps }] = await Promise.all([
    import("../forecast/question"),
    import("../forecast/service"),
  ]);
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
  return json(answer);
}
