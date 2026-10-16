// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { typedForecastDeps } from "../forecast/service";
import { typedForecastFor } from "../forecast/surface";
import type { TypedForecastRequest } from "../forecast/typed";
import { writeResearchReport } from "../research/report";
import type { InvestigationRequest } from "../sdk/investigation-types";
import { predictionResult, researchResult } from "./results";
import type { InvestigationExecutionContext, InvestigationExecutor } from "./service";
import { InvestigationError } from "./validation";

function forecastRequest(request: InvestigationRequest): TypedForecastRequest {
  const spec = request.answer ?? { type: "binary" };
  return {
    question: request.question,
    answer:
      spec.type === "binary"
        ? {
            type: "choice",
            probabilities: true,
            options: [
              { id: "yes", label: "Yes" },
              { id: "no", label: "No" },
            ],
          }
        : spec.type === "choice"
          ? { ...spec, probabilities: true }
          : spec,
    ...(request.context ? { context: request.context } : {}),
    ...(request.horizon ? { endTime: request.horizon } : {}),
    ...(request.asOf ? { asOf: request.asOf } : {}),
  };
}

export const executeInvestigation: InvestigationExecutor = async (ctx) => {
  const request = ctx.attempt.request;
  if (request.kind === "research") return research(ctx);
  const made = await typedForecastFor(forecastRequest(request), {
    db: ctx.db,
    ...(request.runs ? { runs: request.runs } : {}),
    observe: (deps, scale, costUsd) => ctx.observation.instrument(deps, scale, costUsd),
  });
  if ("error" in made) throw new InvestigationError("forecast_unavailable", made.error, 503);
  ctx.observation.check();
  const outputId = ctx.observation.capture("forecast", made.answer);
  const result = predictionResult(request, made.answer);
  return {
    result: { ...result, outputId },
    forecast: {
      question: request.question,
      kind: made.answer.answer.type,
      ...(typeof made.answer.prediction === "number" ? { mean: made.answer.prediction } : {}),
      ...(made.answer.uncertainty?.sd ? { sd: made.answer.uncertainty.sd } : {}),
      prediction: made.answer.formatted,
      // Scoring reads the typed result. Detailed private stages remain in the case content store.
      answerJson: JSON.stringify({
        ...made.answer,
        runs: [],
        research: [],
        sources: [],
        lessons: undefined,
        observedLessons: undefined,
      }),
    },
  };
};

async function research(ctx: InvestigationExecutionContext) {
  const request = ctx.attempt.request;
  if (request.asOf)
    throw new InvestigationError(
      "unsupported_cutoff",
      "Historical research requires a qualified dated-evidence executor; omit asOf for current research",
      400,
    );
  const made = typedForecastDeps();
  if ("error" in made) throw new InvestigationError("research_unavailable", made.error, 503);
  const deps = ctx.observation.instrument(made.deps, made.scale, made.costUsd);
  const lead = deps.planner ?? deps.analysts[0];
  if (!lead)
    throw new InvestigationError("research_unavailable", "No research model is configured", 503);
  const report = await writeResearchReport(
    { prompt: [request.question, request.context].filter(Boolean).join("\n\n") },
    {
      lead,
      retriever: deps.retriever,
      pageText: deps.pageText,
      maxSections: 6,
      stopReason: () =>
        ctx.observation.controller.signal.aborted || ctx.observation.budget.signal.aborted
          ? "Investigation stopped"
          : undefined,
      checkpoint: {
        run: (key, input, action) =>
          ctx.observation.stage(`report:${key}`, "research", input, action, false),
      },
    },
  );
  ctx.observation.check();
  return {
    result: {
      ...researchResult(report, made.costUsd()),
      outputId: ctx.observation.capture("report", report),
    },
  };
}
