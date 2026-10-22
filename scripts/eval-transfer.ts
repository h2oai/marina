#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Transfer report: does a candidate configuration improve results on at
 * least two independent evaluations, not just the one it was built for?
 *
 *   bun run eval:transfer --spec <spec.json> [--out <prefix>] [--split all|holdout|selection|after:<date>]
 *                         [--seed N] [--resamples N] [--alpha A] [--margin M] [--min-items N]
 *                         [--bootstrap items|two-stage] [--run [--run-dir <dir>]] [--json]
 *                         [--allow-unversioned]
 *   bun run eval:transfer --adapters
 *   bun run eval:transfer --inventory <root…> [--out <prefix>] [--min-items N] [--max-copy-mb N]
 *
 * Ingest-only by default: every suite reads result files that already exist.
 * `--run` lets a suite with a `run` command execute it (once per arm and
 * replicate, the arm's env overlay on top of the environment) — that can
 * spend money, so it is never implied. Writes `<prefix>.md` and
 * `<prefix>.json` (default `transfer-report`). Exit 0 when the verdict is
 * `transfers`, 2 for any other verdict, 1 on error.
 *
 * Test the right versions: every source's Marina commit stamp is checked. By
 * default both arms of a suite must come from one clean commit (warned when
 * it is behind origin/main); mixed, unstamped or dirty sources make the suite
 * `version-mismatch` / `version-unknown`, reported and not counted. A spec's
 * `versions: {baseline, candidate}` declares a deliberate release-vs-release
 * comparison. `--allow-unversioned` ingests unstamped files, labelled loudly.
 *
 * `--inventory` walks the roots you name (directories or DB files; at least one is
 * required) read-only and writes `<prefix>.md` / `<prefix>.json`
 * (default `transfer-inventory`): every per-item result source an adapter can read, per
 * suite its variants, items and dates, and the baseline/candidate pairs with ready suite
 * entries.
 *
 * Spec format, adapters and how to add a suite: benchmarks/README.md →
 * "Transfer report". Library: benchmarks/transfer/.
 */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ADAPTERS } from "../benchmarks/transfer/adapters";
import { renderMarkdown, type TransferOptions, transferVerdict } from "../benchmarks/transfer/core";
import { buildInventory, renderInventory } from "../benchmarks/transfer/inventory";
import { loadSuites, readSpec, type SplitSpec, specDir } from "../benchmarks/transfer/spec";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    spec: { type: "string" },
    out: { type: "string" },
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
    bootstrap: { type: "string" },
    inventory: { type: "boolean", default: false },
    "max-copy-mb": { type: "string" },
    "allow-unversioned": { type: "boolean", default: false },
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
  if (values.inventory) return inventory();
  if (!values.spec) {
    console.error("usage: bun run eval:transfer --spec <spec.json> [--out <prefix>] [--run]");
    return 1;
  }
  const out = values.out ?? "transfer-report";
  const spec = readSpec(values.spec);
  const split = splitFlag(values.split);
  const suites = loadSuites(spec, {
    baseDir: specDir(values.spec),
    allowRun: values.run,
    ...(values["run-dir"] ? { outDir: values["run-dir"] } : {}),
    ...(split ? { split } : {}),
    allowUnversioned: values["allow-unversioned"],
  });
  const flags: TransferOptions = {};
  type NumericOption = Exclude<keyof TransferOptions, "bootstrap">;
  const set = (k: NumericOption, v: number | undefined) => {
    if (v !== undefined) flags[k] = v;
  };
  set("seed", num("seed", values.seed));
  set("resamples", num("resamples", values.resamples));
  set("alpha", num("alpha", values.alpha));
  set("margin", num("margin", values.margin));
  set("minItems", num("min-items", values["min-items"]));
  if (values.bootstrap !== undefined) {
    if (values.bootstrap !== "items" && values.bootstrap !== "two-stage")
      throw new Error("--bootstrap must be items or two-stage");
    flags.bootstrap = values.bootstrap;
  }
  const result = transferVerdict(suites, { ...(spec.stats ?? {}), ...flags });
  const generatedAt = new Date().toISOString();
  const header = {
    generatedAt,
    baseline: spec.baseline,
    candidate: spec.candidate,
    ...(spec.versions ? { versions: spec.versions } : {}),
    ...(values["allow-unversioned"] ? { allowUnversioned: true } : {}),
  };
  const markdown = renderMarkdown(result, header);
  const json = JSON.stringify({ ...header, ...result }, null, 2);
  writeFileSync(`${out}.md`, markdown);
  writeFileSync(`${out}.json`, `${json}\n`);
  console.log(values.json ? json : markdown);
  for (const s of result.suites) {
    if (s.version && !s.version.counted)
      console.error(`version guard: ${s.name} ${s.outcome} — ${s.version.reason}`);
    for (const w of s.version?.warnings ?? []) console.error(`version warning: ${s.name}: ${w}`);
  }
  if (values["allow-unversioned"])
    console.error("WARNING: --allow-unversioned: unstamped result files were counted");
  console.error(`report → ${out}.md, ${out}.json`);
  return result.verdict === "transfers" ? 0 : 2;
}

function inventory(): number {
  if (positionals.length === 0) {
    console.error(
      "usage: bun run eval:transfer --inventory <root…> [--out <prefix>] [--min-items N] [--max-copy-mb N]\n" +
        "  name at least one directory or DB file to walk (for example ~/.cache/marina-<name>)",
    );
    return 1;
  }
  const out = values.out ?? "transfer-inventory";
  const roots = positionals;
  const maxCopy = num("max-copy-mb", values["max-copy-mb"]);
  const inv = buildInventory({
    roots,
    ...(values["min-items"] ? { minItems: num("min-items", values["min-items"])! } : {}),
    ...(maxCopy !== undefined ? { maxCopyBytes: maxCopy * 1024 * 1024 } : {}),
    log: (line) => console.error(line),
  });
  const json = JSON.stringify(inv, null, 2);
  writeFileSync(`${out}.md`, renderInventory(inv));
  writeFileSync(`${out}.json`, `${json}\n`);
  console.log(values.json ? json : renderInventory(inv));
  console.error(`inventory → ${out}.md, ${out}.json`);
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
