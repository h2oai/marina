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
 *
 * Profile rounds (`weighProfileProposals`): the same rule, cell by cell. Each
 * member is asked ONE call (up to 16 cells a call — the decision API's
 * question limit — so a 16-cell crosstab is one call per member) with one
 * yes/no question per cell it moved; support therefore differs by cell. Per
 * cell: weighted median of the members' moves on that cell, trust = that
 * cell's unjudged trust × its mean support (never above it). Any failure on
 * any call fails the WHOLE profile open to the unjudged aggregation.
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
  /** Profile rounds: the judgement per cell (support per proposal key, both aggregations). */
  cells?: Record<string, ProfileCellJudgement>;
}

/** One profile cell's judgement (`weighProfileProposals`). */
export interface ProfileCellJudgement {
  /** Yes-probability per proposal key that answered the cell (1 = did not move it). */
  support: Record<string, number>;
  meanSupport: number;
  unjudged: { mean: number; sd: number; trust: number; move: number };
  judged: { mean: number; sd: number; trust: number; move: number };
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

/** The decision API's limit on questions per request (`questions.ts`). */
export const MAX_CELLS_PER_CALL = 16;

const cellQuestion = (cell: string) =>
  noul(
    `The forecaster's move of cell "${cell.slice(0, 120)}" away from its start forecast is supported by the verified evidence lines.`,
    {
      true: "A verified line reports a concrete, dated change or measurement for this cell (or the group or item it names) that points the same direction as the move and plausibly justifies its size.",
      false:
        "No verified line bears on this cell's move, a line points the other way, or the reason rests on extrapolation, mean reversion or facts not in the verified lines.",
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

/** A whole-profile proposal as the judge reads it. */
export interface ProfileProposalForJudge {
  profile: Record<string, Distribution>;
  reason?: string;
}

/**
 * Ask the judge about every cell each proposal moved: one call per proposal
 * (chunked at `MAX_CELLS_PER_CALL` cells), one yes/no question per moved cell.
 * Returns the support per key per cell (1 for a cell the proposal answered
 * but did not move), or the error — any failure ⇒ the whole judgement is
 * unavailable.
 */
export async function judgeProfileSupport(
  judge: DecisionProvider,
  round: Pick<ArenaRound, "question" | "unit">,
  cells: string[],
  base: Record<string, Distribution>,
  proposals: Record<string, ProfileProposalForJudge>,
  verified: string,
): Promise<
  | {
      support: Record<string, Record<string, number>>;
      calls: number;
      latencyMs: number;
      costUsd: number;
    }
  | { error: string; calls: number; latencyMs: number; costUsd: number }
> {
  const evidence = verified.trim().slice(0, MAX_EVIDENCE_CHARS);
  const support: Record<string, Record<string, number>> = {};
  let calls = 0;
  let latencyMs = 0;
  let costUsd = 0;
  const errors: string[] = [];
  const asks: Array<Promise<void>> = [];
  for (const [key, p] of Object.entries(proposals)) {
    const mine: Record<string, number> = {};
    support[key] = mine;
    const moved: string[] = [];
    for (const c of cells) {
      const d = p.profile[c];
      const b = base[c];
      if (!d || !b) continue;
      if (d.mean === b.mean) mine[c] = 1;
      else moved.push(c);
    }
    for (let i = 0; i < moved.length; i += MAX_CELLS_PER_CALL) {
      const chunk = moved.slice(i, i + MAX_CELLS_PER_CALL);
      calls++;
      asks.push(
        (async () => {
          try {
            const result = await judge.ask({
              state: {
                question: round.question,
                ...(round.unit ? { unit: round.unit } : {}),
                member_reason: (p.reason ?? "").slice(0, 600) || "(none stated)",
                cells: chunk.map((c, j) => {
                  const b = base[c]!;
                  const d = p.profile[c]!;
                  const move = d.mean - b.mean;
                  return {
                    question_id: `cell_${j + 1}`,
                    cell: c,
                    start_forecast: { mean: b.mean, sd: b.sd },
                    member_forecast: { mean: d.mean, sd: d.sd },
                    move_from_start: `${move > 0 ? "up" : "down"} by ${round3(Math.abs(move))} (${round3(Math.abs(move) / b.sd)} start sds)`,
                  };
                }),
                verified_evidence: evidence,
              },
              questions: Object.fromEntries(
                chunk.map((c, j) => [`cell_${j + 1}`, cellQuestion(c)]),
              ),
            });
            latencyMs = Math.max(latencyMs, result.latencyMs ?? 0);
            costUsd += result.costUsd ?? 0;
            chunk.forEach((c, j) => {
              const a = result.answers[`cell_${j + 1}`];
              if (a?.type !== "noul" || !Number.isFinite(a.noul)) {
                errors.push(`${key}/${c}: no noul answer`.slice(0, 200));
                return;
              }
              mine[c] = Math.min(1, Math.max(0, a.noul));
            });
          } catch (err) {
            errors.push(`${key}: ${getErrorMessage(err)}`.slice(0, 200));
          }
        })(),
      );
    }
  }
  await Promise.all(asks);
  return errors.length
    ? { error: errors.join("; ").slice(0, 400), calls, latencyMs, costUsd }
    : { support, calls, latencyMs, costUsd };
}

/**
 * Weigh a profile formation's final proposals by judged support, cell by
 * cell. `unjudged` is the formation's own per-cell aggregation (median move,
 * median sd, its per-cell trust); `settle` is the shrink-and-cap step for one
 * cell. Anything but `applied` files `unjudged` unchanged.
 */
export async function weighProfileProposals(opts: {
  config: ProposalJudgeConfig;
  round: Pick<ArenaRound, "question" | "unit">;
  cells: string[];
  base: Record<string, Distribution>;
  proposals: Record<string, ProfileProposalForJudge>;
  verified: string | undefined;
  unjudged: { profile: Record<string, Distribution>; trust: Record<string, number> };
  settle: (cell: string, move: number, sd: number, trust: number) => Distribution;
}): Promise<{
  profile: Record<string, Distribution>;
  trust: Record<string, number>;
  record: ProposalJudgeRecord;
}> {
  const { config, cells, base, proposals, unjudged } = opts;
  const record: ProposalJudgeRecord = {
    mode: config.mode,
    status: "skipped",
    provider: config.provider.kind,
    model: config.provider.model,
    ...(config.provider.calibrated === undefined ? {} : { calibrated: config.provider.calibrated }),
    calls: 0,
    latencyMs: 0,
    costUsd: 0,
  };
  const today = { profile: unjudged.profile, trust: unjudged.trust, record };
  const keys = Object.keys(proposals);
  if (!opts.verified?.trim())
    return { ...today, record: { ...record, reason: "no verified lines" } };
  if (keys.length === 0) return { ...today, record: { ...record, reason: "no proposals" } };
  const moved = keys.some((k) =>
    cells.some((c) => {
      const d = proposals[k]!.profile[c];
      return d !== undefined && base[c] !== undefined && d.mean !== base[c]!.mean;
    }),
  );
  if (!moved) return { ...today, record: { ...record, reason: "no proposal moved" } };
  const judged = await judgeProfileSupport(
    config.provider,
    opts.round,
    cells,
    base,
    proposals,
    opts.verified,
  );
  record.calls = judged.calls;
  record.latencyMs = judged.latencyMs;
  record.costUsd = Math.round(judged.costUsd * 1e6) / 1e6;
  if ("error" in judged) {
    new Logger().warn("arena", "proposal judge unavailable; unjudged profile filed", {
      model: config.provider.model,
      error: judged.error,
    });
    return { ...today, record: { ...record, status: "unavailable", error: judged.error } };
  }
  const profile: Record<string, Distribution> = { ...unjudged.profile };
  const trust: Record<string, number> = { ...unjudged.trust };
  const perCell: Record<string, ProfileCellJudgement> = {};
  const all: number[] = [];
  for (const c of cells) {
    const b = base[c];
    const on = keys.filter((k) => proposals[k]!.profile[c] !== undefined);
    if (!b || on.length === 0) continue;
    const weights = on.map((k) => judged.support[k]?.[c] ?? 1);
    all.push(...weights);
    const ms = weights.reduce((s, w) => s + w, 0) / weights.length;
    const moves = on.map((k) => proposals[k]!.profile[c]!.mean - b.mean);
    const sds = on.map((k) => proposals[k]!.profile[c]!.sd);
    const t0 = unjudged.trust[c] ?? 0;
    const t = Math.min(t0, t0 * ms);
    const move = weightedMedian(moves, weights);
    const sd = weightedMedian(
      sds,
      sds.map(() => 1),
    );
    const d = opts.settle(c, move, sd, t);
    const u = unjudged.profile[c] ?? b;
    perCell[c] = {
      support: Object.fromEntries(on.map((k, i) => [k, round3(weights[i]!)])),
      meanSupport: round3(ms),
      unjudged: { mean: u.mean, sd: u.sd, trust: round3(t0), move: round3(u.mean - b.mean) },
      judged: { mean: d.mean, sd: d.sd, trust: round3(t), move: round3(move) },
    };
    profile[c] = d;
    trust[c] = t;
  }
  const keySupport = Object.fromEntries(
    keys.map((k) => {
      const vs = Object.values(judged.support[k] ?? {});
      return [k, round3(vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : 1)];
    }),
  );
  record.support = keySupport;
  record.meanSupport = round3(all.length ? all.reduce((s, w) => s + w, 0) / all.length : 1);
  record.cells = perCell;
  if (config.mode === "observe") return { ...today, record: { ...record, status: "observed" } };
  return { profile, trust, record: { ...record, status: "applied" } };
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
