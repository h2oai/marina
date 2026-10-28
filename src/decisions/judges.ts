// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One judge service. Every judge surface records its opinions — and, once
 * known, their ground truth — in ONE ledger (`judge_ledger`, migration 179),
 * asks ONE earned rule over it (`judgeEarned` → `earnedJudge`), takes its
 * mode from ONE flag (`MARINA_JUDGE`, the legacy per-surface variables
 * overriding it), and is read through ONE readout (`judge stats`).
 *
 * Surfaces (`surface` column):
 *  - `challenge`        the challenge judge's shadow call on a held action
 *                       (allow = pass) against the person's answer; counted
 *                       per class (`question`) as PRECISION OF ALLOW — the
 *                       only call it ever acts on.
 *  - `verify`           the submission verifier's opinion against the task
 *                       creator's verdict (latest opinion per attempt).
 *  - `attention:<kind>` the attention judges, against their mechanical result.
 *  - `outcome`          every other judged outcome (`judged:<subject>` — judged
 *                       resolutions, judged quality, the verifier's opinion on
 *                       the outcome path) against the mechanical outcome for
 *                       the same subject.
 *  - `arbiter`          the Arbiter's overrules against the resolved truth
 *                       (right = beat the majority). Recorded for the
 *                       readout; the Arbiter keeps its own bar (precision ≥
 *                       `MARINA_ARBITER_EARN_MIN_PRECISION` over ≥
 *                       `…_MIN_RESOLVED`) read from as-of-fenced forecast
 *                       history, because a backtest must not see a later
 *                       resolution.
 *
 * Agreement is counted per surface and judge (and per question where a
 * surface has them); unrelated questions are never pooled. A judge earns only
 * from opinions with a ground truth. Nothing here acts: each surface keeps
 * its own never/always rules and asks `judgeEarned` before an earned action.
 */

import { availableModels } from "../agent/available-models";
import { tryLog } from "../engine/errors";
import { Logger } from "../engine/logger";
import { arbiterPolicyFromEnv } from "../orchestration/arbiter";
import type { MarinaDB } from "../persistence/database";
import type { JudgeLedgerTally, JudgeOpinionInput } from "../persistence/db-judge-ledger";
import { EARNED_JUDGE_MIN_LOWER, EARNED_JUDGE_MIN_N, earnedJudge } from "./earned-judge";

const logger = new Logger();

export type JudgeMode = "off" | "observe" | "on";

/** The surfaces a mode switch governs (attention covers every attention judge). */
export type JudgeModeSurface = "challenge" | "verify" | "attention" | "outcome";

interface SurfaceSwitch {
  legacy: string;
  fallback: JudgeMode | ((env: NodeJS.ProcessEnv) => JudgeMode);
  /** The legacy variable's own parse, exactly as before the one flag. */
  parse(v: string): JudgeMode;
}

const onOffElseObserve = (v: string): JudgeMode => (v === "on" || v === "off" ? v : "observe");

export const JUDGE_SURFACE_SWITCHES: Readonly<Record<JudgeModeSurface, SurfaceSwitch>> = {
  challenge: { legacy: "MARINA_CHALLENGE_JUDGE", fallback: "observe", parse: onOffElseObserve },
  verify: { legacy: "MARINA_DECISION_VERIFY", fallback: "observe", parse: onOffElseObserve },
  attention: { legacy: "MARINA_ATTENTION_JUDGE", fallback: "observe", parse: onOffElseObserve },
  // Unset: on when this installation has a model provider to judge with,
  // else off (the same rule as MARINA_LESSONS_FROM_WORK).
  outcome: {
    legacy: "MARINA_OUTCOME_JUDGE",
    fallback: (env) => (availableModels(env).length > 0 ? "on" : "off"),
    parse: (v) => (v === "observe" || v === "on" ? v : "off"),
  },
};

export interface ResolvedJudgeMode {
  mode: JudgeMode;
  /** Where it came from: the surface's own variable, `MARINA_JUDGE`, or the surface default. */
  from: "legacy" | "judge" | "default";
  /** The variable that set it (the legacy name, `MARINA_JUDGE`, or none). */
  variable?: string;
}

/** `MARINA_JUDGE` when it names a mode; junk is ignored. */
export function oneJudgeFlag(env: NodeJS.ProcessEnv = process.env): JudgeMode | undefined {
  const v = env.MARINA_JUDGE?.trim().toLowerCase();
  return v === "off" || v === "observe" || v === "on" ? v : undefined;
}

