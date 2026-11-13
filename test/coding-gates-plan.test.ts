// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Review findings on the repository gates' plan and the no-change baseline: every runner the
// repository configures, its configured type-check, no runner substitution, and a baseline
// that never misses submodule edits or runs a repository's content filters.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { resolveVerificationOptions } from "../src/coding/verification-plan";
import { compareWorkspaceState, observeWorkspaceState } from "../src/coding/workspace-state";
import { planVerification } from "../src/engine/commands/code/exec";
import { changedDependencyManifests } from "../src/engine/commands/code/verification";
import type { CodingSessionRow } from "../src/persistence/database";
import { git as gitIn } from "./git-helpers";

let root: string;
const git = (...args: string[]) => gitIn(root, ...args);
const session = () =>
  ({
    id: "s",
    workspace_root: root,
    worktree_path: null,
    execution_target: "local",
  }) as never as CodingSessionRow;
const gatesPlan = (touched: string[]) =>
  planVerification(
    {} as never,
    session(),
    new LocalWorkspace(root),
    resolveVerificationOptions({ dependencies: "check" }, {}),
    true,
    touched,
    true,
  );
const commit = () => {
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marina-gates-plan-"));
  git("init", "--quiet", "--template=");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the repository gates' plan", () => {
  it("[5] plans every runner the repository has, whatever language the change touched", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname = 'x'\n");
    writeFileSync(join(root, "mod.py"), "X = 1\n");
    commit();
    const plan = await gatesPlan(["mod.py"]);
    expect(plan.commands).toContain("python -m pytest");
    expect(plan.commands).toContain("test");
    expect(plan.language).toBe("python+javascript");
  });

  it("[6] always runs a configured Python type-check, even for a configuration-only change", async () => {
    writeFileSync(
      join(root, "pyproject.toml"),
      "[project]\nname = 'x'\n\n[tool.mypy]\nstrict = true\n",
    );
    commit();
    const plan = await gatesPlan(["pyproject.toml"]);
    expect(plan.steps.steps[0]).toEqual({ command: "python -m mypy .", role: "typecheck" });
  });

  it("[2] never substitutes another runner for pytest under the gates", async () => {
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname = 'x'\n");
    writeFileSync(
      join(root, "test_ok.py"),
      "import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n",
    );
    writeFileSync(join(root, "test_bad.py"), "def test_bad():\n    assert False\n");
    commit();
    const plan = await gatesPlan(["test_ok.py"]);
    expect(plan.fallback).toBeUndefined();
    expect(plan.preparation?.fallback).toBeUndefined();
    expect(plan.steps.steps.some((step) => step.command.includes("unittest"))).toBe(false);
  });

  it("[1] records that a repository with lint but no test command has no test gate", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "bun -e 0" } }));
    commit();
    expect((await gatesPlan(["package.json"])).gateTests).toBe(false);
  });
});

describe("the no-change baseline", () => {
  it("[3] does not observe a repository with a submodule gitlink, so verification stays required", async () => {
    writeFileSync(join(root, "a.txt"), "a\n");
    commit();
    git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD").trim()},sub`);
    const observed = await observeWorkspaceState(root);
    expect(observed.reason).toContain("submodules");
    expect(compareWorkspaceState(observed, observed).kind).toBe("unknown");
  });

  it("[3] does not observe a workspace holding a nested repository", async () => {
    writeFileSync(join(root, "a.txt"), "a\n");
    commit();
    mkdirSync(join(root, "inner"));
    gitIn(join(root, "inner"), "init", "--quiet", "--template=");
    writeFileSync(join(root, "inner", "x.txt"), "x\n");
    expect((await observeWorkspaceState(root)).reason).toContain("nested Git repository (inner/)");
  });

  it("[7] never runs the repository's content filters, and still finds pre-existing edits", async () => {
    const marker = join(root, "..", `${root.split("/").at(-1)}-filter-ran`);
    git("config", "filter.evil.clean", `touch ${marker}; cat`);
    git("config", "filter.evil.smudge", `touch ${marker}; cat`);
    writeFileSync(join(root, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(join(root, "a.txt"), "a\n");
    commit();
    rmSync(marker, { force: true });
    // Same size: only reading the content (through the filter) would tell it changed.
    writeFileSync(join(root, "a.txt"), "b\n");
    const observed = await observeWorkspaceState(root);
    expect(existsSync(marker)).toBe(false);
    expect(observed.preexisting?.sample).toContain("a.txt");
    rmSync(marker, { force: true });
  });
});

describe("dependency manifests between base and change", () => {
  it("[E5] counts every workspace, package-manager and lock file", () => {
    writeFileSync(join(root, "a.txt"), "a\n");
    commit();
    const base = git("rev-parse", "HEAD").trim();
    const files = [
      "pnpm-workspace.yaml",
      ".pnpmfile.cjs",
      ".npmrc",
      "bunfig.toml",
      ".yarnrc",
      ".yarnrc.yml",
      "uv.lock",
      "poetry.lock",
      "Pipfile",
      "Pipfile.lock",
      "go.work",
      "go.work.sum",
      "Gemfile",
      "Gemfile.lock",
    ];
    for (const file of files) writeFileSync(join(root, file), "x\n");
    writeFileSync(join(root, "notes.md"), "not a manifest\n");
    git("add", "-A");
    const tree = git("write-tree").trim();
    expect(changedDependencyManifests(root, base, tree).sort()).toEqual([...files].sort());
  });
});
