// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Deliberately bounded JSON Schema subset. Unsupported keywords are errors,
 * never silently ignored. No coercion, inferred facts or model dependency. */
export type MemoryAnswerSchema =
  | { type: "string" | "number" | "integer" | "boolean" | "null"; description?: string }
  | { type: "array"; items: MemoryAnswerSchema; description?: string }
  | {
      type: "object";
      properties: Record<string, MemoryAnswerSchema>;
      required: string[];
      additionalProperties: false;
      description?: string;
    };

export interface MemoryAnswerContract {
  schema: MemoryAnswerSchema;
  evidence: "required" | "optional";
  allow_historical?: boolean;
}
export type MemoryEvidence =
  | {
      kind: "record";
      space_id: string;
      id: string;
      version: number;
      text: string;
      freshness: string;
    }
  | {
      kind: "source";
      space_id: string;
      id: string;
      text_hash: string;
      start: number;
      end: number;
      text: string;
    };
export type MemoryCitation =
  | (Omit<Extract<MemoryEvidence, { kind: "record" }>, "text" | "freshness"> & {
      quote: string;
    })
  | (Omit<Extract<MemoryEvidence, { kind: "source" }>, "text"> & { quote: string });
export type MemoryAnswer =
  | { status: "answered"; answer: unknown; citations: MemoryCitation[] }
  | { status: "abstained"; reason: string };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

export function assertMemoryAnswerContract(contract: MemoryAnswerContract): void {
  const visit = (schema: MemoryAnswerSchema, depth: number) => {
    if (depth > 12 || !object(schema))
      throw new Error("Invalid or excessively nested answer schema");
    const keys = ["type", "description"];
    if (schema.description !== undefined && typeof schema.description !== "string")
      throw new Error("Schema description must be a string");
    if (schema.type === "object") {
      keys.push("properties", "required", "additionalProperties");
      if (
        !object(schema.properties) ||
        schema.additionalProperties !== false ||
        !Array.isArray(schema.required) ||
        schema.required.some(
          (key) => typeof key !== "string" || !Object.hasOwn(schema.properties, key),
        )
      )
        throw new Error(
          "Object schemas require properties, required and additionalProperties:false",
        );
      for (const child of Object.values(schema.properties)) visit(child, depth + 1);
    } else if (schema.type === "array") {
      keys.push("items");
      visit(schema.items, depth + 1);
    } else if (!["string", "number", "integer", "boolean", "null"].includes(schema.type))
      throw new Error("Unsupported answer schema type");
    if (!keysAre(schema, keys)) throw new Error("Unsupported answer schema keyword");
  };
  if (
    !object(contract) ||
    !keysAre(contract, ["schema", "evidence", "allow_historical"]) ||
    !["required", "optional"].includes(contract.evidence) ||
    (contract.allow_historical !== undefined && typeof contract.allow_historical !== "boolean")
  )
    throw new Error("Invalid answer contract");
  visit(contract.schema, 0);
}

function checkShape(schema: MemoryAnswerSchema, value: unknown, path: string, errors: string[]) {
  if (errors.length >= 10) return;
  if (schema.type === "object") {
    if (!object(value)) {
      errors.push(`${path}: expected object`);
      return;
    }
    for (const key of schema.required)
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) errors.push(`${path}.${key}: additional field`);
      else checkShape(schema.properties[key]!, child, `${path}.${key}`, errors);
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) errors.push(`${path}: expected array`);
    else
      for (const [index, child] of value.entries())
        checkShape(schema.items, child, `${path}[${index}]`, errors);
  } else {
    const valid =
      schema.type === "null"
        ? value === null
        : schema.type === "integer"
          ? Number.isSafeInteger(value)
          : schema.type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : typeof value === schema.type;
    if (!valid) errors.push(`${path}: expected ${schema.type}`);
  }
}

/** Call only with authenticated read-operation results, not model output or
 * arbitrary documents. Excerpts, provenance IDs and write receipts aren't reads.
 * Source ranges inherit the explicitly requested space; federated callers must
 * collect each peer result with its own origin space. */
