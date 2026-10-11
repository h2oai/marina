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
import { TYPED_FORMATIONS, typedFormation } from "./formations";
import type { ForecastAnswer, ForecastKind, ForecastRequest } from "./question";
import { inferKind } from "./question";
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
  /**
   * The board this forecast is for: its earned configuration
   * (`forecast-config:<board>`) is read before the general one. Default
   * `MARINA_FORECAST_BOARD`; without either only the general slots are read.
   */
  board?: string;
  /** `false`: recall no lessons (the database still supplies earned defaults). */
  lessons?: boolean;
}

const logger = new Logger();

/** Formation names a surface accepts: the typed formations plus `verify` (a checked ensemble). */
export const SURFACE_FORMATIONS = [...TYPED_FORMATIONS, "verify"] as const;

/**
 * The env a caller-chosen formation runs under. `verify` keeps the resolved
 * formation and checks each run's draft (`MARINA_FORECAST_VERIFY=on`); an
 * unknown name is an error, never a silent fallback to the default.
 */
export function formationEnv(
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { env: NodeJS.ProcessEnv } | { error: string } {
  const n = name?.trim().toLowerCase();
  if (!n) return { env };
  if (n === "verify") return { env: { ...env, MARINA_FORECAST_VERIFY: "on" } };
  if (typedFormation(n)) return { env: { ...env, MARINA_FORECAST_FORMATION: n } };
  return { error: `unknown formation "${name}": use one of ${SURFACE_FORMATIONS.join(", ")}` };
}

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
  const board = opts.board?.trim() || env.MARINA_FORECAST_BOARD?.trim() || undefined;
  const resolved = defaults.resolveForecastDefaults({
    env,
    ...(opts.db ? { db: opts.db } : {}),
    ...(board ? { board } : {}),
  });
  const surfaceOptions = {
    ...(opts.runs !== undefined ? { runs: opts.runs } : {}),
    ...(opts.researchRounds !== undefined ? { researchRounds: opts.researchRounds } : {}),
    ...(opts.critique !== undefined ? { critique: opts.critique } : {}),
    ...(opts.analysts?.length ? { analysts: opts.analysts } : {}),
    ...(opts.db && opts.lessons !== false
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

/** A plain answer produced by the typed pipeline: the full typed answer is kept as its audit trail. */
export type PlainViaTypedAnswer = ForecastAnswer & {
  pipeline: "typed";
  typed: TypedForecastAnswer;
};

const YES_NO_OPTIONS = [
  { id: "yes", label: "Yes" },
  { id: "no", label: "No" },
];

/** A `resolveBy` date as the typed request's `endTime` (a bare date ends that day, UTC). */
function endTimeOf(resolveBy: string | undefined): string | undefined {
  const v = resolveBy?.trim();
  if (!v) return undefined;
  const at = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59Z` : v);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * A plain probability or number question through the same full pipeline as a
 * typed one (plan → research rounds → runs → judge → critique → lessons →
 * formation and routing → prior/recalibration): a probability is a yes/no
 * choice with probabilities, a number a typed number. The result keeps the
 * plain answer's shape (`probability`, or `mean`/`sd`/80 % `interval`) for
 * existing callers and savers, with the typed answer attached as `typed`.
 * `MARINA_FORECAST_PLAIN=legacy` keeps the older single-round analyst pipeline.
 */
export async function plainForecastFor(
  req: ForecastRequest,
  opts: TypedSurfaceOptions = {},
): Promise<{ answer: PlainViaTypedAnswer; scale: ForecastScale } | { error: string }> {
  const kind: ForecastKind = req.kind ?? inferKind(req.question);
  const endTime = endTimeOf(req.resolveBy);
  const made = await typedForecastFor(
    {
      question: req.question,
      answer:
        kind === "probability"
          ? { type: "choice", options: YES_NO_OPTIONS, probabilities: true }
          : { type: "number", ...(req.unit ? { unit: req.unit } : {}) },
      ...(endTime ? { endTime } : {}),
      ...(req.resolveBy && !endTime ? { context: `Resolves by: ${req.resolveBy}` } : {}),
    },
    opts,
  );
  if ("error" in made) return made;
  return { answer: plainFromTyped(kind, made.answer), scale: made.scale };
}

/** The plain answer shape of a typed yes/no or number answer. */
export function plainFromTyped(kind: ForecastKind, t: TypedForecastAnswer): PlainViaTypedAnswer {
  const analysts = t.runs.map((run) => {
    const yes = run.distribution?.yes;
    const value = typeof run.value === "number" ? run.value : undefined;
    return {
      name: run.model,
      weight: run.weight,
      status: run.status,
      ...(kind === "probability" && yes !== undefined ? { probability: yes } : {}),
      ...(kind === "number" && value !== undefined ? { mean: value } : {}),
      ...(kind === "number" && run.sd !== undefined ? { sd: run.sd } : {}),
      ...(run.reason ? { reason: run.reason } : {}),
      ...(run.grounded !== undefined ? { grounded: run.grounded } : {}),
      ...(run.quality !== undefined ? { quality: run.quality } : {}),
      ...(run.judgeError ? { judgeError: run.judgeError } : {}),
    };
  });
  const out: PlainViaTypedAnswer = {
    question: t.question,
    kind,
    analysts,
    sources: t.sources,
    ...(t.verification ? { verification: t.verification } : {}),
    report: "",
    ...(t.judge ? { judge: t.judge } : {}),
    costUsd: t.costUsd,
    latencyMs: t.latencyMs,
    ...(t.caveat ? { caveat: t.caveat } : {}),
    pipeline: "typed",
    typed: t,
  };
  if (kind === "probability") {
    const yes = t.distribution?.yes;
    if (yes !== undefined && Number.isFinite(yes)) out.probability = r3(yes);
  } else if (typeof t.prediction === "number") {
    out.mean = r3(t.prediction);
    const sd = t.uncertainty?.sd;
    if (sd !== undefined && sd > 0) {
      out.sd = r3(sd);
      out.interval = [r3(t.prediction - 1.2816 * sd), r3(t.prediction + 1.2816 * sd)];
    }
  }
  return out;
}

/** `MARINA_FORECAST_PLAIN=legacy`: plain questions keep the single-round analyst pipeline. */
export function plainUsesLegacy(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_FORECAST_PLAIN?.trim().toLowerCase() === "legacy";
}
