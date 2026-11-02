// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The held-out measurement the posture decision rests on: does task success
 * fall — or rise — in the K outcomes after a dream against the K before?
 * Applied dreams (not rolled back) with K outcomes on each side are the
 * units; they are split by time into DISCOVERY (the older half) and HOLDOUT
 * (the newer half), and each split pools its before/after outcomes into one
 * Agresti–Caffo interval on the difference (`differenceInterval`). The
 * verdict reads the holdout only: `wins` when its lower bound clears
 * `promotionMargin(tried)`, `loses` when its upper bound is below the negated
 * margin, else `no change` — or `insufficient` with fewer than MEASURE_MIN
 * dreams in the holdout. Numbers only; the same machinery as live promotion.
 */

import { promotionMargin } from "../../engine/fishing-margin";
import type { MarinaDB } from "../../persistence/database";
import { differenceInterval } from "../../stats";
import { GUARD_K } from "./guard";

export const MEASURE_MIN = 5;

export interface MeasuredSplit {
  dreams: number;
  before: { n: number; successes: number; rate: number };
  after: { n: number; successes: number; rate: number };
  /** 95 % interval on after − before. */
  interval: [number, number];
}

export interface DreamEffect {
  k: number;
  margin: number;
  /** Applied dreams considered, and how many had K outcomes on both sides. */
  applied: number;
  measured: number;
  discovery: MeasuredSplit;
  holdout: MeasuredSplit;
  verdict: "wins" | "no change" | "loses" | "insufficient";
}

interface Unit {
  createdAt: number;
  before: boolean[];
  after: boolean[];
}

function split(units: Unit[]): MeasuredSplit {
  const b = units.flatMap((u) => u.before);
  const a = units.flatMap((u) => u.after);
  const sb = b.filter(Boolean).length;
  const sa = a.filter(Boolean).length;
  const rb = b.length ? sb / b.length : 0;
  const ra = a.length ? sa / a.length : 0;
  return {
    dreams: units.length,
    before: { n: b.length, successes: sb, rate: rb },
    after: { n: a.length, successes: sa, rate: ra },
    interval: a.length && b.length ? differenceInterval(ra, a.length, rb, b.length) : [0, 0],
  };
}

/**
 * The effect of dreaming on one owner's work (or everyone's, with no owner).
 * `tried` is how many times this measurement has been read for a decision
 * before (the fishing margin grows with it).
 */
export function dreamEffect(
  db: MarinaDB,
  opts: { owner?: string; k?: number; tried?: number } = {},
): DreamEffect {
  const k = opts.k ?? GUARD_K;
  const margin = promotionMargin(opts.tried ?? 0);
  type Row = { id: number; entity_name: string; applied_at: number | null; created_at: number };
  const raw = db.memoryRepository().raw;
  const rows = opts.owner
    ? raw
        .query<Row, [string]>(
          `SELECT id, entity_name, applied_at, created_at FROM memory_dreams
           WHERE state = 'applied' AND entity_name = ? ORDER BY created_at ASC LIMIT 2000`,
        )
        .all(opts.owner)
    : raw
        .query<Row, []>(
          `SELECT id, entity_name, applied_at, created_at FROM memory_dreams
           WHERE state = 'applied' ORDER BY created_at ASC LIMIT 2000`,
        )
        .all();
  const units: Unit[] = [];
  for (const row of rows) {
    const at = row.applied_at ?? row.created_at;
    const outcomes = db
      .listOutcomes({ owner: row.entity_name, limit: 10_000 })
      .sort((a, b) => a.resolved_at - b.resolved_at);
    const before = outcomes.filter((o) => o.resolved_at < at).slice(-k);
    const after = outcomes.filter((o) => o.resolved_at >= at).slice(0, k);
    if (before.length < k || after.length < k) continue;
    units.push({
      createdAt: row.created_at,
      before: before.map((o) => o.succeeded === 1),
      after: after.map((o) => o.succeeded === 1),
    });
  }
  const half = Math.floor(units.length / 2);
  const discovery = split(units.slice(0, half));
  const holdout = split(units.slice(half));
  let verdict: DreamEffect["verdict"] = "insufficient";
  if (holdout.dreams >= MEASURE_MIN) {
    if (holdout.interval[0] > margin) verdict = "wins";
    else if (holdout.interval[1] < -margin) verdict = "loses";
    else verdict = "no change";
  }
  return { k, margin, applied: rows.length, measured: units.length, discovery, holdout, verdict };
}

export function renderDreamEffect(e: DreamEffect): string[] {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const line = (name: string, s: MeasuredSplit) =>
    `  ${name.padEnd(10)} ${s.dreams} dream(s) · before ${pct(s.before.rate)} (${s.before.successes}/${s.before.n}) · after ${pct(s.after.rate)} (${s.after.successes}/${s.after.n}) · Δ [${s.interval[0].toFixed(3)}, ${s.interval[1].toFixed(3)}]`;
  return [
    `  K=${e.k} outcomes each side · ${e.measured} of ${e.applied} applied dream(s) measurable · margin ${e.margin.toFixed(3)}`,
    line("discovery", e.discovery),
    line("holdout", e.holdout),
    `  verdict: ${e.verdict}${e.verdict === "insufficient" ? ` (needs ${MEASURE_MIN} measurable dreams in the holdout)` : ""}`,
  ];
}
