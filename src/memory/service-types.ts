// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  MemoryClaim,
  MemoryRecordInput,
  MemoryTerm,
  MemoryValidity,
} from "../sdk/memory-types";

export class MemoryError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export type {
  MemoryCheckpoint,
  MemoryClaim,
  MemoryGraphQuery,
  MemoryGraphResult,
  MemoryQuery,
  MemoryQueryResult,
  MemoryReceipt,
  MemoryRecord,
  MemoryRecordInput,
  MemorySource,
  MemorySpace,
  MemoryTerm,
} from "../sdk/memory-types";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MemoryError(400, "invalid_input", "An object is required");
  return value as Record<string, unknown>;
}
export function textValue(value: unknown, name: string, max = 65536): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max)
    throw new MemoryError(
      400,
      "invalid_input",
      `${name} must be a nonempty string of at most ${max} bytes`,
    );
  return value;
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new MemoryError(
      400,
      "invalid_input",
      `${name} must be an integer between ${min} and ${max}`,
    );
  return Number(value);
}
export function memoryTerm(value: unknown): MemoryTerm {
  const term = object(value);
  if (term.kind === "entity") return { kind: "entity", id: textValue(term.id, "entity id", 256) };
  if (
    term.kind === "literal" &&
    (term.value === null ||
      typeof term.value === "boolean" ||
      (typeof term.value === "number" && Number.isFinite(term.value)) ||
      (typeof term.value === "string" && Buffer.byteLength(term.value) <= 8192))
  )
    return { kind: "literal", value: term.value as string | number | boolean | null };
  throw new MemoryError(400, "invalid_term", "Use an entity reference or a finite scalar literal");
}
export function memoryClaim(value: unknown): MemoryClaim {
  const claim = object(value);
  return {
    subject: textValue(claim.subject, "subject", 256),
    predicate: textValue(claim.predicate, "predicate", 256),
    object: memoryTerm(claim.object),
  };
}
export function recordInput(value: unknown): MemoryRecordInput {
  const input = object(value);
  const types = ["fact", "observation", "decision", "inference", "skill", "episode"];
  const tiers = ["fact", "reflection", "skill"];
  const content = textValue(input.content, "content");
  let validTime: MemoryValidity | null | undefined;
  if (input.valid_time === null) validTime = null;
  else if (input.valid_time !== undefined) {
    const interval = object(input.valid_time);
    const from =
      interval.from === null
        ? null
        : integer(interval.from, "valid_time.from", 0, Number.MAX_SAFE_INTEGER);
    const until =
      interval.until === null
        ? null
        : integer(interval.until, "valid_time.until", 0, Number.MAX_SAFE_INTEGER);
    if (from !== null && until !== null && from >= until)
      throw new MemoryError(
        400,
        "invalid_interval",
        "valid_time must be a nonempty half-open interval",
      );
    validTime = { from, until };
  }
  const expectedVocabulary =
    input.expected_vocabulary_version === undefined
      ? undefined
      : integer(
          input.expected_vocabulary_version,
          "expected_vocabulary_version",
          0,
          Number.MAX_SAFE_INTEGER,
        );
  if (input.type !== undefined && (typeof input.type !== "string" || !types.includes(input.type)))
    throw new MemoryError(400, "invalid_input", "Unsupported memory type");
  if (input.tier !== undefined && (typeof input.tier !== "string" || !tiers.includes(input.tier)))
    throw new MemoryError(400, "invalid_input", "Unsupported memory tier");
  if (input.importance !== undefined) integer(input.importance, "importance", 1, 10);
  if (input.subject !== undefined) textValue(input.subject, "subject", 256);
  const claim =
    input.claim === null ? null : input.claim === undefined ? undefined : memoryClaim(input.claim);
  if (claim && input.subject !== undefined && input.subject !== claim.subject)
    throw new MemoryError(400, "subject_conflict", "Record and claim subjects must agree");
  if (input.metadata !== undefined) {
    object(input.metadata);
    if (Buffer.byteLength(JSON.stringify(input.metadata)) > 16384)
      throw new MemoryError(400, "invalid_input", "Metadata exceeds 16 KiB");
  }
  for (const key of ["source_ids", "depends_on"] as const) {
    const ids = input[key];
    if (
      ids !== undefined &&
      (!Array.isArray(ids) ||
        ids.length > 32 ||
        ids.some((id) => typeof id !== "string" || !id || id.length > 128))
    )
      throw new MemoryError(400, "invalid_input", `${key} must contain at most 32 identifiers`);
  }
  return {
    valid_time: validTime,
    expected_vocabulary_version: expectedVocabulary,
    content,
    type: input.type as MemoryRecordInput["type"],
    tier: input.tier as MemoryRecordInput["tier"],
    importance: input.importance as number | undefined,
    subject: claim?.subject ?? (input.subject as string | undefined),
    metadata: input.metadata as Record<string, unknown> | undefined,
    source_ids: input.source_ids as string[] | undefined,
    depends_on: input.depends_on as string[] | undefined,
    claim,
  };
}
