// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ResearchBrief } from "../arena/research/briefs";
import type { WorkBudget } from "../coordination/work-budget";
import { getErrorMessage } from "../engine/errors";
import type { ResearchReport, Retriever } from "./retrieve";

export const RESEARCH_HYPOTHESES = {
  measurement:
    "Find the exact target definition, latest eligible measurement, matched earlier reading and source vintage. Separate population, response and subgroup. Do not substitute a different survey's level.",
  mechanism:
    "Find dated primary evidence of changes in the mechanisms that drive this target. Identify what was already known at the anchor, and whether the target population was exposed. A plausible story is not a measured effect.",
  challenge:
    "Pre-mortem: suppose a forecast based on the obvious narrative fails. Find disconfirming observations, revisions, fieldwork or release delays, and overlooked scheduled events that could explain the failure. State what observation would resolve each contradiction.",
} as const;
export type ResearchHypothesis = keyof typeof RESEARCH_HYPOTHESES;

/** Partition a fixed query allowance BEFORE any path sees another's output. */
export function hypothesisBriefs(
  brief: ResearchBrief,
  totalQueries = 6,
): Record<ResearchHypothesis, ResearchBrief> {
  if (!Number.isSafeInteger(totalQueries) || totalQueries < 3 || totalQueries > 24)
    throw new Error("independent research needs 3–24 total queries");
  const target =
    brief.target?.terms?.join(" ") || brief.queries?.[0] || brief.request.slice(0, 200);
  const queries = brief.queries?.length ? brief.queries : [target];
  return Object.fromEntries(
    Object.entries(RESEARCH_HYPOTHESES).map(([id, instruction], i) => {
      const n = Math.floor(totalQueries / 3) + Number(i < totalQueries % 3);
      const terms =
        id === "measurement"
          ? "latest release exact population field dates"
          : id === "mechanism"
            ? "new data changes drivers"
            : "contradictory evidence revisions delayed release";
      return [
        id,
        {
          ...brief,
          request: `${brief.request}\nIndependent research path: ${instruction}`,
          queries: Array.from({ length: n }, (_, j) =>
            `${j === 0 ? target : queries[(j * 3 + i) % queries.length]} ${terms}`.slice(0, 400),
          ),
        },
      ];
    }),
  ) as Record<ResearchHypothesis, ResearchBrief>;
}

export async function researchHypotheses(
  brief: ResearchBrief,
  retrieve: Retriever,
  budget: WorkBudget,
  totalQueries = 6,
) {
  const plans = hypothesisBriefs(brief, totalQueries);
  const paths: Partial<Record<ResearchHypothesis, { report?: ResearchReport; error?: string }>> =
    {};
  await Promise.all(
    Object.entries(plans).map(async ([id, request]) => {
      try {
        paths[id as ResearchHypothesis] = { report: await budget.run(() => retrieve(request)) };
      } catch (error) {
        paths[id as ResearchHypothesis] = { error: getErrorMessage(error) };
      }
    }),
  );
  return {
    plans,
    paths,
    complete: Object.values(paths).every(
      (p) => !p.error && !p.report?.researchLoop?.error && !!p.report?.report.trim(),
    ),
    costUsd: Object.values(paths).reduce((sum, p) => sum + (p.report?.costUsd ?? 0), 0),
    budget: budget.snapshot(),
  };
}
