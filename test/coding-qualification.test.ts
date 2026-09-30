// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  codingQualificationFailure,
  codingQualificationFixture,
  codingWorkspaceFixture,
  codingWorkspaceHoldout,
  codingWorkspaceInstructionEvidence,
  qualifyCoding,
  validateCodingQualification,
} from "../scripts/qualify-coding";
import { captureGitCandidate } from "../src/coding/candidate";
import { BUN_PREPARATION_POLICY } from "../src/coding/candidate-dependencies";
import { LocalWorkspace } from "../src/coding/local-workspace";
import {
  loadProjectInstructions,
  projectInstructionMetadata,
} from "../src/coding/project-instructions";
import { scopeProcessState } from "./process-state";

test("live coding qualification refuses unbounded spending and output in the source checkout", () => {
  const options = { directory: "/tmp/marina-coding-qualification-unit", budgetUsd: 1 };
  expect(() => validateCodingQualification(options)).not.toThrow();
  expect(() =>
    validateCodingQualification({
      ...options,
      scenarios: ["bugfix", "feature", "refactor", "workspace"],
    }),
  ).not.toThrow();
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

test("workspace fixture captures local dependencies and its independent oracle rejects plausible partial fixes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-qualification-workspace-"));
  const root = join(directory, "workspace");
  const snapshots: Awaited<ReturnType<typeof captureGitCandidate>>[] = [];
  const fixture = codingWorkspaceFixture();
  const command = async (args: string[], cwd: string) => {
    const child = Bun.spawn(args, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, output: stdout + stderr };
  };
  const capture = async () => {
    const snapshot = await captureGitCandidate(root);
    snapshots.push(snapshot);
    const prepared = await new LocalWorkspace(snapshot.directory).prepareCandidateDependencies(
      () => {},
    );
    expect(prepared.result.exitCode, prepared.result.output).toBe(0);
    expect(prepared.policy).toBe(BUN_PREPARATION_POLICY);
    expect(readFileSync(join(snapshot.directory, "bun.lock"), "utf8")).toBe(
      fixture.files["bun.lock"]!,
    );
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    return snapshot;
  };
  try {
    for (const [path, content] of Object.entries(fixture.files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    for (const path of fixture.instructionPaths) expect(fixture.files[path]).toContain("contract:");
    expect(fixture.task).toContain("dependencies:bun");
    expect(fixture.task).toContain("inspect the completed receipt");
    const reads = await Promise.all(
      fixture.sourcePaths.map(async (path) => ({
        id: path,
        actor: "Coderworkspace",
        kind: "file_read",
        payload_json: JSON.stringify({
          path,
          projectInstructions: projectInstructionMetadata(
            await loadProjectInstructions({ root, target: path, executionTarget: "local" }),
          ),
        }),
      })),
    );
    expect(
      codingWorkspaceInstructionEvidence(reads, "Coderworkspace").map((item) => item.path),
    ).toEqual(fixture.instructionPaths);
    expect(codingWorkspaceInstructionEvidence(reads, "SomeoneElse")).toEqual([]);
    const truncated = reads.map((read) => {
      const payload = JSON.parse(read.payload_json);
      for (const source of payload.projectInstructions.sources) source.status = "truncated";
      return { ...read, payload_json: JSON.stringify(payload) };
    });
    expect(codingWorkspaceInstructionEvidence(truncated, "Coderworkspace")).toEqual([]);
    const explicit = fixture.instructionPaths.map((path) => ({
      id: path,
      actor: "Coderworkspace",
      kind: "file_read",
      payload_json: JSON.stringify({
        path,
        size: Buffer.byteLength(fixture.files[path]!),
        truncated: false,
      }),
    }));
    expect(
      codingWorkspaceInstructionEvidence(explicit, "Coderworkspace").map((item) => item.path),
    ).toEqual(fixture.instructionPaths);
    for (const args of [
      ["init", "--quiet", "--template="],
      ["add", "."],
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ],
    ]) {
      const result = await command(["git", ...args], root);
      expect(result.code, result.output).toBe(0);
    }
    const baseline = await capture();
    const before = await command([process.execPath, "test"], baseline.directory);
    expect(before.code, before.output).toBe(0);
    expect(before.output).toContain("2 pass");
    const holdout = join(directory, "independent.ts");
    writeFileSync(holdout, codingWorkspaceHoldout(baseline.directory));
    expect((await command([process.execPath, holdout], directory)).code).not.toBe(0);

    // A deterministic reference repair tests the *fixture*, not agent capability.
    // The live qualification never writes these edits or regression tests.
    const pricingPath = fixture.sourcePaths[0]!;
    const checkoutPath = fixture.sourcePaths[1]!;
    const repairedPricing = fixture.files[pricingPath]!.replace(
      "quantity: number)",
      "quantity: number, discountBasisPoints = 0)",
    ).replace(
      "return unitCents * quantity;",
      `if (!Number.isInteger(discountBasisPoints) || discountBasisPoints < 0 || discountBasisPoints > 10000) throw new RangeError("discountBasisPoints");
  return Math.floor((unitCents * quantity * (10000 - discountBasisPoints) + 5000) / 10000);`,
    );
    writeFileSync(join(root, pricingPath), repairedPricing);
    const repairedCheckout = fixture.files[checkoutPath]!.replace(
      "quantity: number }",
      "quantity: number; discountBasisPoints?: number }",
    ).replace("line.quantity)", "line.quantity, line.discountBasisPoints)");
    writeFileSync(join(root, checkoutPath), repairedCheckout);
    writeFileSync(
      join(root, fixture.regressionPaths[0]!),
      `import { expect, test } from "bun:test";
import { lineTotal } from "./index";
test("round full line once", () => expect(lineTotal(1, 3, 5000)).toBe(2));
`,
    );
    writeFileSync(
      join(root, fixture.regressionPaths[1]!),
      `import { expect, test } from "bun:test";
import { checkout } from "./index";
test("pass discount across package boundary", () => expect(checkout([{sku:"x",unitCents:1,quantity:3,discountBasisPoints:5000}]).totalCents).toBe(2));
`,
    );
    const repaired = await capture();
    const after = await command([process.execPath, "test"], repaired.directory);
    expect(after.code, after.output).toBe(0);
    expect(after.output).toContain("4 pass");
    for (const path of fixture.regressionPaths) expect(after.output).toContain(path);
    writeFileSync(holdout, codingWorkspaceHoldout(repaired.directory));
    const passed = await command([process.execPath, holdout], directory);
    expect(passed.code, passed.output).toBe(0);
    writeFileSync(join(repaired.directory, checkoutPath), fixture.files[checkoutPath]!);
    expect((await command([process.execPath, holdout], directory)).code).not.toBe(0);
    writeFileSync(join(repaired.directory, checkoutPath), repairedCheckout);
    writeFileSync(
      join(repaired.directory, pricingPath),
      repairedPricing.replace(
        "Math.floor((unitCents * quantity * (10000 - discountBasisPoints) + 5000) / 10000)",
        "Math.floor((unitCents * (10000 - discountBasisPoints) + 5000) / 10000) * quantity",
      ),
    );
    expect((await command([process.execPath, holdout], directory)).code).not.toBe(0);
  } finally {
    for (const snapshot of snapshots) await snapshot.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("qualification distinguishes a worker block, interruption and budgets from the scenario deadline", () => {
  expect(
    codingQualificationFailure({
      status: "interrupted",
      reason: "Blocked: tools unavailable",
      deadlineReached: false,
    }),
  ).toBe("worker blocked: tools unavailable");
  expect(
    codingQualificationFailure({
      status: "interrupted",
      reason: "Owner stopped",
      deadlineReached: false,
    }),
  ).toBe("run interrupted: Owner stopped");
  expect(
    codingQualificationFailure({ status: "active", budgetExhausted: true, deadlineReached: false }),
  ).toBe("native worker exhausted its call budget");
  expect(codingQualificationFailure({ status: "active", deadlineReached: true })).toContain(
    "deadline reached",
  );
  expect(
    codingQualificationFailure({ status: "submitted", deadlineReached: false }),
  ).toBeUndefined();
});

test("missing credentials fail before starting a world and cannot be mistaken for live success", async () => {
  using _state = scopeProcessState({ env: { OPENAI_API_KEY: undefined } });
  await expect(
    qualifyCoding({ directory: "/tmp/marina-qualification-not-created", budgetUsd: 1 }),
  ).rejects.toThrow("no live qualification was run");
});
