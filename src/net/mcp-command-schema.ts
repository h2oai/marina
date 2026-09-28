// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CommandForm } from "../sdk/command-forms";

/** MCP rendering of canonical fields; command-specific schemas live only in CommandDef. */
export function mcpCommandSchema(form: CommandForm) {
  const fields: Record<string, z.ZodType> = {};
  for (const field of form.fields) {
    let schema: z.ZodType;
    if (field.kind === "number") {
      let number = z.number();
      if (field.min !== undefined) number = number.min(field.min);
      if (field.max !== undefined) number = number.max(field.max);
      schema = number;
    } else if (field.kind === "choice" && field.choices?.length) schema = z.enum(field.choices);
    else schema = z.string();
    schema = schema.describe(`${field.label}: ${field.placeholder}`);
    if (field.default !== undefined)
      schema = schema.default(field.kind === "number" ? Number(field.default) : field.default);
    if (field.optionalGroup) schema = schema.optional();
    fields[field.id] = schema;
  }
  const values = z.object(fields).strict();
  const required = form.fields.some((field) => !field.optionalGroup && field.default === undefined);
  return {
    values: required ? values : values.optional(),
    enabled: (form.groups.length
      ? z.array(z.enum(form.groups.map((group) => group.id)))
      : z.array(z.never())
    ).optional(),
  };
}
/** A handler replacement invalidates an exposed tool even if its form is identical. */
export function commandFormFingerprint(
  form: CommandForm,
  revision: number,
  owner?: string,
): string {
  return createHash("sha256").update(JSON.stringify({ revision, owner, form })).digest("hex");
}
