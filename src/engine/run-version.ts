// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which Marina code produced a result: `{ commit, dirty, describe }`, read
 * from git when the run writes its result. Benchmark result files carry it as
 * a top-level `marina` field (`benchmarks/run-version.ts` stamps them), ledger
 * runs carry it in `config_json.marina`, and in-world runs already name their
 * code in `target_json.source` (`sourceRevision()`, `<sha12>[-dirty]`). The
 * transfer report (`benchmarks/transfer/versions.ts`) reads all three to
 * refuse comparisons whose arms ran on different code.
 *
 * Pure apart from `readGitVersion`, which spawns local `git` only (no network).
 */

export interface MarinaVersion {
  /** Full (or, from an in-world source revision, 12-hex) commit sha. */
  commit: string;
  /** The checkout had uncommitted changes to tracked files. */
  dirty: boolean;
  /** `git describe --tags --always --dirty` (a release tag when the commit is one). */
  describe: string;
}

const SHA = /^[0-9a-f]{7,40}$/;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** A well-formed stamp, or undefined. */
export function asMarinaVersion(x: unknown): MarinaVersion | undefined {
  if (!isRecord(x) || typeof x.commit !== "string" || !SHA.test(x.commit)) return undefined;
  if (typeof x.dirty !== "boolean") return undefined;
  return {
    commit: x.commit,
    dirty: x.dirty,
    describe: typeof x.describe === "string" && x.describe ? x.describe : x.commit.slice(0, 12),
  };
}

/** An in-world run's `source` (`<sha>` or `<sha>-dirty`) as a stamp. */
export function versionFromSourceRevision(source: unknown): MarinaVersion | undefined {
  if (typeof source !== "string") return undefined;
  const m = /^([0-9a-f]{7,40})(-dirty)?$/.exec(source);
  if (!m) return undefined;
  return { commit: m[1]!, dirty: !!m[2], describe: source };
}

/** Two commits name the same code: equal, or one an abbreviation (≥ 7 hex) of the other. */
export function sameCommit(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
}

/** Short label: `abc1234def5` or `abc1234def5+dirty`. */
export function versionLabel(v: MarinaVersion): string {
  return `${v.commit.slice(0, 12)}${v.dirty ? "+dirty" : ""}`;
}

/** Runs one git command; returns stdout or undefined on failure. Injected by tests. */
export type GitCommand = (args: string[], cwd: string) => string | undefined;

export const spawnGit: GitCommand = (args, cwd) => {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The checkout's version at `cwd`, or undefined outside a git checkout.
 * Dirty means tracked files differ from HEAD (untracked files, such as the
 * results a run writes, do not count).
 */
export function readGitVersion(cwd: string, git: GitCommand = spawnGit): MarinaVersion | undefined {
  const commit = git(["rev-parse", "HEAD"], cwd);
  if (!commit || !SHA.test(commit)) return undefined;
  const status = git(["status", "--porcelain", "--untracked-files=no"], cwd);
  const dirty = status === undefined ? true : status.length > 0;
  const describe =
    git(["describe", "--tags", "--always", "--dirty"], cwd) ??
    `${commit.slice(0, 12)}${dirty ? "-dirty" : ""}`;
  return { commit, dirty, describe };
}
