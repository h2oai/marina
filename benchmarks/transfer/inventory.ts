// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Inventory of per-item results on disk for the transfer report: walk some
 * roots, recognise every result file and benchmark ledger an adapter can
 * read, and list per suite its variants (arms), item counts, date ranges and
 * the baseline/candidate pairs that share enough items — each pair with a
 * ready-to-use suite entry for a transfer spec.
 *
 * Read-only: files are only read; ledgers are opened through `openReadOnly`
 * (immutable, or a temporary copy when a write-ahead log must be read).
 * Identical files (same bytes) are counted once; a ledger run seen in
 * several DB copies is counted once. Each variant lists the Marina commits
 * its sources were stamped with, and each pair says whether both sides share
 * one clean commit (the transfer report's default rule).
 */

import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { versionLabel } from "../../src/engine/run-version";
import { adapterFor, collapseTrials, loadRuns, type Source, sourceVersions } from "./adapters";
import type { ItemScore } from "./core";
import {
  DEFAULT_MAX_COPY_BYTES,
  hasLedger,
  type LedgerRun,
  ledgerItems,
  listLedgerRuns,
  openReadOnly,
  runVariant,
} from "./ledger";
import { addStamp, type MarinaVersion, mergeScans, type VersionScan } from "./versions";

export interface InventoryOptions {
  roots: string[];
  /** Fewest shared items for a pair to be listed (default 10). */
  minItems?: number;
  /** Largest JSON file parsed (default 200 MB). */
  maxJsonBytes?: number;
  /** Largest DB + log copied to read a write-ahead log (default 1 GB). */
  maxCopyBytes?: number;
  /** Directory names never entered. */
  skipDirs?: string[];
  log?: (line: string) => void;
}

export interface VariantInfo {
  key: string;
  label: string;
  adapter: string;
  sources: Source[];
  replicates: number;
  /** Ids scored in every replicate. */
  items: number;
  /** Range of the items' evidence times (`at`), when known. */
  itemsFrom?: string;
  itemsTo?: string;
  /** When the runs were recorded (ledger start time, else file modification time). */
  recordedFrom?: string;
  recordedTo?: string;
  /** Marina commits the sources were stamped with (`unstamped×N` for sources without one). */
  commits: string[];
}

export interface PairInfo {
  baseline: string;
  candidate: string;
  overlap: number;
  /**
   * `same-commit`: both sides at one clean commit (counts by default);
   * `mixed`: different or dirty commits; `unknown`: a side has no stamp.
   */
  versions: "same-commit" | "mixed" | "unknown";
  /** Mean |delta| over the shared items (replicate-averaged). */
  meanAbsDelta: number;
  /** A suite entry for a transfer spec. */
  suite: {
    name: string;
    group: string;
    adapter: string;
    baseline: Source[];
    candidate: Source[];
  };
}

export interface SuiteInfo {
  suite: string;
  group: string;
  variants: VariantInfo[];
  pairs: PairInfo[];
}

export interface Inventory {
  generatedAt: string;
  roots: string[];
  minItems: number;
  scanned: { files: number; candidates: number; dbs: number; ledgers: number };
  duplicates: number;
  skipped: Array<{ path: string; reason: string }>;
  suites: SuiteInfo[];
  /** Pairs left out because every shared item scored the same: one run recorded twice. */
  identicalPairs: number;
  groups: Array<{
    group: string;
    suites: number;
    variants: number;
    pairs: number;
    maxItems: number;
  }>;
}

export const DEFAULT_SKIP_DIRS = [
  "node_modules",
  ".git",
  "checkout",
  "src",
  "dist",
  "site",
  "dashboard",
  "docs",
  "test",
  "tests",
  "marina-desktop",
  "examples",
  "extensions",
  "skills",
  "specs",
  "worlds",
  "rooms",
  "seeds",
  "scripts",
  "nltk_data",
  "python",
  ".venv",
  "venv",
  "__pycache__",
  "marina-src",
  "marina-src-auto",
  "containers",
  "corpora",
];

const HEAD_BYTES = 1 << 20;

function head(path: string, bytes = HEAD_BYTES): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** A recognised source: one arm of one suite. */
interface Found {
  suite: string;
  group: string;
  /** Identity of the arm within the suite (replicates share it). */
  key: string;
  label: string;
  adapter: string;
  source: Source;
  recorded: number;
  /** Latest recording time when the arm spans several runs. */
  recordedTo?: number;
  hash?: string;
}

const groupOf = (suite: string) => {
  const s = suite.toLowerCase();
  // Conservative: subsets and domains of one benchmark are one group, not independent evaluations.
  for (const g of [
    "futurex",
    "tau2",
    "arena",
    "browsecomp",
    "longmemeval",
    "forecastbench",
    "metaculus",
    "hle",
    "deepresearch",
  ])
    if (s.startsWith(g)) return g;
  return s.replace(/-backtest$/, "").split(":")[0] ?? s;
};

/** One name per suite across formats: a board's backtest is the board. */
const suiteName = (s: string) =>
  s
    .replace(/^[\w.-]+\/(?=[\w.-]+$)/, "") // a hub owner prefix ("Tevatron/browsecomp-plus")
    .replace(/-backtest$/, "");

const stripRep = (s: string) => s.replace(/([._-])r(?:ep)?\d+$/i, "");

function parseJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown);
  }
}

