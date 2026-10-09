// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Judged resolution (`MARINA_OUTCOME_JUDGE=off|observe|on`, default off).
 * Most saved answers are never linked to a market, so nothing mechanical
 * ever settles them and they teach nothing. Past its end time (plus a grace
 * period), such an answer is researched after the fact and the configured
 * decision backend (Jev or any Jev-like engine) picks which option resolved
 * — numbers only, from dated evidence.
 *
 *   observe  the proposal is recorded as a judged outcome
 *            (`judged:forecast:<id>`): it settles nothing and teaches nothing,
 *            and is measured against a mechanical resolution if one comes.
 *   on       as observe; and when this judge has EARNED agreement
 *            (`judgeEarned`: ≥ 25 comparisons, Wilson lower bound ≥ 0.85) and
 *            is confident, it also settles the answer as a judged outcome
 *            that lessons and history learn from, labelled `judged`.
 *
 * Bounded per pass, stopped by the daily spend cap; no backend ⇒ nothing.
 * Choice answers only (one option resolves): the backend answers a choice
 * question over the answer's own options, plus "not resolved yet".
 */

import { type RetrieverKeys, retrieverFromSpec } from "../arena/research/retrieve";
import { harnessDecisionProvider } from "../decisions/engines";
import { choice } from "../decisions/questions";
import type { ChoiceAnswer, DecisionProvider } from "../decisions/types";
import { Logger } from "../engine/logger";
import { dailyCapRefusal } from "../engine/spend-ledger";
import { forecastRetrieverSpec } from "../forecast/retriever-default";
import type { TypedForecastAnswer } from "../forecast/typed";
import type { MarinaDB } from "../persistence/database";
import type { ForecastAnswerRow } from "../persistence/db-markets";
import { judgeEarned } from "./agreement";
import { proposeForecastResolution, resolveForecast } from "./forecast";

const logger = new Logger();

export type JudgeResolutionMode = "off" | "observe" | "on";

/** Time after an answer's end before it is judged (publication lag). */
export const JUDGE_GRACE_MS = 2 * 86_400_000;
/** Answers judged per pass. */
export const JUDGE_MAX_PER_PASS = 5;
/** An answer the judge found unresolved is not judged again for this long. */
export const JUDGE_RECHECK_MS = 86_400_000;
/** Confidence a judge needs to settle on its own (`on`, earned). */
export const JUDGE_MIN_CONFIDENCE = 0.9;
const UNRESOLVED = "not_resolved";

export function judgeResolutionMode(env: NodeJS.ProcessEnv = process.env): JudgeResolutionMode {
  const v = env.MARINA_OUTCOME_JUDGE?.trim().toLowerCase();
  return v === "observe" || v === "on" ? v : "off";
}

const recheck = new WeakMap<object, Map<number, number>>();

/** A typed choice answer past its end time, with nothing linked to settle it. */
function candidate(row: ForecastAnswerRow, now: number): TypedForecastAnswer | undefined {
  if (row.kind !== "choice") return undefined;
  let a: TypedForecastAnswer;
  try {
    a = JSON.parse(row.answer_json) as TypedForecastAnswer;
  } catch {
    return undefined;
  }
  if (a?.answer?.type !== "choice" || a.cutoff?.basis !== "endTime") return undefined;
  const end = Date.parse(a.cutoff.at);
  return Number.isFinite(end) && end + JUDGE_GRACE_MS <= now ? a : undefined;
}

export interface JudgeResolutionDeps {
  /** The decision backend (default: the harness's configured one). */
  judge?: DecisionProvider;
  /** Research after the fact (default: the forecast retriever). */
  retriever?: import("../arena/research/retrieve").Retriever;
  now?: () => number;
}

export interface JudgeResolutionReport {
  mode: JudgeResolutionMode;
  judged: number;
  proposed: number;
  settled: number;
  unresolved: number;
  failed: number;
  stoppedBy?: string;
}

