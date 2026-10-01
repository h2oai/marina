#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Paired comparison of two harness result files (two arms, same items).
 *
 *   bun run bench:compare <runA.json> <runB.json> [--json] [--seed N] [--resamples N]
 *   bun run bench:compare <tier0-dirA> <tier0-dirB>     # every set present in both
 *
 * Items are paired by id; ids present in only one run are counted and left out.
 * Reports per-arm accuracy with a 95 % Wilson interval, McNemar's exact test on
 * the discordant pairs, a paired bootstrap of the accuracy difference (B − A),
 * and per-arm dollars and tokens as the endpoints reported them ("n/a" when no
 * cost was reported — never estimated).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type BootstrapResult,
  type Interval,
  type McNemarResult,
  mcnemarExact,
  pairedBootstrap,
  wilsonInterval,
} from "./stats";
import type { BenchmarkResult, ResultItem, UsageSummary } from "./types";
import { formatUsd, summarizeUsage, totalCostUsd } from "./usage";

export interface ArmReport {
  label: string;
  benchmark: string;
  model: string;
  endpoint: string;
  /** Items in the paired set. */
  n: number;
  correct: number;
  errors: number;
  accuracy: number;
  wilson: Interval;
  /** Usage over the PAIRED items only, so per-item dollars compare like for like. */
  usage: UsageSummary;
  costUsd?: number;
  costPerItemUsd?: number;
}

export interface CompareReport {
  arms: [ArmReport, ArmReport];
  paired: number;
  onlyInA: number;
  onlyInB: number;
  /** Duplicate ids within one run (the first occurrence is used). */
  duplicateIds: number;
  mcnemar: McNemarResult;
  bootstrap: BootstrapResult;
  warnings: string[];
}

function indexById(items: ResultItem[]): { map: Map<string, ResultItem>; dups: number } {
  const map = new Map<string, ResultItem>();
  let dups = 0;
  for (const item of items) {
    if (map.has(item.id)) dups++;
    else map.set(item.id, item);
  }
  return { map, dups };
}

function arm(label: string, run: BenchmarkResult, items: ResultItem[]): ArmReport {
  const correct = items.filter((i) => i.correct).length;
  const usage = summarizeUsage(items);
  const costUsd = totalCostUsd(usage);
  return {
    label,
    benchmark: run.config?.name ?? run.config?.dataset ?? "?",
    model: run.config?.model ?? "?",
    endpoint: run.config?.endpoint ?? "?",
    n: items.length,
    correct,
    errors: items.filter((i) => i.actual?.startsWith("ERROR:")).length,
    accuracy: items.length > 0 ? correct / items.length : 0,
    wilson: wilsonInterval(correct, items.length),
    usage,
    costUsd,
    costPerItemUsd: costUsd !== undefined && items.length > 0 ? costUsd / items.length : undefined,
  };
}

