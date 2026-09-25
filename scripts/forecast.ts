#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forecast any question from the terminal — no server needed.
 *
 *   bun run forecast "Will the Fed cut rates at its October 2026 meeting?"
 *   bun run forecast "What will US regular gasoline average on Oct 15 2026?" --unit "$/gal"
 *   bun run forecast "…" --kind number --by 2026-12-31 --json
 *
 * Research (web, cited) → citation verification → one analyst per vendor →
 * Jev judge → aggregate. Needs OPENROUTER_API_KEY. Typical cost $0.05–0.10.
 */

import { parseArgs } from "node:util";
import { type ForecastKind, forecastQuestion } from "../src/forecast/question";
import { forecastDeps } from "../src/forecast/service";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    kind: { type: "string" },
    by: { type: "string" },
    unit: { type: "string" },
    json: { type: "boolean" },
  },
});
const question = positionals.join(" ").trim();
if (!question) {
  console.error(
    'usage: bun run forecast "<question>" [--kind probability|number] [--by YYYY-MM-DD] [--unit U] [--json]',
  );
  process.exit(2);
}
const made = forecastDeps();
if ("error" in made) {
  console.error(made.error);
  process.exit(1);
}
const answer = await forecastQuestion(
  {
    question,
    ...(values.kind ? { kind: values.kind as ForecastKind } : {}),
    ...(values.by ? { resolveBy: values.by } : {}),
    ...(values.unit ? { unit: values.unit } : {}),
  },
  made.deps,
);
answer.costUsd = made.costUsd();
if (values.json) {
  console.log(JSON.stringify(answer, null, 2));
  process.exit(0);
}
const headline =
  answer.kind === "probability"
    ? answer.probability === undefined
      ? "no answer"
      : `${(answer.probability * 100).toFixed(0)}% yes`
    : answer.mean === undefined
      ? "no answer"
      : `${answer.mean}${values.unit ? ` ${values.unit}` : ""}  (80% interval ${answer.interval?.[0]} – ${answer.interval?.[1]})`;
console.log(`\n${question}\n→ ${headline}${answer.caveat ? `\n  caveat: ${answer.caveat}` : ""}\n`);
for (const a of answer.analysts) {
  const v =
    a.probability !== undefined
      ? `${(a.probability * 100).toFixed(0)}%`
      : a.mean !== undefined
        ? `${a.mean} ± ${a.sd}`
        : a.status;
  const w =
    a.grounded === undefined
      ? ""
      : ` · grounded ${a.grounded.toFixed(2)} · weight ${a.weight.toFixed(2)}`;
  console.log(`  ${a.name}: ${v}${w}\n    ${a.reason ?? ""}`);
}
if (answer.verification) {
  const s = answer.verification;
  console.log(
    `\n  evidence: ${s.verified ?? 0} verified · ${s.unverified ?? 0} unverified · ${s.unreachable ?? 0} unreachable`,
  );
}
for (const src of answer.sources.slice(0, 8)) console.log(`  - ${src.title ?? ""} ${src.url}`);
console.log(`\n  cost $${answer.costUsd.toFixed(3)} · ${(answer.latencyMs / 1000).toFixed(0)} s`);
