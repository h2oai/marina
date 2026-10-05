// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional extensions stay optional: no core source, script, world or
 * benchmark imports an extension directory, and no extension is a member of the
 * root workspace (each keeps its own package.json and lockfile). Extensions may
 * import the core; the core never imports them.
 */

import { expect, test } from "bun:test";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CORE_DIRS = ["src", "scripts", "worlds", "benchmarks", "rooms"];

function sources(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // allow-empty-catch: a core directory may be absent in a slim checkout
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("no core module imports an extension directory", () => {
  const offenders = CORE_DIRS.flatMap((dir) => sources(join(ROOT, dir))).filter((file) =>
    /from\s+["'][^"']*\/extensions\/[a-z0-9-]+\//.test(readFileSync(file, "utf8")),
  );
  expect(offenders.map((file) => relative(ROOT, file))).toEqual([]);
});

test("extensions are not root workspace members", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  expect((pkg.workspaces ?? []).filter((w) => w.startsWith("extensions"))).toEqual([]);
});
