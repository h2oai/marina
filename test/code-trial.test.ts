// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// A code trial measures a candidate build against its base: the candidate is
// snapshotted without moving its branch, both builds run from detached trees
// on their own children, paired runs land in the ledger stamped with each
// build, and the promotion rule decides. Children and trees never outlive it.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodeTrial, snapshotCommit, trialGroup } from "../src/coding/code-trial";
import {
  BenchmarkRunner,
  type BenchmarkRunOptions,
  benchmarkRunConfig,
  type HarnessResult,
} from "../src/engine/benchmark-runner";
import { MarinaDB } from "../src/persistence/database";
import type { ChildMarina } from "../src/world/child-marina";

const ITEMS = 40;

function git(cwd: string, ...argv: string[]): string {
  const result = Bun.spawnSync(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function result(right: (i: number) => boolean): HarnessResult {
  const items = Array.from({ length: ITEMS }, (_, i) => ({
    id: `q${i}`,
    correct: right(i),
    latencyMs: 10,
    usage: { costUsd: 0.001 },
  }));
  return {
    scores: { overall: items.filter((x) => x.correct).length / ITEMS },
    metadata: { total: ITEMS, answered: ITEMS },
    items,
  } as HarnessResult;
}

describe("code trial", () => {
  let dir: string;
  let repo: string;
  let candidate: string;
  let db: MarinaDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-code-trial-"));
    repo = join(dir, "repo");
    git(dir, "init", "-q", "-b", "main", repo);
    git(repo, "config", "user.email", "t@t.invalid");
    git(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "init");
    candidate = join(dir, "candidate");
    git(repo, "worktree", "add", "-q", "-b", "marina/session-x", candidate);
    db = new MarinaDB(":memory:");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshots uncommitted work without moving the branch or the index", () => {
    writeFileSync(join(candidate, "a.txt"), "two\n");
    writeFileSync(join(candidate, "new.txt"), "fresh\n");
    const head = git(candidate, "rev-parse", "HEAD");
    const sha = snapshotCommit(
      (cwd, argv, env) => {
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
      },
      candidate,
      dir,
    );
    expect(sha).not.toBe(head);
    expect(git(candidate, "rev-parse", "HEAD")).toBe(head);
    expect(git(candidate, "status", "--porcelain")).toContain("?? new.txt");
    expect(git(candidate, "show", `${sha}:new.txt`)).toBe("fresh");
    expect(git(candidate, "show", `${sha}:a.txt`)).toBe("two");
    expect(git(candidate, "rev-parse", `${sha}^`)).toBe(head);
  });

  async function trial(right: Record<"base" | "candidate", (i: number) => boolean>) {
    writeFileSync(join(candidate, "a.txt"), "better\n");
    const real = new BenchmarkRunner(db, () => {});
    const started: BenchmarkRunOptions[] = [];
    let n = 0;
    const runner = {
      start(opts: BenchmarkRunOptions) {
        started.push(opts);
        const id = `br_trial_${++n}`;
        db.insertBenchmarkRun({
          id,
          benchmark: opts.benchmark,
          config_hash: "fake",
          config_json: JSON.stringify(benchmarkRunConfig(opts, {})),
          status: "running",
          started_at: Date.now() + n,
        });
        const arm = opts.replicateGroup?.endsWith(":candidate") ? "candidate" : "base";
        real.recordHarnessResult(id, opts, Date.now(), { result: result(right[arm]) });
        return { id, configHash: "fake" };
      },
      async done() {},
    };
    const stopped: string[] = [];
    const children: string[] = [];
    const res = await runCodeTrial(
      {
        db,
        runner,
        trialsRoot: join(dir, "trials"),
        install: () => {},
        startChild: async (spec) => {
          children.push(spec.sourceRoot);
          // Each build runs its own tree.
          expect(existsSync(join(spec.sourceRoot, "a.txt"))).toBe(true);
          return {
            pid: 1,
            port: spec.port,
            url: `http://127.0.0.1:${spec.port}`,
            exited: Promise.resolve(0),
            ready: async () => true,
            stop: async () => {
              stopped.push(spec.name);
            },
            why: (base: string) => base,
          } satisfies ChildMarina;
        },
      },
      {
        id: "t1",
        repoRoot: repo,
        candidateTree: candidate,
        benchmark: "smoke",
        limit: ITEMS,
        seed: 1,
        replicates: 2,
        model: "marina",
        capUsd: 2,
      },
    );
    return { res, started, stopped, children };
  }

  it("files paired, stamped runs per build and declares a clear win", async () => {
    const { res, started, stopped, children } = await trial({
      base: (i) => i % 2 === 0,
      candidate: () => true,
    });
    expect(started).toHaveLength(4);
    expect(new Set(started.map((s) => s.replicateGroup))).toEqual(
      new Set([trialGroup("t1", "base"), trialGroup("t1", "candidate")]),
    );
    // Each run names the build it measured and the endpoint of that build.
    const sources = new Set(started.map((s) => s.source));
    expect(sources.size).toBe(2);
    expect(started.every((s) => s.target?.apiKey?.startsWith("mtk_"))).toBe(true);
    expect(res.verdict).toBe("candidate-wins");
    expect(res.candidate.accuracy).toBe(1);
    expect(res.base.accuracy).toBe(0.5);
    expect(res.delta).toBeCloseTo(0.5);
    expect(res.low).toBeGreaterThan(0);
    // Both builds stopped, both trees and the trial directory removed.
    expect(stopped.sort()).toEqual(["trial-t1-base", "trial-t1-candidate"]);
    expect(children).toHaveLength(2);
    expect(git(repo, "worktree", "list")).not.toContain("trials");
    expect(readdirSync(join(dir, "trials"))).toEqual([]);
    // The candidate's branch did not move.
    expect(git(candidate, "log", "--oneline")).toContain("init");
    expect(git(candidate, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("declares a regression and no win when the candidate is worse", async () => {
    const { res } = await trial({ base: () => true, candidate: (i) => i % 4 !== 0 });
    expect(res.verdict).toBe("candidate-regresses");
  });

  it("decides nothing when the builds are the same", async () => {
    const { res } = await trial({ base: (i) => i % 2 === 0, candidate: (i) => i % 2 === 0 });
    expect(res.verdict).toBe("no-measurable-difference");
  });

  it("refuses a candidate with no changes and cleans up", async () => {
    await expect(
      runCodeTrial(
        {
          db,
          runner: { start: () => ({ id: "x", configHash: "x" }), done: async () => {} },
          trialsRoot: join(dir, "trials"),
        },
        {
          id: "t2",
          repoRoot: repo,
          candidateTree: candidate,
          benchmark: "smoke",
          limit: 5,
          seed: 1,
          replicates: 1,
          model: "marina",
          capUsd: 1,
        },
      ),
    ).rejects.toThrow(/no changes/);
    expect(existsSync(join(dir, "trials", "t2"))).toBe(false);
  });
});