export async function judgeOpenResolutions(
  db: MarinaDB,
  opts: { env?: NodeJS.ProcessEnv; max?: number } & JudgeResolutionDeps = {},
): Promise<JudgeResolutionReport> {
  const env = opts.env ?? process.env;
  const mode = judgeResolutionMode(env);
  const report: JudgeResolutionReport = {
    mode,
    judged: 0,
    proposed: 0,
    settled: 0,
    unresolved: 0,
    failed: 0,
  };
  if (mode === "off") return report;
  const judge = opts.judge ?? harnessDecisionProvider(env);
  if (!judge) {
    report.stoppedBy = "no decision backend";
    return report;
  }
  const judgeId = `${judge.kind}:${judge.model}`;
  const now = opts.now ?? Date.now;
  const seen = recheck.get(db) ?? new Map<number, number>();
  recheck.set(db, seen);
  let retriever = opts.retriever;
  for (const row of db.openUnlinkedForecasts(200)) {
    if (report.judged >= (opts.max ?? JUDGE_MAX_PER_PASS)) break;
    if (db.getOutcomeBySubject(`judged:forecast:${row.id}`)) continue;
    if ((seen.get(row.id) ?? 0) > now()) continue;
    const answer = candidate(row, now());
    if (answer?.answer.type !== "choice") continue;
    const capped = dailyCapRefusal(env);
    if (capped) {
      report.stoppedBy = capped;
      break;
    }
    report.judged++;
    try {
      retriever ??= retrieverFromSpec(forecastRetrieverSpec(env), keysFrom(env), { env });
      const end = answer.cutoff.at;
      const research = await retriever({
        roundId: `resolve:${row.id}`,
        since: end.slice(0, 10),
        request: [
          `How did this question resolve? Report only dated, sourced facts published after ${end.slice(0, 10)}.`,
          `Question: ${row.question}`,
          ...(answer.plan?.resolutionSource
            ? [`Resolution source: ${answer.plan.resolutionSource}`]
            : []),
          `Options: ${answer.answer.options.map((o) => o.label ?? o.id).join(" | ")}`,
        ].join("\n"),
        queries: [`${row.question} result`],
      });
      const options = Object.fromEntries([
        ...answer.answer.options.map((o) => [o.id, o.label ?? o.id] as const),
        [UNRESOLVED, "The evidence does not show that the question has resolved yet"] as const,
      ]);
      const result = await judge.ask({
        state: {
          question: row.question,
          ...(answer.plan?.resolutionSource
            ? { resolution_source: answer.plan.resolutionSource }
            : {}),
          ended: end,
          evidence: research.report.slice(0, 12_000),
        },
        questions: {
          resolution: choice(
            "Which option did this question resolve to, according to the evidence? Choose not_resolved unless the evidence states the outcome.",
            options,
          ),
        },
      });
      const picked = result.answers.resolution as ChoiceAnswer | undefined;
      if (!picked?.choice || picked.choice === UNRESOLVED || !(picked.choice in options)) {
        report.unresolved++;
        seen.set(row.id, now() + JUDGE_RECHECK_MS);
        continue;
      }
      const value = { option: picked.choice };
      if (proposeForecastResolution(db, row.id, value, now(), judgeId)) report.proposed++;
      const confidence = picked.confidence ?? picked.probabilities?.[picked.choice];
      if (
        mode === "on" &&
        (confidence ?? 0) >= JUDGE_MIN_CONFIDENCE &&
        judgeEarned(db, judgeId) &&
        resolveForecast(db, row.id, value, now(), {
          basis: "judged",
          judge: judgeId,
          deliverJudged: true,
          refs: [`judged:forecast:${row.id}`],
        })
      )
        report.settled++;
    } catch (err) {
      // An outage is no opinion: nothing recorded, tried again on a later pass.
      report.failed++;
      seen.set(row.id, now() + JUDGE_RECHECK_MS / 4);
      logger.warn("main", "judged resolution failed", {
        id: row.id,
        error: (err as Error).message,
      });
    }
  }
  return report;
}

function keysFrom(env: NodeJS.ProcessEnv): RetrieverKeys {
  return {
    ...(env.OPENROUTER_API_KEY?.trim() ? { openrouter: env.OPENROUTER_API_KEY.trim() } : {}),
    ...(env.TAVILY_API_KEY?.trim() ? { tavily: env.TAVILY_API_KEY.trim() } : {}),
    ...(env.EXA_API_KEY?.trim() ? { exa: env.EXA_API_KEY.trim() } : {}),
  };
}
