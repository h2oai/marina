// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Suite adapters for the transfer report: each turns a result file (or
 * ledger) an existing evaluation already writes into per-item scores (higher
 * is better) for ONE arm, as one list per replicate run. This is the only
 * place that knows a benchmark's file format; `core.ts` never does.
 *
 * Adding a suite: either write per-item scores in the `items` format
 * (`{"id": "...", "score": 0.7}` per line, optional `at`, `exclude`,
 * `variant`, `replicate`), point the `items` adapter at an existing record
 * format with field options (`records`, `id`, `score`, `variant`, …), or add
 * an adapter here and register it in `ADAPTERS`.
 * See benchmarks/README.md → "Transfer report".
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ItemScore } from "./core";
import {
  DEFAULT_MAX_COPY_BYTES,
  hasLedger,
  ledgerItems,
  listLedgerRuns,
  openReadOnly,
  type RunFilter,
  selectRuns,
} from "./ledger";

/** Where one arm's run(s) of a suite live. */
export interface Source {
  path: string;
  /** For files holding several arms (a column, a `variant` value, a run label): which one. */
  arm?: string;
  /** Adapter-specific options (e.g. `tracker` for arena files, field paths for `items`). */
  options?: Record<string, string>;
  /** Use another adapter for this source than the suite's (mixing formats in one suite). */
  adapter?: string;
}

export interface SuiteAdapter {
  name: string;
  description: string;
  /** Whether the held-out time split can apply (items carry `at`). */
  timed?: boolean;
  /** One run's items. */
  load?(source: Source): ItemScore[];
  /** Several replicate runs from one source (a ledger, a file with a replicate field). */
  loadRuns?(source: Source): ItemScore[][];
}

