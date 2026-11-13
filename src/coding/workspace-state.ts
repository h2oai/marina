// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { getErrorMessage } from "../engine/errors";
import { hostGitArgv, hostGitEnv } from "./host-git";

/**
 * A workspace's state at one moment, for telling "this task changed nothing" apart from
 * "this task changed something". It never verifies anything: it only decides whether there
 * is anything to verify.
 */
export interface WorkspaceState {
  version: 2;
  root?: string;
  /** Whether the root is a Git working-tree root. */
  git?: boolean;
  /**
   * The source: in a Git repository HEAD, the index (staged-only changes), the index flags,
   * and every tracked or untracked-not-ignored path; in a plain folder, every entry.
   */
  source?: string;
  /** Per top-level entry hash of the source, so a difference can be named. */
  sourceParts?: Record<string, string>;
  /** Git-ignored entries (dependencies, build output, local data), by top-level path. */
  ignoredParts?: Record<string, string>;
  /** Set when the ignored entries exceeded the entry limit and were not all observed. */
  ignoredUnobserved?: string;
  /** Entries observed. */
  entries?: number;
  /** Paths Git reported as changed against HEAD when observed (tracked, staged, untracked). */
  preexisting?: { count: number; sample: string[] };
  /** Index entries marked assume-unchanged or skip-worktree: Git does not look at them. */
  hidden?: { count: number; sample: string[] };
  /** Set when the workspace could not be observed; such a state never waives verification. */
  reason?: string;
}

/** Entries observed before giving up (source and ignored together). */
export const WORKSPACE_MAX_ENTRIES = 200_000;
/**
 * Git-ignored entries observed before skipping them. Installed dependencies alone can run to
 * hundreds of thousands of files; past this budget ignored files are named as not observed,
 * so a dispatch stays a fraction of a second even in a large repository.
 */
export const WORKSPACE_MAX_IGNORED_ENTRIES = 10_000;
const SAMPLE = 5;

type Stat = ReturnType<typeof statOf>;
const statOf = (path: string) => lstatSync(path, { bigint: true });
/** Metadata only, never content: any write changes ctime, and a stat costs no read. */
function entryLine(path: string, rel: string, s: Stat): string {
  const target = s.isSymbolicLink()
    ? readlinkSync(path, { encoding: "buffer" }).toString("hex")
    : "";
  return `${Buffer.byteLength(rel)}:${rel}\0${s.mode}\0${s.size}\0${s.ino}\0${s.mtimeNs}\0${s.ctimeNs}\0${target}\0`;
}

class EntryLimit extends Error {}

/**
 * Observe a workspace, read-only and bounded. Entries are hashed by metadata (type, mode,
 * size, inode, mtime and ctime in nanoseconds, symlink target), never read and never
 * followed. In a Git repository the source is what Git sees plus HEAD and the index; ignored
 * entries (such as `node_modules` and build output) are walked separately under their own
 * budget, and past it they are recorded as not observed rather than failing the whole
 * observation. A plain folder is walked whole; past the limit it is not
 * observed at all, which keeps the task's normal verification.
 */
