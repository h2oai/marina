// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// FROZEN copy of `residentForecastScore` (`src/forecast/resident-forecast.ts`)
// as it was before the formation catalogue (`src/orchestration/formations/`,
// 2026-10-20, origin/main 6c4f6d18). The catalogue's ensemble and delphi
// templates must instantiate to exactly these Scores. Never edit this file to
// make that test pass.

import type { Score } from "../../../src/sdk/score";

const K_MAX = 7;
const PIPELINE = "model:marina-forecast";

export function legacyResidentForecastScore(
  pattern: "ensemble" | "delphi",
  k: number,
  assignee = "role:forecaster",
  id = `forecast-${pattern}`,
): Score {
  const n = Math.max(1, Math.min(K_MAX, Math.round(k)));
  const runs = Array.from({ length: n }, (_, i) => ({
    id: `f${i + 1}`,
    instruction: `Forecast independently from the research dossier (run ${i + 1} of ${n}); use your own tools within the evidence cutoff.`,
    assignee,
    access: ["research"],
  }));
  const steps: Score["steps"] = [
    {
      id: "research",
      instruction:
        "Plan the question, research it up to the evidence cutoff, check citations mechanically and run the structured lookups (the typed pipeline's research round).",
      assignee: PIPELINE,
      access: [],
    },
    ...runs,
  ];
  if (pattern === "delphi") {
    steps.push({
      id: "summary",
      instruction:
        "Summarise the panel anonymously: per-option medians and ranges, reason snippets.",
      assignee: PIPELINE,
      access: runs.map((r) => r.id),
    });
    for (let i = 0; i < n; i++)
      steps.push({
        id: `v${i + 1}`,
        instruction: `Revise run ${i + 1} once after reading the anonymous panel summary.`,
        assignee,
        access: ["summary", `f${i + 1}`],
      });
  }
  steps.push({
    id: "combine",
    instruction:
      "Combine by type (pure code): the formation's combination, the critique rule, the answer contract, triage and the Arbiter.",
    assignee: PIPELINE,
    access: steps.filter((s) => s.id !== "research").map((s) => s.id),
  });
  return { id, goal: `Resident forecast (${pattern}, ${n} residents)`, author: "marina", steps };
}
