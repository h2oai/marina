// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Static fence: every tracked TypeScript source under the published trees
 * carries the two-line license header near the top of the file:
 *
 *   // Copyright 2025-2026 H2O.ai, Inc.
 *   // SPDX-License-Identifier: Apache-2.0
 *
 * A shebang line may precede it. Generated files that cannot carry a header
 * go in ALLOW with a reason.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TREES = ["src", "scripts", "benchmarks", "worlds", "dashboard/src"];
const HEADER = "SPDX-License-Identifier: Apache-2.0";
/** Bytes from the start of a file the header must appear within. */
const HEAD_BYTES = 400;
/** Tracked paths exempt from the header, with the reason. */
const ALLOW = new Map<string, string>();

function trackedSources(): string[] | null {
  const result = Bun.spawnSync(["git", "ls-files", "--", ...TREES], { cwd: ROOT });
  if (result.exitCode !== 0) return null;
  return result.stdout
    .toString()
    .split("\n")
    .filter((path) => /\.tsx?$/.test(path) && !path.endsWith(".d.ts"));
}

describe("SPDX license headers", () => {
  const files = trackedSources();

  it.skipIf(files === null)("every tracked .ts/.tsx source carries the header", () => {
    const missing = (files ?? []).filter(
      (path) =>
        !ALLOW.has(path) &&
        !readFileSync(join(ROOT, path), "utf8").slice(0, HEAD_BYTES).includes(HEADER),
    );
    expect(missing).toEqual([]);
  });

  it.skipIf(files === null)("finds the trees it fences", () => {
    expect((files ?? []).length).toBeGreaterThan(100);
  });
});
