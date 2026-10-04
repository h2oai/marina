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

/** Whether an argv starts a git process. */
export function isGitArgv(argv: readonly string[]): boolean {
  return argv[0] === "git";
}

/**
 * `["git", sub, ...args]` → `["git", -c overrides..., sub, ...args]`.
 * Porcelain `diff` also runs external diff and textconv drivers by default;
 * those are switched off. Idempotent: an already-hardened argv is unchanged.
 */
export function hostGitArgv(argv: readonly string[]): string[] {
  if (!isGitArgv(argv)) return [...argv];
  if (argv[1] === "-c" && argv[2] === HOST_GIT_CONFIG_ARGS[1]) return [...argv];
  const rest = argv.slice(1);
  if (rest[0] === "diff") {
    const extra = ["--no-ext-diff", "--no-textconv"].filter((flag) => !rest.includes(flag));
    rest.splice(1, 0, ...extra);
  }
  return ["git", ...HOST_GIT_CONFIG_ARGS, ...rest];
}
