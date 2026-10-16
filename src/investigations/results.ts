// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TypedForecastAnswer } from "../forecast/typed";
import type { ResearchReportResult } from "../research/report";
import {
  INVESTIGATION_SCHEMA,
  type InvestigationRequest,
  type InvestigationResult,
  type PredictionEstimate,
} from "../sdk/investigation-types";

export function predictionResult(
  request: InvestigationRequest,
  answer: TypedForecastAnswer,
): InvestigationResult {
  const shape = request.answer ?? { type: "binary" };
  let estimate: PredictionEstimate;
  let summary: string;
  if (shape.type === "number") {
    const value =
      typeof answer.prediction === "number" && Number.isFinite(answer.prediction)
        ? answer.prediction
        : undefined;
    const sd = answer.uncertainty?.sd;
    estimate = {
      type: "number",
      ...(value !== undefined ? { value } : {}),
      ...(sd !== undefined && Number.isFinite(sd) && sd > 0 ? { sd } : {}),
      ...(shape.unit ? { unit: shape.unit } : {}),
    };
    summary =
      value === undefined
        ? "No supported numeric estimate"
        : `${formatPredictionNumber(value)}${shape.unit ? ` ${shape.unit}` : ""}`;
  } else if (shape.type === "binary") {
    const probability = validProbability(answer.distribution?.yes);
    estimate = { type: "binary", ...(probability !== undefined ? { probability } : {}) };
    summary =
      probability === undefined
        ? "No supported probability"
        : `${formatPredictionNumber(probability * 100)}% probability of Yes`;
  } else {
    const selected = typeof answer.prediction === "string" ? answer.prediction : undefined;
    const options = shape.options.map((option) => ({
      ...option,
      probability: validProbability(answer.distribution?.[option.id]),
    }));
    estimate = { type: "choice", selected, options };
    const winner = options.find((option) => option.id === selected);
    summary = winner
      ? `${winner.label}${winner.probability !== undefined ? ` — ${formatPredictionNumber(winner.probability * 100)}%` : ""}`
      : "No supported choice";
  }
  const available =
    estimate.type === "binary"
      ? estimate.probability !== undefined
      : estimate.type === "number"
        ? estimate.value !== undefined
        : estimate.selected !== undefined;
  const limitations = [
    answer.caveat,
    answer.budgetForced ? "Work ended at its configured budget" : undefined,
  ].filter((s): s is string => !!s);
  if (answer.runs.some((run) => run.status !== "ok"))
    limitations.push("Some analyst runs did not produce usable estimates");
  return {
    schema: INVESTIGATION_SCHEMA,
    kind: "prediction",
    summary,
    estimate,
    availability: !available ? "none" : limitations.length ? "partial" : "final",
    reasons: answer.runs
      .filter((run) => run.reason)
      .map((run) => ({ actor: run.model, text: run.reason!, sourceIds: [] })),
    sources: answer.sources.map((source, index) => ({ ...source, id: `s${index + 1}` })),
    limitations,
    ...(request.horizon ? { horizon: request.horizon } : {}),
    cutoff: answer.cutoff.at,
    capture: { status: "partial", gaps: [] },
    accounting: { knownUsd: Math.max(0, answer.costUsd || 0), complete: false, outstanding: 0 },
  };
}

export function researchResult(
  answer: ResearchReportResult,
  knownUsd: number,
): InvestigationResult {
  const paragraph = answer.body
    .split(/\n\s*\n/)
    .find((part) => part.trim() && !part.trim().startsWith("#"));
  return {
    schema: INVESTIGATION_SCHEMA,
    kind: "research",
    summary: paragraph?.trim() || "Research report available",
    report: answer.markdown,
    availability: !answer.body.trim() ? "none" : answer.status === "partial" ? "partial" : "final",
    reasons: [],
    sources: answer.sources.map((source) => ({
      id: `s${source.n}`,
      url: source.url,
      ...(source.title ? { title: source.title } : {}),
    })),
    limitations: answer.warnings,
    capture: {
      status: "partial",
      gaps: ["Source date labels do not establish historical availability"],
    },
    accounting: { knownUsd: Math.max(0, knownUsd), complete: false, outstanding: 0 },
  };
}

function validProbability(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function formatPredictionNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}
