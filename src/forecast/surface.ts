// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one builder behind every typed-forecast surface Marina serves itself —
 * the in-world `forecast … type:` command and `POST /v1/forecast` with an
 * `answer` spec — so the same question gets the same pipeline wherever it is
 * asked:
 *
 *   deps        `typedForecastDeps` (operator models, retriever, lookups, the
 *               prior shrink / recalibration settings, resolved history);
 *   lessons     the one judged pool through `forecastLessonsFor`
 *               (`MARINA_LESSONS` on / observe / off; leakage rule at the cutoff);
 *   formation   the operator's `MARINA_FORECAST_FORMATION`, routed by
 *               `MARINA_FORECAST_ROUTE` (off = exactly that formation).
 *
 * Callers add only what their surface allows (the API's `runs`,
 * `researchRounds`, `critique`); models stay operator-set.
 */

import type { MarinaDB } from "../persistence/database";
import type { ForecastScale } from "./service";
import type { TypedForecastAnswer, TypedForecastRequest } from "./typed";

export interface TypedSurfaceOptions {
  /** The world database (the lesson pool). Without it, no lessons are recalled. */
  db?: MarinaDB;
  env?: NodeJS.ProcessEnv;
  runs?: number;
  researchRounds?: number;
  critique?: boolean;
}

export async function typedForecastFor(
  req: TypedForecastRequest,
  opts: TypedSurfaceOptions = {},
): Promise<{ answer: TypedForecastAnswer; scale: ForecastScale } | { error: string }> {
  const env = opts.env ?? process.env;
  const [{ formationFromEnv }, { typedForecastDeps }, routing, { forecastLessonsFor }] =
    await Promise.all([
      import("./formations"),
      import("./service"),
      import("./routing"),
      import("../learning/forecast-bridge"),
    ]);
  const made = typedForecastDeps(env, {
    ...(opts.runs !== undefined ? { runs: opts.runs } : {}),
    ...(opts.researchRounds !== undefined ? { researchRounds: opts.researchRounds } : {}),
    ...(opts.critique !== undefined ? { critique: opts.critique } : {}),
    ...(opts.db ? { lessons: forecastLessonsFor(opts.db, { env }) } : {}),
  });
  if ("error" in made) return made;
  const answer = await routing.forecastRouted(
    req,
    made.deps,
    formationFromEnv(env),
    routing.routeSettingsFromEnv(env),
  );
  answer.costUsd = made.costUsd();
  return { answer, scale: made.scale };
}
