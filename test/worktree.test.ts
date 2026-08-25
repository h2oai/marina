// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionWorktree,
  isGitRepo,
  isManagedWorktreePath,
  managedWorktreesRoot,
  removeSessionWorktree,
  sessionWorktreeBranch,
  worktreeHasChanges,
} from "../src/coding/worktree";

// Each test gets an isolated $HOME so the Marina-managed worktrees dir
// (~/.marina/worktrees) lands in a throwaway location, never the real home.
let savedHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "marina-wt-home-")));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function makeGitRepoWithCommit(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marina-wt-repo-")));
  writeFileSync(join(root, "example.txt"), "hello\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const run = (args: string[]) => {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(proc.stderr)}`);
    }
  };
  run(["init", "-q"]);
  run(["add", "example.txt"]);
  run(["commit", "-q", "-m", "initial"]);
  return root;
}

function makeNonGitDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marina-wt-plain-")));
  writeFileSync(join(root, "example.txt"), "hello\n");
  return root;
}

describe("worktree manager", () => {
  it("creates an isolated worktree on a branch off HEAD; edits do not touch the base tree", async () => {
    const repo = makeGitRepoWithCommit();
    const created = await createSessionWorktree(repo, "code_abc123");
    expect(created).not.toBeNull();
    const { path, branch } = created!;
    expect(branch).toBe(sessionWorktreeBranch("code_abc123"));
    expect(existsSync(path)).toBe(true);
    // Worktree lives under the managed dir, NOT inside the repo.
    expect(path.startsWith(managedWorktreesRoot())).toBe(true);
    expect(path.startsWith(repo)).toBe(false);
    // The checked-out file is present in the worktree.
    expect(existsSync(join(path, "example.txt"))).toBe(true);

    // Editing in the worktree must not mutate the base working tree.
    writeFileSync(join(path, "example.txt"), "changed in worktree\n");
    expect(readFileSync(join(repo, "example.txt"), "utf-8")).toBe("hello\n");
  });

  it("returns null for a non-git directory (degrade to shared root)", async () => {
    const plain = makeNonGitDir();
    expect(isGitRepo(plain)).toBe(false);
    expect(await createSessionWorktree(plain, "code_nope")).toBeNull();
  });

  it("reuses an existing worktree for the same session (idempotent-ish)", async () => {
    const repo = makeGitRepoWithCommit();
    const first = await createSessionWorktree(repo, "code_reuse");
    const second = await createSessionWorktree(repo, "code_reuse");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.path).toBe(first!.path);
    expect(second!.branch).toBe(first!.branch);
  });

  it("gives two sessions on one repo distinct worktrees and branches", async () => {
    const repo = makeGitRepoWithCommit();
    const a = await createSessionWorktree(repo, "code_one");
    const b = await createSessionWorktree(repo, "code_two");
    expect(a!.path).not.toBe(b!.path);
    expect(a!.branch).not.toBe(b!.branch);
    expect(existsSync(a!.path)).toBe(true);
    expect(existsSync(b!.path)).toBe(true);
  });

  it("worktreeHasChanges reflects the working-tree state", async () => {
    const repo = makeGitRepoWithCommit();
    const { path } = (await createSessionWorktree(repo, "code_dirty"))!;
    expect(await worktreeHasChanges(path)).toBe(false);
    writeFileSync(join(path, "example.txt"), "dirty\n");
    expect(await worktreeHasChanges(path)).toBe(true);
  });

  it("auto-removes a clean worktree", async () => {
    const repo = makeGitRepoWithCommit();
    const { path } = (await createSessionWorktree(repo, "code_clean"))!;
    const res = await removeSessionWorktree(repo, path);
    expect(res.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("KEEPS a dirty worktree and reports its path", async () => {
    const repo = makeGitRepoWithCommit();
    const { path } = (await createSessionWorktree(repo, "code_keep"))!;
    writeFileSync(join(path, "example.txt"), "unsaved work\n");
    const res = await removeSessionWorktree(repo, path);
    expect(res.removed).toBe(false);
    expect(res.keptReason).toContain(path);
    expect(existsSync(path)).toBe(true); // still there for the human
  });

  it("force-removes a dirty worktree when asked", async () => {
    const repo = makeGitRepoWithCommit();
    const { path } = (await createSessionWorktree(repo, "code_force"))!;
    writeFileSync(join(path, "example.txt"), "unsaved work\n");
    const res = await removeSessionWorktree(repo, path, { force: true });
    expect(res.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it("REFUSES to delete a path outside the Marina-managed worktrees dir", async () => {
    const repo = makeGitRepoWithCommit();
    const outside = makeNonGitDir(); // a real dir we must never touch
    expect(isManagedWorktreePath(outside)).toBe(false);
    const res = await removeSessionWorktree(repo, outside);
    expect(res.removed).toBe(false);
    expect(res.keptReason).toContain("outside the Marina-managed");
    expect(existsSync(outside)).toBe(true); // untouched
  });

  it("host-exec-forbidden create degrades to null (no worktree)", async () => {
    const repo = makeGitRepoWithCommit();
    const created = await createSessionWorktree(repo, "code_forbidden", {
      hostExecForbidden: true,
    });
    expect(created).toBeNull();
  });
});
