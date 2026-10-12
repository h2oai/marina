// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Static, TObject, TOptional, TSchema } from "@sinclair/typebox";
import { z } from "zod";

/** Render the deliberately small JSON Schema vocabulary used by memory tool contracts.
 * Unsupported keywords fail at boot. Object unknown keys keep MCP's historical stripping
 * semantics; record keys stay intact. No experimental JSON Schema conversion dependency. */
function validateKeywords(schema: TSchema): void {
  const supported = new Set([
    "type",
    "properties",
    "required",
    "patternProperties",
    "items",
    "enum",
    "const",
    "anyOf",
    "oneOf",
    "minimum",
    "exclusiveMinimum",
    "maximum",
    "maxItems",
    "description",
  ]);
  for (const key of Object.keys(schema))
    if (!supported.has(key)) throw new Error(`Unsupported memory tool schema keyword: ${key}`);
}

function render(schema: TSchema): z.ZodType {
  validateKeywords(schema);
  let result: z.ZodType;
  if ("const" in schema) result = z.literal(schema.const);
  else if (schema.enum) result = z.enum(schema.enum);
  else if (schema.anyOf) result = z.union(schema.anyOf.map(render));
  else if (schema.oneOf) result = z.xor(schema.oneOf.map(render));
  else if (schema.type === "object") {
    if (schema.patternProperties) {
      if (Object.keys(schema.patternProperties).join() !== "^(.*)$")
        throw new Error("Unsupported record key pattern");
      result = z.record(z.string(), render(schema.patternProperties["^(.*)$"]));
    } else result = z.object(mcpJsonSchema(schema as TObject));
  } else if (schema.type === "array") {
    let array = z.array(render(schema.items));
    if (schema.maxItems !== undefined) array = array.max(schema.maxItems);
    result = array;
  } else if (schema.type === "integer" || schema.type === "number") {
    let number = schema.type === "integer" ? z.number().int() : z.number();
    if (schema.minimum !== undefined) number = number.min(schema.minimum);
    if (schema.exclusiveMinimum !== undefined) number = number.gt(schema.exclusiveMinimum);
    if (schema.maximum !== undefined) number = number.max(schema.maximum);
    result = number;
  } else if (schema.type === "string") result = z.string();
  else if (schema.type === "boolean") result = z.boolean();
  else if (schema.type === "null") result = z.null();
  else if (schema.type === undefined) result = z.unknown();
  else throw new Error(`Unsupported memory tool schema type: ${schema.type}`);
  return schema.description ? result.describe(schema.description) : result;
}

type Shape<T extends TObject> = {
  [K in keyof T["properties"]]: z.ZodType<
    Static<T["properties"][K]> | (T["properties"][K] extends TOptional<TSchema> ? undefined : never)
  >;
};
export function mcpJsonSchema<T extends TObject>(schema: T): Shape<T> {
  validateKeywords(schema);
  return Object.fromEntries(
    Object.entries(schema.properties).map(([name, field]) => {
      const value = render(field);
      return [name, schema.required?.includes(name) ? value : value.optional()];
    }),
  ) as Shape<T>;
}
