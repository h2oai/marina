// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A code trial: does a candidate build of Marina (a session's worktree) do
 * better than the build it branched from? Both run as child Marinas on
 * their own ports and databases; this Marina's own harness sends the same
 * benchmark items to each, in paired replicates, and files every run in
 * this world's ledger (stamped with the build it measured). The verdict
 * uses the promotion rule every other default change uses: the paired
 * interval above zero and the gain past `promotionMargin(tried)`.
 *
 * Nothing here moves a branch or touches the candidate's index: the
 * candidate is snapshotted with a temporary index into an unreferenced
 * commit, and both builds run from detached worktrees that are removed
 * when the trial ends.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { summarizeArm } from "../engine/benchmark-compare-run";
import { comparePooledGroups, loadReplicateGroup } from "../engine/benchmark-replicates";
import { mintRunKey, revokeRunKey } from "../engine/benchmark-run-keys";
import type { BenchmarkRunner } from "../engine/benchmark-runner";
import { promotionMargin } from "../engine/fishing-margin";
import type { MarinaDB } from "../persistence/database";
import { bunExecutable } from "../runtime-paths";
import {
  type ChildMarina,
  type ChildMarinaSpec,
  freeLoopbackPort,
  startChildMarina,
} from "../world/child-marina";

export type TrialArm = "base" | "candidate";
export type TrialVerdict =
  | "candidate-wins"
  | "candidate-regresses"
  | "no-measurable-difference"
  | "incomplete";

export interface CodeTrialSpec {
  id: string;
  /** The Marina checkout the candidate branched from. */
  repoRoot: string;
  /** The candidate's working tree (a session worktree; uncommitted changes count). */
  candidateTree: string;
  benchmark: string;
  limit: number;
  seed: number;
  replicates: number;
  /** What each build serves the harness; default `marina` (its default model). */
  model: string;
  /** Total upstream spend allowed, for both builds together. */
  capUsd: number;
  /** The model this Marina serves the builds' default model with; default `marina/default`. */
  upstreamModel?: string;
}

export interface TrialArmResult {
  sha: string;
  runs: number;
  attempts: number;
  successes: number;
  accuracy: number;
  costUsd: number | null;
}

export interface CodeTrialResult {
  id: string;
  benchmark: string;
  verdict: TrialVerdict;
  base: TrialArmResult;
  candidate: TrialArmResult;
  /** Candidate − base, pooled over paired items, with its 95 % interval. */
  delta: number | null;
  low: number | null;
  high: number | null;
  items: number;
  margin: number;
  triedBefore: number;
  warnings: string[];
}

export type GitRunner = (
  cwd: string,
  argv: string[],
  env?: Record<string, string>,
) => { exitCode: number; stdout: string; stderr: string };

export interface CodeTrialDeps {
  db: MarinaDB;
  /**
   * This Marina's own HTTP base: the builds reach models only through its
   * /v1, with a run key minted for the trial (capped at the trial's cap,
   * revoked when it ends). No provider key enters either build.
   */
  modelEndpoint: string;
  runner: Pick<BenchmarkRunner, "start" | "done">;
  /** Where trial trees and child data live; removed per trial when it ends. */
  trialsRoot: string;
  startChild?: (spec: ChildMarinaSpec) => Promise<ChildMarina>;
  git?: GitRunner;
  /** Install dependencies in a tree whose lockfile differs from the checkout's. */
  install?: (tree: string) => void;
  progress?: (line: string) => void;
}

export function trialGroup(id: string, arm: TrialArm): string {
  return `trial:${id}:${arm}`;
}