/** Recognise one JSON/JSONL file. Returns zero or more arms. */
function detectFile(path: string, mtime: number, hash: string): Found[] {
  const name = basename(path);
  const dir = dirname(path);
  const text = head(path);
  const found = (f: Omit<Found, "recorded" | "hash">): Found => ({ ...f, recorded: mtime, hash });

  if (name === "score.json" && text.includes('"metric"') && text.includes('"level"')) {
    const runDir = basename(dir);
    const batch = basename(dirname(dir));
    const label = stripRep(runDir);
    // Same name as the ledger's filed runs (`benchmarks/futurex/clean-run.ts`), so they pair.
    const suite = runDir.includes("-contaminated-")
      ? "futurex-past-contaminated"
      : "futurex-past-clean";
    return [
      found({
        suite,
        group: "futurex",
        key: `${dirname(dirname(dir))}|${batch}|${label}`,
        label: `${label} ${batch.slice(0, 8)}`,
        adapter: "futurex",
        source: { path: dir },
      }),
    ];
  }
  if (name === "per_question.jsonl" && text.includes('"question_id"')) {
    return [
      found({
        suite: "longmemeval",
        group: "longmemeval",
        key: dir,
        label: `${basename(dirname(dir))}/${basename(dir)}`,
        adapter: "longmemeval",
        source: { path },
      }),
    ];
  }
  if (!name.endsWith(".json") && !name.endsWith(".jsonl")) return [];
  const has = (...m: string[]) => m.every((x) => text.includes(x));
  const plausible =
    has('"simulations"', '"task_id"') ||
    has('"items"', '"correct"') ||
    has('"rounds"', '"persistenceCrps"') ||
    has('"eligible"', '"roundId"') ||
    has('"attempts"', '"arms"') ||
    has('"id"', '"score"');
  if (!plausible) return [];
  const j = parseJson(path);

  if (isRecord(j) && Array.isArray(j.simulations) && isRecord(j.info)) {
    const info = j.info as Record<string, unknown>;
    const domain = String(
      (isRecord(info.environment_info) && info.environment_info.domain_name) || "unknown",
    );
    const agent = isRecord(info.agent_info) ? String(info.agent_info.llm ?? "") : "";
    const label = `${agent ? `${agent} ` : ""}${stripRep(name.replace(/\.json$/, ""))}`;
    return [
      found({
        suite: `tau2-${domain}`,
        group: "tau2",
        key: `${dir}|${label}`,
        label,
        adapter: "tau2",
        source: { path },
      }),
    ];
  }
  if (isRecord(j) && Array.isArray(j.items) && isRecord(j.config)) {
    const items = j.items;
    if (!items.some((x) => isRecord(x) && "id" in x && ("correct" in x || "score" in x))) return [];
    const c = j.config;
    const suite = suiteName(String(c.dataset ?? c.name ?? "harness"));
    const label = String(c.label ?? c.model ?? stripRep(name.replace(/\.json$/, "")));
    return [
      found({
        suite,
        group: groupOf(suite),
        key: `${dir}|${label}|${stripRep(name.replace(/(\.rep\d+)?\.json$/, ""))}`,
        label,
        adapter: "harness",
        source: { path },
      }),
    ];
  }
  if (isRecord(j) && Array.isArray(j.rounds)) {
    const arms = new Set<string>();
    const shapes = isRecord(j.shapes) && Array.isArray(j.shapes.rounds) ? j.shapes.rounds : [];
    for (const r of [...j.rounds, ...shapes])
      if (isRecord(r) && isRecord(r.results)) for (const a of Object.keys(r.results)) arms.add(a);
    if (!j.rounds.some((r) => isRecord(r) && "persistenceCrps" in r)) return [];
    return [...arms].sort().map((arm) =>
      found({
        suite: "arena-evaluate",
        group: "arena",
        key: `${path}|${arm}`,
        label: `${arm} @ ${name}`,
        adapter: "arena-evaluate",
        source: { path, arm },
      }),
    );
  }
  if (Array.isArray(j) && j.some((b) => isRecord(b) && "eligible" in b && "roundId" in b)) {
    const arms = new Set<string>();
    for (const b of j)
      if (isRecord(b) && isRecord(b.results)) for (const a of Object.keys(b.results)) arms.add(a);
    return [...arms].sort().map((arm) =>
      found({
        suite: "arena-paired",
        group: "arena",
        key: `${path}|${arm}`,
        label: `${arm} @ ${name}`,
        adapter: "arena-paired",
        source: { path, arm },
      }),
    );
  }
  if (isRecord(j) && isRecord(j.arms)) {
    const out: Found[] = [];
    for (const [suite, body] of Object.entries(j)) {
      if (!isRecord(body) || !Array.isArray(body.attempts)) continue;
      const arms = new Set<string>();
      for (const a of body.attempts)
        if (isRecord(a) && a.arm !== undefined)
          arms.add(`${String(a.arm)}/${String(a.model ?? "")}`);
      for (const arm of [...arms].sort())
        out.push(
          found({
            suite: `paired-run:${suite}`,
            group: suite.replace(/_.*$/, ""),
            key: `${path}|${suite}|${arm}`,
            label: `${arm} @ ${basename(dir)}`,
            adapter: "paired-run",
            source: { path, arm, options: { suite } },
          }),
        );
    }
    return out;
  }
  const records = Array.isArray(j) ? j : isRecord(j) && Array.isArray(j.items) ? j.items : [];
  const scored = records.filter(
    (r) =>
      isRecord(r) &&
      (typeof r.id === "string" || typeof r.id === "number") &&
      (typeof r.score === "number" || typeof r.score === "boolean"),
  ) as Array<Record<string, unknown>>;
  if (scored.length === 0 || scored.length < records.length / 2) return [];
  const stem = stripRep(name.replace(/\.jsonl?$/, ""));
  // Ids namespaced by their board ("forecastbench:…") name the suite.
  const prefixes = new Set(scored.map((r) => /^([a-z][\w.-]*):/i.exec(String(r.id))?.[1]));
  const prefix = prefixes.size === 1 ? [...prefixes][0] : undefined;
  const suite = suiteName(String(scored[0]?.suite ?? prefix ?? stem));
  const group = String(scored[0]?.group ?? groupOf(suite));
  const variants = [...new Set(scored.map((r) => r.variant).filter((v) => v !== undefined))].map(
    String,
  );
  if (variants.length === 0)
    return [
      found({
        suite,
        group,
        key: `${dir}|${stem}`,
        label: stem,
        adapter: "items",
        source: { path },
      }),
    ];
  return variants.sort().map((arm) =>
    found({
      suite,
      group,
      key: `${path}|${arm}`,
      label: `${arm} @ ${name}`,
      adapter: "items",
      source: { path, arm },
    }),
  );
}

