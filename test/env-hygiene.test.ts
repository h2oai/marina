// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("test environment hygiene", () => {
  it("deletes optional environment variables instead of assigning undefined", () => {
    const violations: string[] = [];
    const assignment = /process\.env(?:\.[A-Z0-9_]+|\[[^\]]+\])\s*=\s*undefined\b/g;

    for (const path of new Bun.Glob("test/**/*.test.ts").scanSync()) {
      if (path.endsWith("env-hygiene.test.ts")) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(assignment)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${path}:${line}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
