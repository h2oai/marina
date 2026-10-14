// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Card routing: which method card (`./method-cards.ts`) answers a question,
 * chosen per class from evidence — the formation routing of `./routing.ts`
 * generalised from formations to every runnable recipe, and from the
 * forecast history file to the one outcome path.
 *
 *   features   `./featurise.ts`: mechanical, plus the decisions judgements
 *              when configured; they yield the class chain (most specific
 *              first: board, category, domain/group, group)
 *   candidates the operator's route candidates whose preconditions hold here
 *              (`eligibility`); the default card always stands
 *   evidence   resolved, mechanically scored outcomes tagged `family:<class>`
 *              and `method:<card>` (live only — a measurement row counts only
 *              for its own board's class), plus the forecast history file's
 *              formation records, both visible at the cutoff and never this
 *              question
 *   class      the most specific class with at least `minN` evidence records,
 *              else the coarsest (the calibration group) — as formation
 *              routing has always fallen back from category to group
 *   the bar    `earnedPick`: a paired held-out win, 95 % lower bound above 0
 *              and past `promotionMargin(tried)`; else the default
 *   explore    sibling classes (same group, other categories/domains) only
 *              ORDER the challengers worth trying next; they never replace
 *              the default
 *
 * With no evidence the default card — the operator's formation with the
 * operator's options — answers, exactly as before; the decision is recorded on
 * the answer (`routing`) and its families / method tag the outcome when it
 * resolves (`./routing-refs.ts`).
 */

import type { DecisionProvider } from "../decisions/types";
import type { MarinaDB } from "../persistence/database";
import type { OutcomeRow } from "../persistence/db-outcomes";
import { classChain, classLabel, featurise, type PropositionFeatures } from "./featurise";
import { type FormedAnswer, forecastFormed, type TypedFormation } from "./formations";
import { type ResolvedRecord, visibleRecords } from "./history";
import {
  applyCard,
  type CardContext,
  cardContext,
  eligibility,
  type MethodCard,
  recipeCard,
} from "./method-cards";
import { earnedPick, type PairedChallenger, type RouteMode, type RouteSettings } from "./routing";
import { outcomeRefs } from "./routing-refs";
import { chooseCutoff, type TypedForecastDeps, type TypedForecastRequest } from "./typed";

/** One method's score on one question, in one class. */
export interface CardEvidence {
  family: string;
  method: string;
  /** What pairs two methods: the `q:` id when the asker gave one, else the outcome subject. */
  question: string;
  /** Higher is better: the outcome's quality, else its negated loss. */
  score: number;
  /** When the outcome was known (ms). */
  resolvedAt: number;
  /** A measurement run (`eval_mode = measure`). */
  measure: boolean;
}

export interface CardCandidate {
  id: string;
  eligible: boolean;
  why?: string;
}

export interface CardRouting {
  mode: RouteMode;
  features: PropositionFeatures;
  /** The class chain, most specific first (each tags the resolved outcome as `family:`). */
  families: string[];
  /** The class the evidence was read for. */
  class: string;
  /** Evidence records in that class (any method). */
  evidence: number;
  default: string;
  /** The card routing picked (differs from `method` only under `observe`). */
  picked: string;
  /** The card that answered — the outcome's `method:` tag. */
  method: string;
  candidates: CardCandidate[];
  challengers: PairedChallenger[];
  /** Challengers worth exploring next, best sibling evidence first (advice only). */
  explore: string[];
  /** The asker's stable question id (pairs methods on the same question). */
  question?: string;
  /** Newest evidence used (ISO; every one at or before the cutoff). */
  through?: string;
  reason: string;
}

/** Card evidence from outcome rows: mechanical, scored, tagged with a family and a method. */
export function evidenceFromOutcomes(rows: readonly OutcomeRow[]): CardEvidence[] {
  const out: CardEvidence[] = [];
  for (const o of rows) {
    if (o.basis !== "mechanical") continue;
    const score =
      o.quality !== null && Number.isFinite(o.quality)
        ? o.quality
        : o.loss !== null && Number.isFinite(o.loss)
          ? -o.loss
          : undefined;
    if (score === undefined) continue;
    const refs = outcomeRefs(o.refs_json);
    const method = refs.find((r) => r.startsWith("method:"))?.slice(7);
    if (!method) continue;
    const question = refs.find((r) => r.startsWith("q:")) ?? o.subject;
    for (const r of refs) {
      if (!r.startsWith("family:")) continue;
      out.push({
        family: r.slice(7),
        method,
        question,
        score,
        resolvedAt: o.resolved_at,
        measure: o.eval_mode === "measure",
      });
    }
  }
  return out;
}

/** Every scored forecast outcome's card evidence (newest 10 000). */
export function readCardEvidence(db: Pick<MarinaDB, "listOutcomes">): CardEvidence[] {
  return evidenceFromOutcomes(
    db.listOutcomes({ kind: "forecast", basis: "mechanical", limit: 10_000 }),
  );
}

/** Whether a history record (the forecast history file) belongs to a class. */
function historyInClass(r: ResolvedRecord, cls: string): boolean {
  if (cls.startsWith("group:")) return r.group === cls.slice(6);
  if (cls.startsWith("category:")) return !!r.category && classLabel(r.category) === cls.slice(9);
  return false;
}

/** method → question → mean score, for one class. */
function classScores(
  cls: string,
  evidence: readonly CardEvidence[],
  history: readonly ResolvedRecord[],
): Map<string, Map<string, number>> {
  const sums = new Map<string, Map<string, { s: number; n: number }>>();
  const add = (method: string, q: string, score: number) => {
    const by = sums.get(method) ?? new Map<string, { s: number; n: number }>();
    const had = by.get(q) ?? { s: 0, n: 0 };
    had.s += score;
    had.n++;
    by.set(q, had);
    sums.set(method, by);
  };
  const board = cls.startsWith("board:");
  const fromOutcomes = new Set<string>();
  for (const e of evidence) {
    if (e.family !== cls || (e.measure && !board)) continue;
    add(e.method, e.question, e.score);
    fromOutcomes.add(e.question);
  }
  for (const r of history) {
    if (!historyInClass(r, cls) || !r.formation || r.score === undefined) continue;
    if (!Number.isFinite(r.score) || fromOutcomes.has(r.id)) continue;
    const card = recipeCard(r.formation);
    if (card) add(card.id, r.id, r.score);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [m, by] of sums)
    out.set(m, new Map([...by].map(([q, { s, n }]) => [q, s / n] as const)));
  return out;
}

const records = (scores: Map<string, Map<string, number>>) =>
  [...scores.values()].reduce((n, by) => n + by.size, 0);

/** The card a question is answered with, and why. Pure. */
export function chooseCard(input: {
  features: PropositionFeatures;
  defaultCard: MethodCard;
  /** Candidate card ids (the operator's list); the default is always eligible. */
  candidates: readonly string[];
  ctx: CardContext;
  evidence: readonly CardEvidence[];
  history?: readonly ResolvedRecord[];
  settings: Pick<RouteSettings, "mode" | "minN">;
  /** The evidence cutoff (ISO): nothing resolved after it counts. */
  cutoff: string;
  /** The question's own id: its own outcome never counts. */
  questionId?: string;
}): CardRouting {
  const { features, defaultCard, settings } = input;
  const at = Date.parse(input.cutoff);
  const own = input.questionId ? `q:${input.questionId}` : undefined;
  const visible = input.evidence.filter(
    (e) => Number.isFinite(at) && e.resolvedAt <= at && e.question !== own,
  );
  const history = input.history ?? [];
  const candidates: CardCandidate[] = [];
  const eligible: string[] = [];
  for (const id of new Set([defaultCard.id, ...input.candidates])) {
    const card = recipeCard(id);
    if (!card) {
      candidates.push({ id, eligible: false, why: "unknown method" });
      continue;
    }
    const ok =
      card.id === defaultCard.id
        ? { ok: true as const }
        : eligibility(card, features.answerType, input.ctx);
    candidates.push(
      ok.ok ? { id: card.id, eligible: true } : { id: card.id, eligible: false, why: ok.why },
    );
    if (ok.ok) eligible.push(card.id);
  }
  const families = classChain(features);
  let cls = families.at(-1)!;
  let scores = classScores(cls, visible, history);
  for (const c of families) {
    const s = c === cls ? scores : classScores(c, visible, history);
    if (records(s) >= settings.minN || c === families.at(-1)) {
      cls = c;
      scores = s;
      break;
    }
  }
  const pick = earnedPick({
    defaultId: defaultCard.id,
    candidates: eligible,
    scores,
    minN: settings.minN,
  });
  // Exploration order: each challenger's unpaired mean score on this group's
  // OTHER questions (sibling categories, domains) — or the whole group when the
  // group is the class. Advice only: it never replaces the default.
  const group = `group:${features.group}`;
  const inCls = new Set(visible.filter((e) => e.family === cls).map((e) => e.question));
  const sib = new Map<string, { s: number; n: number }>();
  for (const e of visible) {
    if (e.family !== group || e.measure || (cls !== group && inCls.has(e.question))) continue;
    const had = sib.get(e.method) ?? { s: 0, n: 0 };
    had.s += e.score;
    had.n++;
    sib.set(e.method, had);
  }
  const mean = (id: string) => {
    const s = sib.get(id);
    return s?.n ? s.s / s.n : Number.NEGATIVE_INFINITY;
  };
  const explore = eligible
    .filter((id) => id !== defaultCard.id && id !== pick.picked)
    .map((id, i) => ({ id, i, m: mean(id) }))
    .sort((a, b) => b.m - a.m || a.i - b.i)
    .map((x) => x.id);
  const newest = visible
    .filter((e) => e.family === cls)
    .reduce((t, e) => Math.max(t, e.resolvedAt), Number.NEGATIVE_INFINITY);
  const method = settings.mode === "on" ? pick.picked : defaultCard.id;
  const best = pick.best;
  return {
    mode: settings.mode,
    features,
    families,
    class: cls,
    evidence: records(scores),
    default: defaultCard.id,
    picked: pick.picked,
    method,
    candidates,
    challengers: pick.challengers,
    explore,
    ...(input.questionId ? { question: input.questionId } : {}),
    ...(Number.isFinite(newest) ? { through: new Date(newest).toISOString() } : {}),
    reason: best
      ? `${best.id} beat ${defaultCard.id} by ${best.gain} [${best.ci!.join(", ")}] on ${best.n} paired questions in ${cls} (margin ${best.margin})${settings.mode === "observe" ? "; observe: the default answered" : ""}`
      : `no challenger cleared the bar in ${cls} (${records(scores)} records): ${defaultCard.id} stands`,
  };
}

/**
 * Forecast with the card routing picks (the default card when routing is off,
 * under `observe`, or without evidence). The decision goes on the answer
 * (`routing`); its families and method tag the outcome when it resolves.
 */
export async function forecastCarded(
  req: TypedForecastRequest,
  deps: TypedForecastDeps,
  defaultFormation: TypedFormation,
  settings: RouteSettings,
  opts: {
    /** The world database: outcome evidence (none: the history file only). */
    db?: Pick<MarinaDB, "listOutcomes">;
    board?: string;
    env?: NodeJS.ProcessEnv;
    /** Decision backends for the featuriser (tests, standalone callers). */
    featureProviders?: readonly DecisionProvider[];
  } = {},
): Promise<FormedAnswer & { routing: CardRouting }> {
  const now = deps.now?.() ?? new Date();
  const cutoff = chooseCutoff(req, now).at;
  const defaultCard = recipeCard(defaultFormation)!;
  // Routing off: no judgement asked, no evidence read — the default answers,
  // and the outcome is still tagged so evidence accumulates.
  const off = settings.mode === "off";
  let history: ResolvedRecord[] = [];
  let evidence: CardEvidence[] = [];
  if (!off) {
    try {
      history = visibleRecords((await deps.adjust?.history?.all()) ?? [], cutoff, req.id);
    } catch {
      // allow-empty-catch: unreadable history falls open to the default card
    }
    try {
      evidence = opts.db ? readCardEvidence(opts.db) : [];
    } catch {
      // allow-empty-catch: unreadable outcomes fall open to the default card
    }
  }
  const features = await featurise(req, {
    now,
    ...(opts.board ? { board: opts.board } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(off ? { mode: "off" as const } : {}),
    ...(opts.featureProviders ? { providers: opts.featureProviders } : {}),
  });
  const routing = chooseCard({
    features,
    defaultCard,
    candidates: off ? [] : (settings.cards ?? settings.candidates.map((f) => recipeCard(f)!.id)),
    ctx: cardContext(deps, history.length),
    evidence,
    history,
    settings,
    cutoff,
    ...(req.id ? { questionId: req.id } : {}),
  });
  const card = recipeCard(routing.method) ?? defaultCard;
  const answer = await forecastFormed(req, applyCard(deps, card), card.formation!);
  return { ...answer, routing };
}
