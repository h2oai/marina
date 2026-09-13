// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MemoryJoin, MemoryPattern, MemoryRule, MemoryVariable } from "../sdk/memory-symbolic";
import { integer, MemoryError, memoryTerm, object, textValue } from "./service-types";

const invalid = (message: string): never => {
  throw new MemoryError(400, "invalid_symbolic", message);
};
export const isMemoryVariable = (value: unknown): value is MemoryVariable =>
  typeof value === "object" && value !== null && Object.hasOwn(value, "variable");

function pattern(value: unknown, variables: Map<string, string>, declare: boolean): MemoryPattern {
  const raw = object(value);
  if (Object.keys(raw).some((key) => !["subject", "predicate", "object"].includes(key)))
    invalid("Unknown pattern field");
  const slot = (value: unknown, position: "subject" | "predicate" | "object") => {
    if (isMemoryVariable(value)) {
      const v = object(value);
      if (Object.keys(v).some((key) => !["variable", "type"].includes(key)))
        invalid("Unknown variable field");
      const name = textValue(v.variable, "variable", 48),
        type = textValue(v.type, "type", 16);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) invalid("Invalid variable name");
      if (
        !(
          position === "subject"
            ? ["entity"]
            : position === "predicate"
              ? ["symbol"]
              : ["entity", "string", "number", "boolean", "null"]
        ).includes(type)
      )
        invalid("Variable type is incompatible with its position");
      if (variables.has(name) ? variables.get(name) !== type : !declare)
        invalid("Variable must be bound consistently by the rule body");
      variables.set(name, type);
      return { variable: name, type } as MemoryVariable;
    }
    return position === "object" ? memoryTerm(value) : textValue(value, position, 256);
  };
  return {
    subject: slot(raw.subject, "subject"),
    predicate: slot(raw.predicate, "predicate"),
    object: slot(raw.object, "object"),
  } as MemoryPattern;
}
export function memoryJoin(value: unknown): MemoryJoin {
  const raw = object(value),
    variables = new Map<string, string>();
  if (Object.keys(raw).some((key) => !["patterns", "select", "valid_at", "limit"].includes(key)))
    invalid("Unknown join field");
  if (!Array.isArray(raw.patterns) || !raw.patterns.length || raw.patterns.length > 8)
    invalid("Use 1–8 nonrecursive patterns");
  const patterns = (raw.patterns as unknown[]).map((p) => pattern(p, variables, true));
  const select = raw.select ?? [...variables.keys()];
  if (
    !Array.isArray(select) ||
    select.length > 24 ||
    select.some((v) => typeof v !== "string" || !variables.has(v)) ||
    new Set(select).size !== select.length
  )
    invalid("Select must name distinct bound variables");
  return {
    patterns,
    select: select as string[],
    limit: integer(raw.limit ?? 20, "limit", 1, 100),
    ...(raw.valid_at === undefined
      ? {}
      : { valid_at: integer(raw.valid_at, "valid_at", 0, Number.MAX_SAFE_INTEGER) }),
  };
}
export function memoryRule(value: unknown): MemoryRule {
  const raw = object(value);
  if (
    raw.schema !== "marina.memory.rule.v1" ||
    Object.keys(raw).some((key) => !["schema", "name", "query", "conclusion"].includes(key))
  )
    invalid("Invalid rule schema");
  const query = memoryJoin(raw.query),
    variables = new Map<string, string>();
  for (const p of query.patterns)
    for (const v of Object.values(p)) if (isMemoryVariable(v)) variables.set(v.variable, v.type);
  // Rule heads need all bindings even if a caller supplied a smaller projection.
  query.select = [...variables.keys()];
  return {
    schema: "marina.memory.rule.v1",
    name: textValue(raw.name, "name", 256),
    query,
    conclusion: pattern(raw.conclusion, variables, false),
  };
}
