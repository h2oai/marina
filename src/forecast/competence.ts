// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The competence map: what Marina's own record says it is good at, per
 * (family, method) — read live from the one outcome path, never a static
 * claim. Every producer tags its outcomes `family:` / `method:` (forecasts by
 * their routing record, the arena by tracker and route, benchmark runs by
 * benchmark and configuration, work by model and by how it was done), so one
 * table covers them all. A row naming several methods counts in each.
 *
 *   live       resolved real questions (what routing reads as evidence)
 *   measure    measurement runs (benchmarks, evaluations): reported, but used
 *              as routing evidence only for their own board's class
 *   score      the mean quality (0–1, higher is better) where the producer
 *              records one, else the mean loss under its metric (lower is
 *              better: CRPS, Brier, energy, RBO), with a 95 % interval
 *   coverage   for CRPS-scored numbers: how often the truth fell inside the
 *              forecast's 80 % band (a calibrated forecaster is near 80 %)
 *
 * Mechanically scored outcomes by default. `includeJudged` adds judged grades
 * (a judge's opinion of a task, never passed off as mechanical) as their own
 * cells, labelled `judged`. Work done for a person (their own, or their
 * agents') is in that person's view only (`viewer`), never the shared map
 * (`src/outcomes/work-refs.ts`). Read-only and pure apart from the query.
 */

import { visibleTo } from "../outcomes/work-refs";
import type { MarinaDB } from "../persistence/database";
import type { OutcomeRow } from "../persistence/db-outcomes";
import { outcomeRefs } from "./routing-refs";

export interface CompetenceCell {
  family: string;
  method: string;
  /** `quality` (higher is better) or the loss metric (lower is better). */
  metric: string;
  /** `mechanical` (scored by rule) or `judged` (a judge's opinion). */
  basis: "mechanical" | "judged";
  live: number;
  measure: number;
  mean: number;
  /** 95 % interval of the mean (normal approximation; absent below n = 2). */
  ci?: [number, number];
  /** CRPS-scored numbers: share of truths inside the 80 % band, and over how many. */
  coverage80?: { rate: number; n: number };
  /** Newest resolution (ms). */
  last: number;
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** The map from outcome rows (newest first is fine; order is not used). */
export interface CompetenceOptions {
  /** Only families starting with this prefix. */
  family?: string;
  /** Add judged grades as their own, labelled cells. */
  includeJudged?: boolean;
  /** Whose own (person-scoped) work to include besides shared work. */
  viewer?: string;
}

export function competenceFrom(
  rows: readonly OutcomeRow[],
  opts: string | CompetenceOptions = {},
): CompetenceCell[] {
  const o0 = typeof opts === "string" ? { family: opts } : opts;
  const familyPrefix = o0.family;
  const cells = new Map<
    string,
    {
      family: string;
      method: string;
      metric: string;
      basis: "mechanical" | "judged";
      live: number;
      measure: number;
      xs: number[];
      inside: number;
      banded: number;
      last: number;
    }
  >();
  for (const o of rows) {
    if (o.basis !== "mechanical" && !(o0.includeJudged && o.basis === "judged")) continue;
    const quality = o.quality !== null && Number.isFinite(o.quality) ? o.quality : undefined;
    const loss = o.loss !== null && Number.isFinite(o.loss) ? o.loss : undefined;
    if (quality === undefined && loss === undefined) continue;
    const refs = outcomeRefs(o.refs_json);
    if (!visibleTo(refs, o0.viewer)) continue;
    // A row counts once per method dimension it names: a forecast or benchmark
    // row names one; work names its model and how it was done (`crew:debate`,
    // `driver:codex`, …), so each way of working gets its own cell.
    const methods = refs.filter((r) => r.startsWith("method:")).map((r) => r.slice(7));
    if (methods.length === 0) continue;
    const metric = quality !== undefined ? "quality" : (o.metric ?? "loss");
    const value = quality ?? loss!;
    for (const [ref, method] of refs.flatMap((r) => methods.map((m) => [r, m] as const))) {
      if (!ref.startsWith("family:")) continue;
      const family = ref.slice(7);
      if (familyPrefix && !family.startsWith(familyPrefix)) continue;
      const basis = o.basis === "judged" ? ("judged" as const) : ("mechanical" as const);
      const key = `${family}\u0000${method}\u0000${metric}\u0000${basis}`;
      const c = cells.get(key) ?? {
        family,
        method,
        metric,
        basis,
        live: 0,
        measure: 0,
        xs: [],
        inside: 0,
        banded: 0,
        last: 0,
      };
      if (o.eval_mode === "measure") c.measure++;
      else c.live++;
      c.xs.push(value);
      if (o.metric === "crps") {
        c.banded++;
        c.inside += o.succeeded;
      }
      c.last = Math.max(c.last, o.resolved_at);
      cells.set(key, c);
    }
  }
  return [...cells.values()]
    .map((c) => {
      const n = c.xs.length;
      const mean = c.xs.reduce((a, b) => a + b, 0) / n;
      const sd =
        n > 1 ? Math.sqrt(c.xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : undefined;
      const half = sd !== undefined ? (1.96 * sd) / Math.sqrt(n) : undefined;
      return {
        family: c.family,
        method: c.method,
        metric: c.metric,
        basis: c.basis,
        live: c.live,
        measure: c.measure,
        mean: r4(mean),
        ...(half !== undefined
          ? { ci: [r4(mean - half), r4(mean + half)] as [number, number] }
          : {}),
        ...(c.banded ? { coverage80: { rate: r4(c.inside / c.banded), n: c.banded } } : {}),
        last: c.last,
      };
    })
    .sort(
      (a, b) =>
        a.family.localeCompare(b.family) ||
        b.live + b.measure - (a.live + a.measure) ||
        a.method.localeCompare(b.method),
    );
}

/** The map from the world database (the newest `limit` outcomes, default 10 000). */
export function competenceMap(
  db: Pick<MarinaDB, "listOutcomes">,
  opts: CompetenceOptions & { limit?: number } = {},
): CompetenceCell[] {
  const limit = opts.limit ?? 10_000;
  const rows = opts.includeJudged
    ? [
        ...db.listOutcomes({ basis: "mechanical", limit }),
        ...db.listOutcomes({ basis: "judged", limit }),
      ]
    : db.listOutcomes({ basis: "mechanical", limit });
  return competenceFrom(rows, opts);
}

const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(3));

/** Plain-text table for agents and people: what the numbers are, then the rows. */
export function renderCompetence(
  cells: readonly CompetenceCell[],
  opts: { limit?: number } = {},
): string {
  if (cells.length === 0) {
    return "Competence map: no resolved outcome tagged with a family and method yet. Rows appear as forecasts, arena rounds, benchmark runs and work (task verdicts, Code Mode checks, reported requests) resolve.";
  }
  const limit = opts.limit ?? 60;
  const lines = [
    "Competence map — from resolved outcomes (live = real questions and work; measure = benchmark/eval runs, routing evidence only for their own board; work done for a person shows only in that person's own view).",
    "score: quality 0–1 (higher better) or mean loss under its metric (lower better); ±95 %; cov80 = share of truths inside the 80 % band (≈0.80 when calibrated); (judged) = a judge's opinion, not a scored result.",
    "",
  ];
  for (const c of cells.slice(0, limit)) {
    const ci = c.ci ? ` [${fmt(c.ci[0])}, ${fmt(c.ci[1])}]` : "";
    const cov = c.coverage80 ? ` cov80 ${c.coverage80.rate.toFixed(2)} (n ${c.coverage80.n})` : "";
    const counts = `${c.live} live${c.measure ? `, ${c.measure} measure` : ""}${c.basis === "judged" ? " (judged)" : ""}`;
    lines.push(
      `${c.family}  ${c.method}  ${counts}  ${c.metric} ${fmt(c.mean)}${ci}${cov}  last ${new Date(c.last).toISOString().slice(0, 10)}`,
    );
  }
  if (cells.length > limit)
    lines.push(`… ${cells.length - limit} more (narrow with a family prefix)`);
  return lines.join("\n");
}

/** The dimension a method competes in: `model`, `crew` (formations and `solo`), `driver`, … */
export function methodDimension(method: string): string {
  if (method === "solo") return "crew";
  const colon = method.indexOf(":");
  return colon > 0 ? method.slice(0, colon) : "method";
}

/** Fewest outcomes behind a method before it is ranked at all. */
export const MIN_RANKED = 5;

export interface MethodRanking {
  dimension: string;
  metric: string;
  /** Best first, by the pessimistic end of the 95 % interval. */
  ranked: CompetenceCell[];
  /** Methods with fewer than `MIN_RANKED` outcomes: shown, never ranked. */
  thin: CompetenceCell[];
  /** `lead` when the best's interval clears every other ranked method's; else `unclear` or `alone`. */
  verdict: "lead" | "unclear" | "alone" | "none";
}

/**
 * Which ways of working have done best at one kind of work (`family`), per
 * dimension: methods compete only with others of their dimension (models
 * with models, crew formations with each other and with solo work). Ranked
 * by the pessimistic end of the 95 % interval (lower bound of a quality,
 * upper bound of a loss), so a method with little evidence never outranks one
 * that is reliably good; a lead is claimed only when the intervals separate.
 * Mechanical scores only. Advice for choosing, never a gate.
 */
export function rankMethods(cells: readonly CompetenceCell[], family: string): MethodRanking[] {
  const own = cells.filter((c) => c.family === family && c.basis === "mechanical");
  const groups = new Map<string, CompetenceCell[]>();
  for (const c of own) {
    const key = `${methodDimension(c.method)}\u0000${c.metric}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: MethodRanking[] = [];
  for (const [key, group] of groups) {
    const [dimension, metric] = key.split("\u0000") as [string, string];
    const higher = metric === "quality";
    const n = (c: CompetenceCell) => c.live + c.measure;
    const pessimistic = (c: CompetenceCell) => (c.ci ? (higher ? c.ci[0] : c.ci[1]) : c.mean);
    const optimistic = (c: CompetenceCell) => (c.ci ? (higher ? c.ci[1] : c.ci[0]) : c.mean);
    const ranked = group
      .filter((c) => n(c) >= MIN_RANKED)
      .sort((a, b) => (higher ? pessimistic(b) - pessimistic(a) : pessimistic(a) - pessimistic(b)));
    const thin = group.filter((c) => n(c) < MIN_RANKED);
    const [best, ...rest] = ranked;
    const verdict: MethodRanking["verdict"] = !best
      ? "none"
      : rest.length === 0
        ? "alone"
        : rest.every((c) =>
              higher ? pessimistic(best) > optimistic(c) : pessimistic(best) < optimistic(c),
            )
          ? "lead"
          : "unclear";
    out.push({ dimension, metric, ranked, thin, verdict });
  }
  return out.sort((a, b) => a.dimension.localeCompare(b.dimension));
}

/** `competence best <family>`: what has worked best, per dimension, and how sure that is. */
export function renderMethodRanking(rankings: readonly MethodRanking[], family: string): string {
  if (rankings.length === 0)
    return `No resolved, scored outcomes for ${family} yet: no method has a record here. Choose by judgement, and the outcome will start one.`;
  const lines = [
    `What has worked for ${family} — from resolved outcomes, ranked by the pessimistic end of the 95 % interval (advice, not a rule):`,
  ];
  for (const r of rankings) {
    const say =
      r.verdict === "lead"
        ? `${r.ranked[0]!.method} leads clearly`
        : r.verdict === "unclear"
          ? `no clear leader yet — the top intervals overlap`
          : r.verdict === "alone"
            ? `only ${r.ranked[0]!.method} has enough outcomes to rank`
            : `nothing has ${MIN_RANKED}+ outcomes yet`;
    lines.push("", `${r.dimension} (${r.metric}): ${say}`);
    for (const c of r.ranked.slice(0, 5)) {
      const ci = c.ci ? ` [${fmt(c.ci[0])}, ${fmt(c.ci[1])}]` : "";
      lines.push(`  ${c.method}  n ${c.live + c.measure}  ${fmt(c.mean)}${ci}`);
    }
    if (r.thin.length)
      lines.push(
        `  too few outcomes to rank: ${r.thin
          .slice(0, 6)
          .map((c) => `${c.method} (${c.live + c.measure})`)
          .join(", ")}`,
      );
  }
  return lines.join("\n");
}
