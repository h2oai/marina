// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Summarize recorded steps, never infer execution from a configured roster or price. */
export function arenaExecutionSummary(detail: string): string {
  let data: unknown;
  try {
    data = JSON.parse(detail);
  } catch {
    return "Execution unknown: invalid stored detail.";
  }
  if (!data || typeof data !== "object") return "Execution unknown: no recorded steps.";
  const record = data as Record<string, unknown>;
  const forecast =
    record.forecast && typeof record.forecast === "object"
      ? (record.forecast as Record<string, unknown>)
      : record;
  const steps = Array.isArray(forecast.rounds) ? forecast.rounds : [];
  const valid = steps.filter(
    (s) =>
      s && typeof s === "object" && typeof s.member === "string" && typeof s.status === "string",
  );
  if (!valid.length)
    return "Execution unknown: no recorded formation steps; this does not establish zero model calls.";
  const ok = valid.filter((s) => s.status === "ok").length;
  return `Recorded formation steps: ${ok} succeeded, ${valid.length - ok} failed; ${new Set(valid.map((s) => s.member)).size} members. Fallback: ${typeof forecast.fallback === "string" ? forecast.fallback : "not recorded"}. Completion protocol evidence, not proof of autonomous world residents.`;
}
