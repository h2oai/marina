// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Transfer report core: does a candidate configuration beat a baseline on
 * more than the evaluation it was built for?
 *
 * The guardrail: a capability counts only when it improves results
 * significantly on at least two INDEPENDENT evaluations (distinct suite
 * groups) and regresses significantly on none. This module is the whole
 * decision and holds no benchmark logic: it sees suites as lists of per-item
 * scores (higher is better) for two arms, already loaded and split by the
 * adapters in `adapters.ts` and `spec.ts`. Pure functions, deterministic for
 * a given seed.
 *
 * Per suite: items are paired by id (replicates averaged per item, ids
 * missing from any run left out and counted), d_i = candidate − baseline,
 * then
 *   - a paired bootstrap of mean(d) (items resampled with replacement,
 *     seeded mulberry32, percentile interval), and
 *   - an exact two-sided sign test on the non-zero d_i (ties dropped).
 * A suite IMPROVES only when both agree: interval low > margin and sign-test
 * p < alpha with more wins than losses. It REGRESSES when either one says so
 * (interval high < 0, or p < alpha with more losses than wins) — the bar to
 * claim a gain is deliberately higher than the bar to flag a loss.
 */

import {
  mcnemarExact,
  bootstrapMean as sharedBootstrapMean,
  twoStageBootstrap as sharedTwoStageBootstrap,
} from "../../src/stats";

/** One item's score in one run. Higher is better (adapters negate a loss). */
export interface ItemScore {
  id: string;
  score: number;
  /** ISO time the item's evidence was frozen at (enables a time split). */
  at?: string;
  /** Why the item must not be used (e.g. a leak audit flag); dropped from both arms. */
  exclude?: string;
}

/** A suite ready for analysis: one entry per replicate run, per arm. */
export interface SuiteData {
  name: string;
  /** Independence group: suites sharing a group count once toward the ≥ 2 rule. */
  group: string;
  baseline: ItemScore[][];
  candidate: ItemScore[][];
  /** How the items were chosen (shown in the report). */
  split: string;
  /** Items removed before pairing, by reason. */
  removed?: Record<string, number>;
}

export interface TransferOptions {
  alpha?: number;
  resamples?: number;
  seed?: number;
  /** Interval level for the bootstrap (default 0.95). */
  level?: number;
  /** An improvement must clear this mean delta at the interval's low end (default 0). */
  margin?: number;
  /** Fewest paired items for a suite to be judged (default 10). */
  minItems?: number;
  /** Independent groups that must improve (default 2). */
  minGroups?: number;
  /**
   * `items` (default): resample items of the replicate-averaged deltas.
   * `two-stage`: resample each arm's replicate runs, then the items — the
   * cluster bootstrap of `benchmarks/forecasting/select.ts`, so run-to-run
   * variance widens the interval.
   */
  bootstrap?: "items" | "two-stage";
}

export interface SignTest {
  wins: number;
  losses: number;
  ties: number;
  /** Exact two-sided binomial p (p = ½) on wins + losses; 1 with none. */
  p: number;
}

export interface Bootstrap {
  mean: number;
  low: number;
  high: number;
  resamples: number;
}

export type SuiteOutcome = "improves" | "regresses" | "no-difference" | "insufficient";

export interface SuiteResult {
  name: string;
  group: string;
  split: string;
  paired: number;
  /** Ids seen in some run of the suite but not in every run of both arms. */
  unpaired: number;
  removed: Record<string, number>;
  replicates: { baseline: number; candidate: number };
  baselineMean: number;
  candidateMean: number;
  delta: Bootstrap;
  sign: SignTest;
  outcome: SuiteOutcome;
  reason: string;
}

export type Verdict = "transfers" | "does-not-transfer" | "regresses" | "insufficient";

export interface TransferResult {
  verdict: Verdict;
  reason: string;
  improvedGroups: string[];
  regressedSuites: string[];
  suites: SuiteResult[];
  options: Required<TransferOptions>;
}

export const DEFAULTS: Required<TransferOptions> = {
  alpha: 0.05,
  resamples: 10_000,
  seed: 1,
  level: 0.95,
  margin: 0,
  minItems: 10,
  minGroups: 2,
  bootstrap: "items",
};

/** Exact two-sided sign test on paired deltas; zero deltas are ties and dropped. */
export function signTest(deltas: readonly number[], eps = 1e-12): SignTest {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const d of deltas) {
    if (d > eps) wins++;
    else if (d < -eps) losses++;
    else ties++;
  }
  // The sign test IS McNemar's exact test on the discordant counts.
  return { wins, losses, ties, p: mcnemarExact(wins, losses).p };
}

/** Paired bootstrap of the mean delta: resample items with replacement (`src/stats`). */
export function bootstrapMean(
  deltas: readonly number[],
  opts: { resamples?: number; seed?: number; level?: number } = {},
): Bootstrap {
  return sharedBootstrapMean(deltas, {
    resamples: opts.resamples ?? DEFAULTS.resamples,
    seed: opts.seed ?? DEFAULTS.seed,
    level: opts.level ?? DEFAULTS.level,
  });
}

