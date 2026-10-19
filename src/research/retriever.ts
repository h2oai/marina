// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Shared research features for arena, general forecasts and research reports. */
import { modelComplete } from "../arena/model-backend";
import { readSwarmRetriever } from "../arena/research/read-swarm-retriever";
import type { Retriever } from "../arena/research/retrieve";
import { defaultPageText } from "../arena/research/verify";
import { researchDecisionProvider } from "./decision-advice";
import { evidenceLoopRetriever } from "./evidence-loop";
import { modelTurns } from "./model-turn";
import { withReleaseCalendar, withSurveyEvidence } from "./survey";

export { researchFeatures } from "./settings";

import { researchFeatures } from "./settings";

export function researchRetriever(
  inner: Retriever,
  env: NodeJS.ProcessEnv,
  defaultReviewer?: string,
  opts: { maxTokens?: number } = {},
): Retriever {
  const settings = researchFeatures(env);
  const calendarFile = env.MARINA_RESEARCH_CALENDAR_FILE?.trim();
  const calendar = (retriever: Retriever) =>
    calendarFile ? withReleaseCalendar(retriever, () => Bun.file(calendarFile).json()) : retriever;
  let base = inner;
  const surveyFile = env.MARINA_RESEARCH_SURVEY_FILE?.trim();
  if (surveyFile) base = withSurveyEvidence(base, () => Bun.file(surveyFile).json());
  if (settings.reader) {
    const reader = modelComplete(settings.reader, env, opts);
    base = readSwarmRetriever(base, {
      reader: { name: settings.reader, complete: reader.complete },
      spent: () => reader.usage.costUsd,
    });
  }
  if (!settings.capture) return calendar(base);
  const model = settings.reviewer ?? defaultReviewer;
  if (settings.rounds > 1 && !model) throw new Error("iterative research needs a reviewer model");
  const reviewer =
    settings.rounds > 1
      ? modelComplete(model!, env, { maxTokens: Math.min(opts.maxTokens ?? 4000, 4000) })
      : undefined;
  let adviceCost = 0;
  // Lazy: missing credentials leave the deterministic plan available.
  const localFallback = model
    ? {
        kind: "research-classifier",
        model,
        async ask(request: import("../decisions/types").DecisionRequest, signal?: AbortSignal) {
          const turns = modelTurns(model, env, {
            maxTokens: 512,
            signal,
            spendSource: "forecast",
            onCost: (cost) => {
              adviceCost += cost;
            },
          });
          return researchDecisionProvider(turns).ask(request, signal);
        },
      }
    : undefined;
  return calendar(
    evidenceLoopRetriever(base, {
      pageText: defaultPageText(),
      maxRounds: settings.rounds,
      ...(settings.authority ? { authority: true } : {}),
      targetEvidence: settings.targetEvidence,
      advice: settings.advice,
      advisory: {
        env,
        localFallback,
        onCost: (cost) => {
          adviceCost += cost;
        },
      },
      adviceCost: () => adviceCost,
      ...(reviewer ? { review: reviewer.complete, reviewCost: () => reviewer.usage.costUsd } : {}),
    }),
  );
}
