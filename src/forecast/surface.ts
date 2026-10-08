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
 *   defaults    formation, analysts, checker and selection mode through
 *               `resolveForecastDefaults` (env, then an earned slot, then the
 *               built-in — `src/forecast/defaults.ts`); the formation is routed
 *               by `MARINA_FORECAST_ROUTE` (off = exactly that formation).
 *
 * Callers add only what their surface allows (the API's `runs`,
 * `researchRounds`, `critique`); models stay operator-set.
 */

import { Logger } from "../engine/logger";
import type { EvalContext } from "../learning/eval-context";
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
  /**
   * The caller's measurement context (`x-marina-eval`): a measurement of a board
   * never recalls lessons learned from that board (leakage rule 2).
   */
  eval?: EvalContext;
  /** Analyst models chosen by the caller (they win over an earned default). */
  analysts?: string[];
}

const logger = new Logger();

export async function typedForecastFor(
  req: TypedForecastRequest,
  opts: TypedSurfaceOptions = {},
): Promise<{ answer: TypedForecastAnswer; scale: ForecastScale } | { error: string }> {
  const env = opts.env ?? process.env;
  const [defaults, { typedForecastDeps }, routing, { forecastLessonsFor }] = await Promise.all([
    import("./defaults"),
    import("./service"),
    import("./routing"),
    import("../learning/forecast-bridge"),
  ]);
  // Env, then an earned slot, then today's built-in — traced per field.
  const resolved = defaults.resolveForecastDefaults({
    env,
    ...(opts.db ? { db: opts.db } : {}),
  });
  const surfaceOptions = {
    ...(opts.runs !== undefined ? { runs: opts.runs } : {}),
    ...(opts.researchRounds !== undefined ? { researchRounds: opts.researchRounds } : {}),
    ...(opts.critique !== undefined ? { critique: opts.critique } : {}),
    ...(opts.analysts?.length ? { analysts: opts.analysts } : {}),
    ...(opts.db
      ? {
          lessons: forecastLessonsFor(opts.db, { env, ...(opts.eval ? { eval: opts.eval } : {}) }),
        }
      : {}),
  };
  const earned = defaults.forecastDefaultOverrides(resolved, env);
  let made = typedForecastDeps(env, { ...earned, ...surfaceOptions });
  if ("error" in made && Object.keys(earned).length > 0) {
    // An earned configuration this installation cannot run (a missing provider)
    // never breaks the surface: today's defaults answer instead.
    logger.warn("forecast", "earned forecast defaults unusable here; using built-in", {
      error: made.error,
    });
    made = typedForecastDeps(env, surfaceOptions);
  }
  if ("error" in made) return made;
  const answer = await routing.forecastRouted(
    req,
    made.deps,
    resolved.formation,
    routing.routeSettingsFromEnv(env),
  );
  answer.costUsd = made.costUsd();
  return { answer, scale: made.scale };
}
