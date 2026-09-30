// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Request-local destination; never changes the resident's selected coding session. */
export interface CodingCommandTarget {
  readonly sessionId: string;
  /** Optional precondition: this must still be the session's active attempt at execution. */
  readonly runId?: string;
}

/** Shared wire validation. Session ownership and attempt freshness are checked by the engine. */
export function parseCodingCommandTarget(value: unknown): CodingCommandTarget {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid coding target: expected { sessionId, runId? }.");
  const target = value as Record<string, unknown>;
  const validId = (id: unknown): id is string =>
    typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  if (
    !validId(target.sessionId) ||
    (target.runId !== undefined && !validId(target.runId)) ||
    Object.keys(target).some((key) => key !== "sessionId" && key !== "runId")
  )
    throw new Error("Invalid coding target: IDs must contain 1–128 letters, digits, '_' or '-'.");
  return Object.freeze({
    sessionId: target.sessionId,
    ...(target.runId !== undefined ? { runId: target.runId } : {}),
  });
}
