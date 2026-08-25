// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { LocalWorkspace, type WorkspaceRunResult } from "./local-workspace";

/**
 * Per-session git-worktree isolation (opt-in, default OFF).
 *
 * A session can bind to a Marina-created git worktree so its edits land on an
 * isolated branch instead of the shared workspace root. This module is the
 * ONLY thing that constructs / destroys those worktrees, and it enforces two
 * hard invariants so cleanup can never delete arbitrary host paths:
 *
 *   1. Worktrees live under a single Marina-managed directory
 *      (`~/.marina/worktrees/<repo-hash>/<session-id>`), NEVER inside the repo.
 *   2. `removeSessionWorktree` refuses to touch any path outside that managed
 *      dir (fail closed) and auto-removes only when the tree has no uncommitted
 *      changes — otherwise it keeps the tree and surfaces the path.
 *
 * Every git call routes through `LocalWorkspace.run` (the existing controlled
 * exec: argv-only — no shell, scrubbed env, cwd pinned, output capped, per-root
 * lock, and the telnet host-exec-forbidden chokepoint). The `git worktree`
 * verbs + `git status --porcelain` are the only new git surface, allowlisted in
 * `local-workspace.ts`. Callers gate the whole feature behind `code.exec`.
 */

export const WORKTREE_BRANCH_PREFIX = "marina/session-";

export interface SessionWorktree {
  path: string;
  branch: string;
}

export interface WorktreeRemoval {
  removed: boolean;
  keptReason?: string;
}

interface ExecOpts {
  /** When true, host git exec is forbidden (telnet-origin). Fails closed. */
  hostExecForbidden?: boolean;
}

/** Root of the Marina-managed worktree area. Nothing outside this is deletable. */
export function managedWorktreesRoot(): string {
  return join(homedir(), ".marina", "worktrees");
}

/** True when `root` is a git working tree (cheap, no subprocess). */
export function isGitRepo(root: string): boolean {
  try {
    return existsSync(join(root, ".git"));
  } catch {
    return false;
  }
}

function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || "session";
}

function repoHash(repoRoot: string): string {
  return createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 16);
}

/** Deterministic, collision-safe managed path for a (repo, session) pair. */
export function sessionWorktreePath(repoRoot: string, sessionId: string): string {
  return join(managedWorktreesRoot(), repoHash(repoRoot), sanitizeSessionId(sessionId));
}

