#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * IFBench through Marina (the reproduction kit's `ifbench` setup drives it, see
 * docs/guides/reproduce.md).
 *
 *   bun scripts/ifbench.ts answer --input in.jsonl --endpoint http://localhost:PORT --model id
 *       --out responses.jsonl [--subset-out subset.jsonl] [--limit N] [--concurrency 4]
 *       [--header KEY=VALUE …]
 *       one chat completion per prompt; the bearer comes from MARINA_BENCH_API_KEY
 *       (environment only, never argv). Writes the grader's `{prompt, response}` JSONL
 *       (plus key, latency and trace id) and the exact input subset it answered.
 *   bun scripts/ifbench.ts convert <grader-output-dir> --input subset.jsonl
 *       --responses responses.jsonl --out f.json [--mode strict|loose] [--stack v]
 *       [--require-clean]
 *       the official grader's verdicts → a harness-shaped file for `bun run benchmark:import`
 *
 * Grading is IFBench's own `python -m run_eval` from an IFBench checkout, unmodified.
 * `--require-clean` refuses (exit 3, no ledger file) when any prompt has no answer
 * (a transport or server error) or no verdict. Only input keys and outcomes reach the
 * ledger — never prompt or response text.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  answerAll,
  gradedFileFor,
  type IfbenchGraded,
  type IfbenchInput,
  type IfbenchMode,
  type IfbenchResponse,
  ifbenchToHarness,
  parseHeaderFlags,
  parseJsonl,
  subsetInputs,
  toJsonl,
} from "../benchmarks/ifbench/ifbench";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    input: { type: "string" },
    endpoint: { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
    "subset-out": { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string" },
    header: { type: "string", multiple: true },
    responses: { type: "string" },
    mode: { type: "string" },
    stack: { type: "string" },
    "require-clean": { type: "boolean" },
  },
});

function fail(msg: string, code = 2): never {
  console.error(`ifbench: ${msg}`);
  process.exit(code);
}

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const [cmd, dir] = positionals;
if (cmd === "answer") {
  if (!values.input || !values.endpoint || !values.model || !values.out) {
    fail("answer needs --input, --endpoint, --model and --out");
  }
  const inputs = subsetInputs(
    parseJsonl<IfbenchInput>(readFileSync(values.input, "utf8")),
    values.limit ? Math.max(1, Number(values.limit)) : undefined,
  );
  if (values["subset-out"]) write(values["subset-out"], toJsonl(inputs));
  const apiKey = process.env.MARINA_BENCH_API_KEY;
  const responses = await answerAll(inputs, {
    endpoint: values.endpoint,
    model: values.model,
    ...(apiKey ? { apiKey } : {}),
    headers: parseHeaderFlags(values.header ?? []),
    concurrency: Math.max(1, Number(values.concurrency) || 4),
  });
  write(values.out, toJsonl(responses));
  const failed = responses.filter((r) => r.error);
  console.log(
    `wrote ${values.out}: ${responses.length - failed.length}/${responses.length} answered`,
  );
  for (const f of failed.slice(0, 5)) console.error(`  ${f.key}: ${f.error}`);
  // Failures are kept as lines with `error`, so grading and the clean check still run.
  process.exit(0);
}

if (cmd !== "convert" || !dir || !values.input || !values.responses || !values.out) {
  fail(
    "usage: bun scripts/ifbench.ts answer … | convert <grader-dir> --input subset.jsonl --responses responses.jsonl --out f.json [--mode strict|loose] [--require-clean]",
  );
}
const mode = (values.mode ?? "strict") as IfbenchMode;
if (mode !== "strict" && mode !== "loose") fail("--mode must be strict or loose");
const gradedName = existsSync(dir) ? gradedFileFor(readdirSync(dir), mode) : undefined;
const graded: IfbenchGraded[] = gradedName
  ? parseJsonl<IfbenchGraded>(readFileSync(join(dir, gradedName), "utf8"))
  : [];
const responses = existsSync(values.responses)
  ? parseJsonl<IfbenchResponse>(readFileSync(values.responses, "utf8"))
  : [];
const { file, infrastructure } = ifbenchToHarness(
  parseJsonl<IfbenchInput>(readFileSync(values.input, "utf8")),
  graded,
  responses,
  { mode, ...(values.stack ? { stack: values.stack } : {}) },
);
if (!gradedName) infrastructure.unshift(`${dir}: no single eval_results_${mode}.jsonl`);
if (infrastructure.length) {
  const lines = infrastructure
    .slice(0, 20)
    .map((l) => `  ${l}`)
    .join("\n");
  if (values["require-clean"]) {
    console.error(
      `INVALID: ${infrastructure.length} infrastructure failure(s) — no scores reported; fix the cause and re-run\n${lines}`,
    );
    process.exit(3);
  }
  console.error(
    `${infrastructure.length} infrastructure failure(s), filed as fallbacks:\n${lines}`,
  );
}
write(values.out, JSON.stringify(file, null, 1));
const passed = (file.items ?? []).filter((i) => i.correct).length;
console.log(`wrote ${values.out} (${passed}/${file.items?.length ?? 0} follow all instructions)`);
