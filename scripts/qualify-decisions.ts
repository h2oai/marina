#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Qualify decision backends on labeled gate + route cases
 * (scripts/fixtures/decision-cases.json) and print a comparison.
 *
 *   bun run qualify:decisions -- --backend jev --backend chat:openai/gpt-4o-mini
 *   bun run qualify:decisions -- --backend typesafe --out /path/outside/repo/report.json
 *
 * Backends: `jev[:<model>]` (Decisions API on OpenRouter, OPENROUTER_API_KEY),
 * `typesafe[:<model>]` (TYPESAFE_API_KEY), `chat:<provider/model>` (any chat
 * model on OpenRouter as a classifier), `openjev:<baseUrl>:<model>` (a
 * self-hosted Decisions-API server). Makes real, billed calls (fractions of a
 * cent for the default case set). Reports belong in the internal repository —
 * pass --out with a path outside this repo.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { providerFromConfig } from "../src/decisions/config";
import { type BackendReport, parseDecisionCases, qualifyBackend } from "../src/decisions/qualify";
import type { DecisionProvider } from "../src/decisions/types";

function backendFor(spec: string): DecisionProvider {
  const [kind, ...rest] = spec.split(":");
  const tail = rest.join(":");
  switch (kind) {
    case "jev":
      return providerFromConfig({
        kind: "decisions-api",
        baseUrl: "https://openrouter.ai/api/alpha",
        path: "/decisions",
        model: tail || "typesafe/jev-1.13",
        apiKey: process.env.OPENROUTER_API_KEY,
        timeoutMs: 10_000,
      });
    case "typesafe":
      return providerFromConfig({
        kind: "decisions-api",
        baseUrl: "https://api.typesafe.ai",
        path: "/v1/systemone",
        model: tail || "jev-latest",
        apiKey: process.env.TYPESAFE_API_KEY,
        timeoutMs: 10_000,
      });
    case "chat":
      if (!tail) throw new Error("chat:<provider/model> needs a model");
      return providerFromConfig({
        kind: "chat-classifier",
        baseUrl: "https://openrouter.ai/api/v1",
        model: tail,
        apiKey: process.env.OPENROUTER_API_KEY,
        timeoutMs: 30_000,
      });
    case "openjev": {
      const at = tail.lastIndexOf(":");
      if (at <= 0) throw new Error("openjev:<baseUrl>:<model>");
      return providerFromConfig({
        kind: "decisions-api",
        baseUrl: tail.slice(0, at),
        model: tail.slice(at + 1),
        timeoutMs: 10_000,
      });
    }
    default:
      throw new Error(`unknown backend "${spec}"`);
  }
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function summary(r: BackendReport): string {
  const missed = r.gate.results.filter((g) => !g.correct).map((g) => `${g.id}→${g.action}`);
  const misrouted = r.route.results.filter((x) => !x.correct).map((x) => `${x.id}→${x.route}`);
  return [
    `${r.model} (${r.backend}${r.calibrated ? "" : ", uncalibrated"})`,
    `  gate   accuracy ${pct(r.gate.accuracy)} · hold recall ${pct(r.gate.holdRecall)} · false holds ${pct(r.gate.falseHoldRate)} · errors ${r.gate.errors}`,
    missed.length ? `         wrong: ${missed.join(", ")}` : "         wrong: none",
    `  route  accuracy ${pct(r.route.accuracy)} · errors ${r.route.errors}`,
    misrouted.length ? `         wrong: ${misrouted.join(", ")}` : "         wrong: none",
    `  latency p50 ${r.latencyMs.p50}ms · p95 ${r.latencyMs.p95}ms · cost $${r.costUsd.toFixed(6)}`,
  ].join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      backend: { type: "string", multiple: true },
      cases: { type: "string" },
      out: { type: "string" },
    },
  });
  const casesPath = resolve(values.cases ?? `${import.meta.dir}/fixtures/decision-cases.json`);
  const cases = parseDecisionCases(JSON.parse(readFileSync(casesPath, "utf8")));
  const specs = values.backend?.length ? values.backend : ["jev", "chat:openai/gpt-4o-mini"];
  const reports: BackendReport[] = [];
  for (const spec of specs) {
    const provider = backendFor(spec);
    process.stderr.write(
      `qualifying ${spec} on ${cases.gate.length} gate + ${cases.route.cases.length} route cases…\n`,
    );
    reports.push(await qualifyBackend(provider, cases));
  }
  console.log(reports.map(summary).join("\n\n"));
  if (values.out) {
    writeFileSync(
      values.out,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), cases: casesPath, reports }, null, 2)}\n`,
    );
    process.stderr.write(`report → ${values.out}\n`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