/** Recognise a BrowseComp-Plus evals directory (one `run_N_eval.json` per query). */
function detectBrowsecomp(dir: string, files: string[], mtime: number): Found | undefined {
  const evals = files.filter((f) => /_eval\.json$/.test(f));
  if (evals.length === 0) return undefined;
  if (!head(join(dir, evals[0]!), 4096).includes('"query_id"')) return undefined;
  const hash = createHash("sha1")
    .update(evals.sort().join("\n"))
    .update(evals.map((f) => readFileSync(join(dir, f))).join(""))
    .digest("hex");
  const run = basename(dirname(dir));
  return {
    suite: "browsecomp-plus",
    group: "browsecomp",
    key: dir,
    label: `${basename(dirname(dirname(dir)))}/${run}`,
    adapter: "browsecomp",
    source: { path: dir },
    recorded: mtime,
    hash,
  };
}

interface Arm {
  found: Found;
  runs: ItemScore[][];
  versions: VersionScan;
}

function* walk(
  root: string,
  skip: Set<string>,
  skipped: Inventory["skipped"],
): Generator<{ path: string; files: string[] }> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    skipped.push({ path: root, reason: `unreadable: ${String(err)}` });
    return;
  }
  yield { path: root, files: entries.filter((e) => e.isFile()).map((e) => e.name) };
  for (const e of entries) {
    if (!e.isDirectory() || skip.has(e.name)) continue;
    // A source checkout's benchmarks/ holds code; only its results/ holds results.
    if (e.name === "benchmarks") {
      const results = join(root, e.name, "results");
      try {
        if (lstatSync(results).isDirectory()) yield* walk(results, skip, skipped);
      } catch {
        // allow-empty-catch: no results directory
      }
      continue;
    }
    yield* walk(join(root, e.name), skip, skipped);
  }
}

