// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Shared research features for arena, general forecasts and research reports. */
import { modelComplete } from "../arena/model-backend";
import { readSwarmRetriever } from "../arena/research/read-swarm-retriever";
import type { Retriever } from "../arena/research/retrieve";
import { defaultPageText } from "../arena/research/verify";
import { evidenceLoopRetriever } from "./evidence-loop";

export { researchFeatures } from "./settings";

import { researchFeatures } from "./settings";

export function researchRetriever(
  inner: Retriever,
  env: NodeJS.ProcessEnv,
  defaultReviewer?: string,
  opts: { maxTokens?: number } = {},
): Retriever {
  const settings = researchFeatures(env);
  let base = inner;
  if (settings.reader) {
    const reader = modelComplete(settings.reader, env, opts);
    base = readSwarmRetriever(base, {
      reader: { name: settings.reader, complete: reader.complete },
      spent: () => reader.usage.costUsd,
    });
  }
  if (!settings.capture) return base;
  const model = settings.reviewer ?? defaultReviewer;
  if (settings.rounds > 1 && !model) throw new Error("iterative research needs a reviewer model");
  const reviewer =
    settings.rounds > 1
      ? modelComplete(model!, env, { maxTokens: Math.min(opts.maxTokens ?? 4000, 4000) })
      : undefined;
  return evidenceLoopRetriever(base, {
    pageText: defaultPageText(),
    maxRounds: settings.rounds,
    ...(reviewer ? { review: reviewer.complete, reviewCost: () => reviewer.usage.costUsd } : {}),
  });
}