/**
 * A surface's mode: its legacy variable when set (parsed exactly as before),
 * else `MARINA_JUDGE`, else the surface's default — so with neither set,
 * every surface behaves as it did before the one flag.
 */
export function judgeModeFor(
  surface: JudgeModeSurface,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedJudgeMode {
  const sw = JUDGE_SURFACE_SWITCHES[surface];
  const legacy = env[sw.legacy]?.trim().toLowerCase();
  if (legacy) return { mode: sw.parse(legacy), from: "legacy", variable: sw.legacy };
  const one = oneJudgeFlag(env);
  if (one) return { mode: one, from: "judge", variable: "MARINA_JUDGE" };
  const mode = typeof sw.fallback === "function" ? sw.fallback(env) : sw.fallback;
  return { mode, from: "default" };
}

// ─── Writing ────────────────────────────────────────────────────────────────

type LedgerDb = Pick<MarinaDB, "recordJudgeOpinion" | "findJudgeTruth" | "settleJudgeTruth">;

/**
 * THE write: one opinion into the ledger. When the truth is not given and the
 * mechanical result already exists (an outcome recorded before the judge
 * looked), it is settled at once. Never throws: the ledger is measurement,
 * never a reason for the judged work to fail.
 */
export function recordJudgeOpinion(db: LedgerDb, input: JudgeOpinionInput): void {
  // A partial store (a test double, a script's narrow slice) keeps no ledger.
  if (typeof db.recordJudgeOpinion !== "function") return;
  tryLog(logger, "decisions", "Judge opinion not recorded", () => {
    db.recordJudgeOpinion(input);
    if (input.truth !== undefined || !input.truthKey || input.opinion === "none") return;
    const t = db.findJudgeTruth(input.truthKey, input.opinedAt);
    if (t)
      db.settleJudgeTruth({
        subject: t.subject,
        succeeded: t.succeeded === 1,
        truthJson: t.truth_json,
        resolvedAt: t.resolved_at,
      });
  });
}

/** The ledger surface of a judged outcome, by its source. */
export function surfaceOfJudgedOutcome(source: string): string {
  return source.startsWith("attention-judge:")
    ? `attention:${source.slice("attention-judge:".length)}`
    : "outcome";
}

/** What a judged outcome subject (`judged:<base>`) is settled by. */
export function truthKeyOfJudged(subject: string): string {
  const base = subject.slice("judged:".length);
  if (/:submission:\d+$/.test(base)) return base;
  // A task attempt (`task:<id>:<claimant>:<t>`): its first verdict after the opinion.
  return base.startsWith("task:") ? base.replace(/\d+$/, "") : base;
}

/** A judged outcome as a ledger opinion (called by `recordResolved`). */
export function recordJudgedOutcome(
  db: LedgerDb,
  o: {
    subject: string;
    kind: string;
    source: string;
    succeeded: boolean;
    judge?: string | null;
    truth?: unknown;
    resolvedAt: number;
  },
): void {
  if (!o.subject.startsWith("judged:")) return;
  recordJudgeOpinion(db, {
    surface: surfaceOfJudgedOutcome(o.source),
    question: o.kind,
    judge: o.judge ?? "unknown",
    subject: o.subject,
    truthKey: truthKeyOfJudged(o.subject),
    opinion: o.succeeded ? "pass" : "fail",
    ...(o.kind === "forecast"
      ? { opinionValue: o.truth === undefined ? "" : JSON.stringify(o.truth) }
      : {}),
    opinedAt: o.resolvedAt,
  });
}

/** A mechanical result settles every opinion waiting on it (called by `recordResolved`). */
export function settleJudgedTruth(
  db: Pick<MarinaDB, "settleJudgeTruth">,
  o: { subject: string; succeeded: boolean; truth?: unknown; resolvedAt: number },
): void {
  if (typeof db.settleJudgeTruth !== "function") return;
  tryLog(logger, "decisions", "Judge truth not settled", () =>
    db.settleJudgeTruth({
      subject: o.subject,
      succeeded: o.succeeded,
      truthJson: o.truth === undefined ? "" : JSON.stringify(o.truth),
      resolvedAt: o.resolvedAt,
    }),
  );
}

// ─── The earned rule ────────────────────────────────────────────────────────

/** Which count a surface earns on. */
export type JudgeRule = "agreement" | "precision-of-allow" | "arbiter-precision";

export function ruleOf(surface: string): JudgeRule {
  if (surface === "challenge") return "precision-of-allow";
  if (surface === "arbiter") return "arbiter-precision";
  return "agreement";
}

/** The comparisons a tally earns on under its surface's rule. */
export function earnedCounts(t: JudgeLedgerTally): { agreed: number; compared: number } {
  return ruleOf(t.surface) === "precision-of-allow"
    ? { agreed: t.passAgreed ?? 0, compared: t.passCompared ?? 0 }
    : { agreed: t.agreed ?? 0, compared: t.compared ?? 0 };
}

export interface JudgeStanding {
  surface: string;
  question: string;
  judge: string;
  rule: JudgeRule;
  opinions: number;
  noOpinion: number;
  awaiting: number;
  /** Comparisons with a ground truth under the surface's rule. */
  compared: number;
  agreed: number;
  falsePass: number;
  falseFail: number;
  calibrated: boolean | undefined;
  /** Wilson 95 % lower bound (`earnedJudge`). */
  lower: number;
  earned: boolean;
  /** More observations needed at the current agreement rate; 0 when earned, undefined when the rate can never earn. */
  needed: number | undefined;
}

/** More comparisons needed for `earnedJudge` if they agree at the current rate (≤ 10 000). */
export function moreNeededAtRate(agreed: number, compared: number): number | undefined {
  if (earnedJudge(agreed, compared).earned) return 0;
  const rate = compared > 0 ? agreed / compared : 1;
  if (rate < EARNED_JUDGE_MIN_LOWER) return undefined;
  for (let m = 1; m <= 10_000; m++)
    if (earnedJudge(agreed + rate * m, compared + m).earned) return m;
  return undefined;
}

function standingOf(t: JudgeLedgerTally, env: NodeJS.ProcessEnv): JudgeStanding {
  const rule = ruleOf(t.surface);
  const { agreed, compared } = earnedCounts(t);
  let { lower, earned } = earnedJudge(agreed, compared);
  let needed = moreNeededAtRate(agreed, compared);
  if (rule === "arbiter-precision") {
    const { minResolved, minPrecision } = arbiterPolicyFromEnv(env).earn;
    const precision = compared ? Math.round((agreed / compared) * 1000) / 1000 : 0;
    earned = compared >= minResolved && precision >= minPrecision;
    lower = precision;
    needed = earned
      ? 0
      : precision >= minPrecision || compared === 0
        ? minResolved - compared
        : undefined;
  }
  return {
    surface: t.surface,
    question: t.question,
    judge: t.judge,
    rule,
    opinions: t.opinions,
    noOpinion: t.noOpinion ?? 0,
    awaiting: t.awaiting ?? 0,
    compared,
    agreed,
    falsePass: t.falsePass ?? 0,
    falseFail: t.falseFail ?? 0,
    calibrated: t.calibrated === null ? undefined : t.calibrated === 1,
    lower,
    earned,
    needed,
  };
}

type TallyDb = Pick<MarinaDB, "judgeLedgerTallies">;

/** Surfaces whose agreement is counted per question. */
const BY_QUESTION = new Set(["challenge"]);

/**
 * Every judge's standing, per surface and judge (and question where the
 * surface has them). `surface` ending in `:` is a prefix (`attention:`).
 */
export function judgeStandings(
  db: TallyDb,
  opts: { surface?: string; judge?: string; env?: NodeJS.ProcessEnv } = {},
): JudgeStanding[] {
  const env = opts.env ?? process.env;
  const byQ = db.judgeLedgerTallies({
    ...(opts.surface ? { surface: opts.surface } : {}),
    ...(opts.judge ? { judge: opts.judge } : {}),
    byQuestion: true,
  });
  const pooled = db.judgeLedgerTallies({
    ...(opts.surface ? { surface: opts.surface } : {}),
    ...(opts.judge ? { judge: opts.judge } : {}),
  });
  return [
    ...byQ.filter((t) => BY_QUESTION.has(t.surface)),
    ...pooled.filter((t) => !BY_QUESTION.has(t.surface)),
  ].map((t) => standingOf(t, env));
}

/**
 * THE question every surface asks before an earned action: has `judge`
 * earned it on `surface` (and `question`, for a surface counted per
 * question)? `earnedJudge` over the ledger's comparisons with a ground truth.
 */
export function judgeEarned(
  db: TallyDb,
  surface: string,
  judge: string,
  opts: { question?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  try {
    const [t] = db.judgeLedgerTallies({
      surface,
      judge,
      ...(opts.question !== undefined ? { question: opts.question } : {}),
    });
    return t ? standingOf(t, opts.env ?? process.env).earned : false;
  } catch {
    // allow-empty-catch: an unreadable ledger earns nothing (fail closed).
    return false;
  }
}

export { EARNED_JUDGE_MIN_LOWER, EARNED_JUDGE_MIN_N };
