// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Transfer spec: the baseline and candidate configurations (env-knob
 * overlays) and the suites to judge them on. Each suite either INGESTS result
 * files that already exist (no spend) or, only when the caller allows it,
 * RUNS a command once per arm and replicate with the arm's overlay on top of
 * the environment, then ingests what it wrote.
 *
 * Held-out split (default for every suite): items are kept only on the
 * `holdout` side of the same stable hash split benchmark promotion uses
 * (`itemSplit(slot, id, fraction)`, slot `transfer:<group>`, fraction 0.5),
 * so the items a capability was tuned on (pass that slot) never count as
 * evidence for it. A `time` split keeps items whose evidence cutoff `at` is
 * on or after a date instead. `"all"` opts out and the report says so.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { itemSplit } from "../../src/engine/benchmark-promotion";
import { adapterFor, loadRuns, type Source } from "./adapters";
import type { ItemScore, SuiteData, TransferOptions } from "./core";

export interface ArmConfig {
  label: string;
  /** Env-knob overlay: applied on top of the environment when a suite runs. */
  env?: Record<string, string>;
}

export type SplitSpec =
  | "all"
  | { kind: "hash"; slot?: string; holdoutFraction?: number; part?: "holdout" | "selection" }
  | { kind: "time"; after: string };

export interface RunSpec {
  /** argv; `{out}`, `{arm}` and `{replicate}` are substituted. Never a shell. */
  command: string[];
  replicates?: number;
  cwd?: string;
}

export interface SuiteSpec {
  name: string;
  /** Independence group (default: the suite name). */
  group?: string;
  adapter: string;
  baseline?: Array<string | Source>;
  candidate?: Array<string | Source>;
  /** Column names in multi-forecaster files (sources may also set `arm`). */
  arms?: { baseline?: string; candidate?: string };
  /** Adapter options applied to every source of this suite. */
  options?: Record<string, string>;
  split?: SplitSpec;
  run?: RunSpec;
}

export interface TransferSpec {
  baseline: ArmConfig;
  candidate: ArmConfig;
  suites: SuiteSpec[];
  /** Default split for suites that set none. */
  split?: SplitSpec;
  stats?: TransferOptions;
}

export type ArmName = "baseline" | "candidate";

/** Runs one command; returns its exit code. Injected so tests never spawn paid work. */
export type CommandRunner = (
  argv: string[],
  opts: { env: Record<string, string>; cwd: string },
) => number;