const hostGit: GitRunner = (cwd, argv, env) => {
  const result = Bun.spawnSync(["git", ...argv], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
};

const hostInstall = (tree: string): void => {
  const result = Bun.spawnSync([bunExecutable(), "install", "--frozen-lockfile"], {
    cwd: tree,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`bun install failed in ${tree}: ${result.stderr.toString().slice(-300)}`);
};

function must(git: GitRunner, cwd: string, argv: string[], env?: Record<string, string>): string {
  const result = git(cwd, argv, env);
  if (result.exitCode !== 0)
    throw new Error(`git ${argv[0]} failed: ${result.stderr.slice(-300) || result.stdout}`);
  return result.stdout;
}

/**
 * The candidate's working tree as a commit, without moving its branch or
 * touching its index: a temporary index takes every tracked and untracked
 * (not ignored) file, and the commit's parent is the tree's HEAD.
 */
export function snapshotCommit(git: GitRunner, tree: string, scratch: string): string {
  const index = join(scratch, "candidate.index");
  const env = { GIT_INDEX_FILE: index };
  must(git, tree, ["read-tree", "HEAD"], env);
  must(git, tree, ["add", "-A"], env);
  const treeId = must(git, tree, ["write-tree"], env);
  const head = must(git, tree, ["rev-parse", "HEAD"]);
  const headTree = must(git, tree, ["rev-parse", "HEAD^{tree}"]);
  rmSync(index, { force: true });
  if (treeId === headTree) return head;
  return must(git, tree, ["commit-tree", treeId, "-p", head, "-m", "marina code trial snapshot"], {
    GIT_AUTHOR_NAME: "Marina",
    GIT_AUTHOR_EMAIL: "trial@marina.invalid",
    GIT_COMMITTER_NAME: "Marina",
    GIT_COMMITTER_EMAIL: "trial@marina.invalid",
  });
}

/** Prior trials on this benchmark: each one tried makes the next win need a larger margin. */
export function trialsBefore(db: MarinaDB, benchmark: string, id: string): number {
  const ids = new Set<string>();
  for (const run of db.queryBenchmarkRuns({ benchmark, limit: 2000 })) {
    const match = /^trial:([^:]+):/.exec(run.replicate_group ?? "");
    if (match && match[1] !== id) ids.add(match[1]!);
  }
  return ids.size;
}

function verdictOf(
  paired: { low: number; high: number; delta: number } | null,
  margin: number,
): TrialVerdict {
  if (!paired) return "incomplete";
  if (paired.low > 0 && paired.delta >= margin) return "candidate-wins";
  if (paired.high < 0) return "candidate-regresses";
  return "no-measurable-difference";
}

/** Build the verdict from the ledger: both arms' runs, paired on common items. */
export function codeTrialResult(
  db: MarinaDB,
  spec: Pick<CodeTrialSpec, "id" | "benchmark">,
  shas: Record<TrialArm, string>,
): CodeTrialResult {
  const rows = db
    .queryBenchmarkRuns({ benchmark: spec.benchmark, limit: 500 })
    .filter((r) => r.replicate_group?.startsWith(`trial:${spec.id}:`));
  const arm = (name: TrialArm) =>
    summarizeArm(
      db,
      name,
      trialGroup(spec.id, name),
      rows.filter((r) => r.replicate_group === trialGroup(spec.id, name)),
    );
  const base = arm("base");
  const candidate = arm("candidate");
  const warnings: string[] = [];
  let unfinished = 0;
  for (const a of [base, candidate]) {
    const missing = a.runs.length - a.valid.length;
    unfinished += missing;
    if (missing) warnings.push(`${a.arm}: ${missing} run(s) did not complete`);
  }
  const slices = new Set([...base.valid, ...candidate.valid].map((r) => r.slice_hash ?? ""));
  if (slices.size > 1) warnings.push("the builds answered different item slices");
  const loadedBase = base.valid[0] ? loadReplicateGroup(db, base.valid[0]) : null;
  const loadedCandidate = candidate.valid[0] ? loadReplicateGroup(db, candidate.valid[0]) : null;
  const paired =
    loadedBase?.replicates.length && loadedCandidate?.replicates.length
      ? comparePooledGroups(loadedCandidate, loadedBase)
      : null;
  const triedBefore = trialsBefore(db, spec.benchmark, spec.id);
  const margin = promotionMargin(triedBefore);
  const armResult = (a: typeof base, sha: string): TrialArmResult => ({
    sha,
    runs: a.valid.length,
    attempts: a.attempts,
    successes: a.successes,
    accuracy: a.accuracy,
    costUsd: a.costUsd,
  });
  return {
    id: spec.id,
    benchmark: spec.benchmark,
    // A verdict needs every run of both builds; a partial trial decides nothing.
    verdict: unfinished ? "incomplete" : verdictOf(paired, margin),
    base: armResult(base, shas.base),
    candidate: armResult(candidate, shas.candidate),
    delta: paired?.delta ?? null,
    low: paired?.low ?? null,
    high: paired?.high ?? null,
    items: paired?.items ?? 0,
    margin,
    triedBefore,
    warnings,
  };
}

/** Run one code trial end to end; always stops both builds and removes their trees. */
export async function runCodeTrial(
  deps: CodeTrialDeps,
  spec: CodeTrialSpec,
): Promise<CodeTrialResult> {
  const git = deps.git ?? hostGit;
  const startChild = deps.startChild ?? ((s: ChildMarinaSpec) => startChildMarina(s, 120_000));
  const install = deps.install ?? hostInstall;
  const say = deps.progress ?? (() => {});
  const root = resolve(deps.trialsRoot, spec.id);
  const repo = resolve(spec.repoRoot);
  mkdirSync(root, { recursive: true });
  const trees: Partial<Record<TrialArm, string>> = {};
  const children: ChildMarina[] = [];
  let modelKey: string | undefined;
  try {
    const candidateSha = snapshotCommit(git, spec.candidateTree, root);
    const base = must(git, repo, ["rev-parse", "HEAD"]);
    const baseSha = must(git, repo, ["merge-base", base, candidateSha]);
    if (baseSha === candidateSha) throw new Error("The candidate has no changes from its base.");
    const shas: Record<TrialArm, string> = { base: baseSha, candidate: candidateSha };
    say(`trial ${spec.id}: base ${baseSha.slice(0, 12)} vs candidate ${candidateSha.slice(0, 12)}`);

    const lock = (tree: string) => {
      const path = join(tree, "bun.lock");
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    };
    for (const arm of ["base", "candidate"] as const) {
      const tree = join(root, arm);
      must(git, repo, ["worktree", "add", "--detach", tree, shas[arm]]);
      trees[arm] = tree;
      if (lock(tree) === lock(repo) && existsSync(join(repo, "node_modules")))
        symlinkSync(join(repo, "node_modules"), join(tree, "node_modules"), "dir");
      else {
        say(`trial ${spec.id}: installing dependencies for the ${arm} build`);
        install(tree);
      }
    }

    const key = `mtk_${crypto.randomUUID().replaceAll("-", "")}`;
    // The builds' only model access: this Marina's /v1, through a run key that
    // adds no instruments of its own (only the builds differ) and stops at the cap.
    modelKey = mintRunKey({
      runId: `trial:${spec.id}`,
      stack: "none",
      evalTag: `code-trial=${spec.id}; benchmark=${spec.benchmark}`,
      capUsd: spec.capUsd,
    });
    const builds: Partial<Record<TrialArm, ChildMarina>> = {};
    for (const arm of ["base", "candidate"] as const) {
      const child = await startChild({
        name: `trial-${spec.id}-${arm}`,
        sourceRoot: trees[arm]!,
        dir: join(root, `${arm}-data`),
        port: await freeLoopbackPort(),
        trust: "untrusted",
        env: {
          MARINA_WORLD: "empty",
          MODEL_API_KEYS: key,
          MARINA_DAILY_SPEND_CAP_USD: String(spec.capUsd / 2),
          LLAMA_BASE_URL: `${deps.modelEndpoint.replace(/\/$/, "")}/v1`,
          LLAMA_API_KEY: modelKey,
          MARINA_DEFAULT_LLAMA_MODEL: spec.upstreamModel ?? "marina/default",
          LLAMA_CONTEXT_WINDOW: "200000",
          MARINA_ROOM_AGENTS: "false",
          MCP_PORT: "0",
          LOG_PORT: "0",
        },
      });
      children.push(child);
      builds[arm] = child;
      say(`trial ${spec.id}: ${arm} build ready on port ${child.port}`);
    }

    for (let replicate = 1; replicate <= spec.replicates; replicate++) {
      const started = (["base", "candidate"] as const).map((arm) =>
        deps.runner.start({
          benchmark: spec.benchmark,
          limit: spec.limit,
          seed: spec.seed,
          model: spec.model,
          target: { endpoint: builds[arm]!.url, apiKey: key },
          source: shas[arm].slice(0, 12),
          replicateGroup: trialGroup(spec.id, arm),
        }),
      );
      await Promise.all(started.map((run) => deps.runner.done(run.id)));
      say(`trial ${spec.id}: replicate ${replicate}/${spec.replicates} done`);
    }
    return codeTrialResult(deps.db, spec, shas);
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    if (modelKey) revokeRunKey(modelKey);
    for (const tree of Object.values(trees))
      if (tree) git(repo, ["worktree", "remove", "--force", tree]);
    rmSync(root, { recursive: true, force: true });
  }
}