export async function observeWorkspaceState(
  inputRoot: string,
  limits: { entries?: number; ignored?: number } = {},
): Promise<WorkspaceState> {
  const limit = limits.entries ?? WORKSPACE_MAX_ENTRIES;
  const ignoredLimit = limits.ignored ?? WORKSPACE_MAX_IGNORED_ENTRIES;
  try {
    const root = await realpath(inputRoot);
    const git = async (args: string[], optional = false) => {
      const proc = Bun.spawn(hostGitArgv(["git", "--no-optional-locks", ...args]), {
        cwd: root,
        env: hostGitEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: 30_000,
      });
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0 && !optional)
        throw new Error(`workspace Git state could not be observed (git ${args[0]})`);
      return code === 0 ? text : undefined;
    };
    let entries = 0;
    let cap = limit;
    // Synchronous stats are an order of magnitude faster than awaited ones; yield to the
    // event loop every few thousand so a large workspace never stalls the server.
    const count = () => {
      if (++entries > cap) throw new EntryLimit();
      return entries % 4096 === 0;
    };
    const yieldNow = () => new Promise((resolve) => setImmediate(resolve));
    const parts = new Map<string, ReturnType<typeof createHash>>();
    const part = (rel: string, directory: boolean) => {
      const top = rel.split("/")[0]!;
      const key = directory || rel.includes("/") ? `${top}/` : top;
      let hash = parts.get(key);
      if (!hash) parts.set(key, (hash = createHash("sha256")));
      return hash;
    };
    // Depth-first in sorted order, so the same tree always hashes the same.
    // An explicit stack: awaiting only to yield keeps a stat per entry the whole cost.
    const walk = async (path: string, rel: string) => {
      const stack: Array<[string, string]> = [[path, rel]];
      while (stack.length) {
        const [at, name] = stack.pop()!;
        if (count()) await yieldNow();
        const s = statOf(at);
        part(name, s.isDirectory()).update(entryLine(at, name, s));
        if (!s.isDirectory()) continue;
        const children = readdirSync(at).sort();
        for (let i = children.length - 1; i >= 0; i--)
          stack.push([join(at, children[i]!), `${name}/${children[i]}`]);
      }
    };
    const digest = () =>
      Object.fromEntries(
        [...parts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, h]) => [k, h.digest("hex")]),
      );
    const top = await git(["rev-parse", "--show-toplevel"], true);
    if (top === undefined) {
      if (existsSync(join(root, ".git"))) throw new Error("workspace Git metadata is unavailable");
      for (const name of readdirSync(root).sort()) await walk(join(root, name), name);
      const sourceParts = digest();
      return {
        version: 2,
        root,
        git: false,
        source: createHash("sha256").update(JSON.stringify(sourceParts)).digest("hex"),
        sourceParts,
        entries,
      };
    }
    if ((await realpath(top.trim())) !== root)
      throw new Error("workspace observation needs the Git working-tree root");
    const state: WorkspaceState = { version: 2, root, git: true };
    const whole = createHash("sha256");
    whole.update(
      `head\0${(await git(["rev-parse", "--verify", "HEAD"], true))?.trim() ?? "unborn"}\0`,
    );
    // Staged-only changes live in the index, not in the working tree.
    whole.update("index\0").update((await git(["ls-files", "--stage", "-z"]))!);
    const flags = (await git(["ls-files", "-v", "-z"]))!.split("\0").filter(Boolean);
    whole.update("flags\0").update(flags.map((entry) => entry.slice(0, 1)).join(""));
    const hidden = flags.filter((entry) => /^[a-zS] /.test(entry)).map((e) => e.slice(2));
    if (hidden.length) state.hidden = { count: hidden.length, sample: hidden.slice(0, SAMPLE) };
    const changed = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]))!
      .split("\0")
      .filter((entry) => /^.. /.test(entry))
      .map((entry) => entry.slice(3));
    if (changed.length)
      state.preexisting = { count: changed.length, sample: changed.slice(0, SAMPLE) };
    // Every path Git sees, by metadata: assume-unchanged and skip-worktree files included,
    // since their changes are invisible to `git status`.
    const paths = [
      ...new Set(
        (await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))!
          .split("\0")
          .filter(Boolean),
      ),
    ].sort();
    for (const rel of paths) {
      if (count()) await yieldNow();
      const path = join(root, rel);
      let s: Stat | undefined;
      try {
        s = statOf(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
      part(rel, false).update(s ? entryLine(path, rel, s) : `${rel}\0missing\0`);
    }
    state.sourceParts = digest();
    whole.update(JSON.stringify(state.sourceParts));
    state.source = whole.digest("hex");
    parts.clear();
    const ignored = (await git([
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ]))!
      .split("\0")
      .filter(Boolean)
      .map((rel) => rel.replace(/\/$/, ""))
      .sort();
    const budget = Math.max(0, Math.min(ignoredLimit, limit - entries));
    try {
      cap = entries + budget;
      for (const rel of ignored) await walk(join(root, rel), rel);
      state.ignoredParts = digest();
    } catch (error) {
      if (!(error instanceof EntryLimit)) throw error;
      entries = cap;
      state.ignoredUnobserved = `Git-ignored files (such as installed dependencies or build output) were not observed: there are more than ${budget} of them`;
    }
    if ((await realpath(inputRoot)) !== root)
      throw new Error("the workspace moved during observation");
    return { ...state, entries };
  } catch (error) {
    return {
      version: 2,
      reason:
        error instanceof EntryLimit
          ? `the workspace has more than ${limit} entries, so it was not observed`
          : getErrorMessage(error),
    };
  }
}

