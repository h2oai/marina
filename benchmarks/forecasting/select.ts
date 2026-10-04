// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Choosing a forecasting configuration by a held-out backtest: every
 * candidate forecasts the same RESOLVED questions as of their original
 * forecast date (evidence frozen there, retrieval strictly date-filtered),
 * in replicates; each run is filed in the benchmark ledger; the candidates
 * are ranked by their pooled score with a paired comparison against the
 * leader; the best `pick` within the live budget are chosen.
 *
 * Leakage guards:
 *   model weights — a candidate is scored only on questions whose forecast
 *                   date is at least `lagDays` after every one of its models'
 *                   public release (an upper bound on its knowledge cutoff);
 *                   a candidate released too recently for `minItems` such
 *                   questions is reported as not yet backtestable, never
 *                   scored on older ones;
 *   retrieval     — the caller's forecaster wraps research in the strict
 *                   pre-cutoff filter;
 *   memory        — lessons are visible only once their outcome was known
 *                   (`visibleAt`) at each question's own cutoff;
 *   crews         — a `marina:<crew>` analyst has its own tools and cannot be
 *                   isolated, so a crew configuration is never backtested
 *                   (it can still be chosen by hand, disclosed as such).
 *
 * Statistics: per item, a candidate's score is the mean over its replicates;
 * the pooled score is the mean over the common items. Against the leader a
 * two-stage (cluster) bootstrap resamples each candidate's replicate runs,
 * then the items, and reports the 95 % interval of the paired difference —
 * run-to-run variance is part of the answer.
 */

import { randomUUID } from "node:crypto";
import type { IsolationLevel } from "../../src/arena/research/isolation";
import { answerDigest, ledgerFromHarnessResult } from "../../src/engine/benchmark-ledger";
import { SpendGuard } from "../../src/engine/spend-guard";
import { dailyCapRefusal } from "../../src/engine/spend-ledger";
import type { TypedForecastAnswer, TypedForecastRequest } from "../../src/forecast/typed";
import type { MarinaStores } from "../../src/persistence/interfaces";
import { defaultReplicateGroup } from "../replicates";
import { mulberry32 } from "../stats";
import {
  configModels,
  describeConfig,
  type ForecastConfig,
  type Forecaster,
  usesCrew,
} from "./configs";
import { mapLimit } from "./shared";

export interface BacktestItem {
  /** Stable id (the ledger item id; never question text). */
  id: string;
  request: TypedForecastRequest & { asOf: string };
  /** 0–1, higher is better (e.g. 1 − Brier), including the board's own fallback for an unusable answer. */
  score(answer: TypedForecastAnswer | undefined): number;
}

export type CandidateStatus =
  | "ranked"
  | "crew (not isolable)"
  | "unknown release"
  | "too recent"
  | "not run (budget)";

export interface Ranked {
  label: string;
  config: string;
  status: CandidateStatus;
  note?: string;
  bound?: string;
  replicates: number;
  /** Pooled mean score on the common items. */
  mean?: number;
  /** Paired difference to the leader (leader − this), 95 % interval, two-stage bootstrap. */
  vsLeader?: { diff: number; ci: [number, number] };
  costPerItem?: number;
  ledgerRuns: string[];
}

export interface Selection {
  benchmark: string;
  at: string;
  items: number;
  /** The earliest forecast date in the common window. */
  window: string;
  replicates: number;
  ranking: Ranked[];
  /** Labels chosen, best first. */
  picked: string[];
  costUsd: number;
}

export interface SelectOptions {
  benchmark: string;
  items: BacktestItem[];
  candidates: ForecastConfig[];
  /** Release dates (YYYY-MM-DD) by bare model id. */
  releases: Record<string, string>;
  /** The candidate's forecaster for a backtest (strict retrieval, lessons as configured). */
  makeForecaster: (c: ForecastConfig) => Forecaster;
  replicates?: number;
  pick?: number;
  minItems?: number;
  /** Most items to use (spread evenly over the window). */
  maxItems?: number;
  lagDays?: number;
  /** Total spend for the selection. */
  budgetUsd: number;
  /** How the forecasters' retrieval is isolated (`isolationOfSpec`); `contaminated` is refused. */
  isolation: IsolationLevel;
  /** Candidates whose measured cost per question exceeds this cannot be picked. */
  livePerItemUsd?: number;
  concurrency?: number;
  ledger?: Pick<MarinaStores, "recordBenchmarkLedgerRun">;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (line: string) => void;
}

