#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commandManifest } from "../src/engine/command-manifest";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";

const directory = mkdtempSync(join(tmpdir(), "marina-reference-"));
const db = new MarinaDB(join(directory, "reference.db"));
const engine = new Engine({ db });
try {
  // Never start the engine, import operator plugins, or open network listeners.
  const commands = commandManifest(engine.commands).sort((a, b) => a.name.localeCompare(b.name));
  const inline = (value: unknown) =>
    `\`${String(value).replaceAll("`", "'").replaceAll("\n", " ")}\``;
  const lines = [
    "# Builtin command API reference",
    "",
    "Generated from registered CommandDef metadata by `bun run docs:api`. Do not edit by hand.",
    "",
    "This is the persistence-enabled builtin surface. Runtime plugins, world room overrides,",
    "rank, gates and Code Mode can change the deployed surface. Query `help catalog` or MCP",
    "`capabilities` for the live contract. This reference grants no authority.",
    "",
    "The same fields generate dashboard helpers, agent rosters and typed MCP forms. Existing",
    "named MCP tools are compatibility adapters; use capabilities/invoke for complete discovery.",
    "",
    "Machine-readable forms and JSON invocation schemas are emitted to `dist/reference/commands.json`.",
    "",
  ];
  for (const command of commands) {
    lines.push(
      `## ${command.name}`,
      "",
      command.help,
      "",
      `Category: ${command.category}. Minimum rank: ${command.minRank}.${command.gate ? ` Gate: ${inline(command.gate)}.` : ""}`,
      `Aliases: ${command.aliases.map(inline).join(", ") || "none"}.`,
      "",
    );
    for (const form of command.forms ?? []) {
      lines.push(`### ${inline(form.syntax)}`, "", `Effect: ${form.effect ?? "unspecified"}.`, "");
      for (const field of form.fields)
        lines.push(
          `- ${inline(field.id)} (${inline(field.label)}): ${field.kind}${field.optionalGroup ? `, optional group ${inline(field.optionalGroup)}` : ", required"}${field.default !== undefined ? `, default ${inline(field.default)}` : ""}${field.choices?.length ? `, choices ${field.choices.map(inline).join(", ")}` : ""}${field.min !== undefined ? `, min ${field.min}` : ""}${field.max !== undefined ? `, max ${field.max}` : ""}.`,
        );
      for (const group of form.groups)
        lines.push(
          `- Group ${inline(group.id)}: ${inline(group.label)}${group.parent ? `; requires ${inline(group.parent)}` : ""}.`,
        );
      lines.push("");
    }
  }
  const output = `${lines.join("\n").trimEnd()}\n`;
  const path = resolve(import.meta.dir, "../docs/reference/commands.md");
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== output)
      throw new Error("Command reference is stale; run bun run docs:api.");
    console.log(`Command reference matches ${commands.length} builtin definitions.`);
  } else {
    mkdirSync(resolve(import.meta.dir, "../docs/reference"), { recursive: true });
    mkdirSync(resolve(import.meta.dir, "../dist/reference"), { recursive: true });
    writeFileSync(path, output);
    writeFileSync(
      resolve(import.meta.dir, "../dist/reference/commands.json"),
      JSON.stringify({ schema: "marina.capabilities.v1", commands }, null, 2),
    );
    console.log(`Generated reference for ${commands.length} builtin commands.`);
  }
} finally {
  await engine.shutdown();
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
