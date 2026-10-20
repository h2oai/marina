// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolving a filed forecast: the ONE place a `forecast_answers` row is
 * scored. Every surface that files an answer (the `forecast` command,
 * `POST /v1/forecast`, board adapters) resolves through `resolveForecast`
 * with the outcome as a resolver Sample's value would carry it, so the row is
 * settled once and one outcome is recorded for lessons and history to read.
 *
 * Scores: a probability by Brier against yes/no, a number by CRPS against the
 * value (needs its sd), a typed answer by `scoreTypedAnswer`. An outcome the
 * answer cannot be scored against leaves it open; an answer with no value is
 * settled with the outcome and no score, and records no outcome (nothing to
 * learn from).
 */

import {
  FORECAST_DAILY_CAP,
  independentParties,
  recordVerified,
  STANDING_AMOUNTS,
} from "../agent/standing";
import { crpsNormal } from "../arena/score";
import { routingRefs, SHADOW_OWNER, shadowExternalId } from "../forecast/routing-refs";
import type { TypedForecastAnswer } from "../forecast/typed";
import { scoreTypedAnswer } from "../forecast/typed-score";
import type { MarinaDB } from "../persistence/database";
import type { ForecastAnswerRow } from "../persistence/db-markets";
import type { OutcomeBasis, OutcomeInput } from "../persistence/db-outcomes";
import { participantOf } from "./live";
import { recordResolved } from "./record";

/** A resolution's yes/no (`{ outcome: "yes" | "no" }`), tolerantly. */
export function yesNoOf(value: unknown): "yes" | "no" | undefined {
  const outcome = (value as Record<string, unknown> | undefined)?.outcome;
  return outcome === "yes" || outcome === "no" ? outcome : undefined;
}

