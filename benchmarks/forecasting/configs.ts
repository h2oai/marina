// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forecasting configurations: which models, which formation, with or without
 * lessons and lookups. Any Marina formation can enter any board — the single
 * best model, an ensemble, delphi or tournament over several vendors, the
 * verification formation (cheap runs checked by a stronger verifier), a crew
 * (`marina:<crew>`) — and the held-out backtest (`select.ts`) decides which
 * one files. A configuration is DATA; `describeConfig` is how it is disclosed.
 */

import type { Retriever } from "../../src/arena/research/retrieve";
import { forecastFormed, type TypedFormation, typedFormation } from "../../src/forecast/formations";
import type { LessonStore } from "../../src/forecast/lessons";
import { priorAnswer } from "../../src/forecast/prior-answer";
import { typedForecastDeps } from "../../src/forecast/service";
import type {
  TypedForecastAnswer,
  TypedForecastDeps,
  TypedForecastRequest,
} from "../../src/forecast/typed";
import type { CatalogueModel } from "./catalogue";

export interface ForecastConfig {
  label: string;
  formation: TypedFormation;
  /** Provider model specs (`openrouter/<vendor>/<model>`) or `marina:<crew>`. */
  analysts: string[];
  planner?: string;
  critic?: string;
  verifier?: string;
  verify?: boolean;
  runs?: number;
  researchRounds?: number;
  critique?: boolean;
  /** Recall lessons from resolved outcomes (default true). */
  lessons?: boolean;
  /** Structured lookups: `auto` (default), `off`, or a list (`markets,fred`). */
  lookups?: string;
  /** No models: each question's best supplied prior is the forecast (the baseline to beat). */
  priorOnly?: boolean;
  /** Pool the answer toward its supplied prior (`MARINA_FORECAST_PRIOR`); unset = the environment's. */
  pool?: boolean;
}

/** The model-free baseline: every question answered by its own best prior. */
export const PRIOR_ONLY_CONFIG: ForecastConfig = {
  label: "prior-only",
  formation: "ensemble",
  analysts: [],
  priorOnly: true,
};