const DAY = 86_400_000;

export function boundOf(c: ForecastConfig, releases: Record<string, string>): string | undefined {
  const dates = configModels(c).map((m) => releases[m]);
  if (dates.some((d) => !d)) return undefined;
  return dates.sort().at(-1);
}

const cleanFor = (item: BacktestItem, bound: string, lagDays: number) =>
  Date.parse(item.request.asOf) >= Date.parse(bound) + lagDays * DAY;

/** Evenly spaced picks from a sorted list. */
function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]!);
}

export async function selectConfiguration(opts: SelectOptions): Promise<Selection> {
  const log = opts.log ?? (() => {});
  if (opts.isolation === "contaminated") {
    throw new Error(
      "the backtest retriever can see outcomes (unfiltered on past cutoffs): use a date-strict asof: retriever, a date-filtered engine or the strict filter",
    );
  }
  const now = opts.now ?? (() => new Date());
  const reps = Math.max(1, opts.replicates ?? 2);
  const lag = opts.lagDays ?? 3;
  const minItems = opts.minItems ?? 20;
  const ranking = new Map<string, Ranked>();
  const eligible: Array<{ c: ForecastConfig; bound: string }> = [];
  for (const c of opts.candidates) {
    const r: Ranked = {
      label: c.label,
      config: describeConfig(c),
      status: "ranked",
      replicates: 0,
      ledgerRuns: [],
    };
    ranking.set(c.label, r);
    if (usesCrew(c)) {
      r.status = "crew (not isolable)";
      continue;
    }
    const bound = boundOf(c, opts.releases);
    if (!bound) {
      r.status = "unknown release";
      r.note = `no release date for ${configModels(c)
        .filter((m) => !opts.releases[m])
        .join(", ")}`;
      continue;
    }
    r.bound = bound;
    const n = opts.items.filter((i) => cleanFor(i, bound, lag)).length;
    if (n < minItems) {
      r.status = "too recent";
      r.note = `released ${bound}: ${n} resolved questions forecast after it (needs ${minItems})`;
      continue;
    }
    eligible.push({ c, bound });
  }
  // The common window: questions clean for every eligible candidate. A candidate
  // that would shrink it below `minItems` waits for more resolved history.
  eligible.sort((a, b) => a.bound.localeCompare(b.bound));
  let common: BacktestItem[] = [];
  while (eligible.length) {
    const latest = eligible.at(-1)!.bound;
    common = opts.items.filter((i) => cleanFor(i, latest, lag));
    if (common.length >= minItems) break;
    const dropped = eligible.pop()!;
    const r = ranking.get(dropped.c.label)!;
    r.status = "too recent";
    r.note = `released ${dropped.bound}: too few questions in the common window`;
  }
  common.sort((a, b) => a.request.asOf.localeCompare(b.request.asOf) || a.id.localeCompare(b.id));
  common = spread(common, opts.maxItems ?? common.length);
  const window = common[0]?.request.asOf.slice(0, 10) ?? "";
  log(
    `selection: ${opts.candidates.length} candidates, ${eligible.length} backtestable on ${common.length} resolved questions forecast from ${window} · ${reps} replicates · budget $${opts.budgetUsd}`,
  );

  // Runs: replicate 1 of every candidate before any replicate 2 (in the order
  // given — pass the cheapest first), so a budget stop still leaves as many
  // candidates measured as it can.
  const stamp = now().getTime();
  const scores = new Map<string, Array<Map<string, number>>>();
  const costs = new Map<string, number[]>();
  const env = opts.env ?? process.env;
  const concurrency = opts.concurrency ?? 4;
  // `eligible` is sorted by release bound for the window; run in the caller's order.
  const runOrder = opts.candidates.filter((c) => eligible.some((e) => e.c === c));
  let spent = 0;
  let stopped = "";
  for (let rep = 1; rep <= reps && !stopped; rep++) {
    for (const c of runOrder) {
      const capped = dailyCapRefusal(env);
      if (capped) stopped = capped;
      else if (spent >= opts.budgetUsd) stopped = `selection budget $${opts.budgetUsd} reached`;
      if (stopped) break;
      // A further replicate whose measured cost would overrun the budget is not started.
      const measuredPer = average(costs.get(c.label) ?? []);
      if (measuredPer !== undefined && spent + measuredPer * common.length > opts.budgetUsd) {
        log(
          `  ${c.label} r${rep}: skipped — ≈ $${(measuredPer * common.length).toFixed(2)} would overrun the selection budget ($${(opts.budgetUsd - spent).toFixed(2)} left)`,
        );
        continue;
      }
      const forecast = opts.makeForecaster(c);
      const started = now();
      let runCost = 0;
      let finished = 0;
      let halt: string | undefined;
      // Stop starting items while every item in flight can still finish under the
      // selection budget and the daily cap: past either, the forecaster's calls
      // would be refused and the items would score as fallbacks.
      const guard = new SpendGuard({
        label: "selection budget",
        budgetUsd: opts.budgetUsd,
        spentUsd: spent,
        concurrency,
        minReserveUsd: STOP_RESERVE_USD,
        env,
      });
      const answers = await mapLimit(common, concurrency, async (item) => {
        halt ??= guard.stopReason();
        if (halt) return undefined;
        let itemCost = 0;
        try {
          const answer = await forecast(item.request);
          itemCost = answer.costUsd ?? 0;
          runCost += itemCost;
          return answer;
        } catch {
          return undefined;
        } finally {
          finished++;
          guard.record(itemCost);
        }
      });
      if (halt) {
        // A partial run is never scored or filed: its missing items would count as fallbacks.
        spent += runCost;
        stopped = halt;
        log(
          `  ${c.label} r${rep}: stopped after ${finished}/${common.length} items — partial run discarded ($${runCost.toFixed(2)})`,
        );
        break;
      }
      const runScores = new Map<string, number>();
      let cost = 0;
      let fallbacks = 0;
      common.forEach((item, i) => {
        runScores.set(item.id, item.score(answers[i]));
        cost += answers[i]?.costUsd ?? 0;
        if (isFallback(answers[i])) fallbacks++;
      });
      spent += cost;
      if (fallbacks) log(`  ${c.label} r${rep}: ${fallbacks}/${common.length} items had no answer`);
      scores.set(c.label, [...(scores.get(c.label) ?? []), runScores]);
      costs.set(c.label, [...(costs.get(c.label) ?? []), cost / Math.max(1, common.length)]);
      const r = ranking.get(c.label)!;
      r.replicates++;
      const mean = [...runScores.values()].reduce((s, x) => s + x, 0) / Math.max(1, runScores.size);
      log(`  ${c.label} r${rep}: mean ${mean.toFixed(4)} · $${cost.toFixed(2)}`);
      if (opts.ledger) {
        try {
          r.ledgerRuns.push(
            fileRun(opts, c, rep, common, answers, runScores, started, now(), cost, stamp),
          );
        } catch (err) {
          log(`  ledger: ${(err as Error).message.slice(0, 120)}`);
        }
      }
    }
  }
  if (stopped) log(`  stopped: ${stopped}`);

  // Pool and rank.
  const measured = eligible.filter(({ c }) => (scores.get(c.label)?.length ?? 0) > 0);
  for (const { c } of eligible) {
    if (!scores.get(c.label)?.length) ranking.get(c.label)!.status = "not run (budget)";
  }
  const pooled = (label: string) => {
    const runs = scores.get(label)!;
    return common.map((it) => runs.reduce((s, r) => s + r.get(it.id)!, 0) / runs.length);
  };
  for (const { c } of measured) {
    const r = ranking.get(c.label)!;
    const xs = pooled(c.label);
    r.mean = round(xs.reduce((s, x) => s + x, 0) / xs.length);
    const cs = costs.get(c.label)!;
    r.costPerItem = round(cs.reduce((s, x) => s + x, 0) / cs.length, 5);
  }
  const ranked = measured
    .map(({ c }) => ranking.get(c.label)!)
    .sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0));
  const leader = ranked[0];
  if (leader) {
    for (const r of ranked.slice(1)) {
      r.vsLeader = pairedBootstrap(
        scores.get(leader.label)!,
        scores.get(r.label)!,
        common.map((i) => i.id),
      );
    }
  }
  const affordable = ranked.filter(
    (r) => opts.livePerItemUsd === undefined || (r.costPerItem ?? 0) <= opts.livePerItemUsd,
  );
  for (const r of ranked) {
    if (!affordable.includes(r)) r.note = `over the live budget ($${r.costPerItem}/question)`;
  }
  const picked = affordable.slice(0, opts.pick ?? 1).map((r) => r.label);
  const order = [...ranked, ...[...ranking.values()].filter((r) => !ranked.includes(r))];
  return {
    benchmark: opts.benchmark,
    at: now().toISOString(),
    items: common.length,
    window,
    replicates: reps,
    ranking: order,
    picked,
    costUsd: round(spent, 4),
  };
}

