// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { z } from "zod";
import { mcpNamedCommandSchema } from "../src/net/mcp-command-schema";
import { composeCommand } from "../src/sdk/command-forms";
import { NAMED_COMMAND_FORMS } from "../src/sdk/named-command-forms";
import baseline from "./fixtures/mcp-named-contracts.json";

it("preserves every published named-tool schema while generating it from CommandForm", () => {
  for (const [name, form] of Object.entries(NAMED_COMMAND_FORMS)) {
    const actual = z.toJSONSchema(z.object(mcpNamedCommandSchema(form)));
    expect<unknown>(actual).toEqual(baseline[name as keyof typeof baseline]);
    expect(composeCommand(form, {}, {}).errors.form).toBeDefined();
  }
});

it("validates bounds, enums, scalar types, record values and array members", () => {
  const think = z.object(mcpNamedCommandSchema(NAMED_COMMAND_FORMS.think));
  for (const budget of [255, 65537, 256.5, "4096", Number.NaN, Number.POSITIVE_INFINITY])
    expect(think.safeParse({ action: "context", text: "quartz", budget }).success).toBe(false);
  for (const budget of [256, 4096, 65536])
    expect(think.safeParse({ action: "context", text: "quartz", budget }).success).toBe(true);
  expect(think.safeParse({ action: "admin", text: "quartz" }).success).toBe(false);
  const probe = z.object(mcpNamedCommandSchema(NAMED_COMMAND_FORMS.probe));
  expect(probe.safeParse({ kind: "echoing", args: { payload: "safe" } }).success).toBe(true);
  for (const args of [[], { payload: 1 }, { payload: null }, "unsafe"])
    expect(probe.safeParse({ kind: "echoing", args }).success).toBe(false);
  const flywheel = z.object(mcpNamedCommandSchema(NAMED_COMMAND_FORMS.flywheel));
  expect(flywheel.safeParse({ action: "exec", args: ["one", "two"] }).success).toBe(true);
  expect(flywheel.safeParse({ action: "exec", args: [1] }).success).toBe(false);
});