const short = (m: string) => m.replace(/^openrouter\//, "").replace(/^[^/]+\//, "");
const spec = (m: CatalogueModel | string) => `openrouter/${typeof m === "string" ? m : m.id}`;

/** One line naming everything that decides a forecast (what submissions disclose). */
export function describeConfig(c: ForecastConfig): string {
  if (c.priorOnly) return "prior only (market price or statistical prior; no model)";
  const models = [...new Set(c.analysts.map(short))];
  const parts = [
    `${c.formation === "ensemble" ? (models.length > 1 ? "ensemble" : "single model") : c.formation} of ${models.join(", ")}`,
    c.verify && c.verifier ? `verified by ${short(c.verifier)}` : "",
    `${c.runs ?? 3} runs`,
    `${c.researchRounds ?? 2} research rounds`,
    c.critique === false || c.formation !== "ensemble"
      ? ""
      : `critic ${short(c.critic ?? c.planner ?? c.analysts[0]!)}`,
    `lessons ${c.lessons === false ? "off" : "on"}`,
    `lookups ${c.lookups ?? "auto"}`,
    c.pool === undefined ? "" : `prior pooling ${c.pool ? "on" : "off"}`,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Every provider model a configuration calls (crews excluded). */
export function configModels(c: ForecastConfig): string[] {
  return [
    ...new Set(
      [...c.analysts, c.planner, c.critic, c.verifier]
        .filter((m): m is string => !!m && !m.startsWith("marina:"))
        .map((m) => m.replace(/^openrouter\//, "")),
    ),
  ];
}

/** A crew answers with its own tools and models: it cannot be isolated for a clean backtest. */
export const usesCrew = (c: ForecastConfig) =>
  [...c.analysts, c.planner, c.critic, c.verifier].some((m) => m?.startsWith("marina:"));

function vendorOf(m: CatalogueModel): string {
  return m.id.split("/")[0]!;
}

/** Up to three models from different vendors, in the given order. */
function trio(models: CatalogueModel[]): CatalogueModel[] {
  const out: CatalogueModel[] = [];
  for (const m of models) {
    if (out.some((x) => vendorOf(x) === vendorOf(m))) continue;
    out.push(m);
    if (out.length === 3) break;
  }
  return out;
}

/**
 * The candidate configurations from the candidate models: each model alone;
 * ensemble, delphi and tournament over a frontier trio and a cheap trio
 * (vendor-diverse); the verification formation (the cheapest model's runs
 * checked by the strongest); each crew named; the prior-only baseline and the
 * cheap ensemble pooled toward the prior; and, with `ablate`, the cheap
 * configurations without lessons and without lookups.
 */
export function candidateConfigs(
  models: CatalogueModel[],
  opts: { crews?: string[]; ablate?: boolean; runs?: number; researchRounds?: number } = {},
): ForecastConfig[] {
  const runs = opts.runs ?? 3;
  const rounds = opts.researchRounds ?? 2;
  const byPrice = [...models].sort((a, b) => a.outPerM - b.outPerM);
  const cheapest = byPrice[0];
  const strongest = byPrice.at(-1);
  const out: ForecastConfig[] = [];
  for (const m of models) {
    out.push({
      label: `single:${m.id}`,
      formation: "ensemble",
      analysts: [spec(m)],
      planner: spec(m),
      critic: spec(m),
      runs,
      researchRounds: rounds,
    });
  }
  const frontier = trio([...byPrice].reverse());
  const cheap = trio(byPrice);
  for (const [name, t] of [
    ["frontier", frontier],
    ["cheap", cheap],
  ] as const) {
    if (t.length < 2) continue;
    const planner = spec([...t].sort((a, b) => a.outPerM - b.outPerM)[0]!);
    const critic = spec([...t].sort((a, b) => b.outPerM - a.outPerM)[0]!);
    for (const formation of ["ensemble", "delphi", "tournament"] as const) {
      out.push({
        label: `${formation}:${name}`,
        formation,
        analysts: t.map(spec),
        planner,
        critic,
        runs: Math.max(runs, t.length),
        researchRounds: rounds,
      });
    }
  }
  if (cheapest && strongest && cheapest.id !== strongest.id) {
    out.push({
      label: "verify:cheap>strong",
      formation: "ensemble",
      analysts: [spec(cheapest)],
      planner: spec(cheapest),
      verifier: spec(strongest),
      critic: spec(strongest),
      verify: true,
      runs,
      researchRounds: rounds,
    });
  }
  for (const crew of opts.crews ?? []) {
    out.push({
      label: `crew:${crew}`,
      formation: "ensemble",
      analysts: [`marina:${crew}`],
      ...(cheapest ? { planner: spec(cheapest) } : {}),
      runs: 1,
      researchRounds: rounds,
      critique: false,
    });
  }
  // The model-free baseline, and the cheap ensemble pooled toward each question's prior.
  out.push(PRIOR_ONLY_CONFIG);
  const cheapEnsemble = out.find((c) => c.label === "ensemble:cheap");
  if (cheapEnsemble) out.push({ ...cheapEnsemble, label: "ensemble:cheap+pool", pool: true });
  if (opts.ablate) {
    for (const base of out.filter(
      (c) => c.label === `single:${cheapest?.id}` || c.label === "ensemble:cheap",
    )) {
      out.push({ ...base, label: `${base.label}+nolessons`, lessons: false });
      out.push({ ...base, label: `${base.label}+nolookups`, lookups: "off" });
    }
  }
  return out;
}

/** A configuration from JSON (a file of `ForecastConfig[]`), validated. */
export function parseConfigs(raw: unknown): ForecastConfig[] {
  if (!Array.isArray(raw)) throw new Error("a configuration file holds an array of configurations");
  return raw.map((r, i) => {
    const c = r as Partial<ForecastConfig>;
    const formation = typedFormation(c.formation ?? "ensemble");
    if (
      !c.label ||
      !formation ||
      !Array.isArray(c.analysts) ||
      (c.analysts.length === 0 && !c.priorOnly)
    ) {
      throw new Error(
        `configuration ${i}: needs label, analysts and a formation (ensemble|delphi|tournament)`,
      );
    }
    return { ...c, formation } as ForecastConfig;
  });
}

export type DepsFactory = () => {
  deps: TypedForecastDeps;
  costUsd: () => number;
  /** The research reports this question's forecast read (with `captureEvidence`). */
  evidence?: () => string[];
};

export interface DepsOptions {
  lessons?: LessonStore;
  /** Wrap retrieval in the strict pre-cutoff filter (backtests). */
  strictRetrieval?: boolean;
  /** A retriever spec instead of MARINA_FORECAST_RETRIEVER (backtests: a date-strict `asof:`). */
  retriever?: string;
  /** Keep each question's research reports (for a leak audit). */
  captureEvidence?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Fresh deps per question (cost attributable to it) for a configuration. */
export function depsForConfig(c: ForecastConfig, opts: DepsOptions = {}): DepsFactory {
  const env = {
    ...(opts.env ?? process.env),
    ...(c.lookups ? { MARINA_FORECAST_LOOKUPS: c.lookups } : {}),
    ...(c.pool !== undefined ? { MARINA_FORECAST_PRIOR: c.pool ? "on" : "off" } : {}),
  };
  return () => {
    const reports: string[] = [];
    const made = typedForecastDeps(env, {
      analysts: c.analysts,
      ...(c.planner ? { planner: c.planner } : {}),
      ...(c.critic ? { critic: c.critic } : {}),
      ...(c.verifier ? { verifier: c.verifier } : {}),
      ...(c.verify ? { verify: true } : {}),
      ...(opts.lessons && c.lessons !== false ? { lessons: opts.lessons } : {}),
      ...(opts.strictRetrieval ? { strictRetrieval: true } : {}),
      ...(opts.retriever ? { retriever: opts.retriever } : {}),
      ...(c.runs !== undefined ? { runs: c.runs } : {}),
      ...(c.researchRounds !== undefined ? { researchRounds: c.researchRounds } : {}),
      ...(c.critique === false ? { critique: false } : {}),
      ...(opts.captureEvidence
        ? {
            wrapRetriever:
              (inner: Retriever): Retriever =>
              async (brief) => {
                const r = await inner(brief);
                reports.push(r.report);
                return r;
              },
          }
        : {}),
    });
    if ("error" in made) throw new Error(made.error);
    return opts.captureEvidence ? { ...made, evidence: () => reports } : made;
  };
}

/** A forecaster: one typed request in, the full answer (formation record and cost included) out. */
export type Forecaster = (req: TypedForecastRequest) => Promise<TypedForecastAnswer>;

export function forecasterFor(
  c: ForecastConfig,
  makeDeps: DepsFactory,
  opts: {
    /** Every finished forecast, with the research reports it read when captured. */
    onAnswer?: (req: TypedForecastRequest, answer: TypedForecastAnswer, reports: string[]) => void;
  } = {},
): Forecaster {
  return async (req) => {
    if (c.priorOnly) {
      const answer = priorAnswer(req);
      opts.onAnswer?.(req, answer, []);
      return answer;
    }
    const made = makeDeps();
    const answer = await forecastFormed(req, made.deps, c.formation);
    answer.costUsd = Math.round(made.costUsd() * 1e6) / 1e6;
    opts.onAnswer?.(req, answer, made.evidence?.() ?? []);
    return answer;
  };
}