export function collectMemoryEvidence(result: unknown, space: string): MemoryEvidence[] {
  const evidence: MemoryEvidence[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 12) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (!object(value)) return;
    if (
      typeof value.id === "string" &&
      typeof value.content === "string" &&
      value.space_id === space &&
      Number.isSafeInteger(value.version) &&
      Number(value.version) > 0
    ) {
      evidence.push({
        kind: "record",
        space_id: space,
        id: value.id,
        version: Number(value.version),
        text: value.content,
        freshness: typeof value.freshness === "string" ? value.freshness : "unassessed",
      });
      return;
    }
    if (
      typeof value.id === "string" &&
      value.representation === "utf8-source-text-v1" &&
      typeof value.text_hash === "string" &&
      typeof value.text === "string" &&
      Number.isSafeInteger(value.start) &&
      Number.isSafeInteger(value.end) &&
      Number(value.start) >= 0 &&
      Number(value.end) >= Number(value.start)
    ) {
      evidence.push({
        kind: "source",
        space_id: space,
        id: value.id,
        text_hash: value.text_hash,
        start: Number(value.start),
        end: Number(value.end),
        text: value.text,
      });
      return;
    }
    for (const key of [
      "trace",
      "evidence",
      "results",
      "edges",
      "record",
      "items",
      "competing_records",
    ])
      visit(value[key], depth + 1);
  };
  visit(result, 0);
  return evidence;
}

/** Validates shape and exact witnessed quotations, not entailment, authority,
 * absence of competing claims, or freshness after the read. */
export function validateMemoryAnswer(
  contract: MemoryAnswerContract,
  value: unknown,
  evidence: readonly MemoryEvidence[],
): { ok: true; value: MemoryAnswer } | { ok: false; errors: string[] } {
  assertMemoryAnswerContract(contract);
  const errors: string[] = [];
  if (!object(value)) return { ok: false, errors: ["Return an answer or abstention object"] };
  if (value.status === "abstained") {
    if (
      !keysAre(value, ["status", "reason"]) ||
      typeof value.reason !== "string" ||
      !value.reason.trim()
    )
      return { ok: false, errors: ["Abstention requires only status and a nonempty reason"] };
    return { ok: true, value: value as MemoryAnswer };
  }
  if (
    value.status !== "answered" ||
    !keysAre(value, ["status", "answer", "citations"]) ||
    !Object.hasOwn(value, "answer")
  )
    return { ok: false, errors: ["Answer requires status:answered, answer and citations"] };
  checkShape(contract.schema, value.answer, "answer", errors);
  if (!Array.isArray(value.citations) || value.citations.length > 64)
    return { ok: false, errors: [...errors, "citations must be an array with at most 64 entries"] };
  if (contract.evidence === "required" && !value.citations.length)
    errors.push("At least one witnessed citation is required");
  for (const [index, citation] of value.citations.entries()) {
    if (
      !object(citation) ||
      typeof citation.quote !== "string" ||
      !citation.quote.trim() ||
      !keysAre(
        citation,
        citation.kind === "record"
          ? ["kind", "space_id", "id", "version", "quote"]
          : ["kind", "space_id", "id", "text_hash", "start", "end", "quote"],
      )
    ) {
      errors.push(`citations[${index}]: invalid citation`);
      continue;
    }
    const match = evidence.some(
      (item) =>
        item.kind === citation.kind &&
        item.space_id === citation.space_id &&
        item.id === citation.id &&
        item.text.includes(citation.quote as string) &&
        (item.kind === "record"
          ? item.version === citation.version &&
            (contract.allow_historical || item.freshness === "current")
          : item.text_hash === citation.text_hash &&
            item.start === citation.start &&
            item.end === citation.end),
    );
    if (!match)
      errors.push(`citations[${index}]: no permitted read matches the ID, version/range and quote`);
  }
  return errors.length
    ? { ok: false, errors: errors.slice(0, 10) }
    : { ok: true, value: value as MemoryAnswer };
}

/** Creates a caller-selected quotation from evidence without making truth or
 * freshness judgments. Quote must be an exact substring of evidence.text and
 * must not be empty or whitespace-only. Does not mutate evidence. */
export function createMemoryCitation(evidence: MemoryEvidence, quote: string): MemoryCitation {
  if (!quote?.trim()) {
    throw new RangeError("Quote must be a nonempty string");
  }
  if (!evidence.text.includes(quote)) {
    throw new RangeError("Quote is not an exact substring of evidence.text");
  }
  if (evidence.kind === "record") {
    return {
      kind: "record",
      space_id: evidence.space_id,
      id: evidence.id,
      version: evidence.version,
      quote: quote,
    };
  } else {
    return {
      kind: "source",
      space_id: evidence.space_id,
      id: evidence.id,
      text_hash: evidence.text_hash,
      start: evidence.start,
      end: evidence.end,
      quote: quote,
    };
  }
}
