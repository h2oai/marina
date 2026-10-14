// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Formation routing: which formation answers a question, chosen per question
 * class (the asker's category, else the answer group) from held-out evidence —
 * the arena's per-family routes (`MARINA_ARENA_ROUTES`), learned instead of
 * hand-set, and held to the promotion rule the ledger uses for defaults
 * (`src/engine/benchmark-promotion.ts`):
 *
 *   evidence   resolved records (`./history.ts`) that name the formation that
 *              produced them and the board's score of the filed answer,
 *              visible at the cutoff (resolved by then, never this question)
 *   pairing    a challenger is compared with the default formation on the
 *              questions BOTH answered (paired), at least `minN` of them
 *   the bar    the paired mean gain's 95 % lower bound is above zero AND the
 *              gain clears `promotionMargin(tried)` — the margin grows with
 *              every challenger considered for the class, so fishing through
 *              formations costs
 *
 * Anything short of that falls open to the default formation, so `on` (the
 * default) is safe with no history. `observe` records what routing would pick
 * without acting on it. Pure except for
 * `forecastRouted`, which runs the chosen formation.
 */

import { mulberry32 } from "../../benchmarks/stats";
import { promotionMargin } from "../engine/fishing-margin";
import {
  type FormedAnswer,
  forecastFormed,
  type TypedFormation,
  typedFormation,
} from "./formations";
import { answerGroup, type ResolvedRecord, visibleRecords } from "./history";
import { type MethodCard, recipeCard } from "./method-cards";
import { chooseCutoff, type TypedForecastDeps, type TypedForecastRequest } from "./typed";

export type RouteMode = "off" | "observe" | "on";

export interface RouteSettings {
  mode: RouteMode;
  /** Formations routing may choose among (the default always included). */
  candidates: TypedFormation[];
  /**
   * Method-card ids routing may choose among (`./method-cards.ts`): the plain
   * formations above plus any variant listed (`ensemble+closed-book`, …).
   * Absent: the plain `candidates`.
   */
  cards?: string[];
  /** Fewest paired questions before a challenger is considered. */
  minN: number;
}

export const DEFAULT_ROUTE_MIN_N = 30;

export function routeSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): RouteSettings {
  const m = env.MARINA_FORECAST_ROUTE?.trim().toLowerCase();
  // `on` by default: an earned pick answers; without enough paired evidence the
  // pick IS the default formation (falls open). `observe` records the pick only.
  const mode: RouteMode = m === "off" || m === "observe" ? m : "on";
  // Formation names or method-card specs (`delphi`, `ensemble+closed-book`, …);
  // an unknown entry is dropped, never mapped to a default.
  const listed = (env.MARINA_FORECAST_ROUTE_CANDIDATES ?? "")
    .split(",")
    .map((s) => recipeCard(s))
    .filter((c): c is MethodCard => !!c);
  const plain = listed
    .filter((c) => c.verify === undefined && !c.retrieval)
    .map((c) => c.formation!);
  const n = Number.parseInt(env.MARINA_FORECAST_ROUTE_MIN_N ?? "", 10);
  const candidates: TypedFormation[] = listed.length
    ? [...new Set(plain)]
    : ["ensemble", "delphi", "tournament", "skeptic"];
  return {
    mode,
    candidates,
    cards: listed.length
      ? [...new Set(listed.map((c) => c.id))]
      : candidates.map((f) => recipeCard(f)!.id),
    minN: Number.isFinite(n) && n >= 5 ? n : DEFAULT_ROUTE_MIN_N,
  };
}

export interface RouteChallenger {
  formation: TypedFormation;
  n: number;
  gain?: number;
  ci?: [number, number];
  margin?: number;
  verdict: "qualifies" | "too few paired" | "not better" | "below margin";
}

export interface RouteDecision {
  mode: RouteMode;
  /** The class the evidence was read for: `category:<c>` or `group:<g>`. */
  class: string;
  default: TypedFormation;
  /** The formation that answered. */
  chosen: TypedFormation;
  /** The formation routing picked (differs from `chosen` only under `observe`). */
  picked: TypedFormation;
  challengers: RouteChallenger[];
  /** Newest evidence time used (ISO; every one at or before the cutoff). */
  through?: string;
  reason: string;
}

/** Paired mean gain (challenger − default) and its 95 % bootstrap interval. */
export function pairedGain(
  pairs: Array<{ challenger: number; incumbent: number }>,
  iterations = 2_000,
  seed = 17,
): { gain: number; ci: [number, number] } {
  const diffs = pairs.map((p) => p.challenger - p.incumbent);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rand = mulberry32(seed);
  const stats: number[] = [];
  for (let k = 0; k < iterations; k++) {
    let s = 0;
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rand() * diffs.length)]!;
    stats.push(s / diffs.length);
  }
  stats.sort((a, b) => a - b);
  const q = (p: number) => stats[Math.min(stats.length - 1, Math.floor(p * stats.length))]!;
  const r = (x: number) => Math.round(x * 10_000) / 10_000;
  return { gain: r(mean(diffs)), ci: [r(q(0.025)), r(q(0.975))] };
}

