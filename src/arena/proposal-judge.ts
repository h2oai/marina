// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The proposal judge (`MARINA_ARENA_PROPOSAL_JUDGE`): after a delphi or
 * symbiosis formation's final revisions, a decision model (Jev by default,
 * any Decisions-API model by `MARINA_ARENA_PROPOSAL_JUDGE_MODEL`) answers ONE
 * yes/no question per member proposal — is this member's move from the start
 * forecast supported by the VERIFIED dossier lines? — and that support:
 *
 *   - weights the centre: a weighted median of the members' moves, weights =
 *     the yes-probabilities renormalised (equal support ⇒ today's median);
 *   - scales the trust: DEFAULT_TRUST × agreement × mean support, so trust can
 *     only DROP versus the unjudged aggregation, never exceed it.
 *
 * Every other clamp stays (the 4-sd drop rule ran before; `settle` caps the
 * final move at MAX_FINAL_SD_MOVE). A proposal that did not move is supported
 * by definition (1) and is not asked about. No verified lines, no moving
 * proposal, or no judge ⇒ skipped, the result is today's exactly. A judge
 * failure on ANY member (outage, timeout, spend-cap refusal, malformed
 * answer) ⇒ fail OPEN to today's aggregation, recorded as `unavailable`.
 * `observe` judges and records what the judged forecast would have been,
 * without changing the filing. The record lands on the forecast as `judge`.
 */

import { DEFAULT_JUDGE_MODEL, researchJudge } from "../decisions/config";
import { noul } from "../decisions/questions";
import type { DecisionProvider } from "../decisions/types";
import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { ArenaRound, Distribution } from "./types";

export type ProposalJudgeMode = "on" | "observe" | "off";

/** What `composeForecastRound` hands a formation: the judge, its mode, and (added there) the verified lines. */
export interface ProposalJudgeConfig {
  mode: Exclude<ProposalJudgeMode, "off">;
  provider: DecisionProvider;
}

/** The audit record kept on the forecast (`forecast.judge`). */
export interface ProposalJudgeRecord {
  mode: Exclude<ProposalJudgeMode, "off">;
  /** `applied` (the filing uses it), `observed` (recorded only), `skipped`, `unavailable` (failed open). */
  status: "applied" | "observed" | "skipped" | "unavailable";
  provider: string;
  model: string;
  calibrated?: boolean;
  reason?: string;
  error?: string;
  calls: number;
  latencyMs: number;
  costUsd: number;
  /** Yes-probability per proposal key (1 for a proposal that did not move: not asked). */
  support?: Record<string, number>;
  meanSupport?: number;
  /** The unjudged aggregation (what the formation files without the judge). */
  unjudged?: { mean: number; sd: number; trust: number; move: number };
  /** The judged aggregation (filed when `applied`, recorded when `observed`). */
  judged?: { mean: number; sd: number; trust: number; move: number };
}

/** Patterns whose final aggregation the proposal judge weighs. */
export const PROPOSAL_JUDGED_PATTERNS = ["delphi", "symbiosis"] as const;

const MAX_EVIDENCE_CHARS = 4_000;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** `MARINA_ARENA_PROPOSAL_JUDGE`: `on` (default), `observe`, `off`. Anything else is `on`. */
export function proposalJudgeMode(env: NodeJS.ProcessEnv): ProposalJudgeMode {
  const raw = env.MARINA_ARENA_PROPOSAL_JUDGE?.trim().toLowerCase();
  return raw === "off" || raw === "observe" ? raw : "on";
}

/** `MARINA_ARENA_PROPOSAL_JUDGE_MODEL`, default `typesafe/jev-1.13`; `decisions` = the world's backend. */
export function proposalJudgeModel(env: NodeJS.ProcessEnv): string {
  return env.MARINA_ARENA_PROPOSAL_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
}

/**
 * The configured proposal judge, or undefined (off, or no reachable backend).
 * A model id goes to OpenRouter's Decisions API (needs `OPENROUTER_API_KEY`;
 * without one there is no judge — the formation files as today); `decisions`
 * uses the world's `MARINA_DECISIONS` backend (`researchJudge`). The provider
 * is metered: the daily spend cap refuses it, and its dollars are recorded.
 */
export function proposalJudgeFromEnv(env: NodeJS.ProcessEnv): ProposalJudgeConfig | undefined {
  const mode = proposalJudgeMode(env);
  if (mode === "off") return undefined;
  const model = proposalJudgeModel(env);
  const orKey = env.OPENROUTER_API_KEY?.trim() || undefined;
  const provider =
    model.toLowerCase() === "decisions"
      ? researchJudge("decisions", env, orKey)
      : orKey
        ? researchJudge("jev", env, orKey, 10_000, model)
        : undefined;
  return provider ? { mode, provider } : undefined;
}

/**
 * Weighted median: the smallest value whose cumulative weight passes half the
 * total; exactly half ⇒ the mean of it and the next (so equal weights give
 * the ordinary median). Non-positive weights are ignored; none positive ⇒
 * the unweighted median.
 */
export function weightedMedian(values: number[], weights: number[]): number {
  const pairs = values
    .map((v, i) => ({ v, w: weights[i] ?? 0 }))
    .filter((p) => Number.isFinite(p.w) && p.w > 0)
    .sort((a, b) => a.v - b.v);
  if (pairs.length === 0)
    return weightedMedian(
      values,
      values.map(() => 1),
    );
  const total = pairs.reduce((s, p) => s + p.w, 0);
  const half = total / 2;
  const eps = 1e-9 * total;
  let cum = 0;
  for (let i = 0; i < pairs.length; i++) {
    cum += pairs[i]!.w;
    if (Math.abs(cum - half) <= eps && i + 1 < pairs.length) {
      return (pairs[i]!.v + pairs[i + 1]!.v) / 2;
    }
    if (cum > half) return pairs[i]!.v;
  }
  return pairs.at(-1)!.v;
}

const SUPPORTED = noul(
  "The forecaster's move away from the start forecast is supported by the verified evidence lines.",
  {
    true: "A verified line reports a concrete, dated change or measurement that points the same direction as the move and plausibly justifies its size.",
    false:
      "No verified line bears on the move, a line points the other way, or the reason rests on extrapolation, mean reversion or facts not in the verified lines.",
  },
);

export interface ProposalForJudge {
  mean: number;
  sd: number;
  reason?: string;
}

/**
 * Ask the judge about every proposal that moved. Returns the support per key,
 * or the error (any failure ⇒ the whole judgement is unavailable).
 */
export async function judgeSupport(
  judge: DecisionProvider,
  round: Pick<ArenaRound, "question" | "unit">,
  base: Distribution,
  proposals: Record<string, ProposalForJudge>,
  reasons: Record<string, string>,
  verified: string,
): Promise<
  | { support: Record<string, number>; calls: number; latencyMs: number; costUsd: number }
  | { error: string; calls: number; latencyMs: number; costUsd: number }
> {
  const evidence = verified.trim().slice(0, MAX_EVIDENCE_CHARS);
  const support: Record<string, number> = {};
  let calls = 0;
  let latencyMs = 0;
  let costUsd = 0;
  const errors: string[] = [];
  await Promise.all(
    Object.entries(proposals).map(async ([key, p]) => {
      const move = p.mean - base.mean;
      if (move === 0) {
        support[key] = 1;
        return;
      }
      calls++;
      try {
        const result = await judge.ask({
          state: {
            question: round.question,
            ...(round.unit ? { unit: round.unit } : {}),
            start_forecast: { mean: base.mean, sd: base.sd },
            member_forecast: { mean: p.mean, sd: p.sd },
            move_from_start: `${move > 0 ? "up" : "down"} by ${round3(Math.abs(move))} (${round3(Math.abs(move) / base.sd)} start sds)`,
            member_reason: (reasons[key] ?? p.reason ?? "").slice(0, 600) || "(none stated)",
            verified_evidence: evidence,
          },
          questions: { supported: SUPPORTED },
        });
        latencyMs = Math.max(latencyMs, result.latencyMs ?? 0);
        costUsd += result.costUsd ?? 0;
        const a = result.answers.supported;
        if (a?.type !== "noul" || !Number.isFinite(a.noul)) {
          errors.push(`${key}: no noul answer`);
          return;
        }
        support[key] = Math.min(1, Math.max(0, a.noul));
      } catch (err) {
        errors.push(`${key}: ${getErrorMessage(err)}`.slice(0, 200));
      }
    }),
  );
  return errors.length
    ? { error: errors.join("; ").slice(0, 400), calls, latencyMs, costUsd }
    : { support, calls, latencyMs, costUsd };
}

/**
 * Weigh a formation's final proposals by judged support. `unjudged` is the
 * formation's own aggregation (median move, median sd, DEFAULT_TRUST ×
 * agreement); `settle` is the formation's shrink-and-cap step. Returns the
 * outcome to file and its audit record; anything but `applied` files
 * `unjudged` unchanged.
 */
export async function weighProposals(opts: {
  config: ProposalJudgeConfig;
  round: Pick<ArenaRound, "question" | "unit">;
  base: Distribution;
  proposals: Record<string, ProposalForJudge>;
  reasons?: Record<string, string>;
  verified: string | undefined;
  unjudged: { topline: Distribution; trust: number; move: number; sd: number };
  settle: (move: number, sd: number, trust: number) => Distribution;
}): Promise<{ topline: Distribution; trust: number; record: ProposalJudgeRecord }> {
  const { config, base, proposals, unjudged } = opts;
  const record: ProposalJudgeRecord = {
    mode: config.mode,
    status: "skipped",
    provider: config.provider.kind,
    model: config.provider.model,
    ...(config.provider.calibrated === undefined ? {} : { calibrated: config.provider.calibrated }),
    calls: 0,
    latencyMs: 0,
    costUsd: 0,
    unjudged: {
      mean: unjudged.topline.mean,
      sd: unjudged.topline.sd,
      trust: round3(unjudged.trust),
      move: round3(unjudged.move),
    },
  };
  const today = { topline: unjudged.topline, trust: unjudged.trust, record };
  const keys = Object.keys(proposals);
  if (!opts.verified?.trim())
    return { ...today, record: { ...record, reason: "no verified lines" } };
  if (keys.length === 0) return { ...today, record: { ...record, reason: "no proposals" } };
  if (keys.every((k) => proposals[k]!.mean === base.mean)) {
    return { ...today, record: { ...record, reason: "no proposal moved" } };
  }
  const judged = await judgeSupport(
    config.provider,
    opts.round,
    base,
    proposals,
    opts.reasons ?? {},
    opts.verified,
  );
  record.calls = judged.calls;
  record.latencyMs = judged.latencyMs;
  record.costUsd = Math.round(judged.costUsd * 1e6) / 1e6;
  if ("error" in judged) {
    new Logger().warn("arena", "proposal judge unavailable; unjudged aggregation filed", {
      model: config.provider.model,
      error: judged.error,
    });
    return { ...today, record: { ...record, status: "unavailable", error: judged.error } };
  }
  const support = Object.fromEntries(keys.map((k) => [k, round3(judged.support[k] ?? 1)]));
  const weights = keys.map((k) => judged.support[k] ?? 1);
  const meanSupport = weights.reduce((s, w) => s + w, 0) / weights.length;
  const move = weightedMedian(
    keys.map((k) => proposals[k]!.mean - base.mean),
    weights,
  );
  // Never above the unjudged trust: support only removes trust.
  const trust = Math.min(unjudged.trust, unjudged.trust * meanSupport);
  const topline = opts.settle(move, unjudged.sd, trust);
  record.support = support;
  record.meanSupport = round3(meanSupport);
  record.judged = { mean: topline.mean, sd: topline.sd, trust: round3(trust), move: round3(move) };
  if (config.mode === "observe") return { ...today, record: { ...record, status: "observed" } };
  return { topline, trust, record: { ...record, status: "applied" } };
}
