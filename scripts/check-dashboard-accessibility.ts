// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import config from "../biome.json";
import exceptions from "../dashboard/accessibility-exceptions.json";

const root = resolve(import.meta.dir, "..");
const expected = exceptions
  .map(({ file, rule, reason }) => {
    if (rule !== "useMediaCaption" || !reason.trim()) {
      throw new Error(`Only documented content-dependent caption exceptions are allowed: ${file}`);
    }
    const source = readFileSync(resolve(root, file), "utf8");
    if (!/<(?:audio|video)\b/.test(source)) throw new Error(`Stale media exception: ${file}`);
    return `${file}:${rule}`;
  })
  .sort();
const actual: string[] = [];
for (const override of config.overrides) {
  for (const [rule, level] of Object.entries(override.linter.rules.a11y ?? {})) {
    if (level === "off") {
      for (const file of override.includes) actual.push(`${file}:${rule}`);
    }
  }
}
if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) {
  throw new Error(
    "Biome accessibility exceptions must match dashboard/accessibility-exceptions.json",
  );
}
const sources = resolve(root, "dashboard/src");
for (const file of readdirSync(sources, { recursive: true })) {
  if (!/\.[jt]sx?$/.test(String(file))) continue;
  if (
    /biome-ignore[^\n]*(?:lint\/a11y|lint\s*:)/.test(
      readFileSync(resolve(sources, String(file)), "utf8"),
    )
  ) {
    throw new Error(`Inline accessibility suppressions are forbidden: dashboard/src/${file}`);
  }
}
console.log(
  `Accessibility exception contract passed (${expected.length} content-dependent exceptions).`,
);