const iso = (t?: number) => (t === undefined ? undefined : new Date(t).toISOString().slice(0, 10));

/** Scan the roots and build the inventory. */
export function buildInventory(opts: InventoryOptions): Inventory {
  const minItems = opts.minItems ?? 10;
  const maxJson = opts.maxJsonBytes ?? 200 * 1024 * 1024;
  const skip = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);
  const log = opts.log ?? (() => {});
  const skipped: Inventory["skipped"] = [];
  const arms: Arm[] = [];
  const seenHashes = new Set<string>();
  const seenRuns = new Set<string>();
  let files = 0;
  let candidates = 0;
  let dbs = 0;
  let ledgers = 0;
  let duplicates = 0;
  /** Content hash → whether that file was a result source. */
  const detectCache = new Map<string, boolean>();

  const addArm = (f: Found) => {
    try {
      const adapter = adapterFor(f.adapter);
      const runs = loadRuns(adapter, f.source).filter((r) => r.length > 0);
      if (runs.length) arms.push({ found: f, runs, versions: sourceVersions(adapter, f.source) });
    } catch (err) {
      skipped.push({ path: f.source.path, reason: `${f.adapter}: ${String(err).slice(0, 200)}` });
    }
  };

  for (const root of opts.roots) {
    log(`scanning ${root}`);
    // A file root is scanned alone (e.g. one live world DB).
    const single = (() => {
      try {
        return lstatSync(root).isFile();
      } catch {
        return false;
      }
    })();
    const dirs = single
      ? [{ path: dirname(root), files: [basename(root)] }]
      : walk(root, skip, skipped);
    for (const { path: dir, files: names } of dirs) {
      files += names.length;
      const dirStat = lstatSync(dir);
      const bc = single ? undefined : detectBrowsecomp(dir, names, dirStat.mtimeMs);
      if (bc) {
        candidates++;
        if (seenHashes.has(bc.hash!)) duplicates++;
        else {
          seenHashes.add(bc.hash!);
          addArm(bc);
        }
      }
      for (const name of names) {
        const path = join(dir, name);
        if (/_eval\.json$/.test(name) && bc) continue;
        let st: import("node:fs").Stats;
        try {
          st = lstatSync(path);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (/\.(db|sqlite3?)$/.test(name)) {
          dbs++;
          readLedger(path);
          continue;
        }
        if (!/\.jsonl?$/.test(name) || st.size === 0) continue;
        if (st.size > maxJson) {
          skipped.push({ path, reason: `larger than ${maxJson} bytes` });
          continue;
        }
        let found: Found[];
        let hash: string;
        try {
          hash = createHash("sha1").update(readFileSync(path)).digest("hex");
          if (seenHashes.has(hash)) {
            // Only count duplicates of files that are results.
            if (detectCache.get(hash)) duplicates++;
            continue;
          }
          found = detectFile(path, st.mtimeMs, hash);
        } catch (err) {
          skipped.push({ path, reason: `unparsable: ${String(err).slice(0, 120)}` });
          continue;
        }
        seenHashes.add(hash);
        detectCache.set(hash, found.length > 0);
        if (found.length) candidates++;
        for (const f of found) addArm(f);
      }
    }
  }

  function readLedger(path: string) {
    let h: ReturnType<typeof openReadOnly> | undefined;
    try {
      h = openReadOnly(path, { maxCopyBytes: opts.maxCopyBytes ?? DEFAULT_MAX_COPY_BYTES });
      if (!hasLedger(h.db)) return;
      const runs = listLedgerRuns(h.db).filter(
        (r) => r.status === "completed" && !r.invalid && r.items > 0,
      );
      if (runs.length === 0) return;
      ledgers++;
      if (h.note) skipped.push({ path, reason: h.note });
      const byVariant = new Map<string, LedgerRun[]>();
      for (const r of runs) {
        if (seenRuns.has(r.id)) continue;
        seenRuns.add(r.id);
        const k = `${r.benchmark}|${runVariant(r)}|${r.group ?? ""}`;
        byVariant.set(k, [...(byVariant.get(k) ?? []), r]);
      }
      for (const [k, list] of byVariant) {
        const first = list[0]!;
        const label = runVariant(first);
        const started = list.map((r) => r.startedAt);
        arms.push({
          found: {
            suite: suiteName(first.benchmark),
            group: groupOf(suiteName(first.benchmark)),
            key: `ledger|${k}`,
            label: `${label}${first.group ? ` [${first.group}]` : ""}`,
            adapter: "ledger",
            source: {
              path,
              options: { run: list.map((r) => r.id).join(","), benchmark: first.benchmark },
            },
            recorded: Math.min(...started),
            recordedTo: Math.max(...started),
          },
          runs: list.map((r) => collapseTrials(ledgerItems(h!.db, r.id))),
          versions: ledgerVersions(list),
        });
      }
    } catch (err) {
      skipped.push({ path, reason: `db: ${String(err).slice(0, 160)}` });
    } finally {
      h?.close();
    }
  }

  return assemble(arms, { opts, minItems, skipped, files, candidates, dbs, ledgers, duplicates });
}

