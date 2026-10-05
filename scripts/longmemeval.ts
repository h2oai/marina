#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LongMemEval-V2 run folders → summary and ledger file (thin adapter; see
 * docs/guides/longmemeval.md).
 *
 *   bun run longmemeval summary <web run dir> <enterprise run dir>
 *   bun run longmemeval convert <web run dir> <enterprise run dir> --out f.json \
 *     --target marina-memory:lexical [--benchmark longmemeval-v2-small]
 *
 * The runs come from `benchmarks/longmemeval/run.py` (the official harness with
 * Marina's memory backend). `convert` writes the harness-shaped file
 * `bun run benchmark:import` reads: question ids and verdicts only.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { readRun, summarize, toHarness } from "../benchmarks/longmemeval/convert";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    out: { type: "string" },
    target: { type: "string" },
    benchmark: { type: "string" },
  },
});
const [cmd, ...dirs] = positionals;
if (!cmd || (cmd !== "summary" && cmd !== "convert") || dirs.length === 0) {
  console.error(
    "usage: bun run longmemeval summary|convert <run dir>… [--out f.json --target id] [--benchmark id]",
  );
  process.exit(2);
}
const runs = dirs.map(readRun);
if (cmd === "summary") {
  console.log(JSON.stringify(summarize(runs), null, 2));
  process.exit(0);
}
if (!values.out || !values.target) {
  console.error("convert needs --out and --target");
  process.exit(2);
}
const tier = runs[0]!.dir.match(/_(small|medium)\/?$/)?.[1] ?? "small";
const file = toHarness(runs, {
  benchmark: values.benchmark ?? `longmemeval-v2-${tier}`,
  target: values.target,
});
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, `${JSON.stringify(file, null, 2)}\n`);
console.log(`${file.items?.length ?? 0} items → ${values.out}`);
