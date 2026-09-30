// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  codingQualificationFixture,
  qualifyCoding,
  validateCodingQualification,
} from "../scripts/qualify-coding";
import { scopeProcessState } from "./process-state";

test("live coding qualification refuses unbounded spending and output in the source checkout", () => {
  const options = { directory: "/tmp/marina-coding-qualification-unit", budgetUsd: 1 };
  expect(() => validateCodingQualification(options)).not.toThrow();
  for (const budgetUsd of [0, -1, 2.001, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => validateCodingQualification({ ...options, budgetUsd })).toThrow("budget-usd");
  expect(() => validateCodingQualification({ ...options, directory: resolve("reports") })).toThrow(
    "outside",
  );
  expect(() =>
    validateCodingQualification({ ...options, scenarios: ["bugfix", "bugfix"] }),
  ).toThrow("distinct");
  expect(() => validateCodingQualification({ ...options, timeoutMs: 600001 })).toThrow("Timeout");
});

test("symlink output cannot hide a report under the public repository", () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-qualification-test-"));
  try {
    symlinkSync(resolve("."), join(directory, "checkout"));
    expect(() =>
      validateCodingQualification({
        directory: join(directory, "checkout", "private-report"),
        budgetUsd: 1,
      }),
    ).toThrow("outside");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fixture contains a real failing boundary and passing starting points for feature/refactor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-qualification-fixture-"));
  try {
    for (const scenario of ["bugfix", "feature", "refactor"] as const) {
      const fixture = codingQualificationFixture(scenario);
      const path = join(directory, `${scenario}.ts`);
      writeFileSync(path, fixture.source);
      const module = await import(path);
      expect(module.paginate([1, 2, 3], 1, 2)).toEqual(scenario === "bugfix" ? [1] : [1, 2]);
      expect(fixture.task).toContain("candidate verification");
      expect(fixture.task).toContain("Do not commit, spawn helpers, or approve your own work");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing credentials fail before starting a world and cannot be mistaken for live success", async () => {
  using _state = scopeProcessState({ env: { OPENAI_API_KEY: undefined } });
  await expect(
    qualifyCoding({ directory: "/tmp/marina-qualification-not-created", budgetUsd: 1 }),
  ).rejects.toThrow("no live qualification was run");
});
