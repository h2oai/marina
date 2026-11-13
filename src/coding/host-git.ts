// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hardened host git for Code Mode. Every git process Marina starts ON THE HOST
 * against a workspace an agent can write to goes through `hostGitArgv` and
 * `hostGitEnv`: a test runner, a container with the worktree mounted, or an
 * approved command can all leave files behind in that workspace, and git
 * executes several of them by configuration (`core.fsmonitor`, hooks,
 * `diff.external`, textconv / filter drivers, `core.sshCommand`).
 *
 * - `-c core.fsmonitor=false` and `-c core.hooksPath=/dev/null` override any
 *   repository setting (command-line config wins over `.git/config`).
 * - `GIT_CONFIG_NOSYSTEM` / `GIT_CONFIG_GLOBAL=/dev/null`: no operator or
 *   system config is consulted either, so results do not depend on the host.
 * - A minimal environment: PATH, a scratch HOME, a fixed locale. No server
 *   secrets (API keys, tokens) and no inherited `GIT_DIR` / `GIT_WORK_TREE` /
 *   `GIT_INDEX_FILE` redirects.
 * - `diff` additionally gets `--no-ext-diff --no-textconv` (see `hostGitArgv`).
 *
 * The primary defence for container workspaces is that `.git` is mounted
 * read-only inside the container (src/coding/container-workspace.ts); these
 * flags are the second layer and also cover host runners.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `-c` overrides placed before the git subcommand. */
export const HOST_GIT_CONFIG_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.sshCommand=false",
  "-c",
  "core.pager=cat",
  "-c",
  "credential.helper=",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  // Never descend into submodules: a submodule's `.git` gitfile lives in the
  // writable work tree, so code that can write there can point it at a gitdir
  // whose config names filter drivers or an fsmonitor, which a recursing diff
  // or status would run on the host.
  "-c",
  "diff.ignoreSubmodules=all",
  "-c",
  "submodule.recurse=false",
];

/** Scratch HOME shared with host Code Mode commands (never the server's own HOME). */
export const CODE_RUN_HOME = join(tmpdir(), "marina-code-home");

/** The environment for a host git process: nothing from the server beyond PATH. */
export function hostGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: CODE_RUN_HOME,
    LANG: "C",
    LC_ALL: "C",
    TERM: "dumb",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    ...extra,
  };
}

/** A passthrough textconv: an absolute `cat` (never resolved through PATH), else the shell builtin. */
const PASSTHROUGH_TEXTCONV =
  ["/usr/bin/cat", "/bin/cat"].find((path) => existsSync(path)) ?? "true";

/**
 * `-c` overrides that switch off every content driver the repository's config
 * names (filters, diff textconv / external commands, merge drivers). Git runs
 * those programs with the work tree as cwd whenever it hashes, diffs or merges
 * work-tree content, so they are inert in host git:
 * - `filter.<n>.clean|smudge|process` empty and `required=false`: no program
 *   runs and content is hashed as stored;
 * - `diff.<n>.textconv` an absolute `cat` (a passthrough), `diff.<n>.command`
 *   and `diff.external` the shell builtin `true`;
 * - `merge.<n>.driver` the shell builtin `false`, so a merge that would use
 *   it reports a conflict instead of running anything.
 * Driver names come from `git config --get-regexp`, which reads configuration
 * (including its includes) without running anything. Global and system config
 * are already off for host git (`hostGitEnv`). A driver name git's `-c` syntax
 * cannot carry fails closed.
 */
export function hostGitDriverOverrides(cwd: string): string[] {
  const probe = Bun.spawnSync(
    ["git", ...HOST_GIT_CONFIG_ARGS, "config", "--null", "--get-regexp", "^(filter|diff|merge)\\."],
    { cwd, env: hostGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  // 1: no such keys; anything else (not a repository, unreadable config)
  // means the real git command reads no drivers either, or fails the same way.
  if (probe.exitCode !== 0) return [];
  const filters = new Set<string>();
  const diffs = new Set<string>();
  const merges = new Set<string>();
  let external = false;
  for (const entry of probe.stdout.toString().split("\0")) {
    const newline = entry.indexOf("\n");
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const firstDot = key.indexOf(".");
    const lastDot = key.lastIndexOf(".");
    if (firstDot < 0) continue;
    const section = key.slice(0, firstDot).toLowerCase();
    if (section !== "filter" && section !== "diff" && section !== "merge") continue;
    if (firstDot === lastDot) {
      if (section === "diff" && key.slice(lastDot + 1).toLowerCase() === "external")
        external = true;
      continue;
    }
    const name = key.slice(firstDot + 1, lastDot);
    if (/[=\n\0]/.test(name))
      throw new Error(
        "A git driver name in this repository's config cannot be overridden safely; refused.",
      );
    if (section === "filter") filters.add(name);
    else if (section === "diff") diffs.add(name);
    else if (section === "merge") merges.add(name);
  }
  const args: string[] = [];
  for (const name of filters)
    for (const setting of ["clean=", "smudge=", "process=", "required=false"])
      args.push("-c", `filter.${name}.${setting}`);
  for (const name of diffs)
    args.push(
      "-c",
      `diff.${name}.textconv=${PASSTHROUGH_TEXTCONV}`,
      "-c",
      `diff.${name}.command=true`,
    );
  if (external) args.push("-c", "diff.external=true");
  for (const name of merges) args.push("-c", `merge.${name}.driver=false`);
  return args;
}

/** Whether an argv starts a git process. */
export function isGitArgv(argv: readonly string[]): boolean {
  return argv[0] === "git";
}

/**
 * `["git", sub, ...args]` → `["git", -c overrides..., sub, ...args]`; given
 * the `cwd` git will run in, the repository's content drivers are switched off
 * too (`hostGitDriverOverrides`).
 * Porcelain `diff` also runs external diff and textconv drivers by default;
 * those are switched off. Idempotent: an already-hardened argv is unchanged.
 */
export function hostGitArgv(argv: readonly string[], cwd?: string): string[] {
  if (!isGitArgv(argv)) return [...argv];
  if (argv[1] === "-c" && argv[2] === HOST_GIT_CONFIG_ARGS[1]) return [...argv];
  const rest = argv.slice(1);
  if (rest[0] === "diff") {
    const extra = ["--no-ext-diff", "--no-textconv"].filter((flag) => !rest.includes(flag));
    rest.splice(1, 0, ...extra);
  }
  // With the directory git will run in, also switch off the content drivers
  // that directory's repository config names.
  const drivers = cwd === undefined ? [] : hostGitDriverOverrides(cwd);
  return ["git", ...HOST_GIT_CONFIG_ARGS, ...drivers, ...rest];
}
