import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPatch,
  envImageRunnerEnv,
  ledgerResult,
  prepareWorkspace,
  reviewPrompt,
  type SweInstance,
  selectSubset,
  sessionSpend,
  sessionVerification,
  spawnRun,
  sweEnvImage,
  taskPrompt,
} from "../benchmarks/swebench/adapter";

const inst = (id: string, repo: string): SweInstance => ({
  instance_id: id,
  repo,
  base_commit: "abc123",
  problem_statement: `issue text for ${id}`,
});

const rows = [
  ...Array.from({ length: 10 }, (_, i) => inst(`django__django-${i}`, "django/django")),
  ...Array.from({ length: 4 }, (_, i) => inst(`sympy__sympy-${i}`, "sympy/sympy")),
  inst("pallets__flask-1", "pallets/flask"),
];

describe("selectSubset", () => {
  it("is reproducible from its seed and mixes repositories", () => {
    const a = selectSubset(rows, 6, 7).map((r) => r.instance_id);
    const b = selectSubset([...rows].reverse(), 6, 7).map((r) => r.instance_id);
    expect(a).toEqual(b);
    const repos = new Set(selectSubset(rows, 6, 7).map((r) => r.repo));
    expect(repos.size).toBe(3);
    expect(selectSubset(rows, 6, 8).map((r) => r.instance_id)).not.toEqual(a);
  });

  it("never exceeds the pool", () => {
    expect(selectSubset(rows, 100, 1)).toHaveLength(rows.length);
  });
});

describe("prompts", () => {
  it("carry the issue text only", () => {
    const i = { ...inst("x__y-1", "x/y"), hints_text: "SECRET HINT" } as SweInstance;
    for (const p of [taskPrompt(i), reviewPrompt(i)]) {
      expect(p).toContain("issue text for x__y-1");
      expect(p).not.toContain("SECRET HINT");
    }
  });

  it("leave a Verified instance's text unchanged (no Pro sections)", () => {
    const p = taskPrompt(inst("x__y-1", "x/y"));
    expect(p.endsWith("ISSUE:\nissue text for x__y-1")).toBe(true);
    expect(p).not.toContain("## Requirements");
  });

  it("include SWE-bench Pro's requirements and interfaces, never its gold or tests", () => {
    const pro = {
      ...inst("instance_a__b-1", "a/b"),
      requirements: "- must accept None",
      interface: "No new interfaces are introduced.",
      patch: "GOLD PATCH",
      fail_to_pass: "['t::x']",
    } as SweInstance;
    for (const p of [taskPrompt(pro), reviewPrompt(pro)]) {
      expect(p).toContain("## Requirements\n- must accept None");
      expect(p).toContain("## New Interfaces\nNo new interfaces are introduced.");
      expect(p).toContain("Do not reference, look up, or copy existing solutions");
      expect(p).not.toContain("GOLD PATCH");
      expect(p).not.toContain("t::x");
    }
  });
});

