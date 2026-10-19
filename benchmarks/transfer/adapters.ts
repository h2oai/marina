// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Suite adapters for the transfer report: each turns one result file an
 * existing evaluation already writes into per-item scores (higher is better)
 * for ONE arm. This is the only place that knows a benchmark's file format;
 * `core.ts` never does.
 *
 * Adding a suite: either write your per-item scores in the `items` format
 * (`[{ "id": "...", "score": 0.7 }]`, JSON or JSONL, optional `at` and
 * `exclude`), or add an adapter here and register it in `ADAPTERS`.
 * See benchmarks/README.md → "Transfer report".
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ItemScore } from "./core";

/** Where one arm's run of a suite lives. */
export interface Source {
  path: string;
  /** For files holding several forecasters/candidates: which one is this arm. */
  arm?: string;
  /** Adapter-specific options (e.g. `tracker` for arena files). */
  options?: Record<string, string>;
}

export interface SuiteAdapter {
  name: string;
  description: string;
  /** Whether the held-out time split can apply (items carry `at`). */
  timed?: boolean;
  load(source: Source): ItemScore[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** JSON (array, or an object with `items`) or JSONL. */
function readRecords(path: string): unknown[] {
  const text = readFileSync(path, "utf8");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(text) as unknown;
      if (Array.isArray(j)) return j;
      const items = (j as { items?: unknown }).items;
      if (Array.isArray(items)) return items;
      throw new Error(`${path}: expected an array or an object with "items"`);
    } catch (err) {
      // A JSONL file also starts with "{": fall through to line parsing.
      if (!trimmed.startsWith("{")) throw err;
    }
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function requireArm(source: Source, adapter: string): string {
  if (!source.arm) throw new Error(`${adapter} source ${source.path} needs "arm" (which column)`);
  return source.arm;
}

/** The generic format: `{ id, score, at?, exclude? }` per item. */
export const itemsAdapter: SuiteAdapter = {
  name: "items",
  description:
    "generic per-item scores: [{id, score, at?, exclude?}] as JSON, {items:[…]} or JSONL",
  timed: true,
  load(source) {
    return readRecords(source.path).map((r, i) => {
      if (!isRecord(r) || typeof r.id !== "string" || typeof r.score !== "number")
        throw new Error(`${source.path}: record ${i} needs string "id" and number "score"`);
      return {
        id: r.id,
        score: r.score,
        ...(typeof r.at === "string" ? { at: r.at } : {}),
        ...(typeof r.exclude === "string" && r.exclude ? { exclude: r.exclude } : {}),
      };
    });
  },
};

/**
 * Harness result files (`benchmarks/harness.ts`, `BenchmarkResult`): the
 * item's `score` when present, else 1/0 for `correct`.
 */
export const harnessAdapter: SuiteAdapter = {
  name: "harness",
  description: "benchmark harness result JSON (BenchmarkResult): items[].score, else correct",
  load(source) {
    const j = readJson(source.path);
    const items = isRecord(j) ? j.items : undefined;
    if (!Array.isArray(items)) throw new Error(`${source.path}: not a harness result (no items)`);
    return items.filter(isRecord).map((x) => ({
      id: String(x.id),
      score: typeof x.score === "number" ? x.score : x.correct === true ? 1 : 0,
    }));
  },
};

/**
 * FutureX clean backtest (`benchmarks/futurex/clean-run.ts`): a run directory
 * (`<out>/<variant>-<isolation>-lessons-<on|off>-r<N>/`) or its `score.json`.
 * The item's `at` is the row's evidence cutoff from `answers.json`; a row the
 * leak audit (`audit.json`) flagged suspicious is excluded from both arms —
 * the report scores clean rows only.
 */
export const futurexAdapter: SuiteAdapter = {
  name: "futurex",
  description:
    "FutureX clean-backtest run dir or score.json; cutoff from answers.json, audit-flagged rows excluded",
  timed: true,
  load(source) {
    const dir = statSync(source.path).isDirectory()
      ? source.path
      : source.path.replace(/[/\\][^/\\]*$/, "");
    const scorePath = statSync(source.path).isDirectory()
      ? join(source.path, "score.json")
      : source.path;
    const score = readJson(scorePath);
    const items = isRecord(score) ? score.items : undefined;
    if (!Array.isArray(items)) throw new Error(`${scorePath}: not a FutureX score.json`);
    const cutoff = new Map<string, string>();
    const answers = join(dir, "answers.json");
    if (existsSync(answers)) {
      const a = readJson(answers);
      for (const r of isRecord(a) && Array.isArray(a.results) ? a.results : []) {
        if (isRecord(r) && typeof r.id === "string" && typeof r.cutoff === "string")
          cutoff.set(r.id, r.cutoff);
      }
    }
    const flagged = new Set<string>();
    const audit = join(dir, "audit.json");
    if (source.options?.audit !== "off" && existsSync(audit)) {
      const a = readJson(audit);
      for (const r of Array.isArray(a) ? a : []) {
        if (isRecord(r) && r.suspicious === true && typeof r.id === "string") flagged.add(r.id);
      }
    }
    return items.filter(isRecord).map((x) => {
      const id = String(x.id);
      const at = cutoff.get(id);
      return {
        id,
        score: Number(x.score),
        ...(at ? { at } : {}),
        ...(flagged.has(id) ? { exclude: "leak-audit flag" } : {}),
      };
    });
  },
};

/**
 * Arena `bun run arena evaluate … --out <file>` reports (`evaluateResolved`):
 * one item per resolved round, the arm's skill vs the arena's persistence
 * (higher is better). Profile and ranking rounds under `shapes` are included.
 * Rounds whose outcome was public before the lock are already excluded by the
 * evaluator. `options.tracker` keeps one family.
 */
export const arenaEvaluateAdapter: SuiteAdapter = {
  name: "arena-evaluate",
  description: "arena evaluate --out JSON: rounds[].results[arm].skill (+ shapes.rounds)",
  load(source) {
    const arm = requireArm(source, "arena-evaluate");
    const j = readJson(source.path);
    if (!isRecord(j) || !Array.isArray(j.rounds))
      throw new Error(`${source.path}: not an arena evaluate report`);
    const shapes = isRecord(j.shapes) && Array.isArray(j.shapes.rounds) ? j.shapes.rounds : [];
    const tracker = source.options?.tracker;
    const out: ItemScore[] = [];
    let armSeen = false;
    for (const r of [...j.rounds, ...shapes]) {
      if (!isRecord(r) || typeof r.roundId !== "string" || !isRecord(r.results)) continue;
      if (tracker && r.tracker !== undefined && r.tracker !== tracker) continue;
      if (tracker && r.tracker === undefined && !r.roundId.startsWith(`${tracker}-`)) continue;
      const cell = r.results[arm];
      if (!isRecord(cell)) continue;
      armSeen = true;
      if (typeof cell.skill === "number" && Number.isFinite(cell.skill))
        out.push({ id: r.roundId, score: cell.skill });
    }
    if (!armSeen) throw new Error(`${source.path}: no round has forecaster "${arm}"`);
    return out;
  },
};

/**
 * Arena paired shadow scores (`bun run arena shadow paired-score --out`):
 * one item per ELIGIBLE batch (complete, resolved, outcome not public before
 * the lock), the arm (candidate name: start / delphi / fred / calibrated)'s
 * skill vs persistence. Items are keyed by round and variant.
 */
export const arenaPairedAdapter: SuiteAdapter = {
  name: "arena-paired",
  description: "arena shadow paired-score JSON: eligible batches, results[arm].skill",
  load(source) {
    const arm = requireArm(source, "arena-paired");
    const j = readJson(source.path);
    if (!Array.isArray(j)) throw new Error(`${source.path}: not a paired-score report`);
    const out: ItemScore[] = [];
    for (const b of j) {
      if (!isRecord(b) || b.eligible !== true || !isRecord(b.results)) continue;
      const cell = b.results[arm];
      if (!isRecord(cell) || typeof cell.skill !== "number") continue;
      out.push({ id: `${String(b.roundId)}/${String(b.variant)}`, score: cell.skill });
    }
    return out;
  },
};

export const ADAPTERS: Record<string, SuiteAdapter> = Object.fromEntries(
  [itemsAdapter, harnessAdapter, futurexAdapter, arenaEvaluateAdapter, arenaPairedAdapter].map(
    (a) => [a.name, a],
  ),
);

export function adapterFor(name: string): SuiteAdapter {
  const a = Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined;
  if (!a) throw new Error(`unknown adapter "${name}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
  return a;
}
