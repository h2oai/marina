// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stamp benchmark results with the Marina code that produced them. Every
 * runner that writes a result file (or files a ledger run) adds a top-level
 * `marina: { commit, dirty, describe }` through `stamped()`, read once per
 * process from this checkout's git: the code a process runs does not change
 * under it. Outside a git checkout nothing is stamped, and the transfer report
 * treats the result as `version-unknown`.
 *
 * Reader side: `benchmarks/transfer/versions.ts`.
 */

import { join } from "node:path";
import { type MarinaVersion, readGitVersion } from "../src/engine/run-version";

export type { MarinaVersion } from "../src/engine/run-version";

const REPO_ROOT = join(import.meta.dir, "..");

let cached: MarinaVersion | null | undefined;

/** This process's Marina version (memoized), or undefined outside a git checkout. */
export function runVersion(): MarinaVersion | undefined {
  if (cached === undefined) cached = readGitVersion(REPO_ROOT) ?? null;
  return cached ?? undefined;
}

/** Test seam: pin (or, with undefined, clear) the version stamped on results. */
export function setRunVersionForTests(v: MarinaVersion | null | undefined): void {
  cached = v;
}

/**
 * `doc` with a `marina` stamp. A stamp already present is kept: it names the
 * run that produced the document, not the process re-saving or filing it.
 */
export function stamped<T extends object>(
  doc: T,
  version: MarinaVersion | undefined = runVersion(),
): T & { marina?: MarinaVersion } {
  const existing = (doc as { marina?: unknown }).marina;
  if (existing !== undefined || !version) return doc;
  return { ...doc, marina: version };
}