/** The isolated branch name for a session's worktree. */
export function sessionWorktreeBranch(sessionId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${sanitizeSessionId(sessionId)}`;
}

/**
 * True only for a path strictly inside the Marina-managed worktrees dir (never
 * the managed root itself). This is the fail-closed guard consulted before ANY
 * deletion — a path Marina did not create can never be removed here.
 */
export function isManagedWorktreePath(path: string): boolean {
  const base = resolve(managedWorktreesRoot());
  const target = resolve(path);
  return target !== base && target.startsWith(base + sep);
}

async function runGit(
  root: string,
  argv: string[],
  hostExecForbidden: boolean,
): Promise<WorkspaceRunResult> {
  // LocalWorkspace confines file ops to `root`, pins cwd, scrubs env, and honors
  // the host-exec-forbidden chokepoint. The worktree git verbs are allowlisted.
  const ws = new LocalWorkspace(root);
  ws.setHostExecForbidden(hostExecForbidden === true);
  return ws.run(argv);
}

/**
 * Create (or reuse) the session's isolated worktree.
 *
 * Returns `{ path, branch }` on success, or `null` when the root is not a git
 * repo, has no commits (unborn HEAD), or git otherwise fails — the caller then
 * degrades to the shared root. Idempotent-ish: an existing worktree dir for the
 * session is reused rather than recreated.
 */
export async function createSessionWorktree(
  repoRoot: string,
  sessionId: string,
  opts: ExecOpts = {},
): Promise<SessionWorktree | null> {
  if (!isGitRepo(repoRoot)) return null; // non-git → degrade to shared root
  const path = sessionWorktreePath(repoRoot, sessionId);
  const branch = sessionWorktreeBranch(sessionId);
  if (existsSync(path)) return { path, branch }; // reuse

  mkdirSync(dirname(path), { recursive: true });
  try {
    const res = await runGit(
      repoRoot,
      ["git", "worktree", "add", "-b", branch, path, "HEAD"],
      opts.hostExecForbidden === true,
    );
    if (res.exitCode !== 0) {
      // Unborn HEAD / branch collision / other git failure — leave nothing behind.
      if (isManagedWorktreePath(path) && existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
      return null;
    }
    return { path, branch };
  } catch {
    // hostExecForbidden or spawn failure — degrade to shared root.
    return null;
  }
}

/**
 * Whether the worktree at `path` has uncommitted changes. Fails CLOSED: if the
 * path is gone treat as no changes; if git status can't be run (forbidden /
 * error) treat as HAS changes so an auto-remove never nukes work we couldn't
 * inspect.
 */
export async function worktreeHasChanges(path: string, opts: ExecOpts = {}): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const res = await runGit(
      path,
      ["git", "status", "--porcelain"],
      opts.hostExecForbidden === true,
    );
    if (res.exitCode !== 0) return true; // couldn't inspect → assume dirty
    return res.output.trim().length > 0;
  } catch {
    return true; // couldn't inspect → assume dirty
  }
}

/**
 * Remove the session's worktree — but only when it is safe.
 *
 *   - REFUSES (fail closed) if `path` is not inside the Marina-managed dir.
 *   - Auto-removes only when the tree has no uncommitted changes, OR `force`.
 *   - Otherwise keeps the tree and returns `keptReason` with the path so a
 *     human can merge or discard it.
 *
 * Never `rm`s an arbitrary path — deletion is `git worktree remove` + `prune`.
 */
export async function removeSessionWorktree(
  repoRoot: string,
  path: string,
  opts: ExecOpts & { force?: boolean } = {},
): Promise<WorktreeRemoval> {
  if (!isManagedWorktreePath(path)) {
    return {
      removed: false,
      keptReason: `Refusing to remove a path outside the Marina-managed worktrees dir: ${path}`,
    };
  }
  const hostExecForbidden = opts.hostExecForbidden === true;

  if (!existsSync(path)) {
    // Already gone on disk — prune the stale administrative record, report done.
    await runGit(repoRoot, ["git", "worktree", "prune"], hostExecForbidden).catch(() => undefined);
    return { removed: true };
  }

  if (!opts.force) {
    const dirty = await worktreeHasChanges(path, { hostExecForbidden });
    if (dirty) {
      return {
        removed: false,
        keptReason: `Worktree has uncommitted changes; keeping it at ${path}`,
      };
    }
  }

  const args = ["git", "worktree", "remove"];
  if (opts.force) args.push("--force");
  args.push(path);
  const res = await runGit(repoRoot, args, hostExecForbidden).catch(() => null);
  if (res?.exitCode !== 0) {
    return { removed: false, keptReason: `git worktree remove failed; keeping it at ${path}` };
  }
  await runGit(repoRoot, ["git", "worktree", "prune"], hostExecForbidden).catch(() => undefined);
  return { removed: true };
}

export interface WorktreeListEntry {
  path: string;
  branch?: string;
}

/** Enumerate the repo's registered worktrees (best-effort; [] on any failure). */
export async function listSessionWorktrees(
  repoRoot: string,
  opts: ExecOpts = {},
): Promise<WorktreeListEntry[]> {
  if (!isGitRepo(repoRoot)) return [];
  const res = await runGit(
    repoRoot,
    ["git", "worktree", "list", "--porcelain"],
    opts.hostExecForbidden === true,
  ).catch(() => null);
  if (res?.exitCode !== 0) return [];
  const out: WorktreeListEntry[] = [];
  for (const block of res.output.split("\n\n")) {
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim();
    }
    if (path) out.push({ path, branch });
  }
  return out;
}
