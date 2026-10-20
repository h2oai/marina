// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Method cards: the forecasting recipes Marina can run, each with what it can
 * answer, what it needs and roughly what it costs, under one stable id — the
 * `method:` key outcomes are tagged with (`src/outcomes/forecast.ts`, the
 * convention `src/arena/settle.ts` and `src/outcomes/benchmark.ts` share), so
 * evidence about a recipe accumulates under the name routing chooses it by.
 *
 *   recipe     a runnable way to answer: a formation (`./formations.ts`),
 *              optionally with the draft check forced on or off, optionally
 *              closed-book (no web research; structured lookups still run).
 *              Id grammar: `formation:<formation>[+verify|+noverify][+closed-book]`.
 *              A plain `formation:<f>` runs with the operator's options.
 *   component  a stage inside every recipe that adopts itself only on held-out
 *              evidence or by operator setting (prior shrink, recalibration,
 *              lookups, lessons, web research): listed so the competence map
 *              can say what is active here, never a routing candidate.
 *
 * A recipe whose preconditions fail here (too few runs for a panel, no
 * retriever, no checker) is never a candidate. Pure, except `applyCard`, which
 * derives the deps a card runs with.
 */

import type { ResearchReport } from "../research/retrieve";
import type { AnswerType } from "./answer-types";
import { ANSWER_TYPES } from "./answer-types";
import { TYPED_FORMATIONS, type TypedFormation, typedFormation } from "./formations";
import type { TypedForecastDeps } from "./typed";

export type CardKind = "recipe" | "component";
export type CardCost = "none" | "low" | "medium" | "high";

export interface CardNeeds {
  /** Independent answer runs (a panel needs at least two). */
  runs?: number;
  /** A web/research retriever. */
  retriever?: boolean;
  /** A model to check each draft. */
  verifier?: boolean;
  /** Resolved history records visible at the cutoff. */
  history?: number;
  /** Structured lookup sources (markets, official series). */
  lookups?: boolean;
  /** A lesson store. */
  lessons?: boolean;
}

export interface MethodCard {
  /** The method key: what outcomes are tagged with and routing chooses by. */
  id: string;
  kind: CardKind;
  summary: string;
  /** Answer shapes it can produce. */
  shapes: readonly AnswerType[];
  needs: CardNeeds;
  cost: CardCost;
  /** Recipe: the formation it runs. */
  formation?: TypedFormation;
  /** Recipe: force the draft check on/off (undefined: the operator's setting). */
  verify?: boolean;
  /** Recipe: `closed-book` answers without web research (undefined: web). */
  retrieval?: "closed-book";
}

const FORMATION_SUMMARY: Record<TypedFormation, string> = {
  ensemble: "independent runs combined by type, then a critique (the control)",
  delphi: "runs revise once after an anonymous panel summary; median of the revisions",
  tournament: "runs' proposals meet in judged pairwise matches; the champion answers",
  skeptic: "statistician and analyst propose; a skeptic trusts their move from the prior",
};

const FORMATION_COST: Record<TypedFormation, CardCost> = {
  ensemble: "medium",
  delphi: "high",
  tournament: "high",
  skeptic: "medium",
};

/** The method key of a recipe. */
export function recipeKey(
  formation: TypedFormation,
  opts: { verify?: boolean; retrieval?: "closed-book" } = {},
): string {
  return `formation:${formation}${opts.verify === true ? "+verify" : opts.verify === false ? "+noverify" : ""}${opts.retrieval ? `+${opts.retrieval}` : ""}`;
}

/**
 * A recipe card from its id or a short spec: `delphi`, `formation:delphi`,
 * `ensemble+closed-book`, `skeptic+noverify`. Undefined for anything else
 * (an unknown name is never silently mapped to a default).
 */
export function recipeCard(spec: string): MethodCard | undefined {
  const raw = spec
    .trim()
    .toLowerCase()
    .replace(/^formation:/, "");
  const [name, ...mods] = raw.split("+");
  const formation = typedFormation(name);
  if (!formation) return undefined;
  let verify: boolean | undefined;
  let retrieval: "closed-book" | undefined;
  for (const m of mods) {
    if (m === "verify" && verify === undefined) verify = true;
    else if (m === "noverify" && verify === undefined) verify = false;
    else if (m === "closed-book" && !retrieval) retrieval = "closed-book";
    else return undefined;
  }
  const opts = {
    ...(verify !== undefined ? { verify } : {}),
    ...(retrieval ? { retrieval } : {}),
  };
  const needs: CardNeeds = {
    ...(formation === "delphi" || formation === "tournament" ? { runs: 2 } : {}),
    ...(retrieval ? {} : { retriever: true }),
    ...(verify ? { verifier: true } : {}),
  };
  const cost: CardCost =
    retrieval && FORMATION_COST[formation] === "medium" ? "low" : FORMATION_COST[formation];
  return {
    id: recipeKey(formation, opts),
    kind: "recipe",
    summary: `${FORMATION_SUMMARY[formation]}${verify === true ? "; every draft checked" : verify === false ? "; drafts unchecked" : ""}${retrieval ? "; no web research (lookups only)" : ""}`,
    shapes: ANSWER_TYPES,
    needs,
    cost,
    formation,
    ...opts,
  };
}

