// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generate docs/reference/environment.md from config/environment.reference.
 *
 *   bun scripts/generate-environment-reference.ts          # write
 *   bun scripts/generate-environment-reference.ts --check  # fail when stale
 *
 * `bun run docs:api` runs this as well, and CI checks it with `docs:api --check`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENVIRONMENT_REFERENCE_PATH,
  environmentCatalog,
  type SettingDescriptor,
} from "../src/config/environment";

const ROOT = resolve(import.meta.dir, "..");
export const ENVIRONMENT_DOC_PATH = "docs/reference/environment.md";

/** Escape table-breaking characters, leaving `code spans` intact. */
function cell(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith("`")
        ? part.replace(/\|/g, "\\|")
        : part.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|"),
    )
    .join("");
}

function flags(entry: SettingDescriptor): string {
  return [
    entry.isSecret && "secret",
    entry.protected && "protected",
    entry.restart && "restart",
    entry.internal && "internal",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Render the catalog as Markdown: one table per section, one row per key group. */
export function renderEnvironmentReference(content: string): string {
  const catalog = environmentCatalog(content);
  const lines = [
    "# Environment reference",
    "",
    `<!-- Generated from ${ENVIRONMENT_REFERENCE_PATH} by scripts/generate-environment-reference.ts. Do not edit. -->`,
    "",
    `Every environment variable the Marina server and its world definitions read, generated from [\`${ENVIRONMENT_REFERENCE_PATH}\`](../../${ENVIRONMENT_REFERENCE_PATH}). Everything is optional; with no configuration a loopback \`bun run start\` runs the ungated \`local\` trust profile. For a short starter, copy [\`.env.example\`](../../.env.example) to \`.env\`.`,
    "",
    "Values are defaults or safe examples. Flags: **secret** values are never displayed; **protected** keys are never written by the dashboard (edit `.env` or the process environment); **restart** keys are read once at startup; **internal** keys are set by Marina itself or read only by a command-line client, and are hidden from Admin → Settings.",
    "",
    "Script, test and CI knobs are in [docs/guides/testing.md](../guides/testing.md) and [docs/guides/release-qualification.md](../guides/release-qualification.md); SDK example knobs in [`src/sdk/examples/.env.example`](../../src/sdk/examples/.env.example); memory-service example knobs in [`examples/memory-service/.env.example`](../../examples/memory-service/.env.example).",
  ];
  let category = "";
  for (let i = 0; i < catalog.length; ) {
    const first = catalog[i]!;
    if (first.category !== category) {
      category = first.category;
      lines.push("", `## ${category}`, "", "| Variable | Description | Flags |", "|---|---|---|");
    }
    // Consecutive keys sharing one description and flags render as one row.
    const group = [first];
    while (
      i + group.length < catalog.length &&
      catalog[i + group.length]!.category === category &&
      catalog[i + group.length]!.description === first.description &&
      flags(catalog[i + group.length]!) === flags(first)
    )
      group.push(catalog[i + group.length]!);
    const keys = group
      .map((entry) => `\`${entry.key}=${entry.example}\``.replace(/\|/g, "\\|"))
      .join("<br>");
    lines.push(`| ${keys} | ${cell(first.description)} | ${flags(first)} |`);
    i += group.length;
  }
  return `${lines.join("\n")}\n`;
}

/** Write (or with `check`, verify) the generated page. */
export function generateEnvironmentReference(check: boolean): void {
  const output = renderEnvironmentReference(
    readFileSync(resolve(ROOT, ENVIRONMENT_REFERENCE_PATH), "utf8"),
  );
  const path = resolve(ROOT, ENVIRONMENT_DOC_PATH);
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      // allow-empty-catch: a missing page is simply stale
    }
    if (current !== output)
      throw new Error("Environment reference is stale; run bun run docs:api.");
    console.log(`Environment reference matches ${ENVIRONMENT_REFERENCE_PATH}.`);
  } else {
    mkdirSync(resolve(ROOT, "docs/reference"), { recursive: true });
    writeFileSync(path, output);
    console.log(`Generated ${ENVIRONMENT_DOC_PATH}.`);
  }
}

if (import.meta.main) generateEnvironmentReference(process.argv.includes("--check"));