/**
 * Leader minus candidate, two-stage bootstrap: resample each side's replicate
 * runs, then the items (paired), 2 000 times; the observed difference and its
 * 95 % percentile interval.
 */
export function pairedBootstrap(
  leader: Array<Map<string, number>>,
  other: Array<Map<string, number>>,
  ids: string[],
  iterations = 2_000,
  seed = 11,
): { diff: number; ci: [number, number] } {
  const rand = mulberry32(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const itemMean = (runs: Array<Map<string, number>>, id: string) =>
    runs.reduce((s, r) => s + (r.get(id) ?? 0), 0) / runs.length;
  const observed =
    ids.reduce((s, id) => s + itemMean(leader, id) - itemMean(other, id), 0) / ids.length;
  const stats: number[] = [];
  for (let k = 0; k < iterations; k++) {
    const l = leader.map(() => pick(leader));
    const o = other.map(() => pick(other));
    let s = 0;
    for (let j = 0; j < ids.length; j++) {
      const id = pick(ids);
      s += itemMean(l, id) - itemMean(o, id);
    }
    stats.push(s / ids.length);
  }
  stats.sort((a, b) => a - b);
  const q = (p: number) => stats[Math.min(stats.length - 1, Math.floor(p * stats.length))]!;
  return { diff: round(observed), ci: [round(q(0.025)), round(q(0.975))] };
}

function fileRun(
  opts: SelectOptions,
  c: ForecastConfig,
  rep: number,
  items: BacktestItem[],
  answers: Array<TypedForecastAnswer | undefined>,
  scores: Map<string, number>,
  started: Date,
  finished: Date,
  cost: number,
  stamp: number,
): string {
  const benchmark = `${opts.benchmark}-backtest`;
  const file = {
    config: {
      dataset: benchmark,
      name: benchmark,
      model: c.label,
      configuration: describeConfig(c),
      replicate: rep,
      isolation: opts.isolation,
      lessons: c.lessons === false ? "off" : "on",
    },
    timestamp: finished.getTime(),
    duration_ms: finished.getTime() - started.getTime(),
    metadata: { usage: { costUsd: cost } },
    items: items.map((it, i) => ({
      id: it.id,
      // Better than the board's own fallback (a coin flip scores 0.75 on 1 − Brier).
      correct: (scores.get(it.id) ?? 0) > 0.75,
      score: scores.get(it.id) ?? 0,
      // Scored as the board's fallback, flagged so the ledger can see the run's fallback rate.
      ...(isFallback(answers[i]) ? { fallback: true } : {}),
      // A digest of the answer, never its text (stored keyed per ledger).
      ...(answers[i]?.formatted && answerDigest(answers[i]!.formatted)
        ? { answerDigest: answerDigest(answers[i]!.formatted) }
        : {}),
      usage: { costUsd: answers[i]?.costUsd ?? 0 },
      judge: "1-brier",
    })),
  };
  const raw = JSON.stringify(file);
  const built = ledgerFromHarnessResult(file, {
    targetKind: "population",
    target: { configuration: c },
    // One group per (selection, candidate): its replicates pool in `benchmark compare`.
    replicateGroup: defaultReplicateGroup(`${opts.benchmark}-${c.label}`, stamp),
    label: `${c.label} r${rep}`,
    judge: "1 − Brier on resolved outcomes",
    raw,
    id: `bench_${randomUUID().slice(0, 13)}`,
    now: finished.getTime(),
  });
  return opts.ledger!.recordBenchmarkLedgerRun(built.run, built.items).id;
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

const average = (xs: number[]) =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;

/** No usable answer: the forecaster threw, or no run produced a prediction. */
const isFallback = (a: TypedForecastAnswer | undefined) => a?.prediction === undefined;

/** The least spend kept in reserve before starting another item. */
const STOP_RESERVE_USD = 0.5;