/**
 * Two-stage (cluster) paired bootstrap of mean(candidate − baseline): each
 * iteration resamples each arm's replicate runs with replacement, then the
 * items, and averages per item over the drawn runs (`src/stats`
 * `twoStageBootstrap`; `pairedBootstrap` in `benchmarks/forecasting/select.ts`
 * is the same draw, leader − other, so a seed gives the same interval).
 */
export function twoStageBootstrap(
  candidate: ReadonlyArray<ReadonlyMap<string, number>>,
  baseline: ReadonlyArray<ReadonlyMap<string, number>>,
  ids: readonly string[],
  opts: { resamples?: number; seed?: number; level?: number } = {},
): Bootstrap {
  return sharedTwoStageBootstrap(candidate, baseline, ids, {
    resamples: opts.resamples ?? DEFAULTS.resamples,
    seed: opts.seed ?? DEFAULTS.seed,
    level: opts.level ?? DEFAULTS.level,
  });
}

/** Per-item mean over one arm's replicate runs, restricted to `ids`. */
function armMeans(runs: ItemScore[][], ids: readonly string[]): number[] {
  const maps = runs.map((run) => new Map(run.map((x) => [x.id, x.score])));
  return ids.map((id) => maps.reduce((s, m) => s + (m.get(id) ?? 0), 0) / maps.length);
}

/**
 * Pair a suite's runs by item id: an id is kept only when every run of both
 * arms scored it and no run excluded it. Returns the kept ids (sorted, so the
 * bootstrap sees a stable order), the unpaired count and exclusions by reason.
 */
export function pairItems(suite: SuiteData): {
  ids: string[];
  unpaired: number;
  excluded: Record<string, number>;
} {
  const runs = [...suite.baseline, ...suite.candidate];
  const excludedIds = new Map<string, string>();
  const seen = new Set<string>();
  const sets = runs.map((run) => {
    const s = new Set<string>();
    for (const x of run) {
      seen.add(x.id);
      if (x.exclude && !excludedIds.has(x.id)) excludedIds.set(x.id, x.exclude);
      if (Number.isFinite(x.score)) s.add(x.id);
    }
    return s;
  });
  const ids: string[] = [];
  let unpaired = 0;
  const excluded: Record<string, number> = {};
  for (const id of [...seen].sort()) {
    const why = excludedIds.get(id);
    if (why) {
      excluded[why] = (excluded[why] ?? 0) + 1;
      continue;
    }
    if (runs.length > 0 && sets.every((s) => s.has(id))) ids.push(id);
    else unpaired++;
  }
  return { ids, unpaired, excluded };
}

export function analyzeSuite(suite: SuiteData, options: TransferOptions = {}): SuiteResult {
  const o = { ...DEFAULTS, ...options };
  const { ids, unpaired, excluded } = pairItems(suite);
  const base = armMeans(suite.baseline, ids);
  const cand = armMeans(suite.candidate, ids);
  const deltas = ids.map((_, i) => (cand[i] ?? 0) - (base[i] ?? 0));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const asMaps = (runs: ItemScore[][]) => runs.map((r) => new Map(r.map((x) => [x.id, x.score])));
  const delta =
    o.bootstrap === "two-stage"
      ? twoStageBootstrap(asMaps(suite.candidate), asMaps(suite.baseline), ids, o)
      : bootstrapMean(deltas, o);
  const sign = signTest(deltas);
  const removed = { ...(suite.removed ?? {}) };
  for (const [k, v] of Object.entries(excluded)) removed[k] = (removed[k] ?? 0) + v;

  let outcome: SuiteOutcome;
  let reason: string;
  const signUp = sign.p < o.alpha && sign.wins > sign.losses;
  const signDown = sign.p < o.alpha && sign.losses > sign.wins;
  if (suite.baseline.length === 0 || suite.candidate.length === 0) {
    outcome = "insufficient";
    reason = "an arm has no run";
  } else if (ids.length < o.minItems) {
    outcome = "insufficient";
    reason = `${ids.length} paired item(s) < ${o.minItems}`;
  } else if (delta.high < 0 || signDown) {
    outcome = "regresses";
    reason =
      delta.high < 0
        ? `interval [${fmt(delta.low)}, ${fmt(delta.high)}] below 0`
        : `sign test p=${fmtP(sign.p)} (${sign.losses} losses vs ${sign.wins} wins)`;
  } else if (delta.low > o.margin && signUp) {
    outcome = "improves";
    reason = `interval low ${fmt(delta.low)} > ${fmt(o.margin)} and sign test p=${fmtP(sign.p)}`;
  } else {
    outcome = "no-difference";
    reason =
      delta.low > o.margin
        ? `sign test p=${fmtP(sign.p)} ≥ ${o.alpha}`
        : `interval [${fmt(delta.low)}, ${fmt(delta.high)}] includes ${fmt(o.margin)}`;
  }
  return {
    name: suite.name,
    group: suite.group,
    split: suite.split,
    paired: ids.length,
    unpaired,
    removed,
    replicates: { baseline: suite.baseline.length, candidate: suite.candidate.length },
    baselineMean: mean(base),
    candidateMean: mean(cand),
    delta,
    sign,
    outcome,
    reason,
  };
}

