#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Turn a Gate Label Desk export (Results → Export labels) into gate cases with
 * `labeledBy: "human-panel"` (see src/decisions/panel-labels.ts), and report
 * how far the tracked cases' author labels agree with the panel.
 *
 *   bun run scripts/decision-cases/import-labels.ts --in gate-labels.json \
 *     [--out <cases.json>] [--min-agree 2]
 *   bun run qualify:decisions -- --cases <cases.json> --backend jev --calibrate <file>
 */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  authorAgreement,
  consensus,
  type PanelExport,
  panelGateCase,
} from "../../src/decisions/panel-labels";
import { loadDecisionCases } from "../../src/decisions/qualify";

const { values } = parseArgs({
  options: { in: { type: "string" }, out: { type: "string" }, "min-agree": { type: "string" } },
});
if (!values.in) throw new Error("--in <gate-labels.json> (the page's export)");
const minAgree = Number(values["min-agree"] ?? 2);
const outPath = values.out ?? join(homedir(), ".cache/marina/decision-cases/panel-gate-cases.json");

const panel = (await Bun.file(values.in).json()) as PanelExport;
const gate = panel.cases.flatMap((c) => {
  const g = panelGateCase(c, minAgree);
  return g ? [g] : [];
});
const author = new Map(loadDecisionCases().gate.map((c) => [c.id, c.expect] as const));
const byVerdict = { allow: 0, ask: 0, block: 0 };
for (const c of panel.cases) {
  const k = consensus(c, minAgree);
  if (k) byVerdict[k.verdict]++;
}
writeFileSync(
  outPath,
  `${JSON.stringify({ version: 1, gate, route: { routes: {}, cases: [] } })}\n`,
);
console.log(
  JSON.stringify(
    {
      cases: panel.cases.length,
      withConsensus: gate.length,
      byVerdict,
      families: Object.fromEntries(
        [...new Set(gate.map((g) => g.family))].map((f) => [
          f,
          {
            hold: gate.filter((g) => g.family === f && g.expect === "hold").length,
            allow: gate.filter((g) => g.family === f && g.expect === "allow").length,
          },
        ]),
      ),
      authorVsPanel: authorAgreement(panel.cases, author, minAgree),
      out: outPath,
    },
    null,
    2,
  ),
);
