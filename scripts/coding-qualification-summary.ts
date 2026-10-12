// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Public CI receives only bounded scalar metadata. Prompts, provider errors,
 * transcripts, credentials and project paths remain in encrypted evidence. */
export function publicCodingQualificationSummary(report: Record<string, unknown>) {
  const spending = report.spending as Record<string, unknown> | undefined;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    passed: report.passed === true,
    revision:
      typeof report.revision === "string" && /^[a-f0-9]{40}$/.test(report.revision)
        ? report.revision
        : null,
    cli_controls: report.cli_controls === true,
    elapsed_ms: number(report.elapsed_ms),
    attempted_requests: number(spending?.attempts),
    reserved_usd: number(spending?.reserved),
    recorded_usd: number(spending?.recorded_usd),
    completed_scenarios: Array.isArray(report.scenarios)
      ? report.scenarios.filter((s) => s && typeof s === "object" && s.passed === true).length
      : 0,
    failed: report.error !== undefined || report.shutdown_error !== undefined,
  };
}

if (import.meta.main) {
  try {
    console.log(
      "```json\n" +
        JSON.stringify(
          publicCodingQualificationSummary(await Bun.file(Bun.argv[2]!).json()),
          null,
          2,
        ) +
        "\n```",
    );
  } catch {
    console.log(
      "Live acceptance unavailable or incomplete; no success claimed. Inspect encrypted evidence when present.",
    );
  }
}