/** Judge every suite and apply the transfer rule. */
export function transferVerdict(
  suites: readonly SuiteData[],
  options: TransferOptions = {},
): TransferResult {
  const o = { ...DEFAULTS, ...options };
  // Each suite gets its own stream so adding a suite never moves another's interval.
  const results = suites.map((s, i) => analyzeSuite(s, { ...o, seed: o.seed + i * 7919 }));
  const improvedGroups = [
    ...new Set(results.filter((r) => r.outcome === "improves").map((r) => r.group)),
  ].sort();
  const regressedSuites = results.filter((r) => r.outcome === "regresses").map((r) => r.name);
  const judgedGroups = new Set(
    results.filter((r) => r.outcome !== "insufficient").map((r) => r.group),
  );
  let verdict: Verdict;
  let reason: string;
  if (regressedSuites.length > 0) {
    verdict = "regresses";
    reason = `significant regression on ${regressedSuites.join(", ")}`;
  } else if (improvedGroups.length >= o.minGroups) {
    verdict = "transfers";
    reason = `significant improvement on ${improvedGroups.length} independent group(s) (${improvedGroups.join(", ")}) and no significant regression`;
  } else if (judgedGroups.size < o.minGroups) {
    verdict = "insufficient";
    reason = `only ${judgedGroups.size} independent group(s) had enough paired items; ${o.minGroups} needed`;
  } else {
    verdict = "does-not-transfer";
    reason = `significant improvement on ${improvedGroups.length} independent group(s)${improvedGroups.length ? ` (${improvedGroups.join(", ")})` : ""}; ${o.minGroups} needed`;
  }
  return { verdict, reason, improvedGroups, regressedSuites, suites: results, options: o };
}

const fmt = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(4)}`;
const fmtP = (p: number) => (p < 0.0001 ? p.toExponential(2) : p.toFixed(4));

export interface ReportHeader {
  baseline: { label: string; env?: Record<string, string> };
  candidate: { label: string; env?: Record<string, string> };
  generatedAt?: string;
}

/** Markdown rendering of a transfer result: ids-free aggregates only. */
export function renderMarkdown(result: TransferResult, header: ReportHeader): string {
  const env = (e?: Record<string, string>) =>
    e && Object.keys(e).length
      ? Object.entries(e)
          .map(([k, v]) => `\`${k}=${v}\``)
          .join(" ")
      : "(no overlay)";
  const o = result.options;
  const lines = [
    "# Transfer report",
    "",
    `**Verdict: ${result.verdict}** — ${result.reason}.`,
    "",
    `- Baseline \`${header.baseline.label}\`: ${env(header.baseline.env)}`,
    `- Candidate \`${header.candidate.label}\`: ${env(header.candidate.env)}`,
    `- Rule: improves on ≥ ${o.minGroups} independent groups (bootstrap ${Math.round(o.level * 100)} % interval low > ${o.margin} AND sign test p < ${o.alpha}), no suite regressing (interval high < 0 OR sign test p < ${o.alpha} against).`,
    `- Bootstrap: ${o.bootstrap === "two-stage" ? "two-stage (replicate runs, then items)" : "items"}, ${o.resamples} resamples, seed ${o.seed}; suites need ≥ ${o.minItems} paired items.`,
    ...(header.generatedAt ? [`- Generated ${header.generatedAt}`] : []),
    "",
    "| Suite | Group | Split | n | Baseline | Candidate | Δ mean [interval] | Sign W/L/T, p | Outcome |",
    "|---|---|---|---:|---:|---:|---|---|---|",
  ];
  for (const s of result.suites) {
    lines.push(
      `| ${s.name} | ${s.group} | ${s.split} | ${s.paired} | ${s.baselineMean.toFixed(4)} | ${s.candidateMean.toFixed(4)} | ${fmt(s.delta.mean)} [${fmt(s.delta.low)}, ${fmt(s.delta.high)}] | ${s.sign.wins}/${s.sign.losses}/${s.sign.ties}, ${fmtP(s.sign.p)} | **${s.outcome}** |`,
    );
  }
  lines.push("", "## Notes", "");
  for (const s of result.suites) {
    const removed = Object.entries(s.removed)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    lines.push(
      `- **${s.name}**: ${s.reason}. Replicates ${s.replicates.baseline} vs ${s.replicates.candidate}; ${s.unpaired} unpaired id(s) left out${removed ? `; removed: ${removed}` : ""}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
