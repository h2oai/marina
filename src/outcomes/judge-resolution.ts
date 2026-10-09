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
 * Choice answers: a choice question over the answer's own options, plus
 * "not resolved yet". Multi-select: one yes/no per option behind a "has it
 * resolved" gate. Numbers: a model proposes the value with a verbatim quote,
 * the quote must be in the evidence and contain the number, and the judge
 * confirms it. Ranking and text answers are not judged.
 */

import { modelComplete } from "../arena/model-backend";
import { type RetrieverKeys, retrieverFromSpec } from "../arena/research/retrieve";
import { harnessDecisionProvider } from "../decisions/engines";
import { choice, noul } from "../decisions/questions";
import type { ChoiceAnswer, DecisionProvider, NoulAnswer } from "../decisions/types";
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

/** Kinds a judge can resolve. */
const JUDGED_KINDS = new Set(["choice", "multi", "number"]);
/** Options a multi-select answer may have and still be judged option by option. */
export const JUDGE_MAX_MULTI_OPTIONS = 30;

/** A typed answer past its end time, with nothing linked to settle it. */
function candidate(row: ForecastAnswerRow, now: number): TypedForecastAnswer | undefined {
  if (!JUDGED_KINDS.has(row.kind)) return undefined;
  let a: TypedForecastAnswer;
  try {
    a = JSON.parse(row.answer_json) as TypedForecastAnswer;
  } catch {
    return undefined;
  }
  if (a?.answer?.type !== row.kind || a.cutoff?.basis !== "endTime") return undefined;
  if (a.answer.type === "multi" && a.answer.options.length > JUDGE_MAX_MULTI_OPTIONS)
    return undefined;
  const end = Date.parse(a.cutoff.at);
  return Number.isFinite(end) && end + JUDGE_GRACE_MS <= now ? a : undefined;
}

export interface JudgeResolutionDeps {
  /** The decision backend (default: the harness's configured one). */
  judge?: DecisionProvider;
  /** Research after the fact (default: the forecast retriever). */
  retriever?: import("../arena/research/retrieve").Retriever;
  /**
   * Proposes a number's resolved value with a verbatim quote (numbers only;
   * default: `MARINA_OUTCOME_JUDGE_MODEL`, else the first forecast analyst,
   * else this Marina's `marina/default`). The judge then verifies it.
   */
  extractor?: (system: string, user: string) => Promise<string>;
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

/** A judge's resolution: the value to score with, and how sure it is (0–1). */
type Judged = { value: unknown; confidence: number | undefined } | undefined;

interface JudgeInput {
  row: ForecastAnswerRow;
  answer: TypedForecastAnswer;
  state: Record<string, unknown>;
  evidence: string;
  judge: DecisionProvider;
  extractor: () => (system: string, user: string) => Promise<string>;
}

/** One option resolved: a choice question over the options plus `not_resolved`. */
async function judgeChoice(i: JudgeInput): Promise<Judged> {
  if (i.answer.answer.type !== "choice") return undefined;
  const options = Object.fromEntries([
    ...i.answer.answer.options.map((o) => [o.id, o.label ?? o.id] as const),
    [UNRESOLVED, "The evidence does not show that the question has resolved yet"] as const,
  ]);
  const result = await i.judge.ask({
    state: i.state,
    questions: {
      resolution: choice(
        "Which option did this question resolve to, according to the evidence? Choose not_resolved unless the evidence states the outcome.",
        options,
      ),
    },
  });
  const picked = result.answers.resolution as ChoiceAnswer | undefined;
  if (!picked?.choice || picked.choice === UNRESOLVED || !(picked.choice in options))
    return undefined;
  return {
    value: { option: picked.choice },
    confidence: picked.confidence ?? picked.probabilities?.[picked.choice],
  };
}

/**
 * A set of options resolved: one yes/no per option, behind a "has it
 * resolved" gate. Confidence is the least sure of the answers.
 */
async function judgeMulti(i: JudgeInput): Promise<Judged> {
  if (i.answer.answer.type !== "multi") return undefined;
  const opts = i.answer.answer.options;
  const result = await i.judge.ask({
    state: i.state,
    questions: {
      resolved: noul("Does the evidence state how this question resolved?", {
        true: "the outcome is stated",
        false: "the outcome is not stated or not yet known",
      }),
      ...Object.fromEntries(
        opts.map((o, k) => [
          `option_${k}`,
          noul(
            `According to the evidence, is "${o.label ?? o.id}" among the options that resolved true?`,
          ),
        ]),
      ),
    },
  });
  const p = (key: string) => (result.answers[key] as NoulAnswer | undefined)?.noul;
  const gate = p("resolved");
  if (gate === undefined || gate < 0.5) return undefined;
  const ps = opts.map((_, k) => p(`option_${k}`));
  if (ps.some((x) => x === undefined)) return undefined;
  const picked = opts.filter((_, k) => ps[k]! >= 0.5).map((o) => o.id);
  if (picked.length === 0) return undefined;
  return {
    value: { options: picked },
    confidence: Math.min(gate, ...ps.map((x) => Math.max(x!, 1 - x!))),
  };
}

/** Digits of a number as text may write them (`1,234.5`, `1234.5`). */
function numberSpellings(n: number): string[] {
  const plain = String(n);
  return [...new Set([plain, n.toLocaleString("en-US", { maximumFractionDigits: 10 })])];
}

/**
 * A number: a model proposes the resolved value with a verbatim quote; the
 * quote must appear in the evidence and contain the number (mechanical),
 * and the judge must confirm the evidence states that value.
 */
async function judgeNumber(i: JudgeInput): Promise<Judged> {
  if (i.answer.answer.type !== "number") return undefined;
  const unit = i.answer.answer.unit ? ` (${i.answer.answer.unit})` : "";
  const reply = await i.extractor()(
    'You read evidence and report the value a question resolved to. Reply with ONE JSON object: {"value": <number or null>, "quote": "<the sentence from the evidence that states it, copied verbatim>"}. Use null unless the evidence states the resolved value.',
    `Question${unit}: ${i.row.question}\n\nEvidence:\n${i.evidence}`,
  );
  let parsed: { value?: unknown; quote?: unknown };
  try {
    parsed = JSON.parse(
      reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1),
    ) as typeof parsed;
  } catch {
    return undefined;
  }
  const value = typeof parsed.value === "number" ? parsed.value : Number.NaN;
  const quote = typeof parsed.quote === "string" ? parsed.quote.trim() : "";
  if (!Number.isFinite(value) || quote.length < 8 || !i.evidence.includes(quote)) return undefined;
  if (!numberSpellings(value).some((s) => quote.includes(s))) return undefined;
  const result = await i.judge.ask({
    state: { ...i.state, proposed_value: value, quote },
    questions: {
      confirmed: noul(`Does the evidence show that this question resolved to ${value}${unit}?`, {
        true: "the evidence states this resolved value",
        false: "it does not, or states another",
      }),
    },
  });
  const p = (result.answers.confirmed as NoulAnswer | undefined)?.noul;
  if (p === undefined || p < 0.5) return undefined;
  return { value: { value }, confidence: p };
}

