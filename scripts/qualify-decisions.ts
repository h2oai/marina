#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Qualify decision backends on labeled gate + route cases
 * (src/decisions/decision-cases.json) and print a comparison. In the world,
 * `decision qualify` runs the same cases against the world's own backend.
 *
 *   bun run qualify:decisions -- --backend jev --backend chat:openai/gpt-6-luna
 *   bun run qualify:decisions -- --backend hf:zai-org/GLM-5.3-Flash
 *   bun run qualify:decisions -- --backend typesafe --out /path/outside/repo/report.json
 *   bun run qualify:decisions -- --backend jev --backend chat:z-ai/glm-5.3-flash --method auto --conformance
 *   bun run qualify:decisions -- --backend marina:http://localhost:3300:marina/classifier:z-ai/glm-5.3-flash
 *
 * Backends: `jev[:<model>]` (Decisions API on OpenRouter, OPENROUTER_API_KEY),
 * `typesafe[:<model>]` (TYPESAFE_API_KEY), `chat:<provider/model>` (any chat
 * model on OpenRouter as a classifier), `hf:<hub model>` (any chat model on the
 * Hugging Face router, HUGGINGFACE_API_KEY or HF_TOKEN), `openjev:<baseUrl>:<model>`
 * (a self-hosted Decisions-API server), `marina:<url>[:<engine>]` (a running
 * Marina's `/v1/systemone`, end to end; key: the first of MODEL_API_KEYS).
 * `--method` sets how chat backends get probabilities (auto | logprobs |
 * sampled | verbalized; default verbalized). `--conformance` also checks every
 * backend against TypeSafe's response shape (src/decisions/conformance.ts).
 * `--calibrate <file>` scores the gate on RAW probabilities, fits each
 * backend's gate calibration and writes the file `MARINA_DECISION_CALIBRATION`
 * reads (src/decisions/calibrate.ts) — mode 0644; only EARNED fits are used.
 * Makes real, billed calls (fractions of a cent for the default case set).
 * Reports belong in the internal repository — pass --out with a path outside
 * this repo.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CalibrationEntry, CalibrationFile } from "../src/decisions/calibrate";
import { type ClassifierMethod, parseClassifierMethod } from "../src/decisions/classifier-methods";
import { providerFromConfig } from "../src/decisions/config";
import { runConformance } from "../src/decisions/conformance";
import {
  type BackendReport,
  calibrateFromReport,
  DECISION_CASES_PATH,
  loadDecisionCases,
  qualifyBackend,
  renderBackendReport,
} from "../src/decisions/qualify";
import type { DecisionProvider } from "../src/decisions/types";

function backendFor(spec: string, method?: ClassifierMethod): DecisionProvider {
  const tuning = method ? { method } : {};
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
        ...tuning,
      });
    case "hf":
      if (!tail) throw new Error("hf:<hub model> needs a model");
      return providerFromConfig({
        kind: "chat-classifier",
        baseUrl: "https://router.huggingface.co/v1",
        model: tail,
        apiKey: process.env.HUGGINGFACE_API_KEY ?? process.env.HF_TOKEN,
        timeoutMs: 30_000,
        ...tuning,
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
    case "marina": {
      // marina:<http(s)://host:port>[:<engine model>] — the URL itself holds colons.
      const m = /^(https?:\/\/[^/:]+(?::\d+)?)(?::(.+))?$/.exec(tail);
      if (!m) throw new Error("marina:<http(s)://host[:port]>[:<engine model>]");
      const engine = m[2] || "marina/classifier";
      const provider = providerFromConfig({
        kind: "decisions-api",
        baseUrl: m[1]!,
        path: "/v1/systemone",
        model: engine,
        apiKey: process.env.MODEL_API_KEYS?.split(",")[0]?.trim(),
        timeoutMs: 60_000,
      });
      // A chat model behind Marina is still a chat model: uncalibrated policies.
      return engine.startsWith("marina/classifier") ? { ...provider, calibrated: false } : provider;
    }
    default:
      throw new Error(`unknown backend "${spec}"`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      backend: { type: "string", multiple: true },
      cases: { type: "string" },
      out: { type: "string" },
      method: { type: "string" },
      conformance: { type: "boolean" },
      calibrate: { type: "string" },
    },
  });
  const casesPath = resolve(values.cases ?? DECISION_CASES_PATH);
  const cases = loadDecisionCases(casesPath);
  const specs = values.backend?.length ? values.backend : ["jev", "chat:openai/gpt-6-luna"];
  const method = values.method ? parseClassifierMethod(values.method) : undefined;
  if (values.method && !method) throw new Error("--method: auto | logprobs | sampled | verbalized");
  const reports: BackendReport[] = [];
  const conformance: Record<string, Awaited<ReturnType<typeof runConformance>>> = {};
  const fits: Record<string, CalibrationEntry> = {};
  for (const spec of specs) {
    const provider = backendFor(spec, method);
    process.stderr.write(
      `qualifying ${spec} on ${cases.gate.length} gate + ${cases.route.cases.length} route cases…\n`,
    );
    // Fitting needs the backend's own probabilities, never an existing fit's.
    const report = await qualifyBackend(
      provider,
      cases,
      undefined,
      values.calibrate ? null : undefined,
    );
    reports.push(report);
    if (values.calibrate) {
      const chat = /^(chat|hf):/.test(spec) || spec.startsWith("marina:");
      fits[provider.model] = calibrateFromReport(
        report,
        chat ? (method ?? "verbalized") : undefined,
      );
    }
    if (values.conformance) conformance[spec] = await runConformance(provider);
  }
  console.log(reports.map(renderBackendReport).join("\n\n"));
  if (values.calibrate) {
    const file: CalibrationFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      cases: casesPath,
      engines: fits,
    };
    writeFileSync(values.calibrate, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o644 });
    chmodSync(values.calibrate, 0o644); // an existing file keeps its old mode otherwise
    for (const [model, f] of Object.entries(fits)) {
      const m = (x: { brier: number; ece: number }) =>
        `Brier ${x.brier.toFixed(3)} · ECE ${x.ece.toFixed(3)}`;
      console.log(
        `\ncalibration ${model}: ${f.earned ? "EARNED" : "not earned"} (${f.cases} cases, ${f.holds} hold)`,
      );
      console.log(
        `  raw ${m(f.raw)} → fitted (leave-one-out) ${m(f.fitted)} · a ${f.a.toFixed(2)} b ${f.b.toFixed(2)}`,
      );
      for (const r of f.reasons) console.log(`  ✗ ${r}`);
    }
    process.stderr.write(`calibration → ${values.calibrate}\n`);
  }
  for (const [spec, c] of Object.entries(conformance)) {
    console.log(`\nconformance ${spec}: ${c.passed}/${c.total}`);
    for (const f of c.failures) console.log(`  ${f.name}: ${f.problems.join("; ")}`);
  }
  if (values.out) {
    writeFileSync(
      values.out,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          cases: casesPath,
          ...(method ? { method } : {}),
          reports,
          ...(values.conformance ? { conformance } : {}),
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(`report → ${values.out}\n`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
