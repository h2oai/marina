// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { integer, MemoryError, object, textValue } from "../memory/service-types";
import type {
  MemoryRecordInput,
  MemoryVocabulary,
  MemoryVocabularyDefinition,
} from "../sdk/memory-types";
import { authorizeMemorySpace, event, mutation } from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

export function memoryVocabulary(
  db: Database,
  actor: MemoryActor,
  space: string,
  version?: number,
): MemoryVocabulary {
  authorizeMemorySpace(db, actor, space);
  return readVocabulary(db, space, version);
}

function readVocabulary(db: Database, space: string, version?: number): MemoryVocabulary {
  if (version !== undefined) integer(version, "version", 0, Number.MAX_SAFE_INTEGER);
  if (version === 0) return { version: 0, definition: { closed: false, predicates: {} } };
  const row = db
    .query(`SELECT version,definition FROM memory_vocabularies WHERE space_id=?
    AND (? IS NULL OR version=?) ORDER BY version DESC LIMIT 1`)
    .get(space, version ?? null, version ?? null) as { version: number; definition: string } | null;
  if (!row && version !== undefined)
    throw new MemoryError(404, "vocabulary_not_found", "Vocabulary version not found");
  return row
    ? { version: row.version, definition: JSON.parse(row.definition) }
    : { version: 0, definition: { closed: false, predicates: {} } };
}

export function definitionInput(value: unknown): MemoryVocabularyDefinition {
  const input = object(value),
    predicates = object(input.predicates);
  if (typeof input.closed !== "boolean" || Object.keys(predicates).length > 128)
    throw new MemoryError(
      400,
      "invalid_vocabulary",
      "Use closed:boolean and at most 128 predicates",
    );
  const definitions: MemoryVocabularyDefinition["predicates"] = Object.create(null);
  for (const [name, value] of Object.entries(predicates)) {
    textValue(name, "predicate", 256);
    const entry = object(value);
    if (
      typeof entry.object !== "string" ||
      !["entity", "string", "number", "boolean", "null"].includes(entry.object) ||
      typeof entry.cardinality !== "string" ||
      !["one", "many"].includes(entry.cardinality)
    )
      throw new MemoryError(400, "invalid_vocabulary", "Invalid object type or cardinality");
    definitions[name] = {
      object: entry.object as "entity",
      cardinality: entry.cardinality as "one",
      ...(entry.description === undefined
        ? {}
        : { description: textValue(entry.description, "description", 1024) }),
    };
  }
  return { closed: input.closed, predicates: definitions };
}

export function validateMemoryContract(
  db: Database,
  _actor: MemoryActor,
  space: string,
  input: MemoryRecordInput,
  exclude = "",
  vocabulary = readVocabulary(db, space),
): number {
  if (
    input.expected_vocabulary_version !== undefined &&
    input.expected_vocabulary_version !== vocabulary.version
  )
    throw new MemoryError(409, "vocabulary_changed", "Vocabulary version changed");
  const claim = input.claim;
  if (!claim) return vocabulary.version;
  const def = Object.hasOwn(vocabulary.definition.predicates, claim.predicate)
    ? vocabulary.definition.predicates[claim.predicate]
    : undefined;
  if (!def) {
    if (vocabulary.definition.closed)
      throw new MemoryError(
        409,
        "unknown_predicate",
        `Predicate is not declared: ${claim.predicate}`,
      );
    return vocabulary.version;
  }
  const kind =
    claim.object.kind === "entity"
      ? "entity"
      : claim.object.value === null
        ? "null"
        : typeof claim.object.value;
  if (kind !== def.object)
    throw new MemoryError(
      409,
      "claim_type_conflict",
      `Predicate ${claim.predicate} requires ${def.object}`,
    );
  if (def.cardinality === "one") {
    const conflicts = db
      .query(`SELECT c.record_id,c.object_json FROM memory_claims c JOIN memory_records r ON r.id=c.record_id
      WHERE c.space_id=? AND c.subject=? AND c.predicate=? AND c.record_id!=? AND r.status='active' AND r.stale=0
      AND (? IS NULL OR r.valid_until IS NULL OR r.valid_until>?)
      AND (? IS NULL OR r.valid_from IS NULL OR r.valid_from<?)`)
      .all(
        space,
        claim.subject,
        claim.predicate,
        exclude,
        input.valid_time?.from ?? null,
        input.valid_time?.from ?? null,
        input.valid_time?.until ?? null,
        input.valid_time?.until ?? null,
      ) as { record_id: string; object_json: string }[];
    const different = conflicts.filter((row) => {
      const term = JSON.parse(row.object_json);
      return (
        term.kind !== claim.object.kind ||
        (claim.object.kind === "entity"
          ? term.id !== claim.object.id
          : term.value !== claim.object.value)
      );
    });
    if (different.length)
      throw new MemoryError(
        409,
        "claim_cardinality_conflict",
        `Conflicting active assertions: ${different
          .slice(0, 10)
          .map((row) => row.record_id)
          .join(", ")}`,
      );
  }
  return vocabulary.version;
}

export function saveMemoryVocabulary(
  db: Database,
  actor: MemoryActor,
  space: string,
  expected: number,
  value: unknown,
  key: string,
) {
  const definition = definitionInput(value);
  integer(expected, "expected_version", 0, Number.MAX_SAFE_INTEGER);
  return mutation(db, actor, space, key, "vocabulary.save", { expected, definition }, () => {
    const current = authorizeMemorySpace(db, actor, space, "memory:write");
    if (current.owner_id !== actor.principalId)
      throw new MemoryError(403, "owner_required", "Only the space owner may change vocabulary");
    if (readVocabulary(db, space).version !== expected)
      throw new MemoryError(409, "version_conflict", "Vocabulary version is stale");
    const version = expected + 1;
    const claims = db
      .query(`SELECT c.record_id,c.subject,c.predicate,c.object_json,r.valid_from,r.valid_until FROM memory_claims c
      JOIN memory_records r ON r.id=c.record_id WHERE c.space_id=? AND r.status='active' AND r.stale=0 LIMIT 10001`)
      .all(space) as {
      record_id: string;
      subject: string;
      predicate: string;
      object_json: string;
      valid_from: number | null;
      valid_until: number | null;
    }[];
    if (claims.length > 10000)
      throw new MemoryError(
        413,
        "vocabulary_capacity",
        "Online vocabulary validation is limited to 10,000 assertions",
      );
    for (const claim of claims)
      validateMemoryContract(
        db,
        actor,
        space,
        {
          content: "validation",
          claim: {
            subject: claim.subject,
            predicate: claim.predicate,
            object: JSON.parse(claim.object_json),
          },
          valid_time: { from: claim.valid_from, until: claim.valid_until },
        },
        claim.record_id,
        { version, definition },
      );
    db.run("INSERT INTO memory_vocabularies VALUES (?,?,?,?)", [
      space,
      version,
      JSON.stringify(definition),
      Date.now(),
    ]);
    return { id: space, version, seq: event(db, actor, space, "vocabulary.saved", space, version) };
  });
}