describe("workspace and patch", () => {
  it("prepares a mirrored checkout without touching the network when the mirror exists", async () => {
    const calls: string[][] = [];
    const fake = async (argv: string[]) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    const data = mkdtempSync(join(tmpdir(), "swe-data-"));
    try {
      // Pretend the mirror is already there.
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(data, "mirrors", "x__y.git"), { recursive: true });
      await prepareWorkspace(inst("x__y-1", "x/y"), data, join(data, "work", "a"), fake);
      expect(calls.some((c) => c.includes("--mirror"))).toBe(false);
      expect(calls.some((c) => c.includes("--shared"))).toBe(true);
      expect(calls.at(-1)).toContain("abc123");
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it("collects edits and new files as one diff against HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swe-git-"));
    try {
      const g = (args: string[]) => spawnRun(["git", ...args], { cwd: dir });
      await g(["init", "-q"]);
      await g(["config", "user.email", "t@example.com"]);
      await g(["config", "user.name", "t"]);
      writeFileSync(join(dir, "a.py"), "x = 1\n");
      await g(["add", "a.py"]);
      await g(["commit", "-q", "-m", "base"]);
      writeFileSync(join(dir, "a.py"), "x = 2\n");
      writeFileSync(join(dir, "b.py"), "y = 3\n");
      const patch = await collectPatch(dir);
      expect(patch).toContain("-x = 1");
      expect(patch).toContain("+x = 2");
      expect(patch).toContain("b.py");
      expect(patch).toContain("+y = 3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ledgerResult and spend", () => {
  it("maps resolved ids onto ledger items with cost", () => {
    const attempts = ["a", "b", "c"].map((id, i) => ({
      instance_id: id,
      arm: "single",
      replicate: 1,
      exitCode: 0,
      patchBytes: 10,
      costUsd: 0.1 * (i + 1),
      durationMs: 1000,
      trajectory: `${id}.md`,
    }));
    const r = ledgerResult({ resolved_ids: ["a", "c"] }, attempts, {
      arm: { name: "single", model: "m" },
      replicate: 1,
      subsetSeed: 7,
    });
    expect(r.items.map((i) => i.correct)).toEqual([true, false, true]);
    expect(r.scores.overall).toBeCloseTo(2 / 3);
    expect(r.items[1]?.usage.costUsd).toBeCloseTo(0.2);
    expect(r.config.dataset).toBe("swe-bench-verified");
  });

  it("excludes instances the harness could not grade instead of scoring them 0", () => {
    const attempts = ["a", "b", "c"].map((id) => ({
      instance_id: id,
      arm: "single",
      replicate: 1,
      exitCode: 0,
      patchBytes: 10,
      costUsd: 0.1,
      durationMs: 1000,
      trajectory: `${id}.md`,
    }));
    const r = ledgerResult({ resolved_ids: ["a"], error_ids: ["c"] }, attempts, {
      arm: { name: "single", model: "m" },
      replicate: 1,
      subsetSeed: 7,
      benchmark: "pro",
    });
    expect(r.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(r.scores.overall).toBeCloseTo(1 / 2);
    expect(r.metadata.excluded).toEqual(["c"]);
    expect(r.config.dataset).toBe("swe-bench-pro");
  });

  it("files an expected instance with no recorded attempt as unresolved, never drops it", () => {
    const attempts = ["a"].map((id) => ({
      instance_id: id,
      arm: "single",
      replicate: 1,
      exitCode: 0,
      patchBytes: 10,
      costUsd: 0.1,
      durationMs: 1000,
      trajectory: `${id}.md`,
    }));
    const r = ledgerResult({ resolved_ids: ["a"], error_ids: ["c"] }, attempts, {
      arm: { name: "single", model: "m" },
      replicate: 1,
      subsetSeed: 7,
      expectedIds: ["a", "b", "c"],
    });
    // b crashed before recording: unresolved. c was never attempted AND errored in the
    // grader: still an infrastructure exclusion.
    expect(r.items.map((i) => [i.id, i.correct])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(r.metadata.missingAttempts).toEqual(["b", "c"]);
    expect(r.metadata.excluded).toEqual(["c"]);
    expect(r.scores.overall).toBeCloseTo(1 / 2);
  });

  it("reads 0 spend from a missing or schema-less database", () => {
    expect(sessionSpend(join(tmpdir(), "does-not-exist.db"))).toBe(0);
  });

  it("counts in-loop verification by outcome; not_run is never a failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "swe-verify-"));
    try {
      const dbPath = join(dir, "marina.db");
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const db = new Database(dbPath);
      db.run("CREATE TABLE coding_artifacts (kind TEXT, status TEXT)");
      for (const [kind, status] of [
        ["verification", "complete"],
        ["verification", "failed"],
        ["verification", "not_run"],
        ["verification", "not_run"],
        ["verification", "error"],
        ["command_output", "failed"],
      ])
        db.run("INSERT INTO coding_artifacts (kind, status) VALUES (?, ?)", [kind!, status!]);
      db.close();
      const counts = sessionVerification(dbPath);
      expect(counts).toEqual({ passed: 1, failed: 1, not_run: 2, error: 1 });
      expect(sessionVerification(join(dir, "missing.db"))).toEqual({
        passed: 0,
        failed: 0,
        not_run: 0,
        error: 0,
      });
      const attempts = ["a", "b"].map((id) => ({
        instance_id: id,
        arm: "env-verify",
        replicate: 1,
        exitCode: 0,
        patchBytes: 10,
        costUsd: 0.1,
        durationMs: 1000,
        trajectory: `${id}.md`,
        verification: counts,
      }));
      const r = ledgerResult({ resolved_ids: ["a"] }, attempts, {
        arm: { name: "env-verify", model: "m" },
        replicate: 1,
        subsetSeed: 7,
      });
      expect(r.metadata.verification).toEqual({ passed: 2, failed: 2, not_run: 4, error: 2 });
      // Grading is the harness's alone: verification outcomes never change a score.
      expect(r.scores.overall).toBeCloseTo(1 / 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("env-image mode (opt-in)", () => {
  it("names the official environment image for an instance", () => {
    expect(sweEnvImage("django__django-11099")).toBe(
      "docker.io/swebench/sweb.eval.x86_64.django_1776_django-11099:latest",
    );
    expect(sweEnvImage("Sympy__Sympy-1", "localhost/x")).toBe(
      "localhost/x/sweb.eval.x86_64.sympy_1776_sympy-1:latest",
    );
  });

  it("configures Marina's container runner in patch sync at /testbed", () => {
    expect(envImageRunnerEnv("pylint-dev__pylint-7080")).toEqual({
      MARINA_CODE_CONTAINER_IMAGE:
        "docker.io/swebench/sweb.eval.x86_64.pylint-dev_1776_pylint-7080:latest",
      MARINA_CODE_CONTAINER_SYNC: "patch",
      MARINA_CODE_CONTAINER_WORKDIR: "/testbed",
      MARINA_CODE_CONTAINER_SHELL: "bash",
      MARINA_CODE_CONTAINER_INIT: "source /opt/miniconda3/bin/activate testbed",
    });
  });

  it("tells the agent it may run existing tests only in env-image mode", () => {
    const i = inst("django__django-1", "django/django");
    expect(taskPrompt(i)).toContain("cannot run here");
    expect(taskPrompt(i, "env-image")).toContain("EXISTING tests");
    expect(taskPrompt(i, "env-image")).not.toContain("cannot run here");
    expect(reviewPrompt(i, "env-image")).toContain("environment image");
  });
});
