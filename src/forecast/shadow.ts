// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shadow challengers: the paired evidence earned routing needs, produced on
 * live questions instead of only by benchmarks.
 *
 * Card routing (`./card-routing.ts`) replaces the default card only on at
 * least `minN` questions where BOTH cards answered, but a live forecast runs
 * one card, so live pairs never formed. On a sampled fraction of filed live
 * forecasts (`MARINA_FORECAST_SHADOW=off|<fraction>`, default off) this runs
 * ONE challenger card on the same question, with the same deps, at the same
 * evidence cutoff, and files it on the one outcome path:
 *
 *   which card  the routing record's `explore` order (sibling-class evidence
 *               first), the first challenger still short of `minN` paired
 *               questions; when routing answered with a challenger, the default
 *               card, so the incumbent keeps its pairs
 *   filing      owner `marina:shadow`, source `shadow`, `eval_mode = live` (an
 *               evaluation filing: no standing), external id
 *               `shadow:forecast:<live id>`, the live answer's shape (a plain
 *               probability or number stays plain so both score on one metric),
 *               tags `method:` (the card), `card:`, `model:`, `family:` (the live
 *               answer's classes) and `q:` or `pair:forecast:<live id>`
 *               (`./routing-refs.ts`)
 *   settling    with the live answer: `resolveForecast` resolves the shadow on
 *               the same value when the live answer resolves, so its outcome
 *               teaches lessons like any other; it never writes history (the
 *               live answer already records the question: no correlated extra
 *               record for prior shrink or recalibration). A board that files
 *               only at resolution (FutureX) uses `startBoardShadow` /
 *               `settleBoardShadow` instead
 *   bounds      `MARINA_FORECAST_SHADOW_MAX_PER_DAY` runs a UTC day (default 10)
 *               and `MARINA_FORECAST_SHADOW_CAP_USD` a UTC day (default 2), both
 *               counted from the filed shadows plus those in flight, and the
 *               world's daily spend cap
 *   leakage     a cutoff more than an hour in the past (a live question asked
 *               with `asOf` or after its end time) gets backtest isolation: a
 *               date-filtered engine as is, any other engine behind the strict
 *               pre-cutoff filter (`strictDateFilter`), as a post-filtered
 *               backtest; lessons and history are read at the cutoff as always
 *
 * The live answer is never changed: the plan is taken after the answer is
 * final, the shadow starts only after the live answer is filed, runs in the
 * background, and touches nothing the live answer holds. Off (the default)
 * plans nothing.
 */

import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import { dailyCapRefusal } from "../engine/spend-ledger";
import { resolveForecast } from "../outcomes/forecast";
import type { MarinaDB } from "../persistence/database";
import type { CardRouting } from "./card-routing";
import { forecastFormed } from "./formations";
import { applyCard, type MethodCard, recipeCard } from "./method-cards";
import type { ForecastKind } from "./question";
import { SHADOW_OWNER, SHADOW_SOURCE, shadowExternalId } from "./routing-refs";
import { plainFromTyped } from "./surface";
import type { TypedForecastAnswer, TypedForecastDeps, TypedForecastRequest } from "./typed";

const logger = new Logger();

export interface ShadowSettings {
  /** Fraction of filed live forecasts that get a shadow challenger (0 < rate ≤ 1). */
  rate: number;
  /** Shadow runs a UTC day. */
  maxPerDay: number;
  /** Shadow spend a UTC day (USD). */
  capUsd: number;
}

export const DEFAULT_SHADOW_MAX_PER_DAY = 10;
export const DEFAULT_SHADOW_CAP_USD = 2;

/** `MARINA_FORECAST_SHADOW=off|<fraction>` and its caps; undefined = off (the default). */
export function shadowSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ShadowSettings | undefined {
  const raw = env.MARINA_FORECAST_SHADOW?.trim().toLowerCase();
  if (!raw || raw === "off") return undefined;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const max = Number.parseInt(env.MARINA_FORECAST_SHADOW_MAX_PER_DAY ?? "", 10);
  const cap = Number(env.MARINA_FORECAST_SHADOW_CAP_USD ?? "");
  return {
    rate: Math.min(1, rate),
    maxPerDay: Number.isFinite(max) && max >= 0 ? max : DEFAULT_SHADOW_MAX_PER_DAY,
    capUsd:
      env.MARINA_FORECAST_SHADOW_CAP_USD?.trim() && Number.isFinite(cap) && cap >= 0
        ? cap
        : DEFAULT_SHADOW_CAP_USD,
  };
}

/** What a live answer leaves for its shadow: the same request, deps and routing record. */
export interface ShadowPlan {
  req: TypedForecastRequest;
  deps: TypedForecastDeps;
  routing: CardRouting;
  /** The live deps' running cost (the shadow's cost is what it adds). */
  costUsd: () => number;
  env: NodeJS.ProcessEnv;
  /** Routing's paired minimum (a challenger past it has enough pairs). */
  minN: number;
}

/** Plans waiting for their live answer to be filed (a plain answer is found by its `typed`). */
const plans = new WeakMap<object, ShadowPlan>();

/**
 * Keep a shadow plan beside a finished live answer. Nothing when shadows are
 * off or the answer has no routing record. Never touches the answer.
 */
export function planForecastShadow(answer: object, plan: ShadowPlan): void {
  if (!shadowSettingsFromEnv(plan.env) || !plan.routing) return;
  plans.set(answer, plan);
}

/**
 * The challenger to shadow: the default card when routing answered with
 * another, else the first `explore` challenger still short of `minN` paired
 * questions (else the first one). Undefined when routing names none (routing
 * off, or no eligible challenger).
 */
export function pickShadowCard(routing: CardRouting, minN: number): MethodCard | undefined {
  if (routing.mode === "off") return undefined;
  if (routing.method !== routing.default) return recipeCard(routing.default);
  const paired = new Map(routing.challengers.map((c) => [c.id, c.n] as const));
  const id = routing.explore.find((c) => (paired.get(c) ?? 0) < minN) ?? routing.explore[0];
  return id ? recipeCard(id) : undefined;
}

/** How a shadow's research is isolated at its cutoff. */
export type ShadowIsolation = "live" | "date-filtered" | "post-filtered" | "closed-book";

/**
 * Backtest isolation for a past cutoff: `live` when the cutoff is current (the
 * live answer's own conditions); a closed-book card needs none; a date-strict
 * engine is `date-filtered`; any other engine is wrapped in the strict
 * pre-cutoff filter (`post-filtered`), as a backtest would be.
 */
export async function shadowIsolation(
  cutoff: TypedForecastAnswer["cutoff"],
  card: MethodCard,
  env: NodeJS.ProcessEnv,
): Promise<ShadowIsolation> {
  if (!cutoff.pastCutoff) return "live";
  if (card.retrieval === "closed-book") return "closed-book";
  const [{ isolationOfSpec }, { defaultRetrieverSpec, retrievalFilterFromEnv }] = await Promise.all(
    [import("../research/isolation"), import("./service")],
  );
  const spec = env.MARINA_FORECAST_RETRIEVER?.trim() || defaultRetrieverSpec(env);
  const level = isolationOfSpec(spec, retrievalFilterFromEnv(env) === "strict");
  return level === "date-filtered" ? "date-filtered" : "post-filtered";
}

/** Shadows filed this UTC day: how many, and what they cost. */
export function shadowUsage(
  db: Pick<MarinaDB, "listForecastAnswers">,
  now: number,
): { count: number; spentUsd: number } {
  const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  let count = 0;
  let spentUsd = 0;
  for (const row of db.listForecastAnswers(SHADOW_OWNER, 1_000)) {
    if (row.created_at < dayStart) continue;
    count++;
    try {
      const c = (JSON.parse(row.answer_json) as { costUsd?: unknown }).costUsd;
      if (typeof c === "number" && Number.isFinite(c) && c > 0) spentUsd += c;
    } catch {
      // allow-empty-catch: an unreadable record counts as a run with no recorded cost
    }
  }
  return { count, spentUsd };
}

/** Shadows started and not yet filed (they count against the caps). */
const inflight = { count: 0, reserveUsd: 0 };
const running = new Set<Promise<ShadowResult>>();

/**
 * Whether this filing gets a shadow: sampled, then under the day's count and
 * spend (filed plus in flight, with this run's estimate reserved) and the
 * world's daily cap. Pure apart from the injected readings.
 */
export function shadowGate(input: {
  settings: ShadowSettings;
  used: { count: number; spentUsd: number };
  pending: { count: number; reserveUsd: number };
  /** The expected cost of this run (the live answer's). */
  estimateUsd: number;
  draw: number;
  worldCap?: string;
}): { run: true } | { run: false; reason: string } {
  const { settings, used, pending } = input;
  if (!(input.draw < settings.rate)) return { run: false, reason: "not sampled" };
  if (used.count + pending.count >= settings.maxPerDay)
    return { run: false, reason: `daily shadow count reached (${settings.maxPerDay})` };
  if (used.spentUsd + pending.reserveUsd + Math.max(0, input.estimateUsd) > settings.capUsd)
    return { run: false, reason: `daily shadow spend cap reached ($${settings.capUsd})` };
  if (input.worldCap) return { run: false, reason: input.worldCap };
  return { run: true };
}

export type ShadowResult =
  | { status: "filed"; answerId: number; card: string; costUsd: number; isolation: ShadowIsolation }
  | { status: "dropped"; card: string; reason: string };

export type ShadowStart =
  | { started: false; reason: string }
  | { started: true; card: string; done: Promise<ShadowResult> };

/** What a shadow is filed against: a filed live answer, or a board answer filed later. */
interface ShadowTarget {
  kind: string;
  question: string;
  /** The live answer's subject when it pairs without a question id (`forecast:<id>`). */
  pair?: string;
  /** The live answer's id when it is already filed. */
  of?: number;
  externalId: string;
  /** False once there is nothing left to pair with (the live answer settled). */
  open: () => boolean;
}

/**
 * Start the shadow for a live answer just filed as `liveId`, when one was
 * planned and the gate lets it run. Returns at once; the run continues in the
 * background (`drainForecastShadows` waits for it). Never throws.
 */
export function startForecastShadow(
  db: MarinaDB,
  liveId: number | undefined,
  answer: unknown,
  opts: { draw?: number; now?: number } = {},
): ShadowStart {
  if (liveId === undefined) return { started: false, reason: "not filed" };
  const live = db.getForecastAnswer(liveId);
  return startShadow(db, answer, opts, () => {
    if (!live || live.resolved_at !== null) return "live answer settled";
    if (live.eval_mode === "measure") return "measurement run";
    if (live.entity_name === SHADOW_OWNER) return "a shadow";
    return {
      kind: live.kind,
      question: live.question,
      of: live.id,
      pair: `forecast:${live.id}`,
      externalId: shadowExternalId(live.id),
      open: () => db.getForecastAnswer(live.id)?.resolved_at === null,
    };
  });
}

/**
 * Start the shadow for a board answer that is filed only when it resolves
 * (FutureX files at learn time): the shadow is filed now, keyed by the board's
 * own id (`shadow:<key>#<filed at>`), and the adapter settles it with its live
 * answer (`settleBoardShadow`). The live answer must carry a question id, so
 * the two pair on `q:`. Same plan, sampling, caps and isolation as any shadow.
 */
export function startBoardShadow(
  db: MarinaDB,
  answer: unknown,
  key: string,
  opts: { draw?: number; now?: number } = {},
): ShadowStart {
  return startShadow(db, answer, opts, (plan, typed) => {
    if (!plan.routing.question) return "no question id to pair on";
    const at = opts.now ?? Date.now();
    let externalId = `shadow:${key}#${at}`;
    for (let n = 1; db.getForecastAnswerByExternalId(SHADOW_OWNER, externalId); n++)
      externalId = `shadow:${key}#${at}.${n}`;
    return {
      kind: typed.answer.type,
      question: typed.question,
      externalId,
      open: () => true,
    };
  });
}

/** Settle a board shadow on its live answer's resolution (once; superseded ones are skipped). */
export function settleBoardShadow(
  db: MarinaDB,
  shadowId: number,
  value: unknown,
  resolvedAt: number,
): boolean {
  const row = db.getForecastAnswer(shadowId);
  if (!row || row.entity_name !== SHADOW_OWNER || row.resolved_at !== null) return false;
  return !!resolveForecast(db, shadowId, value, resolvedAt);
}

/**
 * Close an open board shadow whose live answer was replaced before it was
 * submitted (a revised standing answer): settled `superseded`, unscored, no
 * outcome — it no longer pairs with what was filed.
 */
export function supersedeShadow(db: MarinaDB, shadowId: number, now = Date.now()): void {
  const row = db.getForecastAnswer(shadowId);
  if (!row || row.entity_name !== SHADOW_OWNER || row.resolved_at !== null) return;
  db.resolveForecastAnswer(shadowId, JSON.stringify({ superseded: true }), null, now);
}

function startShadow(
  db: MarinaDB,
  answer: unknown,
  opts: { draw?: number; now?: number },
  target: (plan: ShadowPlan, typed: TypedForecastAnswer) => ShadowTarget | string,
): ShadowStart {
  if (!answer || typeof answer !== "object") return { started: false, reason: "no answer" };
  const key = (answer as { typed?: object }).typed ?? answer;
  const plan = plans.get(answer as object) ?? plans.get(key);
  if (!plan) return { started: false, reason: "no plan" };
  plans.delete(answer as object);
  plans.delete(key);
  try {
    const settings = shadowSettingsFromEnv(plan.env);
    if (!settings) return { started: false, reason: "off" };
    const typed = key as TypedForecastAnswer;
    const t = target(plan, typed);
    if (typeof t === "string") return { started: false, reason: t };
    const card = pickShadowCard(plan.routing, plan.minN);
    if (!card?.formation) return { started: false, reason: "no challenger to explore" };
    const now = opts.now ?? Date.now();
    const estimateUsd = Number(typed.costUsd) || 0;
    const gate = shadowGate({
      settings,
      used: shadowUsage(db, now),
      pending: inflight,
      estimateUsd,
      draw: opts.draw ?? Math.random(),
      ...(dailyCapRefusal() ? { worldCap: dailyCapRefusal() } : {}),
    });
    if (!gate.run) return { started: false, reason: gate.reason };
    inflight.count++;
    inflight.reserveUsd += estimateUsd;
    const done = runShadow(db, t, plan, card, typed)
      .catch((err): ShadowResult => {
        logger.warn("forecast", "shadow challenger failed", {
          target: t.externalId,
          card: card.id,
          error: getErrorMessage(err),
        });
        return { status: "dropped", card: card.id, reason: getErrorMessage(err) };
      })
      .finally(() => {
        inflight.count--;
        inflight.reserveUsd = Math.max(0, inflight.reserveUsd - estimateUsd);
        running.delete(done);
      });
    running.add(done);
    return { started: true, card: card.id, done };
  } catch (err) {
    return { started: false, reason: getErrorMessage(err) };
  }
}

/** Wait for every shadow in flight (tests, a process about to exit). */
export async function drainForecastShadows(): Promise<ShadowResult[]> {
  return Promise.all([...running]);
}

async function runShadow(
  db: MarinaDB,
  target: ShadowTarget,
  plan: ShadowPlan,
  card: MethodCard,
  liveTyped: TypedForecastAnswer,
): Promise<ShadowResult> {
  const before = plan.costUsd();
  const isolation = await shadowIsolation(liveTyped.cutoff, card, plan.env);
  let deps = applyCard(plan.deps, card);
  if (isolation === "post-filtered") {
    const { strictDateFilter } = await import("../research/isolation");
    deps = { ...deps, retriever: strictDateFilter(deps.retriever) };
  }
  // The live answer's cutoff exactly: both cards see the same evidence window.
  const req: TypedForecastRequest = { ...plan.req, asOf: liveTyped.cutoff.at };
  const formed = await forecastFormed(req, deps, card.formation!);
  const costUsd = Math.max(0, plan.costUsd() - before);
  const routing = plan.routing;
  const models = [...new Set(formed.runs.map((r) => r.model).filter(Boolean))].slice(0, 4);
  const shadow = {
    ...(target.of !== undefined ? { of: target.of } : {}),
    card: card.id,
    live: routing.method,
    isolation,
    models,
    ...(routing.question || !target.pair ? {} : { pair: target.pair }),
  };
  const typed = {
    ...formed,
    costUsd,
    routing: {
      ...routing,
      picked: card.id,
      method: card.id,
      reason: `shadow of ${routing.method}`,
    },
  } as TypedForecastAnswer & { routing: CardRouting };
  // Settled while the shadow ran: there is nothing left to pair it with.
  if (!target.open())
    return { status: "dropped", card: card.id, reason: "live answer settled first" };
  const { fileAnswer, fileTypedAnswer } = await import("../outcomes/filing");
  const filing = {
    owner: SHADOW_OWNER,
    source: SHADOW_SOURCE,
    externalId: target.externalId,
    evalMode: "live" as const,
  };
  let answerId: number | undefined;
  if (target.kind === "probability" || target.kind === "number") {
    // A plain live answer: the shadow is filed plain too, so both score on one metric.
    const plain = { ...plainFromTyped(target.kind as ForecastKind, typed), shadow };
    if (target.kind === "probability" && plain.probability === undefined)
      return { status: "dropped", card: card.id, reason: "no probability" };
    answerId = fileAnswer(
      db,
      {
        question: target.question,
        kind: target.kind,
        ...(plain.probability !== undefined ? { probability: plain.probability } : {}),
        ...(plain.mean !== undefined ? { mean: plain.mean } : {}),
        ...(plain.sd !== undefined ? { sd: plain.sd } : {}),
        answer: plain,
      },
      filing,
    );
  } else {
    answerId = fileTypedAnswer(db, { ...typed, shadow } as TypedForecastAnswer, filing);
  }
  if (answerId === undefined) return { status: "dropped", card: card.id, reason: "not filed" };
  return { status: "filed", answerId, card: card.id, costUsd, isolation };
}