/** What changed between two observations of the same workspace. */
export type WorkspaceComparison =
  | { kind: "unknown"; reason: string }
  | { kind: "changed"; paths: string[] }
  | {
      kind: "unchanged";
      /** Changes already in the workspace before the task: not the task's, never verified. */
      preexisting?: WorkspaceState["preexisting"];
      hidden?: WorkspaceState["hidden"];
      /** Git-ignored top-level paths that changed during the task (outside any check). */
      ignoredChanged?: string[];
      /** Why ignored files could not be compared. */
      ignoredUnobserved?: string;
    };

const changedKeys = (a: Record<string, string> = {}, b: Record<string, string> = {}) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

export function compareWorkspaceState(
  baseline: WorkspaceState | undefined,
  current: WorkspaceState,
): WorkspaceComparison {
  if (baseline?.version !== 2 || !baseline.source)
    return {
      kind: "unknown",
      reason: `the workspace was not observed when the task started${baseline?.reason ? ` (${baseline.reason})` : ""}`,
    };
  if (!current.source)
    return {
      kind: "unknown",
      reason: `the workspace could not be observed now${current.reason ? ` (${current.reason})` : ""}`,
    };
  if (current.root !== baseline.root || current.git !== baseline.git)
    return { kind: "unknown", reason: "the workspace binding changed during the task" };
  if (current.source !== baseline.source) {
    const paths = changedKeys(baseline.sourceParts, current.sourceParts);
    // Only Git's HEAD or index moved: a commit, a reset or a staged-only change.
    return { kind: "changed", paths: paths.length ? paths : ["Git HEAD or index"] };
  }
  const unobserved = baseline.ignoredUnobserved ?? current.ignoredUnobserved;
  const ignoredChanged = unobserved ? [] : changedKeys(baseline.ignoredParts, current.ignoredParts);
  return {
    kind: "unchanged",
    ...(baseline.preexisting ? { preexisting: baseline.preexisting } : {}),
    ...(baseline.hidden ? { hidden: baseline.hidden } : {}),
    ...(ignoredChanged.length ? { ignoredChanged } : {}),
    ...(unobserved ? { ignoredUnobserved: unobserved } : {}),
  };
}

const listed = (s: { count: number; sample: string[] }) =>
  `${s.count} path${s.count === 1 ? "" : "s"}: ${s.sample.join(", ")}${s.count > s.sample.length ? ", …" : ""}`;

/**
 * The reason a no-change answer records. It always says nothing was verified, and it names
 * what it cannot vouch for instead of passing over it: changes already present before the
 * task, files Git is told not to check, and ignored files that changed or were not observed.
 */
export function noChangeReason(
  comparison: Extract<WorkspaceComparison, { kind: "unchanged" }>,
): string {
  const notes: string[] = [];
  if (comparison.preexisting)
    notes.push(
      `changes already present before the task are not this task's and were not verified (${listed(comparison.preexisting)})`,
    );
  if (comparison.hidden)
    notes.push(
      `files Git is told not to check (assume-unchanged or skip-worktree; ${listed(comparison.hidden)}) were observed directly and did not change`,
    );
  if (comparison.ignoredChanged?.length)
    notes.push(
      `Git-ignored paths changed during the task and no check covers them (${comparison.ignoredChanged.slice(0, 8).join(", ")}${comparison.ignoredChanged.length > 8 ? ", …" : ""})`,
    );
  if (comparison.ignoredUnobserved) notes.push(comparison.ignoredUnobserved);
  return `nothing to verify: no files changed during this task${notes.length ? `; ${notes.join("; ")}` : ""}`;
}

/** Why a workspace still needs verification, naming where it changed. */
export function changedReason(comparison: Extract<WorkspaceComparison, { kind: "changed" }>) {
  const shown = comparison.paths.slice(0, 8);
  return `the workspace changed during this task (${shown.join(", ")}${comparison.paths.length > shown.length ? ", …" : ""})`;
}
