import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWorkspaceIsolated,
  collectPatch,
  envImageRunnerEnv,
  ledgerResult,
  prepareWorkspace,
  reviewPrompt,
  type SweInstance,
  selectSubset,
  sessionSpend,
  spawnRun,
  sweEnvImage,
  taskPrompt,
  workspaceLeaks,
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
      mkdirSync(join(data, "mirrors", "x__y.git"), { recursive: true });
      await prepareWorkspace(inst("x__y-1", "x/y"), data, join(data, "work", "a"), fake);
      expect(calls.some((c) => c.includes("--mirror"))).toBe(false);
      // The mirror is fetched from (base commit only), never cloned or shared.
      expect(calls.some((c) => c.includes("clone") || c.includes("--shared"))).toBe(false);
      const fetch = calls.find((c) => c.includes("fetch"));
      expect(fetch).toContain("abc123");
      expect(fetch).toContain("--depth=1");
      expect(fetch).toContain("--no-tags");
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  it("keeps every commit after the base, including the gold fix, out of the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "swe-leak-"));
    const g = async (cwd: string, args: string[]) => {
      const r = await spawnRun(
        ["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
        {
          cwd,
        },
      );
      return { ...r, stdout: r.stdout.trim() };
    };
    try {
      // Upstream: base → gold (the fix) on main, plus a branch and tags reaching past the base.
      const up = join(root, "up");
      mkdirSync(up);
      await g(up, ["init", "-q", "-b", "main"]);
      writeFileSync(join(up, "a.py"), "x = 1\n");
      await g(up, ["add", "a.py"]);
      await g(up, ["commit", "-q", "-m", "older"]);
      writeFileSync(join(up, "a.py"), "x = 1\ny = 1\n");
      await g(up, ["commit", "-q", "-am", "base"]);
      const base = (await g(up, ["rev-parse", "HEAD"])).stdout;
      writeFileSync(join(up, "a.py"), "x = 2\ny = 1\n");
      writeFileSync(join(up, "fix.py"), "FIXED = True\n");
      await g(up, ["add", "fix.py"]);
      await g(up, ["commit", "-q", "-am", "gold fix"]);
      const gold = (await g(up, ["rev-parse", "HEAD"])).stdout;
      await g(up, ["tag", "-a", "v2", "-m", "release with the fix"]);
      await g(up, ["branch", "later", gold]);
      const data = join(root, "data");
      mkdirSync(join(data, "mirrors"), { recursive: true });
      await g(root, ["clone", "-q", "--mirror", up, join(data, "mirrors", "x__y.git")]);

      const work = join(data, "work", "a");
      await prepareWorkspace({ ...inst("x__y-1", "x/y"), base_commit: base }, data, work);

      // No route a solver might try reaches the gold commit.
      expect((await g(work, ["log", "--all", "--format=%H"])).stdout).toBe(base);
      expect((await g(work, ["reflog"])).stdout).toBe("");
      expect((await g(work, ["reflog", "--all"])).stdout).toBe("");
      expect((await g(work, ["cat-file", "-e", gold])).code).not.toBe(0);
      expect((await g(work, ["show", gold])).code).not.toBe(0);
      expect((await g(work, ["show-ref"])).stdout).toBe("");
      expect((await g(work, ["remote", "-v"])).stdout).toBe("");
      const fsck = await g(work, ["fsck", "--lost-found"]);
      expect(fsck.stdout + fsck.stderr).not.toContain(gold);
      expect(existsSync(join(work, ".git", "objects", "info", "alternates"))).toBe(false);
      expect(await workspaceLeaks(work, base, spawnRun, [gold])).toEqual([]);

      // The solver's change round-trips: `collectPatch` applied to the base reproduces gold.
      writeFileSync(join(work, "a.py"), "x = 2\ny = 1\n");
      writeFileSync(join(work, "fix.py"), "FIXED = True\n");
      const patch = await collectPatch(work);
      const grader = join(root, "grader");
      await g(root, ["clone", "-q", up, grader]);
      await g(grader, ["checkout", "-q", "--detach", base]);
      writeFileSync(join(root, "model.patch"), patch);
      const applied = await g(grader, ["apply", join(root, "model.patch")]);
      expect(applied.code).toBe(0);
      await g(grader, ["add", "-A"]);
      expect((await g(grader, ["diff", "--cached", gold, "--stat"])).stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a workspace that can reach history past the base", async () => {
    const root = mkdtempSync(join(tmpdir(), "swe-leak-"));
    const g = (cwd: string, args: string[]) =>
      spawnRun(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd });
    try {
      const up = join(root, "up");
      mkdirSync(up);
      await g(up, ["init", "-q", "-b", "main"]);
      writeFileSync(join(up, "a.py"), "x = 1\n");
      await g(up, ["add", "a.py"]);
      await g(up, ["commit", "-q", "-m", "base"]);
      const base = (await g(up, ["rev-parse", "HEAD"])).stdout.trim();
      writeFileSync(join(up, "a.py"), "x = 2\n");
      await g(up, ["commit", "-q", "-am", "gold fix"]);
      const gold = (await g(up, ["rev-parse", "HEAD"])).stdout.trim();
      // The old layout: a --shared clone of the full repository, checked out at the base.
      const old = join(root, "old");
      await g(root, ["clone", "-q", "--shared", "--no-checkout", up, old]);
      await g(old, ["-c", "advice.detachedHead=false", "checkout", "-q", base]);
      const problems = await workspaceLeaks(old, base, spawnRun, [gold]);
      expect(problems.some((p) => p.startsWith("refs present"))).toBe(true);
      expect(problems.some((p) => p.startsWith("remotes present"))).toBe(true);
      expect(problems).toContain(".git/objects/info/alternates present");
      expect(problems.some((p) => p.startsWith("commits other than the base"))).toBe(true);
      expect(problems).toContain(`forbidden object ${gold} is resolvable`);
      await expect(assertWorkspaceIsolated(old, base)).rejects.toThrow(/history beyond/);

      // Strip every ref, remote and packed ref: the alternates still expose the later objects.
      await g(old, ["remote", "remove", "origin"]);
      rmSync(join(old, ".git", "packed-refs"), { force: true });
      for (const ref of (await g(old, ["for-each-ref", "--format=%(refname)"])).stdout.split(
        "\n",
      )) {
        if (ref.trim()) await g(old, ["update-ref", "-d", ref.trim()]);
      }
      rmSync(join(old, ".git", "logs"), { recursive: true, force: true });
      const viaAlternates = await workspaceLeaks(old, base);
      expect(viaAlternates).toContain(".git/objects/info/alternates present");
      expect(viaAlternates.some((p) => p.startsWith("objects not reachable from the base"))).toBe(
        true,
      );
      expect(viaAlternates.some((p) => p.startsWith("refs present"))).toBe(false);

      // A stray unreachable object (e.g. a later blob left in the store) is caught too.
      const clean = join(root, "clean");
      mkdirSync(clean);
      await g(clean, ["init", "-q"]);
      await g(clean, ["fetch", "-q", "--depth=1", "--no-write-fetch-head", up, base]);
      await g(clean, ["-c", "advice.detachedHead=false", "checkout", "-q", "--detach", base]);
      rmSync(join(clean, ".git", "logs"), { recursive: true, force: true });
      expect(await workspaceLeaks(clean, base)).toEqual([]);
      writeFileSync(join(root, "later.txt"), "later content\n");
      await g(clean, ["hash-object", "-w", join(root, "later.txt")]);
      expect(await workspaceLeaks(clean, base)).toEqual([
        "objects not reachable from the base: 1 blob",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
