#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * check-versions — every versioned package.json in the repository must carry the
 * root version.
 *
 *   bun run check:versions
 *
 * Walks the repo (skipping node_modules, dist, build output), prints a table of
 * every manifest, and exits 1 when a versioned manifest differs from the root.
 * Unversioned manifests are listed but never fail the check. Workspace membership
 * is irrelevant on purpose: the extensions are published standalone and still
 * must ship the root version.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".astro",
  "data",
  "marina-data",
  "backups",
  "artifacts",
  "test-results",
  "playwright-report",
]);

interface Manifest {
  path: string;
  name: string;
  version: string | undefined;
  private: boolean;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (entry === "package.json") yield full;
  }
}

export function collectManifests(root = ROOT): Manifest[] {
  const out: Manifest[] = [];
  for (const file of walk(root)) {
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    out.push({
      path: relative(root, file) || "package.json",
      name: typeof json.name === "string" ? json.name : "(unnamed)",
      version: typeof json.version === "string" ? json.version : undefined,
      private: json.private === true,
    });
  }
  return out.sort((a, b) =>
    a.path === "package.json" ? -1 : b.path === "package.json" ? 1 : a.path.localeCompare(b.path),
  );
}

export function findMismatches(manifests: Manifest[]): {
  rootVersion: string;
  mismatched: Manifest[];
} {
  const root = manifests.find((m) => m.path === "package.json");
  if (!root?.version) throw new Error("root package.json has no version");
  const mismatched = manifests.filter((m) => m.version !== undefined && m.version !== root.version);
  return { rootVersion: root.version, mismatched };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

if (import.meta.main) {
  const manifests = collectManifests();
  const { rootVersion, mismatched } = findMismatches(manifests);
  const bad = new Set(mismatched.map((m) => m.path));
  const w = Math.max(...manifests.map((m) => m.path.length), 12);
  const wn = Math.max(...manifests.map((m) => m.name.length), 4);
  console.log(`root version: ${rootVersion}\n`);
  console.log(`${pad("manifest", w)}  ${pad("name", wn)}  version      status`);
  console.log(`${"-".repeat(w)}  ${"-".repeat(wn)}  -----------  ------`);
  for (const m of manifests) {
    const status = m.version === undefined ? "unversioned" : bad.has(m.path) ? "MISMATCH" : "ok";
    console.log(`${pad(m.path, w)}  ${pad(m.name, wn)}  ${pad(m.version ?? "-", 11)}  ${status}`);
  }
  if (mismatched.length > 0) {
    console.error(
      `\n${mismatched.length} manifest(s) differ from the root version ${rootVersion}.`,
    );
    process.exit(1);
  }
  console.log(
    `\nAll ${manifests.filter((m) => m.version !== undefined).length} versioned manifests are at ${rootVersion}.`,
  );
}