function ledgerVersions(runs: readonly LedgerRun[]): VersionScan {
  const stamps: MarinaVersion[] = [];
  let unstamped = 0;
  for (const r of runs) {
    if (r.version) addStamp(stamps, r.version);
    else unstamped++;
  }
  return { stamps, unstamped };
}

const commitLabels = (v: VersionScan) => [
  ...v.stamps.map(versionLabel),
  ...(v.unstamped ? [`unstamped×${v.unstamped}`] : []),
];

function pairVersions(a: VersionScan, b: VersionScan): PairInfo["versions"] {
  if (a.unstamped || b.unstamped) return "unknown";
  const both = mergeScans([a, b]);
  return both.stamps.length === 1 && !both.stamps[0]!.dirty ? "same-commit" : "mixed";
}

function assemble(
  arms: Arm[],
  ctx: {
    opts: InventoryOptions;
    minItems: number;
    skipped: Inventory["skipped"];
    files: number;
    candidates: number;
    dbs: number;
    ledgers: number;
    duplicates: number;
  },
): Inventory {
  // Merge arms sharing a key (replicates in separate files) into one variant.
  const bySuite = new Map<string, Map<string, { arms: Arm[] }>>();
  for (const a of arms) {
    const s = bySuite.get(a.found.suite) ?? new Map();
    bySuite.set(a.found.suite, s);
    const v = s.get(a.found.key) ?? { arms: [] };
    v.arms.push(a);
    s.set(a.found.key, v);
  }
  const suites: SuiteInfo[] = [];
  let identicalPairs = 0;
  for (const [suite, vars] of [...bySuite].sort(([a], [b]) => a.localeCompare(b))) {
    const infos: Array<
      VariantInfo & { ids: Set<string>; means: Map<string, number>; scan: VersionScan }
    > = [];
    for (const [key, { arms: list }] of vars) {
      const runs = list.flatMap((a) => a.runs);
      const sets = runs.map((r) => new Set(r.map((x) => x.id)));
      const ids = new Set([...(sets[0] ?? [])].filter((id) => sets.every((s) => s.has(id))));
      const means = new Map<string, number>();
      for (const run of runs)
        for (const x of run)
          if (ids.has(x.id)) means.set(x.id, (means.get(x.id) ?? 0) + x.score / runs.length);
      const ats = runs
        .flat()
        .map((x) => x.at)
        .filter((x): x is string => !!x && !Number.isNaN(Date.parse(x)))
        .sort();
      const recorded = list.flatMap((a) => [
        a.found.recorded,
        a.found.recordedTo ?? a.found.recorded,
      ]);
      const f = list[0]!.found;
      const scan = mergeScans(list.map((a) => a.versions));
      infos.push({
        key,
        label: f.label,
        adapter: f.adapter,
        sources: list.map((a) => a.found.source),
        replicates: runs.length,
        items: ids.size,
        ...(ats.length
          ? { itemsFrom: ats[0]!.slice(0, 10), itemsTo: ats.at(-1)!.slice(0, 10) }
          : {}),
        ...(recorded.length
          ? { recordedFrom: iso(Math.min(...recorded)), recordedTo: iso(Math.max(...recorded)) }
          : {}),
        commits: commitLabels(scan),
        ids,
        means,
        scan,
      });
    }
    infos.sort(
      (a, b) =>
        (a.recordedFrom ?? "").localeCompare(b.recordedFrom ?? "") || a.key.localeCompare(b.key),
    );
    // Disambiguate equal labels with the variant key.
    const counts = new Map<string, number>();
    for (const v of infos) counts.set(v.label, (counts.get(v.label) ?? 0) + 1);
    for (const v of infos)
      if ((counts.get(v.label) ?? 0) > 1) v.label = `${v.label} (${shortKey(v.key)})`;
    const group = arms.find((a) => a.found.suite === suite)!.found.group;
    const pairs: PairInfo[] = [];
    for (let i = 0; i < infos.length; i++) {
      for (let k = i + 1; k < infos.length; k++) {
        const a = infos[i]!;
        const b = infos[k]!;
        let overlap = 0;
        let absDelta = 0;
        for (const id of a.ids) {
          if (!b.ids.has(id)) continue;
          overlap++;
          absDelta += Math.abs((a.means.get(id) ?? 0) - (b.means.get(id) ?? 0));
        }
        if (overlap < ctx.minItems) continue;
        if (absDelta < 1e-9) {
          identicalPairs++;
          continue;
        }
        const sameAdapter = a.adapter === b.adapter;
        const tag = (v: VariantInfo) =>
          v.sources.map((s) => (sameAdapter ? s : { ...s, adapter: v.adapter }));
        pairs.push({
          baseline: a.label,
          candidate: b.label,
          overlap,
          versions: pairVersions(a.scan, b.scan),
          meanAbsDelta: Math.round((absDelta / overlap) * 1e4) / 1e4,
          suite: {
            name: `${suite}: ${a.label} vs ${b.label}`,
            group,
            adapter: a.adapter,
            baseline: tag(a),
            candidate: tag(b),
          },
        });
      }
    }
    pairs.sort((x, y) => y.overlap - x.overlap);
    suites.push({
      suite,
      group,
      variants: infos.map(({ ids: _ids, means: _means, scan: _scan, ...v }) => v),
      pairs,
    });
  }
  const groups = new Map<
    string,
    { suites: number; variants: number; pairs: number; maxItems: number }
  >();
  for (const s of suites) {
    const g = groups.get(s.group) ?? { suites: 0, variants: 0, pairs: 0, maxItems: 0 };
    g.suites++;
    g.variants += s.variants.length;
    g.pairs += s.pairs.length;
    g.maxItems = Math.max(g.maxItems, ...s.pairs.map((p) => p.overlap), 0);
    groups.set(s.group, g);
  }
  return {
    generatedAt: new Date().toISOString(),
    roots: ctx.opts.roots,
    minItems: ctx.minItems,
    scanned: { files: ctx.files, candidates: ctx.candidates, dbs: ctx.dbs, ledgers: ctx.ledgers },
    duplicates: ctx.duplicates,
    skipped: ctx.skipped,
    suites,
    identicalPairs,
    groups: [...groups]
      .map(([group, g]) => ({ group, ...g }))
      .sort((a, b) => b.pairs - a.pairs || a.group.localeCompare(b.group)),
  };
}

