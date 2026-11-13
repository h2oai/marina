// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// `code ship`: only a change that a trial measured, exactly as measured,
// becomes a pull request; the commit lands on the session's branch, is pushed,
// and the pull request carries the trial's evidence.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ShipRunner, shipBody, shipChange, shipRefusal } from "../src/coding/code-ship";
import { type CodeTrialResult, type GitRunner, snapshotCommit } from "../src/coding/code-trial";
import {
  isProtectedPath,
  PROTECTED_PATHS,
  protectedChanges,
  protectedHold,
} from "../src/coding/protected-paths";

function sh(cwd: string, ...argv: string[]): string {
  const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
const runner: ShipRunner = (cwd, argv) => {
  const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
const git: GitRunner = (cwd, argv, env) => {
  const r = Bun.spawnSync(["git", ...argv], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout.toString().trim(),
    stderr: r.stderr.toString().trim(),
  };
};

function trialFor(
  sha: string,
  verdict: CodeTrialResult["verdict"] = "candidate-wins",
): CodeTrialResult {
  const arm = (s: string, accuracy: number) => ({
    sha: s,
    runs: 2,
    attempts: 40,
    successes: accuracy * 40,
    accuracy,
    costUsd: 0.1,
  });
  return {
    id: "trial_abc",
    benchmark: "smoke",
    verdict,
    base: arm("1111111111111111", 0.5),
    candidate: arm(sha, 1),
    delta: 0.5,
    low: 0.3,
    high: 0.7,
    items: 20,
    margin: 0.02,
    triedBefore: 0,
    warnings: [],
  };
}

describe("code ship", () => {
  let dir: string;
  let repo: string;
  let origin: string;
  let tree: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-code-ship-"));
    origin = join(dir, "origin.git");
    sh(dir, "git", "init", "-q", "--bare", "-b", "main", origin);
    repo = join(dir, "repo");
    sh(dir, "git", "clone", "-q", origin, repo);
    sh(repo, "git", "config", "user.email", "t@t.invalid");
    sh(repo, "git", "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "one\n");
    sh(repo, "git", "add", "a.txt");
    sh(repo, "git", "commit", "-q", "-m", "init");
    sh(repo, "git", "push", "-q", "origin", "HEAD:main");
    tree = join(dir, "tree");
    sh(repo, "git", "worktree", "add", "-q", "-b", "marina/session-s1", tree);
    writeFileSync(join(tree, "a.txt"), "better\n");
    writeFileSync(join(tree, "new.txt"), "added\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ships only the change the trial measured, and only on a non-regressing verdict", () => {
    const measured = snapshotCommit(git, tree, dir);
    expect(shipRefusal(git, { tree, trial: trialFor(measured), scratch: dir })).toBeNull();
    expect(
      shipRefusal(git, {
        tree,
        trial: trialFor(measured, "no-measurable-difference"),
        scratch: dir,
      }),
    ).toBeNull();
    expect(
      shipRefusal(git, { tree, trial: trialFor(measured, "candidate-regresses"), scratch: dir }),
    ).toContain("nothing ships");
    expect(
      shipRefusal(git, { tree, trial: trialFor(measured, "incomplete"), scratch: dir }),
    ).toContain("nothing ships");
    writeFileSync(join(tree, "a.txt"), "changed after the trial\n");
    expect(shipRefusal(git, { tree, trial: trialFor(measured), scratch: dir })).toContain(
      "moved since trial",
    );
  });

  it("commits on the session branch, pushes it and opens a pull request with the evidence", () => {
    const trial = trialFor(snapshotCommit(git, tree, dir));
    const gh: string[][] = [];
    const result = shipChange(
      {
        git: runner,
        push: runner,
        gh: (_cwd, argv) => {
          gh.push(argv);
          return {
            exitCode: 0,
            stdout: argv[2] === "create" ? "https://github.com/o/r/pull/7\n" : "",
            stderr: "",
          };
        },
        identity: { name: "Operator", email: "op@example.invalid" },
      },
      {
        tree,
        branch: "marina/session-s1",
        base: "main",
        title: "Better a",
        trial,
        author: "Coder",
        merge: true,
        scratch: dir,
      },
    );
    expect(result.url).toBe("https://github.com/o/r/pull/7");
    expect(result.queued).toBe(true);
    // The commit is on the remote branch, authored by the operator, with both files.
    expect(sh(repo, "git", "ls-remote", origin, "refs/heads/marina/session-s1")).toContain(
      result.commit,
    );
    expect(sh(tree, "git", "log", "-1", "--format=%an <%ae>%n%B")).toContain(
      "Operator <op@example.invalid>",
    );
    expect(sh(tree, "git", "show", "--stat", "--format=", "HEAD")).toContain("new.txt");
    expect(sh(tree, "git", "status", "--porcelain")).toBe("");
    // The pull request carries the trial evidence and is queued.
    expect(gh[0]!.slice(0, 3)).toEqual(["gh", "pr", "create"]);
    expect(gh[0]!.join(" ")).toContain("--base main --head marina/session-s1");
    expect(gh[0]!.at(-1)).toContain("trial_abc");
    expect(gh[1]).toEqual(["gh", "pr", "merge", "https://github.com/o/r/pull/7", "--squash"]);
  });

  it("finds protected files in the change and holds an agent's protected change for a person", () => {
    mkdirSync(join(tree, "src/engine"), { recursive: true });
    writeFileSync(join(tree, "src/engine/safety-gates.ts"), "export const loosened = true;\n");
    const base = sh(tree, "git", "rev-parse", "HEAD");
    const trial = trialFor(snapshotCommit(git, tree, dir));
    trial.base.sha = base;
    const touched = protectedChanges(git, tree, base, trial.candidate.sha);
    expect(touched).toEqual(["src/engine/safety-gates.ts"]);
    const gh: string[][] = [];
    const result = shipChange(
      {
        git: runner,
        push: runner,
        gh: (_cwd, argv) => {
          gh.push(argv);
          return { exitCode: 0, stdout: "https://github.com/o/r/pull/8\n", stderr: "" };
        },
        identity: { name: "Operator", email: "op@example.invalid" },
      },
      {
        tree,
        branch: "marina/session-s1",
        base: "main",
        title: "Loosen",
        trial,
        author: "Coder",
        merge: true,
        scratch: dir,
        protectedFiles: touched,
        holdForPerson: true,
      },
    );
    // Opened, never queued; the body says why and names the files.
    expect(result.queued).toBe(false);
    expect(gh).toHaveLength(1);
    expect(gh[0]!.at(-1)).toContain("## Protected paths");
    expect(gh[0]!.at(-1)).toContain("`src/engine/safety-gates.ts`");
    expect(gh[0]!.at(-1)).toContain("a person reads it and queues it");
  });

  it("protects the gates, the judging rules, these steps and what checks a change", () => {
    for (const path of [
      "src/engine/safety-gates.ts",
      "src/engine/benchmark-promotion.ts",
      "src/stats/paired.ts",
      "src/coding/code-trial.ts",
      ".github/workflows/ci.yml",
      "package.json",
    ])
      expect(isProtectedPath(path)).toBe(true);
    expect(isProtectedPath("src/engine/commands/look.ts")).toBe(false);
    expect(isProtectedPath("src/stats-other.ts")).toBe(false);
    // Every listed path exists, so the list cannot silently drift.
    for (const path of PROTECTED_PATHS) expect(existsSync(path), path).toBe(true);
    expect(protectedHold({})).toBe(true);
    expect(protectedHold({ MARINA_SELF_IMPROVE_PROTECTED: "off" })).toBe(false);
  });

  it("states the measurement in the pull request body", () => {
    const body = shipBody({ trial: trialFor("2222222222222222"), author: "Coder" });
    expect(body).toContain("**candidate-wins**");
    expect(body).toContain("Δ +50.0%");
    expect(body).toContain("no provider credentials");
  });
});