/** Every replicate run a source holds. */
export function loadRuns(adapter: SuiteAdapter, source: Source): ItemScore[][] {
  if (adapter.loadRuns) return adapter.loadRuns(source);
  if (adapter.load) return [adapter.load(source)];
  throw new Error(`adapter ${adapter.name} loads nothing`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** JSON or JSONL text → the parsed value (JSONL becomes an array of lines). */
function parseJsonOrLines(text: string, path: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      // A JSONL file also starts with "{": fall through to line parsing.
      if (!trimmed.startsWith("{")) throw new Error(`${path}: ${String(err)}`);
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

/** `a.b.c` lookup; `x|y` tries alternatives in order. */
export function fieldAt(x: unknown, path: string): unknown {
  for (const alt of path.split("|")) {
    let v: unknown = x;
    for (const k of alt.split(".")) {
      if (isRecord(v)) v = v[k];
      else if (Array.isArray(v) && /^\d+$/.test(k)) v = v[Number(k)];
      else {
        v = undefined;
        break;
      }
    }
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** A score: a finite number, or a boolean as 1/0. */
function scoreValue(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return undefined;
}

/** The records of a file or a directory of files; `records` picks a nested array. */
function readRecordsAt(path: string, records?: string): unknown[] {
  const fromValue = (j: unknown, where: string): unknown[] => {
    if (records) {
      const at = fieldAt(j, records);
      if (!Array.isArray(at)) throw new Error(`${where}: no array at "${records}"`);
      return at;
    }
    if (Array.isArray(j)) return j;
    if (isRecord(j) && Array.isArray(j.items)) return j.items;
    return [j];
  };
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => /\.jsonl?$/.test(f))
      .sort()
      .flatMap((f) => {
        const p = join(path, f);
        return fromValue(parseJsonOrLines(readFileSync(p, "utf8"), p), p);
      });
  }
  return fromValue(parseJsonOrLines(readFileSync(path, "utf8"), path), path);
}

export interface FieldMap {
  records?: string;
  id: string;
  score: string;
  /** Comma-separated field paths joined with "/" (e.g. `arm,model`). */
  variant?: string;
  replicate?: string;
  at?: string;
  exclude?: string;
}

export const ITEMS_FIELDS: FieldMap = {
  id: "id",
  score: "score",
  variant: "variant",
  replicate: "replicate",
  at: "at",
  exclude: "exclude",
};

function fieldsWith(defaults: FieldMap, options?: Record<string, string>): FieldMap {
  const m: FieldMap = { ...defaults };
  for (const k of ["records", "id", "score", "variant", "replicate", "at", "exclude"] as const) {
    const v = options?.[k];
    if (v !== undefined) {
      if (v === "") delete m[k];
      else m[k] = v;
    }
  }
  return m;
}

export function variantKey(record: unknown, variant?: string): string | undefined {
  if (!variant) return undefined;
  const parts = variant.split(",").map((f) => fieldAt(record, f.trim()));
  if (parts.every((p) => p === undefined)) return undefined;
  return parts.map((p) => (p === undefined ? "" : String(p))).join("/");
}

/**
 * Map records to replicate runs: keep the source's `arm` when records carry a
 * variant (refuse a multi-variant file without one), group by the replicate
 * field, average duplicate ids within a run, skip records with no score.
 */
export function mapRecords(source: Source, map: FieldMap): ItemScore[][] {
  const records = readRecordsAt(source.path, map.records);
  const variants = new Set<string>();
  for (const r of records) {
    const v = variantKey(r, map.variant);
    if (v !== undefined) variants.add(v);
  }
  if (variants.size > 1 && !source.arm)
    throw new Error(
      `${source.path} holds variants ${[...variants].sort().join(", ")}: give "arm" to pick one`,
    );
  const runs = new Map<
    string,
    Map<string, { sum: number; n: number; at?: string; exclude?: string }>
  >();
  let kept = 0;
  for (const r of records) {
    if (source.arm && variants.size > 0 && variantKey(r, map.variant) !== source.arm) continue;
    const rawId = fieldAt(r, map.id);
    const score = scoreValue(fieldAt(r, map.score));
    if ((typeof rawId !== "string" && typeof rawId !== "number") || score === undefined) continue;
    const rep = map.replicate ? fieldAt(r, map.replicate) : undefined;
    const key = rep === undefined ? "" : String(rep);
    const run = runs.get(key) ?? new Map();
    runs.set(key, run);
    const id = String(rawId);
    const cur = run.get(id) ?? { sum: 0, n: 0 };
    cur.sum += score;
    cur.n++;
    const at = map.at ? fieldAt(r, map.at) : undefined;
    if (typeof at === "string") cur.at = at;
    const ex = map.exclude ? fieldAt(r, map.exclude) : undefined;
    if (typeof ex === "string" && ex) cur.exclude = ex;
    run.set(id, cur);
    kept++;
  }
  if (source.arm && variants.size > 0 && kept === 0)
    throw new Error(
      `${source.path}: no scored record of variant "${source.arm}" (has ${[...variants].sort().join(", ")})`,
    );
  return [...runs.keys()].sort().map((k) =>
    [...runs.get(k)!].map(([id, x]) => ({
      id,
      score: x.sum / x.n,
      ...(x.at ? { at: x.at } : {}),
      ...(x.exclude ? { exclude: x.exclude } : {}),
    })),
  );
}

const TRIAL_ID = /^(.+)#(\d+)$/;

/**
 * Repeated-trial filings key each item `<task>#<trial>` (τ²-bench through
 * `benchmarks/tau2/convert.ts`, Mind2Web 2 through `benchmarks/mind2web2/ledger.ts`).
 * The trials of one task are not independent items: counted apart they
 * inflate n, and the hash split would put trials of one task on both sides of
 * the held-out line. When EVERY id of a run has that shape, collapse it to the
 * task (score = mean over its trials in the run), as the `tau2` adapter does;
 * `options.trials: "keep"` opts out.
 */
export function collapseTrials(items: ItemScore[], options?: Record<string, string>): ItemScore[] {
  if (options?.trials === "keep" || items.length === 0) return items;
  if (!items.every((x) => TRIAL_ID.test(x.id))) return items;
  const byTask = new Map<string, { sum: number; n: number; at?: string; exclude?: string }>();
  for (const x of items) {
    const task = TRIAL_ID.exec(x.id)![1]!;
    const cur = byTask.get(task) ?? { sum: 0, n: 0 };
    cur.sum += x.score;
    cur.n++;
    if (x.at && !cur.at) cur.at = x.at;
    if (x.exclude && !cur.exclude) cur.exclude = x.exclude;
    byTask.set(task, cur);
  }
  return [...byTask].map(([id, x]) => ({
    id,
    score: x.sum / x.n,
    ...(x.at ? { at: x.at } : {}),
    ...(x.exclude ? { exclude: x.exclude } : {}),
  }));
}

function requireArm(source: Source, adapter: string): string {
  if (!source.arm) throw new Error(`${adapter} source ${source.path} needs "arm" (which column)`);
  return source.arm;
}

/**
 * The generic format: `{id, score, at?, exclude?, variant?, replicate?}` per
 * record, as a JSON array, `{items: […]}`, JSONL, or a directory of such
 * files. `arm` keeps one `variant`; distinct `replicate` values become
 * replicate runs. Options remap the fields (`id`, `score`, `variant`,
 * `replicate`, `at`, `exclude`; dotted paths, `a|b` alternatives, "" to drop)
 * and `records` points at a nested array, so most per-item outputs need no
 * adapter of their own.
 */
export const itemsAdapter: SuiteAdapter = {
  name: "items",
  description:
    "generic records {id, score, at?, exclude?, variant?, replicate?} (JSON, {items}, JSONL or a directory); fields remappable",
  timed: true,
  loadRuns: (source) => mapRecords(source, fieldsWith(ITEMS_FIELDS, source.options)),
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
    return collapseTrials(
      items.filter(isRecord).map((x) => ({
        id: String(x.id),
        score: typeof x.score === "number" ? x.score : x.correct === true ? 1 : 0,
      })),
      source.options,
    );
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

/** A named field mapping over the generic record reader (no code of its own). */
function preset(
  name: string,
  description: string,
  fields: Omit<FieldMap, "id" | "score"> & Pick<FieldMap, "id" | "score">,
  opts: { timed?: boolean; prepare?: (source: Source) => Partial<FieldMap> } = {},
): SuiteAdapter {
  return {
    name,
    description,
    ...(opts.timed ? { timed: true } : {}),
    loadRuns: (source) =>
      mapRecords(
        source,
        fieldsWith({ ...fields, ...(opts.prepare?.(source) ?? {}) }, source.options),
      ),
  };
}

/** τ²-bench results (`results/*.json`, trials files): one item per task, trials as replicates. */
export const tau2Adapter = preset(
  "tau2",
  "tau2-bench results JSON: simulations[].reward_info.reward by task_id, trial = replicate",
  { records: "simulations", id: "task_id", score: "reward_info.reward", replicate: "trial" },
);

/**
 * BrowseComp-Plus evaluation directory (`evals/run_N_eval.json`, one file per
 * query). As in the official evaluator, an incomplete run (turn cap, empty
 * reply: `is_completed: false`, never judged) is WRONG, not missing: dropping
 * it would score only the queries an arm finished, and lose exactly the items
 * where two formations differ in finishing. A completed run without a judge
 * verdict (a failed judge call) stays unscored.
 */
export const browsecompAdapter: SuiteAdapter = {
  name: "browsecomp",
  description:
    "BrowseComp-Plus evals directory: run_N_eval.json per query, judge_result.correct; an incomplete run scores 0",
  loadRuns(source) {
    const run = new Map<string, number>();
    for (const r of readRecordsAt(source.path)) {
      if (!isRecord(r)) continue;
      const id = r.query_id;
      if (typeof id !== "string" && typeof id !== "number") continue;
      const correct = fieldAt(r, "judge_result.correct");
      const score =
        typeof correct === "boolean" ? (correct ? 1 : 0) : r.is_completed === false ? 0 : undefined;
      if (score !== undefined) run.set(String(id), score);
    }
    return [[...run].map(([id, score]) => ({ id, score }))];
  },
};

/** LongMemEval harness `per_question.jsonl`. */
export const longmemevalAdapter = preset(
  "longmemeval",
  "LongMemEval per_question.jsonl: score by question_id",
  { id: "question_id", score: "score|score_bool" },
);

/**
 * Paired-run campaign `analysis.json` (terminal, automation, …): the suite's
 * `attempts[]` (`options.suite`), item = task, arm = `arm/model`.
 */
export const pairedRunAdapter = preset(
  "paired-run",
  "paired-run analysis.json: <suite>.attempts[] by task, arm/model variant, reward|passed",
  { id: "task", score: "reward|passed|score", variant: "arm,model" },
  {
    prepare: (source) => {
      const suite = source.options?.suite;
      if (!suite) throw new Error(`paired-run source ${source.path} needs options.suite`);
      return { records: `${suite}.attempts` };
    },
  },
);

/**
 * A Marina benchmark ledger (any world or ledger DB, read-only): every
 * selected run is one replicate. Select with `arm` (a run variant: the label
 * without its ` rN` suffix, else the model) and/or options `run` (ids),
 * `label`, `group`, `benchmark` (globs), `since`/`until` (start time),
 * `includeInvalid`, `status`. Covers in-world `benchmark run`/`compare-run`,
 * imported harness runs and the ForecastBench/Metaculus selection runs.
 */
export const ledgerAdapter: SuiteAdapter = {
  name: "ledger",
  description:
    "benchmark ledger DB (read-only): runs selected by arm/label, run ids, group, benchmark, date range",
  loadRuns(source) {
    const o = source.options ?? {};
    const filter: RunFilter = {
      ...(o.run ? { run: o.run } : {}),
      ...(o.label || source.arm ? { label: o.label ?? source.arm } : {}),
      ...(o.group ? { group: o.group } : {}),
      ...(o.benchmark ? { benchmark: o.benchmark } : {}),
      ...(o.since ? { since: o.since } : {}),
      ...(o.until ? { until: o.until } : {}),
      ...(o.status ? { status: o.status } : {}),
      includeInvalid: o.includeInvalid === "true",
    };
    if (!filter.run && !filter.label && !filter.group)
      throw new Error(`ledger source ${source.path}: select runs by arm, label, run or group`);
    const h = openReadOnly(source.path, {
      maxCopyBytes: o.maxCopyMb ? Number(o.maxCopyMb) * 1024 * 1024 : DEFAULT_MAX_COPY_BYTES,
    });
    try {
      if (!hasLedger(h.db)) throw new Error(`${source.path}: no benchmark ledger tables`);
      const runs = selectRuns(listLedgerRuns(h.db), filter);
      if (runs.length === 0)
        throw new Error(`${source.path}: no ledger run matches ${JSON.stringify(filter)}`);
      const benchmarks = new Set(runs.map((r) => r.benchmark));
      if (benchmarks.size > 1)
        throw new Error(
          `${source.path}: runs from several benchmarks (${[...benchmarks].join(", ")}): add options.benchmark`,
        );
      return runs.map((r) => collapseTrials(ledgerItems(h.db, r.id), o));
    } finally {
      h.close();
    }
  },
};

export const ADAPTERS: Record<string, SuiteAdapter> = Object.fromEntries(
  [
    itemsAdapter,
    harnessAdapter,
    futurexAdapter,
    arenaEvaluateAdapter,
    arenaPairedAdapter,
    ledgerAdapter,
    tau2Adapter,
    browsecompAdapter,
    longmemevalAdapter,
    pairedRunAdapter,
  ].map((a) => [a.name, a]),
);

export function adapterFor(name: string): SuiteAdapter {
  const a = Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined;
  if (!a) throw new Error(`unknown adapter "${name}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
  return a;
}