/** A numeric resolution: the value itself, or its `value` / `actual` field. */
export function numberOf(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "object" && value !== null
        ? ((value as Record<string, unknown>).value ?? (value as Record<string, unknown>).actual)
        : undefined;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

export interface ForecastResolution {
  answerId: number;
  /** The recorded outcome (absent when the answer had no value to score). */
  outcomeId?: number;
  loss: number | null;
  succeeded?: boolean;
  quality?: number;
}

interface Scored {
  outcomeJson: Record<string, unknown>;
  loss: number | null;
  /** Absent: settled without a score (no outcome is recorded). */
  learn?: {
    succeeded: boolean;
    quality?: number;
    metric: string;
    truth: unknown;
    detail: string;
  };
}

function score(f: ForecastAnswerRow, value: unknown): Scored | undefined {
  if (f.kind === "probability") {
    const outcome = yesNoOf(value);
    if (!outcome) return undefined;
    const y = outcome === "yes" ? 1 : 0;
    if (f.probability === null) return { outcomeJson: { outcome }, loss: null };
    const brier = (f.probability - y) ** 2;
    const correct = f.probability >= 0.5 === (outcome === "yes");
    return {
      outcomeJson: { outcome, brier, correct },
      loss: brier,
      learn: {
        succeeded: correct,
        quality: 1 - brier,
        metric: "brier",
        truth: { options: [outcome] },
        detail: `brier ${brier.toFixed(3)} (said ${Math.round(f.probability * 100)}%)`,
      },
    };
  }
  if (f.kind === "number") {
    const actual = numberOf(value);
    if (actual === undefined) return undefined;
    if (f.mean === null || f.sd === null) return { outcomeJson: { actual }, loss: null };
    const crps = crpsNormal(f.mean, f.sd, actual);
    const within80 = Math.abs(actual - f.mean) <= 1.2816 * f.sd;
    return {
      outcomeJson: { actual, crps, absError: Math.abs(actual - f.mean), within80 },
      loss: crps,
      learn: {
        succeeded: within80,
        metric: "crps",
        truth: { value: actual },
        detail: `${within80 ? "inside" : "outside"} the 80% band; error ${actual === 0 ? "n/a" : `${(((f.mean - actual) / Math.abs(actual)) * 100).toFixed(1)}%`}`,
      },
    };
  }
  let answer: TypedForecastAnswer;
  try {
    answer = JSON.parse(f.answer_json) as TypedForecastAnswer;
  } catch {
    return undefined;
  }
  if (!answer?.answer || answer.answer.type !== f.kind) return undefined;
  const r = scoreTypedAnswer(answer, value);
  if (!r) return undefined;
  return {
    outcomeJson: {
      outcome: r.outcome,
      metric: r.metric,
      quality: r.quality,
      correct: r.succeeded,
    },
    loss: r.loss,
    learn: {
      succeeded: r.succeeded,
      quality: r.quality,
      metric: r.metric,
      truth: Array.isArray(r.outcome) ? { options: r.outcome } : { value: r.outcome },
      detail: `${r.metric} loss ${r.loss.toFixed(3)}`,
    },
  };
}

function outcomeInput(
  f: ForecastAnswerRow,
  s: Scored & { learn: NonNullable<Scored["learn"]> },
  subject: string,
  resolvedAt: number,
  refs: string[],
  opts: { basis?: OutcomeBasis; judge?: string; participants?: unknown },
): OutcomeInput {
  return {
    subject,
    kind: "forecast",
    source:
      f.source && f.source !== "command" && f.source !== "api"
        ? `${f.source}:${f.kind}`
        : `forecast:${f.kind}`,
    domain: "forecast",
    owner: f.entity_name,
    succeeded: s.learn.succeeded,
    ...(s.learn.quality !== undefined ? { quality: s.learn.quality } : {}),
    ...(s.loss !== null ? { loss: s.loss } : {}),
    metric: s.learn.metric,
    truth: s.learn.truth,
    detail: s.learn.detail,
    basis: opts.basis ?? "mechanical",
    ...(opts.judge ? { judge: opts.judge } : {}),
    ...(f.eval_mode ? { evalMode: f.eval_mode } : {}),
    ...(opts.participants !== undefined ? { participants: opts.participants } : {}),
    refs,
    resolvedAt,
  };
}

/**
 * The residents or agents that produced an answer, as its filing recorded them
 * (`producers` on the stored answer; see `src/outcomes/filing.ts`). At most 8
 * names; the owner is not repeated.
 */
export function producersOf(f: Pick<ForecastAnswerRow, "answer_json" | "entity_name">): string[] {
  let raw: unknown;
  try {
    raw = (JSON.parse(f.answer_json) as { producers?: unknown } | null)?.producers;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string" || !p.trim()) continue;
    const name = p.trim();
    if (name.toLowerCase() === f.entity_name.toLowerCase()) continue;
    if (out.some((o) => o.toLowerCase() === name.toLowerCase())) continue;
    out.push(name);
    if (out.length >= 8) break;
  }
  return out;
}

/** Who did the forecasting: the owner, then its recorded producers (agent, model, role). */
function forecastParticipants(db: MarinaDB, f: ForecastAnswerRow) {
  const producers = producersOf(f);
  if (!producers.length && !/"producers"\s*:/.test(f.answer_json)) return undefined;
  return [f.entity_name, ...producers].map((name) => participantOf(db, name));
}

/**
 * Standing for a resolved forecast: everyone who produced it — the filer and
 * the residents or agents its filing names as producers — is paid by skill: a
 * probability by its Brier skill over a coin flip, a number when it fell in
 * its 80% band, a typed answer by its quality when correct — up to
 * `forecast_resolved` (0.5) each, at most FORECAST_DAILY_CAP credits per
 * account a UTC day, once per answer. One PARTY is considered once: a
 * producer in the lineage of a worker already considered for this answer (a
 * person and the agents it spawned) earns nothing, paid or refused — the
 * producer list is the filer's own claim, so this keeps `independentParties`
 * (one person cannot multiply one answer across its own agents). The
 * resolution must come from someone who may credit each worker: an external
 * resolver or judge (`resolvedBy` absent), or a resolver passing
 * `standingVerifierRefusal` (another account; an agent resolver inside the
 * worker's lineage has no grounding signal and pays nothing). An evaluation
 * filing (`eval_mode`) never earns, and nothing here reads or stores the
 * question.
 */
function creditResolvedForecast(
  db: MarinaDB,
  f: ForecastAnswerRow,
  learn: NonNullable<Scored["learn"]>,
  resolvedBy: string | undefined,
): void {
  if (f.eval_mode) return;
  const skill =
    f.kind === "probability" && learn.quality !== undefined
      ? Math.max(0, 1 - (1 - learn.quality) / 0.25)
      : learn.succeeded
        ? (learn.quality ?? 1)
        : 0;
  const amount = Number((STANDING_AMOUNTS.forecast_resolved * skill).toFixed(3));
  if (amount <= 0) return;
  // Parties already considered for this answer, paid or not: a worker's
  // lineage never collects what the worker itself was refused (cap, resolver).
  const seen: string[] = [];
  for (const worker of [f.entity_name, ...producersOf(f)]) {
    if (seen.some((c) => !independentParties(db, c, worker))) continue;
    seen.push(worker);
    const key = db.durableKeyForName(worker);
    if (!key) continue;
    const dayStart = new Date().setUTCHours(0, 0, 0, 0);
    if (db.countStandingEvents(key, "forecast_resolved", dayStart) >= FORECAST_DAILY_CAP) continue;
    recordVerified(db, {
      kind: "forecast_resolved",
      ref: `forecast:${f.id}`,
      worker: { name: worker },
      verifier: resolvedBy && resolvedBy !== "system" ? resolvedBy : null,
      amount,
    });
  }
}

/**
 * Score and settle one filed answer against its resolution, and record the
 * outcome. `value` is the resolution as a Sample's value carries it
 * (`{ outcome: "yes" }`, `{ option: "Home" }`, `{ value: 110 }`, …).
 * Undefined when the answer is unknown, already settled, or cannot be scored
 * against this value (it stays open). A `judged` settlement is delivered only
 * with `deliverJudged` (its judge has earned agreement); otherwise it is
 * recorded and teaches nothing.
 */
export function resolveForecast(
  db: MarinaDB,
  answerId: number,
  value: unknown,
  resolvedAt: number,
  opts: {
    refs?: string[];
    basis?: OutcomeBasis;
    judge?: string;
    participants?: unknown;
    deliverJudged?: boolean;
    /** Who settled the question when a person or agent did (an in-world market's resolver). */
    resolvedBy?: string;
  } = {},
): ForecastResolution | undefined {
  const f = db.getForecastAnswer(answerId);
  if (!f || f.resolved_at !== null) return undefined;
  const s = score(f, value);
  if (!s) return undefined;
  // The routing record's family / method / question tags, so evidence reads per (family, method).
  const refs = [
    ...new Set([`forecast:${f.id}`, ...(opts.refs ?? []), ...routingRefs(f.answer_json)]),
  ];
  if (
    !db.resolveForecastAnswer(f.id, JSON.stringify({ ...s.outcomeJson, refs }), s.loss, resolvedAt)
  )
    return undefined;
  if (!s.learn) {
    settleShadowOf(db, f, value, resolvedAt, opts);
    return { answerId: f.id, loss: s.loss };
  }
  const participants = opts.participants ?? forecastParticipants(db, f);
  const recorded = recordResolved(
    db,
    outcomeInput(
      f,
      s as Scored & { learn: NonNullable<Scored["learn"]> },
      `forecast:${f.id}`,
      resolvedAt,
      refs,
      { ...opts, ...(participants !== undefined ? { participants } : {}) },
    ),
    { deliverJudged: opts.deliverJudged === true },
  );
  if (recorded.created && (opts.basis !== "judged" || opts.deliverJudged === true))
    creditResolvedForecast(db, f, s.learn, opts.resolvedBy);
  settleShadowOf(db, f, value, resolvedAt, opts);
  return {
    answerId: f.id,
    outcomeId: recorded.id,
    loss: s.loss,
    succeeded: s.learn.succeeded,
    ...(s.learn.quality !== undefined ? { quality: s.learn.quality } : {}),
  };
}

/**
 * A shadow challenger filed against this answer (`src/forecast/shadow.ts`)
 * settles with it, on the same value and basis, through this same path: its
 * own outcome (tagged `shadow`, its card and models) teaches lessons and
 * writes history like any other; as an `eval_mode` filing it earns no standing.
 * None of the live answer's board refs are copied onto it.
 */
function settleShadowOf(
  db: MarinaDB,
  f: ForecastAnswerRow,
  value: unknown,
  resolvedAt: number,
  opts: { basis?: OutcomeBasis; judge?: string; deliverJudged?: boolean },
): void {
  if (f.entity_name === SHADOW_OWNER) return;
  const shadow = db.getForecastAnswerByExternalId(SHADOW_OWNER, shadowExternalId(f.id));
  if (!shadow || shadow.resolved_at !== null) return;
  resolveForecast(db, shadow.id, value, resolvedAt, {
    ...(opts.basis ? { basis: opts.basis } : {}),
    ...(opts.judge ? { judge: opts.judge } : {}),
    ...(opts.deliverJudged ? { deliverJudged: true } : {}),
  });
}

/**
 * A judge's proposed resolution of an open answer, recorded as a JUDGED
 * outcome (`judged:forecast:<id>`) without settling the answer: an opinion
 * that teaches nothing, measured against the mechanical resolution if one
 * comes (`judgeAgreement`). Once per answer. Undefined when the proposal
 * cannot be scored against the answer.
 */
export function proposeForecastResolution(
  db: MarinaDB,
  answerId: number,
  value: unknown,
  at: number,
  judge: string,
): { outcomeId: number; succeeded: boolean } | undefined {
  const f = db.getForecastAnswer(answerId);
  if (!f) return undefined;
  const s = score(f, value);
  if (!s?.learn) return undefined;
  const recorded = recordResolved(
    db,
    outcomeInput(
      f,
      s as Scored & { learn: NonNullable<Scored["learn"]> },
      `judged:forecast:${f.id}`,
      at,
      [`forecast:${f.id}`],
      {
        basis: "judged",
        judge,
      },
    ),
  );
  return { outcomeId: recorded.id, succeeded: s.learn.succeeded };
}
