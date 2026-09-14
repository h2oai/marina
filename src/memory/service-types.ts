// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  MemoryAdoptInput,
  MemoryClaim,
  MemoryRecordInput,
  MemoryResolveInput,
  MemoryResolvePolicy,
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
/** Half-open `[from, until)` in UTC milliseconds; null bounds are unbounded.
 * `undefined` means "not supplied" and `null` means "explicitly unbounded". */
export function memoryValidity(value: unknown): MemoryValidity | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const interval = object(value);
  const from =
    interval.from === null || interval.from === undefined
      ? null
      : integer(interval.from, "valid_time.from", 0, Number.MAX_SAFE_INTEGER);
  const until =
    interval.until === null || interval.until === undefined
      ? null
      : integer(interval.until, "valid_time.until", 0, Number.MAX_SAFE_INTEGER);
  if (from !== null && until !== null && from >= until)
    throw new MemoryError(
      400,
      "invalid_interval",
      "valid_time must be a nonempty half-open interval",
    );
  return { from, until };
}
export const MEMORY_RESOLVE_POLICIES = [
  "last_writer_wins",
  "evidence_weighted",
  "await_confirmation",
  "keep_both",
] as const satisfies readonly MemoryResolvePolicy[];
export function resolveInput(value: unknown): MemoryResolveInput {
  const input = object(value);
  if (
    typeof input.policy !== "string" ||
    !MEMORY_RESOLVE_POLICIES.includes(input.policy as MemoryResolvePolicy)
  )
    throw new MemoryError(
      400,
      "invalid_policy",
      `policy must be one of ${MEMORY_RESOLVE_POLICIES.join(", ")}`,
    );
  const competing = input.competing;
  if (
    !Array.isArray(competing) ||
    !competing.length ||
    competing.length > 32 ||
    competing.some((id) => typeof id !== "string" || !id || id.length > 128) ||
    new Set(competing).size !== competing.length
  )
    throw new MemoryError(
      400,
      "invalid_input",
      "competing must list 1–32 distinct record identifiers",
    );
  const rationale = textValue(input.rationale, "rationale", 4096);
  const deadline =
    input.deadline_ms === undefined
      ? undefined
      : integer(input.deadline_ms, "deadline_ms", 1000, 366 * 86_400_000);
  if (deadline !== undefined && input.policy !== "await_confirmation")
    throw new MemoryError(400, "invalid_input", "deadline_ms applies only to await_confirmation");
  const validTime = memoryValidity(input.valid_time);
  return {
    policy: input.policy as MemoryResolvePolicy,
    competing: competing as string[],
    rationale,
    ...(validTime === undefined ? {} : { valid_time: validTime }),
    ...(deadline === undefined ? {} : { deadline_ms: deadline }),
  };
}
export function adoptInput(value: unknown): MemoryAdoptInput {
  const input = object(value);
  const jobId = textValue(input.job_id, "job_id", 128);
  const target =
    input.target_space_id === undefined || input.target_space_id === null
      ? undefined
      : textValue(input.target_space_id, "target_space_id", 128);
  const rationale =
    input.rationale === undefined || input.rationale === null
      ? undefined
      : textValue(input.rationale, "rationale", 4096);
  if (input.confirm_abstention !== undefined && typeof input.confirm_abstention !== "boolean")
    throw new MemoryError(400, "invalid_input", "confirm_abstention must be boolean");
  const validTime = memoryValidity(input.valid_time);
  return {
    job_id: jobId,
    ...(target === undefined ? {} : { target_space_id: target }),
    ...(rationale === undefined ? {} : { rationale }),
    ...(validTime === undefined ? {} : { valid_time: validTime }),
    ...(input.confirm_abstention === undefined
      ? {}
      : { confirm_abstention: input.confirm_abstention }),
  };
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
  const validTime = memoryValidity(input.valid_time);
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
  let dependencyVersions: Record<string, number> | undefined;
  if (input.dependency_versions !== undefined) {
    const versions = object(input.dependency_versions);
    if (Object.keys(versions).length > 32)
      throw new MemoryError(
        400,
        "invalid_dependencies",
        "At most 32 dependency versions are supported",
      );
    dependencyVersions = Object.create(null);
    for (const [id, version] of Object.entries(versions))
      dependencyVersions![textValue(id, "dependency id", 128)] = integer(
        version,
        "dependency version",
        1,
        Number.MAX_SAFE_INTEGER,
      );
  }
  return {
    dependency_versions: dependencyVersions,
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
