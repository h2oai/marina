// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  InvestigationAttempt,
  InvestigationResult,
  PredictionEstimate,
} from "./investigation-types";

/** Browser/terminal-safe plain text. Escape sequences in evidence are data, never instructions. */
export function investigationPlainText(value: string): string {
  return (
    value
      .replace(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strip CSI/OSC/DCS terminal instructions.
        /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*(?:\u001b\\)|[@-_])/g,
        "",
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip remaining controls and bidi direction overrides.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
  );
}

export function investigationEstimate(estimate?: PredictionEstimate): string | undefined {
  if (!estimate) return undefined;
  if (estimate.type === "binary")
    return estimate.probability === undefined
      ? "Probability unavailable"
      : `${Number((estimate.probability * 100).toFixed(1))}% chance`;
  if (estimate.type === "number")
    return estimate.value === undefined
      ? "Estimate unavailable"
      : `${estimate.value.toLocaleString("en-US", { maximumFractionDigits: 4 })}${estimate.unit ? ` ${estimate.unit}` : ""}${estimate.sd === undefined ? " · uncertainty not supplied" : ` (SD ${estimate.sd})`}`;
  const selected = estimate.options.find((option) => option.id === estimate.selected);
  return selected
    ? `${selected.label}${selected.probability === undefined ? "" : ` · ${Number((selected.probability * 100).toFixed(1))}%`}`
    : "No option selected";
}

export type InvestigationView = "answer" | "why" | "sources" | "report";

export function investigationResultText(
  result: InvestigationResult,
  view: InvestigationView = "answer",
): string {
  const lines: string[] = [];
  if (view === "answer") {
    const estimate = investigationEstimate(result.estimate);
    if (estimate) lines.push(estimate);
    lines.push(result.summary);
    if (result.availability !== "final") lines.push(`Answer: ${result.availability}`);
    if (result.horizon) lines.push(`Horizon: ${result.horizon}`);
    if (result.cutoff) lines.push(`Evidence cutoff: ${result.cutoff}`);
    if (result.limitations.length)
      lines.push("", "Limitations", ...result.limitations.map((line) => `• ${line}`));
  } else if (view === "why") {
    lines.push(
      ...result.reasons.map(
        (reason) =>
          `${reason.actor}: ${reason.text}${reason.sourceIds.length ? ` [${reason.sourceIds.join(", ")}]` : ""}`,
      ),
    );
    if (!result.reasons.length) lines.push("No detailed rationale was returned.");
    lines.push(
      "",
      `Capture: ${result.capture.status}`,
      ...result.capture.gaps.map((gap) => `• ${gap}`),
    );
  } else if (view === "sources") {
    lines.push(
      ...result.sources.map(
        (source) => `[${source.id}] ${source.title ?? source.url}\n  ${source.url}`,
      ),
    );
    if (!result.sources.length) lines.push("No sources were returned.");
  } else lines.push(result.report ?? "This prediction has no research report. Use Why or Sources.");
  return investigationPlainText(lines.join("\n"));
}

export function investigationAttemptText(
  attempt: InvestigationAttempt,
  view: InvestigationView = "answer",
): string {
  return investigationPlainText(
    [
      attempt.request.question,
      "",
      attempt.result
        ? investigationResultText(attempt.result, view)
        : `Status: ${attempt.state}${attempt.error ? `\n${attempt.error}` : ""}`,
      "",
      `Attempt ${attempt.id} · ${attempt.state}`,
      `$${attempt.accounting.knownUsd.toFixed(4)} recorded${attempt.accounting.complete ? "" : " · accounting incomplete"}${attempt.accounting.outstanding ? ` · ${attempt.accounting.outstanding} call(s) still outstanding` : ""}`,
    ].join("\n"),
  );
}