function shortKey(key: string): string {
  const parts = key.split("|")[0]!.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

/** Markdown summary of an inventory (paths and counts; no item content). */
export function renderInventory(inv: Inventory, opts: { pairsPerSuite?: number } = {}): string {
  const top = opts.pairsPerSuite ?? 5;
  const lines = [
    "# Per-item result inventory",
    "",
    `Generated ${inv.generatedAt}. Roots: ${inv.roots.map((r) => `\`${r}\``).join(", ")}.`,
    "",
    `Scanned ${inv.scanned.files} files (${inv.scanned.candidates} result sources, ${inv.duplicates} byte-identical copies counted once) and ${inv.scanned.dbs} SQLite files (${inv.scanned.ledgers} with benchmark ledger runs). A pair needs ≥ ${inv.minItems} shared items; ${inv.identicalPairs} pair(s) with identical scores on every shared item (one run recorded twice, e.g. a result file and its ledger filing) are left out.`,
    "",
    "## Independent groups",
    "",
    "| Group | Suites | Variants | Usable pairs | Most shared items |",
    "|---|---:|---:|---:|---:|",
    ...inv.groups.map(
      (g) => `| ${g.group} | ${g.suites} | ${g.variants} | ${g.pairs} | ${g.maxItems || "—"} |`,
    ),
    "",
    `Groups with at least one usable pair: ${inv.groups.filter((g) => g.pairs > 0).length} (${inv.groups
      .filter((g) => g.pairs > 0)
      .map((g) => g.group)
      .join(", ")}).`,
    "",
    "## Suites",
  ];
  for (const s of inv.suites) {
    lines.push(
      "",
      `### ${s.suite} (group ${s.group})`,
      "",
      `${s.variants.length} variant(s), ${s.pairs.length} usable pair(s).`,
      "",
      "| Variant | Adapter | Replicates | Items | Item dates | Recorded | Commits |",
      "|---|---|---:|---:|---|---|---|",
    );
    for (const v of s.variants.slice(0, 40)) {
      lines.push(
        `| ${v.label.replace(/\|/g, "\\|")} | ${v.adapter} | ${v.replicates} | ${v.items} | ${v.itemsFrom ? `${v.itemsFrom} … ${v.itemsTo}` : "—"} | ${v.recordedFrom ? `${v.recordedFrom} … ${v.recordedTo}` : "—"} | ${v.commits.join(", ") || "—"} |`,
      );
    }
    if (s.variants.length > 40) lines.push(`| … ${s.variants.length - 40} more | | | | | | |`);
    if (s.pairs.length) {
      lines.push("", `Top pairs by shared items:`, "");
      for (const p of s.pairs.slice(0, top))
        lines.push(
          `- ${p.overlap} items: \`${p.baseline}\` vs \`${p.candidate}\` (${p.versions === "same-commit" ? "same commit" : p.versions === "mixed" ? "MIXED commits: refused unless versions are declared" : "commit unknown: needs --allow-unversioned"})`,
        );
    }
    const paths = [...new Set(s.variants.flatMap((v) => v.sources.map((x) => x.path)))];
    lines.push(
      "",
      `<details><summary>${paths.length} source path(s)</summary>`,
      "",
      ...paths.slice(0, 60).map((p) => `- \`${p}\``),
      ...(paths.length > 60 ? [`- … ${paths.length - 60} more (see the JSON inventory)`] : []),
      "",
      "</details>",
    );
  }
  if (inv.skipped.length) {
    lines.push("", "## Skipped", "");
    const reasons = new Map<string, number>();
    for (const s of inv.skipped) {
      const r = s.reason.replace(/:.*$/, "");
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
    for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) lines.push(`- ${n} × ${r}`);
    lines.push("", "Every skipped path and its reason is in the JSON inventory.");
  }
  return `${lines.join("\n")}\n`;
}