/** Pair two runs by item id and compute every statistic. Pure. */
export function compareRuns(
  a: BenchmarkResult,
  b: BenchmarkResult,
  opts: { labels?: [string, string]; seed?: number; resamples?: number } = {},
): CompareReport {
  const ia = indexById(a.items ?? []);
  const ib = indexById(b.items ?? []);
  const ids = [...ia.map.keys()].filter((id) => ib.map.has(id)).sort();
  const pa = ids.map((id) => ia.map.get(id) as ResultItem);
  const pb = ids.map((id) => ib.map.get(id) as ResultItem);
  let bCount = 0;
  let cCount = 0;
  for (let i = 0; i < ids.length; i++) {
    const x = pa[i]?.correct === true;
    const y = pb[i]?.correct === true;
    if (x && !y) bCount++;
    else if (!x && y) cCount++;
  }
  const warnings: string[] = [];
  if (a.config?.dataset !== b.config?.dataset) {
    warnings.push(`different datasets: ${a.config?.dataset} vs ${b.config?.dataset}`);
  }
  if (ids.length === 0) warnings.push("no shared item ids — nothing to pair");
  const [la, lb] = opts.labels ?? ["A", "B"];
  return {
    arms: [arm(la, a, pa), arm(lb, b, pb)],
    paired: ids.length,
    onlyInA: ia.map.size - ids.length,
    onlyInB: ib.map.size - ids.length,
    duplicateIds: ia.dups + ib.dups,
    mcnemar: mcnemarExact(bCount, cCount),
    bootstrap: pairedBootstrap(
      pa.map((i) => i.correct === true),
      pb.map((i) => i.correct === true),
      { seed: opts.seed ?? 1, resamples: opts.resamples ?? 10_000 },
    ),
    warnings,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signedPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;

function tokens(u: UsageSummary): string {
  if (u.promptTokens === undefined && u.completionTokens === undefined) return "n/a";
  return `${u.promptTokens ?? "n/a"} in / ${u.completionTokens ?? "n/a"} out`;
}

function priced(r: ArmReport): string {
  if (r.costUsd === undefined) return "n/a";
  const partial = r.usage.pricedItems < r.n ? ` (priced ${r.usage.pricedItems}/${r.n})` : "";
  return `${formatUsd(r.costUsd)}${partial}`;
}

function formatP(p: number): string {
  if (p >= 0.001) return p.toFixed(3);
  return p.toExponential(1);
}

/** Plain-text report. Pure — the CLI only prints it. */
export function formatCompareReport(report: CompareReport): string {
  const lines: string[] = [];
  const [a, b] = report.arms;
  lines.push(`Paired comparison — ${a.benchmark}`);
  lines.push(
    `  paired items: ${report.paired}` +
      (report.onlyInA || report.onlyInB
        ? ` (unpaired: ${report.onlyInA} only in ${a.label}, ${report.onlyInB} only in ${b.label})`
        : ""),
  );
  for (const w of report.warnings) lines.push(`  warning: ${w}`);
  if (report.duplicateIds > 0) {
    lines.push(`  warning: ${report.duplicateIds} duplicate item id(s); first occurrence used`);
  }
  lines.push("");
  for (const r of report.arms) {
    lines.push(`  ${r.label}: ${r.model} @ ${r.endpoint}`);
    lines.push(
      `    accuracy  ${pct(r.accuracy)} (${r.correct}/${r.n})  95% Wilson [${pct(r.wilson.low)}, ${pct(r.wilson.high)}]` +
        (r.errors > 0 ? `  errors ${r.errors}` : ""),
    );
    lines.push(
      `    cost      ${priced(r)}  per item ${formatUsd(r.costPerItemUsd)}` +
        (r.usage.judgeCostUsd !== undefined ? `  (judge ${formatUsd(r.usage.judgeCostUsd)})` : ""),
    );
    lines.push(`    tokens    ${tokens(r.usage)}`);
  }
  lines.push("");
  const m = report.mcnemar;
  lines.push(
    `  McNemar exact: ${a.label}-only correct ${m.b}, ${b.label}-only correct ${m.c}, p = ${formatP(m.p)}`,
  );
  const bs = report.bootstrap;
  lines.push(
    `  Paired bootstrap ${b.label} − ${a.label}: ${signedPct(bs.diff)}  95% CI [${signedPct(bs.interval.low)}, ${signedPct(bs.interval.high)}]  (${bs.resamples} resamples)`,
  );
  return lines.join("\n");
}

/**
 * Two files compare directly; two directories (e.g. two `bench:tier0` runs)
 * compare every result file present in both, matched by name.
 */
export function filePairs(a: string, b: string): [string, string][] {
  const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
  if (!isDir(a) || !isDir(b)) return [[a, b]];
  const results = (d: string) =>
    readdirSync(d).filter((f) => f.endsWith(".json") && f !== "summary.json");
  const inB = new Set(results(b));
  return results(a)
    .filter((f) => inB.has(f))
    .sort()
    .map((f) => [join(a, f), join(b, f)]);
}

function load(path: string): BenchmarkResult {
  return JSON.parse(readFileSync(path, "utf-8")) as BenchmarkResult;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean" },
      seed: { type: "string" },
      resamples: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help || positionals.length !== 2) {
    console.log(
      "usage: bun run bench:compare <runA.json> <runB.json> [--json] [--seed N] [--resamples N]",
    );
    process.exit(values.help ? 0 : 1);
  }
  const [pathA, pathB] = positionals as [string, string];
  const opts = {
    seed: values.seed ? Number.parseInt(values.seed, 10) : undefined,
    resamples: values.resamples ? Number.parseInt(values.resamples, 10) : undefined,
  };
  const pairs = filePairs(pathA, pathB);
  if (pairs.length === 0) {
    console.error("no result files to compare (two directories share no *.json set name)");
    process.exit(1);
  }
  const reports = pairs.map(([fa, fb]) => ({
    a: fa,
    b: fb,
    report: compareRuns(load(fa), load(fb), opts),
  }));
  if (values.json) console.log(JSON.stringify(reports, null, 2));
  else {
    console.log(`A = ${pathA}\nB = ${pathB}`);
    for (const r of reports) console.log(`\n${formatCompareReport(r.report)}`);
  }
}