function extractorFrom(env: NodeJS.ProcessEnv): (system: string, user: string) => Promise<string> {
  const spec =
    env.MARINA_OUTCOME_JUDGE_MODEL?.trim() ||
    env.MARINA_FORECAST_ANALYSTS?.split(",")[0]?.trim() ||
    "marina/default";
  return modelComplete(spec, env, { maxTokens: 400 }).complete;
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
  let extractor = opts.extractor;
  for (const row of db.openUnlinkedForecasts(200)) {
    if (report.judged >= (opts.max ?? JUDGE_MAX_PER_PASS)) break;
    if (db.getOutcomeBySubject(`judged:forecast:${row.id}`)) continue;
    if ((seen.get(row.id) ?? 0) > now()) continue;
    const answer = candidate(row, now());
    if (!answer) continue;
    const capped = dailyCapRefusal(env);
    if (capped) {
      report.stoppedBy = capped;
      break;
    }
    report.judged++;
    try {
      retriever ??= retrieverFromSpec(forecastRetrieverSpec(env), keysFrom(env), { env });
      const end = answer.cutoff.at;
      const spec = answer.answer;
      const research = await retriever({
        roundId: `resolve:${row.id}`,
        since: end.slice(0, 10),
        request: [
          `How did this question resolve? Report only dated, sourced facts published after ${end.slice(0, 10)}.`,
          `Question: ${row.question}`,
          ...(answer.plan?.resolutionSource
            ? [`Resolution source: ${answer.plan.resolutionSource}`]
            : []),
          ...("options" in spec
            ? [`Options: ${spec.options.map((o) => o.label ?? o.id).join(" | ")}`]
            : spec.type === "number" && spec.unit
              ? [`Unit: ${spec.unit}`]
              : []),
        ].join("\n"),
        queries: [`${row.question} result`],
      });
      const evidence = research.report.slice(0, 12_000);
      const input: JudgeInput = {
        row,
        answer,
        evidence,
        judge,
        state: {
          question: row.question,
          ...(answer.plan?.resolutionSource
            ? { resolution_source: answer.plan.resolutionSource }
            : {}),
          ended: end,
          evidence,
        },
        extractor: () => (extractor ??= extractorFrom(env)),
      };
      const judged =
        spec.type === "choice"
          ? await judgeChoice(input)
          : spec.type === "multi"
            ? await judgeMulti(input)
            : await judgeNumber(input);
      if (!judged) {
        report.unresolved++;
        seen.set(row.id, now() + JUDGE_RECHECK_MS);
        continue;
      }
      if (proposeForecastResolution(db, row.id, judged.value, now(), judgeId)) report.proposed++;
      if (
        mode === "on" &&
        (judged.confidence ?? 0) >= JUDGE_MIN_CONFIDENCE &&
        judgeEarned(db, judgeId) &&
        resolveForecast(db, row.id, judged.value, now(), {
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
