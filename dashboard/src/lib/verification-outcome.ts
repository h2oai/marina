// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Code Mode verification results, as the server records them: `passed`,
 * `failed` (checks ran and failed), `not_run` (no tests found, or the
 * environment was not ready) and `error` (the runner failed). `not_run` and
 * `error` are neither a pass nor a failure, so they are never shown as one.
 * Coding-attempt states (`missing`, `stale`, `unbound`, `unavailable`) pass
 * through as labels.
 */

export type VerificationTone = "success" | "danger" | "muted" | "warning";

/** The outcome a verification artifact status stands for (legacy rows: complete/failed). */
export function verificationOutcomeFromStatus(status: unknown): string | undefined {
  if (status === "complete") return "passed";
  if (status === "failed" || status === "not_run" || status === "error") return status;
  return undefined;
}

export function verificationLabel(value: unknown, fallback = "not recorded"): string {
  if (typeof value !== "string" || !value) return fallback;
  if (value === "not_run") return "not run";
  return value;
}

export function verificationTone(value: unknown): VerificationTone {
  if (value === "passed") return "success";
  if (value === "failed") return "danger";
  if (value === "not_run") return "muted";
  return "warning";
}

export const VERIFICATION_TONE_CLASS: Record<VerificationTone, string> = {
  success: "text-success",
  danger: "text-danger",
  muted: "text-text-dim",
  warning: "text-warning",
};
