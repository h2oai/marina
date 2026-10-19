#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Transfer report: does a candidate configuration improve results on at
 * least two independent evaluations, not just the one it was built for?
 *
 *   bun run eval:transfer --spec <spec.json> [--out <prefix>] [--split all|holdout|selection|after:<date>]
 *                         [--seed N] [--resamples N] [--alpha A] [--margin M] [--min-items N]
 *                         [--run [--run-dir <dir>]] [--json]
 *   bun run eval:transfer --adapters
 *
 * Ingest-only by default: every suite reads result files that already exist.
 * `--run` lets a suite with a `run` command execute it (once per arm and
 * replicate, the arm's env overlay on top of the environment) — that can
 * spend money, so it is never implied. Writes `<prefix>.md` and
 * `<prefix>.json` (default `transfer-report`). Exit 0 when the verdict is
 * `transfers`, 2 for any other verdict, 1 on error.
 *
 * Spec format, adapters and how to add a suite: benchmarks/README.md →
 * "Transfer report". Library: benchmarks/transfer/.
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ADAPTERS } from "../benchmarks/transfer/adapters";
import { renderMarkdown, type TransferOptions, transferVerdict } from "../benchmarks/transfer/core";
import { loadSuites, readSpec, type SplitSpec, specDir } from "../benchmarks/transfer/spec";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    spec: { type: "string" },
    out: { type: "string", default: "transfer-report" },
    split: { type: "string" },
    seed: { type: "string" },
    resamples: { type: "string" },
    alpha: { type: "string" },
    margin: { type: "string" },
    "min-items": { type: "string" },
    run: { type: "boolean", default: false },
    "run-dir": { type: "string" },
    json: { type: "boolean", default: false },
    adapters: { type: "boolean", default: false },
  },
});

function num(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

function splitFlag(raw: string | undefined): SplitSpec | undefined {
  if (raw === undefined) return undefined;
  if (raw === "all") return "all";
  if (raw === "holdout" || raw === "selection") return { kind: "hash", part: raw };
  if (raw.startsWith("after:")) return { kind: "time", after: raw.slice(6) };
  throw new Error("--split must be all, holdout, selection or after:<date>");
}

function main(): number {
  if (values.adapters) {
    for (const a of Object.values(ADAPTERS)) console.log(`${a.name.padEnd(16)} ${a.description}`);
    return 0;
  }
  if (!values.spec) {
    console.error("usage: bun run eval:transfer --spec <spec.json> [--out <prefix>] [--run]");
    return 1;
  }
  const spec = readSpec(values.spec);
  const split = splitFlag(values.split);
  const suites = loadSuites(spec, {
    baseDir: specDir(values.spec),
    allowRun: values.run,
    ...(values["run-dir"] ? { outDir: values["run-dir"] } : {}),
    ...(split ? { split } : {}),
  });
  const flags: TransferOptions = {};
  const set = <K extends keyof TransferOptions>(k: K, v: number | undefined) => {
    if (v !== undefined) flags[k] = v;
  };
  set("seed", num("seed", values.seed));
  set("resamples", num("resamples", values.resamples));
  set("alpha", num("alpha", values.alpha));
  set("margin", num("margin", values.margin));
  set("minItems", num("min-items", values["min-items"]));
  const result = transferVerdict(suites, { ...(spec.stats ?? {}), ...flags });
  const generatedAt = new Date().toISOString();
  const header = { baseline: spec.baseline, candidate: spec.candidate, generatedAt };
  const markdown = renderMarkdown(result, header);
  const json = JSON.stringify({ generatedAt, ...header, ...result }, null, 2);
  writeFileSync(`${values.out}.md`, markdown);
  writeFileSync(`${values.out}.json`, `${json}\n`);
  console.log(values.json ? json : markdown);
  console.error(`report → ${values.out}.md, ${values.out}.json`);
  return result.verdict === "transfers" ? 0 : 2;
}

try {
  process.exit(main());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
