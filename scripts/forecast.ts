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
 * Typed answers (plan → research rounds → K runs → critique):
 *
 *   bun run forecast "Who wins the runoff?" --type choice --options "A=Lula|B=Bolsonaro"
 *   bun run forecast "Which bands will the rate fall in?" --type multi --options "A|B|C|D"
 *   bun run forecast "Top 3 films by weekend gross?" --type ranking --size 3 --end 2026-10-12T00:00:00Z
 *   bun run forecast "Factory orders, $bn?" --type number --unit '$bn' --runs 5 --context "Census M3, first print"
 *
 * Research (web, cited) → citation verification → analysts → Jev judge →
 * aggregate. Runs on whatever models are configured (OpenRouter's three-vendor
 * default, other provider keys, or one local model); a degraded setup says so. Typical cost $0.05–0.10 (typed: more,
 * by runs and research rounds).
 */

import { parseArgs } from "node:util";
import { type AnswerSpec, parseAnswerSpec } from "../src/forecast/answer-types";
import { type ForecastKind, forecastQuestion } from "../src/forecast/question";
import { forecastDeps, typedForecastDeps } from "../src/forecast/service";
import { forecastTyped } from "../src/forecast/typed";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    kind: { type: "string" },
    by: { type: "string" },
    unit: { type: "string" },
    json: { type: "boolean" },
    type: { type: "string" },
    options: { type: "string" },
    size: { type: "string" },
    end: { type: "string" },
    "as-of": { type: "string" },
    context: { type: "string" },
    runs: { type: "string" },
    rounds: { type: "string" },
    "no-critique": { type: "boolean" },
    analysts: { type: "string" },
  },
});
const question = positionals.join(" ").trim();
if (!question) {
  console.error(
    [
      'usage: bun run forecast "<question>" [--kind probability|number] [--by YYYY-MM-DD] [--unit U] [--json]',
      '       bun run forecast "<question>" --type choice|multi|number|ranking|text [--options "A=label|B=label"]',
      "         [--size N] [--end ISO] [--as-of ISO] [--context TEXT] [--runs K] [--rounds R] [--no-critique]",
      "         [--analysts m1,m2] [--json]",
    ].join("\n"),
  );
  process.exit(2);
}

if (values.type) await typed();
else await probabilistic();

async function typed(): Promise<void> {
  const options = (values.options ?? "")
    .split("|")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => {
      const eq = o.indexOf("=");
      return eq > 0 ? { id: o.slice(0, eq).trim(), label: o.slice(eq + 1).trim() } : { id: o };
    });
  const parsed = parseAnswerSpec({
    type: values.type,
    ...(options.length ? { options, candidates: options.map((o) => o.label ?? o.id) } : {}),
    ...(values.size ? { size: Number(values.size) } : {}),
    ...(values.unit ? { unit: values.unit } : {}),
  });
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(2);
  }
  const spec: AnswerSpec = parsed.spec;
  const made = typedForecastDeps(process.env, {
    ...(values.runs ? { runs: Number(values.runs) } : {}),
    ...(values.rounds ? { researchRounds: Number(values.rounds) } : {}),
    ...(values["no-critique"] ? { critique: false } : {}),
    ...(values.analysts ? { analysts: values.analysts.split(",").map((s) => s.trim()) } : {}),
  });
  if ("error" in made) {
    console.error(made.error);
    process.exit(1);
  }
  const a = await forecastTyped(
    {
      question,
      answer: spec,
      ...(values.end ? { endTime: values.end } : {}),
      ...(values["as-of"] ? { asOf: values["as-of"] } : {}),
      ...(values.context ? { context: values.context } : {}),
    },
    made.deps,
  );
  a.costUsd = made.costUsd();
  if (values.json) {
    console.log(JSON.stringify({ ...a, scale: made.scale }, null, 2));
    return;
  }
  if (made.scale.tier === "degraded") console.log(`  degraded: ${made.scale.notes.join("; ")}`);
  console.log(
    `\n${question}\n→ ${a.formatted ?? "no answer"}${a.confidence === undefined ? "" : `  (confidence ${a.confidence.toFixed(2)})`}${a.caveat ? `\n  caveat: ${a.caveat}` : ""}\n`,
  );
  if (a.plan?.resolutionSource) console.log(`  resolves from: ${a.plan.resolutionSource}`);
  for (const r of a.research) {
    console.log(
      `  research ${r.round}: ${r.sources} sources${r.error ? ` (error: ${r.error})` : ""}${r.missing ? ` · missing: ${r.missing}` : ""}`,
    );
  }
  for (const r of a.runs) {
    console.log(`  run ${r.run} ${r.model}: ${r.formatted ?? r.status}\n    ${r.reason ?? ""}`);
  }
  if (a.critique) {
    console.log(
      `  critique ${a.critique.model}: ${a.critique.verdict}${a.critique.proposed ? ` → ${a.critique.proposed} (${a.critique.applied ? "applied" : "not applied"})` : ""}`,
    );
  }
  for (const src of a.sources.slice(0, 8)) console.log(`  - ${src.title ?? ""} ${src.url}`);
  console.log(
    `\n  cutoff ${a.cutoff.at} (${a.cutoff.basis}) · cost $${a.costUsd.toFixed(3)} · ${(a.latencyMs / 1000).toFixed(0)} s`,
  );
}

async function probabilistic(): Promise<void> {
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
    console.log(JSON.stringify({ ...answer, scale: made.scale }, null, 2));
    return;
  }
  if (made.scale.tier === "degraded") console.log(`  degraded: ${made.scale.notes.join("; ")}`);
  const headline =
    answer.kind === "probability"
      ? answer.probability === undefined
        ? "no answer"
        : `${(answer.probability * 100).toFixed(0)}% yes`
      : answer.mean === undefined
        ? "no answer"
        : `${answer.mean}${values.unit ? ` ${values.unit}` : ""}  (80% interval ${answer.interval?.[0]} – ${answer.interval?.[1]})`;
  console.log(
    `\n${question}\n→ ${headline}${answer.caveat ? `\n  caveat: ${answer.caveat}` : ""}\n`,
  );
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
}
