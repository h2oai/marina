// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The competence map: what Marina's own record says it is good at, per
 * (family, method) — read live from the one outcome path, never a static
 * claim. Every producer tags its outcomes `family:` / `method:` (forecasts by
 * their routing record, the arena by tracker and route, benchmark runs by
 * benchmark and configuration), so one table covers them all.
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
 * Only mechanically scored outcomes count (a judged one is an opinion until
 * its judge has earned agreement). Read-only and pure apart from the query.
 */

import type { MarinaDB } from "../persistence/database";
import type { OutcomeRow } from "../persistence/db-outcomes";
import { outcomeRefs } from "./routing-refs";

export interface CompetenceCell {
  family: string;
  method: string;
  /** `quality` (higher is better) or the loss metric (lower is better). */
  metric: string;
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
export function competenceFrom(
  rows: readonly OutcomeRow[],
  familyPrefix?: string,
): CompetenceCell[] {
  const cells = new Map<
    string,
    {
      family: string;
      method: string;
      metric: string;
      live: number;
      measure: number;
      xs: number[];
      inside: number;
      banded: number;
      last: number;
    }
  >();
  for (const o of rows) {
    if (o.basis !== "mechanical") continue;
    const quality = o.quality !== null && Number.isFinite(o.quality) ? o.quality : undefined;
    const loss = o.loss !== null && Number.isFinite(o.loss) ? o.loss : undefined;
    if (quality === undefined && loss === undefined) continue;
    const refs = outcomeRefs(o.refs_json);
    const method = refs.find((r) => r.startsWith("method:"))?.slice(7);
    if (!method) continue;
    const metric = quality !== undefined ? "quality" : (o.metric ?? "loss");
    const value = quality ?? loss!;
    for (const ref of refs) {
      if (!ref.startsWith("family:")) continue;
      const family = ref.slice(7);
      if (familyPrefix && !family.startsWith(familyPrefix)) continue;
      const key = `${family}\u0000${method}\u0000${metric}`;
      const c = cells.get(key) ?? {
        family,
        method,
        metric,
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
  opts: { family?: string; limit?: number } = {},
): CompetenceCell[] {
  return competenceFrom(
    db.listOutcomes({ basis: "mechanical", limit: opts.limit ?? 10_000 }),
    opts.family,
  );
}

const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(3));

/** Plain-text table for agents and people: what the numbers are, then the rows. */
export function renderCompetence(
  cells: readonly CompetenceCell[],
  opts: { limit?: number } = {},
): string {
  if (cells.length === 0) {
    return "Competence map: no resolved, mechanically scored outcome tagged with a family and method yet. Rows appear as forecasts, arena rounds and benchmark runs resolve.";
  }
  const limit = opts.limit ?? 60;
  const lines = [
    "Competence map — from resolved outcomes (live = real questions; measure = benchmark/eval runs, routing evidence only for their own board).",
    "score: quality 0–1 (higher better) or mean loss under its metric (lower better); ±95 %; cov80 = share of truths inside the 80 % band (≈0.80 when calibrated).",
    "",
  ];
  for (const c of cells.slice(0, limit)) {
    const ci = c.ci ? ` [${fmt(c.ci[0])}, ${fmt(c.ci[1])}]` : "";
    const cov = c.coverage80 ? ` cov80 ${c.coverage80.rate.toFixed(2)} (n ${c.coverage80.n})` : "";
    const counts = `${c.live} live${c.measure ? `, ${c.measure} measure` : ""}`;
    lines.push(
      `${c.family}  ${c.method}  ${counts}  ${c.metric} ${fmt(c.mean)}${ci}${cov}  last ${new Date(c.last).toISOString().slice(0, 10)}`,
    );
  }
  if (cells.length > limit)
    lines.push(`… ${cells.length - limit} more (narrow with a family prefix)`);
  return lines.join("\n");
}
