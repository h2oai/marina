#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * AutomationBench exports → Marina's benchmark ledger (thin adapter; the
 * reproduction kit's `automation` setup drives it, see docs/guides/reproduce.md).
 *
 *   bun scripts/automationbench.ts tasks [--limit N]
 *       the kit's fixed task list (first N, spread over the six domains)
 *   bun scripts/automationbench.ts convert <export.json …> --out f.json
 *       [--expect a,b,c] [--model id] [--stack value] [--require-clean]
 *       harness-shaped file for `bun run benchmark:import`
 *
 * `--require-clean` refuses (exit 3, no ledger file) when any task has no
 * result: a missing or unreadable export, an export without the task, a task
 * AutomationBench reports aborted, or one that never reached the model. Such a
 * run measured the infrastructure, not the model, and must be re-run.
 *
 * AutomationBench itself runs unmodified (`auto-bench --base-url <marina>/v1`).
 * Only task names and outcomes reach the ledger — never transcripts or task text.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  AUTOMATION_TASKS,
  type AutomationExport,
  automationToHarness,
  type ExportInput,
} from "../benchmarks/automation/convert";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    out: { type: "string" },
    expect: { type: "string" },
    model: { type: "string" },
    stack: { type: "string" },
    limit: { type: "string" },
    "require-clean": { type: "boolean" },
  },
});

const [cmd, ...files] = positionals;
if (cmd === "tasks") {
  const n = values.limit ? Math.max(1, Number(values.limit)) : AUTOMATION_TASKS.length;
  for (const t of AUTOMATION_TASKS.slice(0, n)) console.log(t);
  process.exit(0);
}
if (cmd !== "convert" || files.length === 0 || !values.out) {
  console.error(
    "usage: bun scripts/automationbench.ts convert <export.json …> --out f.json [--expect a,b] [--model id] [--stack v] [--require-clean] | tasks [--limit N]",
  );
  process.exit(2);
}

function read(path: string): ExportInput {
  if (!existsSync(path)) return { path, error: "no export (auto-bench did not finish)" };
  try {
    return { path, data: JSON.parse(readFileSync(path, "utf8")) as AutomationExport };
  } catch (e) {
    return { path, error: `unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const expect = values.expect
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const { file, infrastructure } = automationToHarness(files.map(read), {
  ...(expect?.length ? { expect } : {}),
  ...(values.model ? { model: values.model } : {}),
  ...(values.stack ? { stack: values.stack } : {}),
});
if (infrastructure.length) {
  const lines = infrastructure.map((l) => `  ${l}`).join("\n");
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
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, JSON.stringify(file, null, 1));
const passed = (file.items ?? []).filter((i) => i.correct).length;
console.log(`wrote ${values.out} (${passed}/${file.items?.length ?? 0} passed)`);