/** Every recipe Marina can run: each formation, plain and closed-book. */
export const RECIPE_CARDS: readonly MethodCard[] = TYPED_FORMATIONS.flatMap((f) => [
  recipeCard(f)!,
  recipeCard(`${f}+closed-book`)!,
]);

/** Stages inside every recipe (never routing candidates). */
export const COMPONENT_CARDS: readonly MethodCard[] = [
  {
    id: "component:web-research",
    kind: "component",
    summary: "planned queries through the operator's retriever, citations checked",
    shapes: ANSWER_TYPES,
    needs: { retriever: true },
    cost: "medium",
  },
  {
    id: "component:lookups",
    kind: "component",
    summary: "structured sources (markets, odds, official series) as dated observations",
    shapes: ANSWER_TYPES,
    needs: { lookups: true },
    cost: "low",
  },
  {
    id: "component:lessons",
    kind: "component",
    summary: "judged lessons from resolved questions visible at the cutoff",
    shapes: ANSWER_TYPES,
    needs: { lessons: true },
    cost: "none",
  },
  {
    id: "component:prior-shrink",
    kind: "component",
    summary: "pool toward the best prior; weight adopted only on a held-out gain",
    shapes: ["choice", "multi", "number"],
    needs: { history: 1 },
    cost: "none",
  },
  {
    id: "component:recalibration",
    kind: "component",
    summary: "per answer group calibration map; adopted only on a held-out gain",
    shapes: ["choice", "multi", "number"],
    needs: { history: 1 },
    cost: "none",
  },
];

/** What this installation provides, as card preconditions read it. */
export interface CardContext {
  runs: number;
  retriever: boolean;
  verifier: boolean;
  lookups: boolean;
  lessons: boolean;
  /** Resolved history records visible at the cutoff. */
  history: number;
}

/** Default typed runs when the options name none (`./typed.ts`). */
const DEFAULT_RUNS = 3;

/** The card context of a deps bundle. */
export function cardContext(deps: TypedForecastDeps, history = 0): CardContext {
  const runs = deps.options?.runs;
  return {
    // As `forecastTyped` reads it: 1–9, default 3.
    runs:
      runs !== undefined && Number.isFinite(runs)
        ? Math.min(9, Math.max(1, Math.round(runs)))
        : DEFAULT_RUNS,
    retriever: typeof deps.retriever === "function",
    // The checker defaults to the critic, else the planner, else the first analyst.
    verifier: !!(deps.verifier ?? deps.critic ?? deps.planner ?? deps.analysts[0]),
    lookups: (deps.lookups?.length ?? 0) > 0,
    lessons: !!deps.lessons,
    history,
  };
}

/** Whether a card can answer this shape here; the first failed precondition when not. */
export function eligibility(
  card: MethodCard,
  shape: AnswerType,
  ctx: CardContext,
): { ok: true } | { ok: false; why: string } {
  if (!card.shapes.includes(shape)) return { ok: false, why: `cannot answer ${shape}` };
  const n = card.needs;
  if (n.runs !== undefined && ctx.runs < n.runs)
    return { ok: false, why: `needs ${n.runs}+ runs (have ${ctx.runs})` };
  if (n.retriever && !ctx.retriever) return { ok: false, why: "needs a retriever" };
  if (n.verifier && !ctx.verifier) return { ok: false, why: "needs a checker model" };
  if (n.lookups && !ctx.lookups) return { ok: false, why: "needs structured lookups" };
  if (n.lessons && !ctx.lessons) return { ok: false, why: "needs a lesson store" };
  if (n.history !== undefined && ctx.history < n.history)
    return { ok: false, why: `needs ${n.history}+ resolved records (have ${ctx.history})` };
  return { ok: true };
}

/** A retriever that researches nothing: closed-book answers from lookups and the model alone. */
async function closedBook(): Promise<ResearchReport> {
  return { report: "", sources: [], costUsd: 0, searches: 0, retriever: "closed-book" };
}

/** The deps a recipe card runs with (the operator's deps for a plain formation card). */
export function applyCard(deps: TypedForecastDeps, card: MethodCard): TypedForecastDeps {
  if (card.verify === undefined && !card.retrieval) return deps;
  return {
    ...deps,
    ...(card.retrieval === "closed-book" ? { retriever: closedBook } : {}),
    ...(card.verify !== undefined ? { options: { ...deps.options, verify: card.verify } } : {}),
  };
}
