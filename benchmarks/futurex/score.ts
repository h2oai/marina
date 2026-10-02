// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A local FutureX scorer, written from the metric definitions FutureX publishes
 * (the FutureX paper, arXiv 2508.11987; the dataset cards) — no FutureX code is
 * copied. It exists for smoke tests on the resolved-questions dataset, whose
 * outcomes are already public, so a backtest score is a pipeline check, never
 * an estimate of live skill. The official weekly scoring uses an LLM judge to
 * extract and match answers; this scorer matches strings mechanically
 * (normalized), so it can under-credit paraphrases.
 *
 *   one-label truth (L1/L2)    exact match on the option label
 *   multi-label truth (L2)     F1 between predicted and true label sets
 *   numeric truth (L3/L4)      max(0, 1 − ((pred − truth)/σ)²),
 *                              σ = 5 % of |truth| (0.01 when truth is 0), or the
 *                              dataset's own std when asked for
 *   string truth (L3/L4)       1 when equal after normalization, else 0
 *   list truth (L4)            1 for an exact ordered match, else 0.8 × overlap / |truth|
 *   overall                    Σ_level w_level × mean score at that level,
 *                              weights 0.1 / 0.2 / 0.3 / 0.4 over the levels present
 *                              (missing answers count as 0)
 */

import { normalizeText } from "../../src/forecast/answer-types";
import type { FuturexRow } from "./dataset";
import { parseOptions } from "./map";

export const LEVEL_WEIGHTS: Record<number, number> = { 1: 0.1, 2: 0.2, 3: 0.3, 4: 0.4 };

/** The dataset's `ground_truth` (a JSON- or Python-style list string, or a value) as items. */
export function parseTruth(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof raw === "number") return [String(raw)];
  if (typeof raw !== "string") return [];
  const t = raw.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      // allow-empty-catch: not JSON — fall through to the Python-style list parse
    }
    const inner = t.slice(1, -1);
    const items: string[] = [];
    const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^,\s][^,]*)/g;
    for (const m of inner.matchAll(re)) {
      const v = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1").trim();
      if (v) items.push(v);
    }
    return items;
  }
  return t ? [t] : [];
}

/** A prediction string → items (comma / semicolon / pipe separated). */
export function predictionItems(prediction: string): string[] {
  return prediction
    .split(/[,;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const asNumber = (s: string): number | undefined => {
  const cleaned = s.replace(/[,\s_$%]/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
};

/** Map an item to a canonical option key: its letter, else its label matched to a letter. */
function optionKey(item: string, row: FuturexRow): string {
  const letters = parseOptions(row.prompt);
  const t = item.trim();
  const byLetter = letters.find((o) => o.id === t.toUpperCase());
  if (byLetter) return byLetter.id;
  const n = normalizeText(t);
  const byLabel = letters.find((o) => normalizeText(o.label ?? "") === n);
  return byLabel ? byLabel.id : n;
}

export interface ItemScore {
  id: string;
  level: number;
  score: number;
  /** Which rule scored it. */
  metric: "exact" | "f1" | "numeric" | "string" | "list" | "missing";
}

export function scoreItem(
  row: FuturexRow,
  prediction: string | undefined,
  opts: { sigma?: "relative" | "dataset" } = {},
): ItemScore {
  const base = { id: row.id, level: row.level };
  const truth = parseTruth(row.ground_truth);
  if (prediction === undefined || prediction.trim() === "" || truth.length === 0) {
    return { ...base, score: 0, metric: "missing" };
  }
  const pred = predictionItems(prediction);
  if (row.level <= 2) {
    const t = new Set(truth.map((x) => optionKey(x, row)));
    const p = new Set(pred.map((x) => optionKey(x, row)));
    if (t.size === 1) {
      return {
        ...base,
        score: p.size === 1 && [...p][0] === [...t][0] ? 1 : 0,
        metric: "exact",
      };
    }
    const hit = [...p].filter((x) => t.has(x)).length;
    const precision = p.size ? hit / p.size : 0;
    const recall = hit / t.size;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { ...base, score: round(f1), metric: "f1" };
  }
  if (truth.length === 1) {
    const g = asNumber(truth[0]!);
    if (g !== undefined) {
      const pn = asNumber(pred[0] ?? prediction);
      if (pn === undefined) return { ...base, score: 0, metric: "numeric" };
      const datasetStd = Number(row.std);
      const sigma =
        opts.sigma === "dataset" && Number.isFinite(datasetStd) && datasetStd > 0
          ? datasetStd
          : g === 0
            ? 0.01
            : Math.abs(g) * 0.05;
      return {
        ...base,
        score: round(Math.max(0, 1 - ((pn - g) / sigma) ** 2)),
        metric: "numeric",
      };
    }
    const ok = normalizeText(pred.join(", ")) === normalizeText(truth[0]!);
    return { ...base, score: ok ? 1 : 0, metric: "string" };
  }
  const t = truth.map(normalizeText);
  const p = pred.map(normalizeText);
  if (t.length === p.length && t.every((x, i) => x === p[i])) {
    return { ...base, score: 1, metric: "list" };
  }
  const pool = [...p];
  let overlap = 0;
  for (const x of t) {
    const i = pool.indexOf(x);
    if (i >= 0) {
      overlap++;
      pool.splice(i, 1);
    }
  }
  return { ...base, score: round((0.8 * overlap) / t.length), metric: "list" };
}

export interface BatchScore {
  overall: number;
  byLevel: Record<number, { n: number; mean: number }>;
  items: ItemScore[];
}

/** Score predictions (id → string) over rows; a row without a prediction scores 0. */
export function scoreBatch(
  rows: FuturexRow[],
  predictions: Map<string, string>,
  opts: { sigma?: "relative" | "dataset" } = {},
): BatchScore {
  const items = rows.map((r) => scoreItem(r, predictions.get(r.id), opts));
  const byLevel: Record<number, { n: number; mean: number }> = {};
  for (const lvl of [1, 2, 3, 4]) {
    const at = items.filter((i) => i.level === lvl);
    if (at.length) {
      byLevel[lvl] = { n: at.length, mean: round(at.reduce((s, i) => s + i.score, 0) / at.length) };
    }
  }
  const present = Object.keys(byLevel).map(Number);
  const w = present.reduce((s, l) => s + (LEVEL_WEIGHTS[l] ?? 0), 0);
  const overall = w
    ? present.reduce((s, l) => s + (LEVEL_WEIGHTS[l] ?? 0) * byLevel[l]!.mean, 0) / w
    : 0;
  return { overall: round(overall), byLevel, items };
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;
