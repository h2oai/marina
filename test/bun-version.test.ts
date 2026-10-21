// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunVersionRefusal, REQUIRED_BUN } from "../src/version";

const root = join(import.meta.dir, "..");

describe("Bun version requirement", () => {
  test("the running Bun satisfies the declared range", () => {
    expect(bunVersionRefusal()).toBeNull();
  });

  test("an older Bun is refused with both versions named", () => {
    const refusal = bunVersionRefusal("1.3.11");
    expect(refusal).toContain("1.3.11");
    expect(refusal).toContain(REQUIRED_BUN);
  });

  test("engines.bun agrees with .bun-version and packageManager", () => {
    const pinned = readFileSync(join(root, ".bun-version"), "utf8").trim();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      packageManager: string;
    };
    expect(REQUIRED_BUN).toBe(`>=${pinned}`);
    expect(pkg.packageManager).toBe(`bun@${pinned}`);
    expect(bunVersionRefusal(pinned)).toBeNull();
  });
});
