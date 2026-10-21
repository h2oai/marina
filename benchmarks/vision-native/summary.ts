// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-mode accuracy with Wilson intervals, per kind and per family, and the
 * paired native-vs-describe comparison (exact McNemar and a paired bootstrap)
 * over the tasks both modes answered. Pure; reuses `src/stats`.
 */

import { type Interval, mcnemarExact, pairedBootstrap, wilsonInterval } from "../../src/stats";

export interface ResultRow {
  task: string;
  kind: string;
  mode: string;
  correct: boolean;
  cost?: number;
  error?: string;
}

export interface ModeStats {
  n: number;
  correct: number;
  accuracy: number;
  wilson: Interval;
  costUsd: number;
  errors: number;
}

export interface Summary {
  modes: Record<string, ModeStats>;
  byKind: Record<string, Record<string, ModeStats>>;
  byFamily: Record<string, Record<string, ModeStats>>;
  /** Over tasks both `a` (describe) and `b` (native) answered: diff = acc(b) − acc(a). */
  paired: {
    a: string;
    b: string;
    n: number;
    accA: number;
    accB: number;
    diff: number;
    bootstrap: Interval;
    /** b = a right and b wrong; c = a wrong and b right. */
    mcnemar: { b: number; c: number; p: number };
  };
}

function stats(rows: readonly ResultRow[]): ModeStats {
  const correct = rows.filter((r) => r.correct).length;
  return {
    n: rows.length,
    correct,
    accuracy: rows.length ? correct / rows.length : 0,
    wilson: wilsonInterval(correct, rows.length),
    costUsd: rows.reduce((s, r) => s + Number(r.cost ?? 0), 0),
    errors: rows.filter((r) => r.error).length,
  };
}

function group(
  rows: readonly ResultRow[],
  key: (r: ResultRow) => string,
): Record<string, Record<string, ModeStats>> {
  const out: Record<string, Record<string, ModeStats>> = {};
  const keys = [...new Set(rows.map(key))];
  for (const k of keys) {
    const inK = rows.filter((r) => key(r) === k);
    out[k] = {};
    for (const mode of [...new Set(inK.map((r) => r.mode))]) {
      out[k][mode] = stats(inK.filter((r) => r.mode === mode));
    }
  }
  return out;
}

export function summarize(
  rows: readonly ResultRow[],
  opts: { family?: Record<string, string>; a?: string; b?: string; seed?: number } = {},
): Summary {
  const a = opts.a ?? "describe";
  const b = opts.b ?? "native";
  const modes: Record<string, ModeStats> = {};
  for (const mode of [...new Set(rows.map((r) => r.mode))]) {
    modes[mode] = stats(rows.filter((r) => r.mode === mode));
  }
  const byA = new Map(rows.filter((r) => r.mode === a).map((r) => [r.task, r.correct]));
  const pairs = rows
    .filter((r) => r.mode === b && byA.has(r.task))
    .map((r) => [byA.get(r.task)!, r.correct] as const);
  const xa = pairs.map((p) => p[0]);
  const xb = pairs.map((p) => p[1]);
  const boot = pairedBootstrap(xa, xb, { seed: opts.seed ?? 1 });
  const mc = mcnemarExact(
    pairs.filter(([x, y]) => x && !y).length,
    pairs.filter(([x, y]) => !x && y).length,
  );
  const acc = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
  return {
    modes,
    byKind: group(rows, (r) => r.kind),
    byFamily: group(rows, (r) => opts.family?.[r.kind] ?? r.kind),
    paired: {
      a,
      b,
      n: pairs.length,
      accA: acc(xa),
      accB: acc(xb),
      diff: boot.diff,
      bootstrap: boot.interval,
      mcnemar: mc,
    },
  };
}
