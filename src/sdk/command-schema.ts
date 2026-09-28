// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { CommandField, CommandForm } from "./command-forms";

/** One portable field contract for structured commands and stable named tools. */
export function commandFieldSchema(field: CommandField): Record<string, unknown> {
  return {
    ...(field.placeholder ? { description: field.placeholder } : {}),
    type:
      field.wireType === "string-array"
        ? "array"
        : field.wireType === "string-record"
          ? "object"
          : field.kind === "number"
            ? field.integer
              ? "integer"
              : "number"
            : "string",
    ...(field.wireType === "string-array" ? { items: { type: "string" } } : {}),
    ...(field.wireType === "string-record" ? { additionalProperties: { type: "string" } } : {}),
    ...(field.kind === "choice" ? { enum: field.choices } : {}),
    ...(field.kind === "json" && !field.wireType ? { contentMediaType: "application/json" } : {}),
    ...(field.min !== undefined ? { minimum: field.min } : {}),
    ...(field.max !== undefined ? { maximum: field.max } : {}),
    ...(field.default !== undefined
      ? { default: field.kind === "number" ? Number(field.default) : field.default }
      : {}),
  };
}

export function namedInputSchema(form: CommandForm): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(
      form.fields.map((field) => [field.id, commandFieldSchema(field)]),
    ),
    required: form.fields
      .filter((field) => !field.optionalGroup && field.default === undefined)
      .map((field) => field.id),
    additionalProperties: false,
  };
}

/** Portable invocation schema generated from the same fields the human builder uses. */
export function commandInputSchema(form: CommandForm): Record<string, unknown> {
  const properties = Object.fromEntries(
    form.fields.map((field) => [
      field.id,
      {
        title: field.label,
        ...commandFieldSchema(field),
      },
    ]),
  );
  const required = form.fields
    .filter((field) => !field.optionalGroup && field.default === undefined)
    .map((field) => field.id);
  const conditions = form.groups.flatMap((group) => {
    const fields = form.fields
      .filter((field) => field.optionalGroup === group.id && field.default === undefined)
      .map((field) => field.id);
    if (!fields.length && !group.parent) return [];
    return [
      {
        if: { required: ["enabled"], properties: { enabled: { contains: { const: group.id } } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a promise method.
        then: {
          ...(fields.length ? { required: ["values"] } : {}),
          properties: {
            ...(fields.length ? { values: { required: fields } } : {}),
            ...(group.parent ? { enabled: { contains: { const: group.parent } } } : {}),
          },
        },
      },
    ];
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    description: form.description ?? form.syntax,
    properties: {
      command: { const: form.syntax.split(" ")[0] },
      syntax: { const: form.syntax },
      values: { type: "object", properties, required, additionalProperties: false },
      enabled: {
        type: "array",
        uniqueItems: true,
        items: form.groups.length ? { enum: form.groups.map((group) => group.id) } : false,
      },
    },
    required: ["command", "syntax", ...(required.length ? ["values"] : [])],
    additionalProperties: false,
    ...(conditions.length ? { allOf: conditions } : {}),
  };
}
