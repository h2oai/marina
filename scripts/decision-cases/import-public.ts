#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Build independently labeled gate cases from public corpora normalized by
 * DefenseClaw (see src/decisions/public-cases.ts for what is imported and why).
 *
 *   bash scripts/decision-cases/fetch-public.sh          # download + normalize (pinned)
 *   bun run scripts/decision-cases/import-public.ts \
 *     [--in ~/.cache/marina/decision-cases/out] [--out <cases.json>] \
 *     [--per-tool 12] [--per-side 400] [--seed 20260927]
 *   bun run qualify:decisions -- --cases <cases.json> --backend jev …
 *
 * The cases stay OUT of this repository (the sources are download-only for
 * DefenseClaw's lock, and evaluation-only here); the script prints a manifest —
 * sources, revisions, licences, grades and counts, no case content — that can be
 * kept with results.
 */

import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type DefenseClawCase,
  sampleCases,
  toGateCase,
  truthGrade,
} from "../../src/decisions/public-cases";
import type { GateCase } from "../../src/decisions/qualify";

const { values } = parseArgs({
  options: {
    in: { type: "string" },
    out: { type: "string" },
    "per-tool": { type: "string" },
    "per-side": { type: "string" },
    seed: { type: "string" },
  },
});
const inDir = values.in ?? join(homedir(), ".cache/marina/decision-cases/out");
const outPath =
  values.out ?? join(homedir(), ".cache/marina/decision-cases/public-gate-cases.json");
const perTool = Number(values["per-tool"] ?? 12);
const perSide = Number(values["per-side"] ?? 400);
const seed = Number(values.seed ?? 20260927);

const grades: Record<string, Record<string, number>> = {};
const candidates: GateCase[] = [];
const sources: Record<string, { revision?: string; license?: string; rows: number }> = {};

for (const file of readdirSync(inDir)
  .filter((f) => f.endsWith(".jsonl"))
  .sort()) {
  const text = await Bun.file(join(inDir, file)).text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as DefenseClawCase;
    const dataset = row.source?.dataset ?? file;
    const g = truthGrade(row);
    grades[dataset] ??= {};
    grades[dataset][g] = (grades[dataset][g] ?? 0) + 1;
    const s = (sources[dataset] ??= {
      ...(row.source?.revision ? { revision: row.source.revision } : {}),
      ...(row.source?.license ? { license: row.source.license } : {}),
      rows: 0,
    });
    s.rows++;
    const c = toGateCase(row);
    if (c) candidates.push(c);
  }
}

const gate = sampleCases(candidates, { perTool, perSide, seed });
const count = (cs: GateCase[]) => {
  const out: Record<string, { hold: number; allow: number; tools: number }> = {};
  for (const c of cs) {
    const f = (out[c.family ?? "?"] ??= { hold: 0, allow: 0, tools: 0 });
    f[c.expect]++;
  }
  for (const [f, v] of Object.entries(out)) {
    v.tools = new Set(cs.filter((c) => c.family === f).map((c) => c.tool)).size;
  }
  return out;
};
const body = JSON.stringify({ version: 1, gate, route: { routes: {}, cases: [] } });
const manifest = {
  generatedAt: new Date().toISOString(),
  normalizer: "cisco-ai-defense/defenseclaw@d2ae73f32736db0aa9fd8e78d5656355c1a41012",
  sample: { perTool, perSide, seed },
  sources,
  grades,
  eligible: count(candidates),
  sampled: count(gate),
  sha256: createHash("sha256").update(body).digest("hex"),
};
writeFileSync(outPath, body);
writeFileSync(
  outPath.replace(/\.json$/, ".manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(JSON.stringify(manifest, null, 2));
console.error(`cases → ${outPath} (${gate.length})`);
