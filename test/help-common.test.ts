// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What `help` leads with (src/engine/commands/help-common.ts) is held to the
 * live command definitions: every common form is a declared usage syntax, and
 * every start-here form is one with its optional `[…]` parts left out.
 */

import { afterEach, beforeEach, expect, it } from "bun:test";
import { COMMON_FORMS, START_HERE } from "../src/engine/commands/help-common";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi } from "./helpers";

let world: ReturnType<typeof createTestEngine>;
beforeEach(() => {
  world = createTestEngine();
});
afterEach(() => world.dispose());

const syntaxes = () => {
  const out = new Map<string, string[]>();
  for (const def of world.engine.commands.allBuiltins())
    out.set(
      def.name,
      (def.usage ?? []).map((u) => (typeof u === "string" ? u : u.syntax)),
    );
  return out;
};
const withoutOptional = (syntax: string) =>
  syntax
    .replace(/\s*\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

it("every common form is a declared syntax of its command", () => {
  const all = syntaxes();
  for (const [name, forms] of Object.entries(COMMON_FORMS))
    for (const form of forms)
      expect({ name, form, declared: all.get(name)?.includes(form) ?? false }).toMatchObject({
        declared: true,
      });
});

it("every start-here form is a declared syntax, optional parts aside", () => {
  const all = syntaxes();
  for (const [form] of START_HERE) {
    const name = form.split(" ")[0]!;
    const declared = (all.get(name) ?? []).some(
      (syntax) => syntax === form || withoutOptional(syntax) === form,
    );
    expect({ form, declared }).toMatchObject({ declared: true });
  }
});

it("`help` leads with the start-here commands; `help code` with its common forms", async () => {
  const ada = world.login("Ada");
  const run = async (raw: string) => {
    ada.connection.clear();
    await world.engine.processCommand(ada.entityId, raw);
    return ada.connection.messages.map((m) => stripAnsi(String(m.data?.text ?? ""))).join("\n");
  };
  const home = await run("help");
  expect(home).toContain("Start here");
  for (const [form] of START_HERE) expect(home).toContain(form);
  // Categories are named, not expanded into every command.
  expect(home).not.toContain("inheritance");
  const code = await run("help code");
  expect(code).toContain("Common forms:");
  expect(code).toContain("code start [title]");
  expect(code).not.toContain("code sandbox hibernate");
  expect(code.split("\n").length).toBeLessThan(25);
  expect(await run("help code full")).toContain("code sandbox hibernate");
});
