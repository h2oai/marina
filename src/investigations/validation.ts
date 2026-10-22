// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  InvestigationLimits,
  InvestigationRequest,
  PredictionShape,
} from "../sdk/investigation-types";

export class InvestigationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "InvestigationError";
  }
}

export const CONTENT_OBJECT_BYTES = 2 * 1024 * 1024;
export const CONTENT_ATTEMPT_BYTES = 24 * 1024 * 1024;
export const CONTENT_OWNER_BYTES = 128 * 1024 * 1024;
export const MAX_INVESTIGATION_EVENTS = 10_000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvestigationError("invalid_request", "Expected an object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new InvestigationError("invalid_request", `${field} must contain 1–${max} characters`);
  }
  return value.trim();
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new InvestigationError("invalid_request", `${field} must be an integer ${min}–${max}`);
  }
  return value;
}

export function investigationLimits(raw?: Partial<InvestigationLimits>): InvestigationLimits {
  const value = raw === undefined ? {} : object(raw);
  return {
    calls: integer(value.calls ?? 80, "calls", 1, 200),
    concurrency: integer(value.concurrency ?? 4, "concurrency", 1, 9),
    timeoutMs: integer(value.timeoutMs ?? 600_000, "timeoutMs", 1_000, 900_000),
  };
}

export function parseInvestigationRequest(raw: unknown): InvestigationRequest {
  const value = object(raw);
  if (value.kind !== "prediction" && value.kind !== "research") {
    throw new InvestigationError("invalid_request", "kind must be prediction or research");
  }
  const request: InvestigationRequest = {
    kind: value.kind,
    question: text(value.question, "question", 4000),
    limits: investigationLimits(value.limits as Partial<InvestigationLimits> | undefined),
  };
  for (const field of ["context", "caseId", "parentAttemptId"] as const) {
    if (value[field] !== undefined)
      request[field] = text(value[field], field, field === "context" ? 8000 : 100);
  }
  for (const field of ["horizon", "asOf"] as const) {
    if (value[field] === undefined) continue;
    const date = text(value[field], field, 60);
    if (
      !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(date) ||
      !Number.isFinite(Date.parse(date))
    ) {
      throw new InvestigationError(
        "invalid_request",
        `${field} must be an ISO date or timestamp with timezone`,
      );
    }
    request[field] = new Date(date).toISOString();
  }
  if (value.runs !== undefined) request.runs = integer(value.runs, "runs", 1, 9);
  if (value.kind === "prediction") {
    const spec = value.answer === undefined ? { type: "binary" } : object(value.answer);
    let answer: PredictionShape;
    if (spec.type === "binary") answer = { type: "binary" };
    else if (spec.type === "number") {
      answer = {
        type: "number",
        ...(spec.unit === undefined ? {} : { unit: text(spec.unit, "unit", 80) }),
      };
    } else if (spec.type === "choice") {
      if (!Array.isArray(spec.options) || spec.options.length < 2 || spec.options.length > 32) {
        throw new InvestigationError("invalid_request", "A choice needs 2–32 exclusive options");
      }
      const options = spec.options.map((rawOption) => {
        const option = object(rawOption);
        const id = text(option.id, "option id", 64);
        if (!/^[a-zA-Z0-9_-]+$/.test(id))
          throw new InvestigationError("invalid_request", "Option IDs use letters, digits, - or _");
        return { id, label: text(option.label, "option label", 160) };
      });
      if (new Set(options.map((option) => option.id)).size !== options.length) {
        throw new InvestigationError("invalid_request", "Option IDs must be unique");
      }
      answer = { type: "choice", options };
    } else
      throw new InvestigationError(
        "invalid_request",
        "answer.type must be binary, choice or number",
      );
    request.answer = answer;
  } else if (value.answer !== undefined) {
    throw new InvestigationError(
      "invalid_request",
      "Research reports do not have a forecast answer shape",
    );
  }
  return request;
}

export function investigationKey(raw: unknown): string {
  const key = text(raw, "idempotency key", 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(key))
    throw new InvestigationError("invalid_request", "Invalid idempotency key");
  return key;
}