export const spawnRunner: CommandRunner = (argv, opts) => {
  const p = Bun.spawnSync(argv, {
    env: opts.env,
    cwd: opts.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  return p.exitCode ?? 1;
};

export interface LoadOptions {
  /** Directory relative source paths resolve against (the spec file's). */
  baseDir: string;
  /** Allow `run` suites to execute (default false: ingest only). */
  allowRun?: boolean;
  /** Where `run` suites write their outputs. */
  outDir?: string;
  runner?: CommandRunner;
  /** Overrides every suite's split. */
  split?: SplitSpec;
  env?: Record<string, string | undefined>;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function checkSplit(split: unknown, where: string): void {
  if (split === undefined || split === "all") return;
  if (isObj(split) && split.kind === "time" && typeof split.after === "string") return;
  if (
    isObj(split) &&
    split.kind === "hash" &&
    (split.part === undefined || split.part === "holdout" || split.part === "selection")
  )
    return;
  throw new Error(`${where}: "all", {kind:"hash",…} or {kind:"time",after}`);
}

/** Validate a parsed spec (throws with the first problem). */
export function parseSpec(raw: unknown): TransferSpec {
  if (!isObj(raw)) throw new Error("spec must be a JSON object");
  for (const arm of ["baseline", "candidate"] as const) {
    const a = raw[arm];
    if (!isObj(a) || typeof a.label !== "string") throw new Error(`spec.${arm}.label is required`);
    if (a.env !== undefined) {
      if (!isObj(a.env) || Object.values(a.env).some((v) => typeof v !== "string"))
        throw new Error(`spec.${arm}.env must map names to strings`);
    }
  }
  if (!Array.isArray(raw.suites) || raw.suites.length === 0)
    throw new Error("spec.suites must be a non-empty array");
  checkSplit(raw.split, "spec.split");
  const names = new Set<string>();
  for (const s of raw.suites) {
    if (!isObj(s) || typeof s.name !== "string" || typeof s.adapter !== "string")
      throw new Error("every suite needs a name and an adapter");
    if (names.has(s.name)) throw new Error(`duplicate suite name ${s.name}`);
    names.add(s.name);
    adapterFor(s.adapter);
    checkSplit(s.split, `suite ${s.name} split`);
    const listed = Array.isArray(s.baseline) || Array.isArray(s.candidate);
    if (!listed && !isObj(s.run)) throw new Error(`suite ${s.name}: give sources or a run`);
  }
  return raw as unknown as TransferSpec;
}

export function readSpec(path: string): TransferSpec {
  return parseSpec(JSON.parse(readFileSync(path, "utf8")));
}

function splitLabel(split: SplitSpec, group: string): string {
  if (split === "all") return "all items (not held out)";
  if (split.kind === "time") return `time ≥ ${split.after}`;
  return `${split.part ?? "holdout"} ${Math.round((split.holdoutFraction ?? 0.5) * 100)} % of ${split.slot ?? `transfer:${group}`}`;
}

/** Apply a split to one run; removed ids accumulate into `removed` by reason. */
export function applySplit(
  items: ItemScore[],
  split: SplitSpec,
  group: string,
  removed: Map<string, Set<string>>,
): ItemScore[] {
  if (split === "all") return items;
  const bump = (reason: string, id: string) => {
    const ids = removed.get(reason) ?? new Set<string>();
    ids.add(id);
    removed.set(reason, ids);
  };
  if (split.kind === "time") {
    const after = Date.parse(split.after);
    if (Number.isNaN(after)) throw new Error(`time split: bad date ${split.after}`);
    return items.filter((x) => {
      if (!x.at || Number.isNaN(Date.parse(x.at))) {
        bump("no timestamp (time split)", x.id);
        return false;
      }
      if (Date.parse(x.at) < after) {
        bump("before the time split", x.id);
        return false;
      }
      return true;
    });
  }
  const slot = split.slot ?? `transfer:${group}`;
  const fraction = split.holdoutFraction ?? 0.5;
  const part = split.part ?? "holdout";
  if (!(fraction > 0 && fraction < 1)) throw new Error("holdoutFraction must be in (0, 1)");
  return items.filter((x) => {
    if (itemSplit(slot, x.id, fraction) === part) return true;
    bump(`not in ${part} split`, x.id);
    return false;
  });
}

function toSource(s: string | Source, baseDir: string, suite: SuiteSpec, arm: ArmName): Source {
  const src: Source = typeof s === "string" ? { path: s } : { ...s };
  src.path = isAbsolute(src.path) ? src.path : resolve(baseDir, src.path);
  src.arm ??= suite.arms?.[arm];
  if (suite.options) src.options = { ...suite.options, ...(src.options ?? {}) };
  return src;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

function runSources(
  spec: TransferSpec,
  suite: SuiteSpec,
  arm: ArmName,
  opts: LoadOptions,
): Array<string | Source> {
  const run = suite.run;
  if (!run) throw new Error(`suite ${suite.name}: no ${arm} sources`);
  if (!opts.allowRun)
    throw new Error(
      `suite ${suite.name}: no ${arm} result files listed and running is off (pass --run to execute its command)`,
    );
  if (
    !Array.isArray(run.command) ||
    run.command.length === 0 ||
    run.command.some((a) => typeof a !== "string")
  )
    throw new Error(`suite ${suite.name}: run.command must be a non-empty argv array`);
  const outDir = join(opts.outDir ?? join(opts.baseDir, "transfer-runs"), safeName(suite.name));
  mkdirSync(outDir, { recursive: true });
  const runner = opts.runner ?? spawnRunner;
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined) base[k] = v;
  const env = { ...base, ...(spec[arm].env ?? {}) };
  const outs: string[] = [];
  for (let r = 1; r <= Math.max(1, run.replicates ?? 1); r++) {
    const out = join(outDir, `${safeName(spec[arm].label)}-r${r}.json`);
    const argv = run.command.map((a) =>
      a
        .replaceAll("{out}", out)
        .replaceAll("{arm}", spec[arm].label)
        .replaceAll("{replicate}", String(r)),
    );
    const code = runner(argv, {
      env,
      cwd: run.cwd ? resolve(opts.baseDir, run.cwd) : opts.baseDir,
    });
    if (code !== 0) throw new Error(`suite ${suite.name}: ${arm} replicate ${r} exited ${code}`);
    outs.push(out);
  }
  return outs;
}

/** Load (or, if allowed, run then load) every suite of a spec. */
export function loadSuites(spec: TransferSpec, opts: LoadOptions): SuiteData[] {
  return spec.suites.map((suite) => {
    const group = suite.group ?? suite.name;
    const split = opts.split ?? suite.split ?? spec.split ?? { kind: "hash" };
    const removed = new Map<string, Set<string>>();
    const arm = (name: ArmName) => {
      const listed = suite[name];
      const sources = listed?.length ? listed : runSources(spec, suite, name, opts);
      return sources.flatMap((s) => {
        const source = toSource(s, opts.baseDir, suite, name);
        const adapter = adapterFor(source.adapter ?? suite.adapter);
        if (split !== "all" && split.kind === "time" && !adapter.timed)
          throw new Error(
            `suite ${suite.name}: adapter ${adapter.name} has no item times for a time split`,
          );
        return loadRuns(adapter, source).map((run) => applySplit(run, split, group, removed));
      });
    };
    const baseline = arm("baseline");
    const candidate = arm("candidate");
    return {
      name: suite.name,
      group,
      baseline,
      candidate,
      split: splitLabel(split, group),
      removed: Object.fromEntries([...removed].map(([k, ids]) => [k, ids.size])),
    };
  });
}

export function specDir(path: string): string {
  return dirname(resolve(path));
}