/** The class's per-question score of each formation (the mean when a formation answered twice). */
function scoresBy(records: ResolvedRecord[]): Map<string, Map<string, number>> {
  const sums = new Map<string, Map<string, { s: number; n: number }>>();
  for (const r of records) {
    const f = typedFormation(r.formation);
    if (!f || r.score === undefined || !Number.isFinite(r.score)) continue;
    const by = sums.get(f) ?? new Map();
    const had = by.get(r.id) ?? { s: 0, n: 0 };
    had.s += r.score;
    had.n++;
    by.set(r.id, had);
    sums.set(f, by);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [f, by] of sums) {
    out.set(f, new Map([...by].map(([id, { s, n }]) => [id, s / n])));
  }
  return out;
}

/** One challenger's verdict under {@link earnedPick}, keyed by any method id. */
export interface PairedChallenger {
  id: string;
  n: number;
  gain?: number;
  ci?: [number, number];
  margin?: number;
  verdict: RouteChallenger["verdict"];
}

/**
 * The earned-promotion rule every router shares: a challenger replaces the
 * default only on at least `minN` questions BOTH answered, with the paired mean
 * gain's 95 % lower bound above zero AND the gain past `promotionMargin(tried)`
 * (the margin grows with every challenger considered, so fishing costs). The
 * best qualifying challenger is picked; with none, the default. Pure.
 *
 * `scores`: method id → question id → that method's score on the question
 * (higher is better), already restricted to evidence visible at the cutoff.
 */
export function earnedPick(input: {
  defaultId: string;
  candidates: readonly string[];
  scores: Map<string, Map<string, number>>;
  minN: number;
}): { picked: string; challengers: PairedChallenger[]; best?: PairedChallenger } {
  const incumbent = input.scores.get(input.defaultId) ?? new Map<string, number>();
  const challengers: PairedChallenger[] = [];
  let tried = 0;
  for (const id of input.candidates) {
    if (id === input.defaultId) continue;
    const theirs = input.scores.get(id);
    const ids = theirs ? [...theirs.keys()].filter((q) => incumbent.has(q)) : [];
    if (ids.length < input.minN) {
      challengers.push({ id, n: ids.length, verdict: "too few paired" });
      continue;
    }
    const margin = Math.round(promotionMargin(tried) * 10_000) / 10_000;
    tried++;
    const { gain, ci } = pairedGain(
      ids.map((q) => ({ challenger: theirs!.get(q)!, incumbent: incumbent.get(q)! })),
    );
    const verdict = ci[0] <= 0 ? "not better" : gain < margin ? "below margin" : "qualifies";
    challengers.push({ id, n: ids.length, gain, ci, margin, verdict });
  }
  const best = challengers
    .filter((c) => c.verdict === "qualifies")
    .sort((a, b) => (b.gain ?? 0) - (a.gain ?? 0))[0];
  return { picked: best?.id ?? input.defaultId, challengers, ...(best ? { best } : {}) };
}

export function chooseFormation(input: {
  spec: TypedForecastRequest["answer"];
  category?: string;
  history: ResolvedRecord[];
  defaultFormation: TypedFormation;
  settings: RouteSettings;
}): RouteDecision {
  const { settings, defaultFormation } = input;
  const group = answerGroup(input.spec);
  const inCategory = input.category
    ? input.history.filter((r) => r.category === input.category)
    : [];
  const useCategory = inCategory.length >= settings.minN;
  const records = useCategory ? inCategory : input.history.filter((r) => r.group === group);
  const cls = useCategory ? `category:${input.category}` : `group:${group}`;
  const pick = earnedPick({
    defaultId: defaultFormation,
    candidates: settings.candidates,
    scores: scoresBy(records),
    minN: settings.minN,
  });
  const challengers: RouteChallenger[] = pick.challengers.map(({ id, ...c }) => ({
    formation: id as TypedFormation,
    ...c,
  }));
  const best = pick.best && { ...pick.best, formation: pick.best.id as TypedFormation };
  const picked = pick.picked as TypedFormation;
  const through = records.at(-1)?.resolvedAt;
  return {
    mode: settings.mode,
    class: cls,
    default: defaultFormation,
    picked,
    chosen: settings.mode === "on" ? picked : defaultFormation,
    challengers,
    ...(through ? { through } : {}),
    reason: best
      ? `${best.formation} beat ${defaultFormation} by ${best.gain} [${best.ci!.join(", ")}] on ${best.n} paired questions (margin ${best.margin})`
      : `no challenger cleared the bar: ${defaultFormation} stands`,
  };
}

/**
 * Forecast with the formation routing picks for the question's class (or the
 * default when routing is off, under `observe`, or without evidence); the
 * decision goes on the answer (`route`).
 */
export async function forecastRouted(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  defaultFormation: TypedFormation,
  settings: RouteSettings,
): Promise<FormedAnswer & { route?: RouteDecision }> {
  if (settings.mode === "off") return forecastFormed(req, deps, defaultFormation);
  let history: ResolvedRecord[] = [];
  try {
    const cutoff = chooseCutoff(req, deps.now?.() ?? new Date()).at;
    history = visibleRecords((await deps.adjust?.history?.all()) ?? [], cutoff, req.id);
  } catch {
    // allow-empty-catch: unreadable evidence falls open to the default formation
  }
  const route = chooseFormation({
    spec: req.answer,
    ...(req.category ? { category: req.category } : {}),
    history,
    defaultFormation,
    settings,
  });
  const answer = await forecastFormed(req, deps, route.chosen);
  return { ...answer, route };
}
