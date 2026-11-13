// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `code ship`: a change to Marina's own source that a trial measured becomes
 * a pull request carrying that evidence. The session's worktree is
 * committed on its own branch, pushed, and opened against the base branch;
 * the repository's own checks and merge queue decide whether it lands, and
 * the always-on server picks it up from there.
 *
 * The trial must have measured exactly this change: the snapshot of the
 * worktree now has the same git tree as the trial's candidate. A trial that
 * found a regression, or that did not complete, ships nothing.
 */
import { join } from "node:path";
import type { CodeTrialResult, GitRunner } from "./code-trial";
import { snapshotCommit } from "./code-trial";
import { HOST_GIT_CONFIG_ARGS } from "./host-git";

export interface ShipCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type ShipRunner = (cwd: string, argv: string[]) => ShipCommandResult;

/** Host commands `code ship` runs (git, push, gh); a test replaces them. */
export interface ShipHost {
  git: ShipRunner;
  push: ShipRunner;
  gh: ShipRunner;
  ghAvailable: () => boolean;
}

export interface ShipSpec {
  /** The session's worktree. */
  tree: string;
  /** The session's branch (`marina/session-*`). */
  branch: string;
  /** Branch the pull request targets. */
  base: string;
  title: string;
  /** The trial that measured this change. */
  trial: CodeTrialResult;
  /** Who did the work, for the commit trailer and the pull request body. */
  author: string;
  /** Queue the pull request for merge after opening it. */
  merge: boolean;
  /** Scratch directory for the snapshot's temporary index. */
  scratch: string;
}

export interface ShipResult {
  commit: string;
  url: string;
  queued: boolean;
}

const SHIPPABLE = new Set(["candidate-wins", "no-measurable-difference"]);

/** Why this change cannot ship on this trial, or null. */
export function shipRefusal(git: GitRunner, spec: Pick<ShipSpec, "tree" | "trial" | "scratch">) {
  if (!SHIPPABLE.has(spec.trial.verdict))
    return `The last trial (${spec.trial.id}) was ${spec.trial.verdict}; nothing ships on it.`;
  const now = snapshotCommit(git, spec.tree, spec.scratch);
  const treeOf = (sha: string) => git(spec.tree, ["rev-parse", `${sha}^{tree}`]).stdout;
  if (treeOf(now) !== treeOf(spec.trial.candidate.sha))
    return `The change moved since trial ${spec.trial.id}. Run code trial again on this change.`;
  return null;
}

export function shipBody(spec: Pick<ShipSpec, "trial" | "author">): string {
  const t = spec.trial;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const measured =
    t.delta === null
      ? "no paired estimate"
      : `Δ ${t.delta >= 0 ? "+" : ""}${pct(t.delta)}, 95% interval [${pct(t.low!)}, ${pct(t.high!)}] over ${t.items} paired items; margin to claim a win ${pct(t.margin)}`;
  return [
    `Shipped from a Marina coding session by ${spec.author}.`,
    "",
    "## Measured",
    `- Trial \`${t.id}\` on \`${t.benchmark}\`: **${t.verdict}**`,
    `- Base \`${t.base.sha.slice(0, 12)}\` ${pct(t.base.accuracy)} (${t.base.successes}/${t.base.attempts}) → candidate \`${t.candidate.sha.slice(0, 12)}\` ${pct(t.candidate.accuracy)} (${t.candidate.successes}/${t.candidate.attempts})`,
    `- ${measured}`,
    ...t.warnings.map((w) => `- warning: ${w}`),
    "",
    "Both builds ran as child Marinas with no provider credentials; this repository's checks and merge queue decide whether it lands.",
  ].join("\n");
}

function must(run: ShipRunner, cwd: string, argv: string[]): string {
  const r = run(cwd, argv);
  if (r.exitCode !== 0)
    throw new Error(`${argv.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).slice(-400)}`);
  return r.stdout.trim();
}

/**
 * Commit, push and open the pull request. `git` runs hardened (no hooks,
 * no repository-supplied drivers); `push` and `gh` run with the operator's
 * own credentials, since publishing is theirs to authorize.
 */
export function shipChange(
  run: {
    git: ShipRunner;
    push: ShipRunner;
    gh: ShipRunner;
    identity: { name: string; email: string };
  },
  spec: ShipSpec,
): ShipResult {
  const hardened = (argv: string[]) => ["git", ...HOST_GIT_CONFIG_ARGS, ...argv];
  must(run.git, spec.tree, hardened(["add", "-A"]));
  must(run.git, spec.tree, [
    ...hardened([
      "-c",
      `user.name=${run.identity.name}`,
      "-c",
      `user.email=${run.identity.email}`,
      "commit",
      "-q",
      "-m",
      spec.title,
      "-m",
      `Measured by Marina code trial ${spec.trial.id} (${spec.trial.verdict}). Work by ${spec.author}.`,
    ]),
  ]);
  const commit = must(run.git, spec.tree, ["git", "rev-parse", "HEAD"]);
  must(run.push, spec.tree, [
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "push",
    "-q",
    "-u",
    "origin",
    `HEAD:refs/heads/${spec.branch}`,
  ]);
  const url = must(run.gh, spec.tree, [
    "gh",
    "pr",
    "create",
    "--base",
    spec.base,
    "--head",
    spec.branch,
    "--title",
    spec.title,
    "--body",
    shipBody(spec),
  ])
    .split("\n")
    .filter(Boolean)
    .at(-1)!;
  let queued = false;
  if (spec.merge) {
    must(run.gh, spec.tree, ["gh", "pr", "merge", url, "--squash"]);
    queued = true;
  }
  return { commit, url, queued };
}

/** Run argv on the host with the operator's environment (for push and gh). */
export function operatorRunner(env: NodeJS.ProcessEnv = process.env): ShipRunner {
  return (cwd, argv) => {
    const r = Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
}

/** The operator's git identity, read with their own configuration. */
export function operatorIdentity(cwd: string, run: ShipRunner = operatorRunner()) {
  const read = (key: string) => run(cwd, ["git", "config", key]).stdout.trim();
  return { name: read("user.name") || "Marina", email: read("user.email") || "marina@localhost" };
}

export const SHIP_SCRATCH = (root: string, id: string) => join(root, "ship", id);
