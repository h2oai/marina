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
  // `commit-tree` and `commit` honour commit.gpgSign: gpg.program (or
  // gpg.ssh.defaultKeyCommand) would run. Marina's own commits are never signed.
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "log.showSignature=false",
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

/**
 * Absolute programs for the driver overrides. Git runs a command string with no
 * shell metacharacters through PATH, so a bare `cat`/`true`/`false` could resolve
 * to a work-tree file when the server's PATH has a relative entry. None found:
 * fail closed rather than fall back to PATH.
 */
function absoluteProgram(name: string): string {
  const found = [`/usr/bin/${name}`, `/bin/${name}`].find((path) => existsSync(path));
  if (!found) throw new Error(`Host git hardening needs /usr/bin/${name} or /bin/${name}.`);
  return found;
}

/**
 * `-c` overrides that switch off every content driver the repository's config
 * names (filters, diff textconv / external commands, merge drivers) and every
 * configured hook (`hook.<name>.command`). Git runs those programs with the
 * work tree as cwd whenever it hashes, diffs or merges work-tree content, or
 * updates a ref, so they are inert in host git:
 * - `filter.<n>.clean|smudge|process` empty and `required=false`: no program
 *   runs and content is hashed as stored;
 * - `diff.<n>.textconv` an absolute `cat` (a passthrough), `diff.<n>.command`
 *   and `diff.external` an absolute `true`;
 * - `merge.<n>.driver` an absolute `false`, so a merge that would use it
 *   reports a conflict instead of running anything;
 * - `hook.<n>.event` reset (an empty value clears the list) and
 *   `hook.<n>.enabled=false`: `core.hooksPath=/dev/null` does not reach hooks
 *   defined in config, which git runs on `update-ref` (reference-transaction),
 *   `commit` and checkout.
 * Absolute programs (`absoluteProgram`): git looks a bare command name up on
 * PATH, which could name a work-tree file.
 * Names come from `git config --get-regexp`, which reads configuration
 * (including its includes) without running anything; `env` decides which
 * configuration that is (default: the repository's alone, as `hostGitEnv`
 * gives every host git). A name git's `-c` syntax cannot carry fails closed.
 */
export function hostGitDriverOverrides(
  cwd: string,
  env: Record<string, string | undefined> = hostGitEnv(),
): string[] {
  const probe = Bun.spawnSync(
    [
      "git",
      ...HOST_GIT_CONFIG_ARGS,
      "config",
      "--null",
      "--get-regexp",
      "^(filter|diff|merge|hook)\\.",
    ],
    { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  // 1: no such keys; anything else (not a repository, unreadable config)
  // means the real git command reads no drivers either, or fails the same way.
  if (probe.exitCode !== 0) return [];
  const filters = new Set<string>();
  const diffs = new Set<string>();
  const merges = new Set<string>();
  const hooks = new Set<string>();
  let external = false;
  for (const entry of probe.stdout.toString().split("\0")) {
    const newline = entry.indexOf("\n");
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const firstDot = key.indexOf(".");
    const lastDot = key.lastIndexOf(".");
    if (firstDot < 0) continue;
    const section = key.slice(0, firstDot).toLowerCase();
    if (section !== "filter" && section !== "diff" && section !== "merge" && section !== "hook")
      continue;
    if (firstDot === lastDot) {
      if (section === "diff" && key.slice(lastDot + 1).toLowerCase() === "external")
        external = true;
      continue;
    }
    const name = key.slice(firstDot + 1, lastDot);
    if (/[=\n\0]/.test(name))
      throw new Error(
        "A git driver or hook name in this repository's config cannot be overridden safely; refused.",
      );
    if (section === "filter") filters.add(name);
    else if (section === "diff") diffs.add(name);
    else if (section === "merge") merges.add(name);
    else if (section === "hook") hooks.add(name);
  }
  const args: string[] = [];
  const cat = diffs.size ? absoluteProgram("cat") : "";
  const yes = diffs.size || external ? absoluteProgram("true") : "";
  const no = merges.size ? absoluteProgram("false") : "";
  for (const name of filters)
    for (const setting of ["clean=", "smudge=", "process=", "required=false"])
      args.push("-c", `filter.${name}.${setting}`);
  for (const name of diffs)
    args.push("-c", `diff.${name}.textconv=${cat}`, "-c", `diff.${name}.command=${yes}`);
  if (external) args.push("-c", `diff.external=${yes}`);
  for (const name of merges) args.push("-c", `merge.${name}.driver=${no}`);
  for (const name of hooks)
    args.push("-c", `hook.${name}.event=`, "-c", `hook.${name}.enabled=false`);
  return args;
}

/**
 * `-c key=value` pairs as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
 * `GIT_CONFIG_VALUE_n`, which bind every git process started with that
 * environment, including those a tool such as `gh` starts itself.
 */
export function gitConfigEnv(args: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  let count = 0;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== "-c") throw new Error("gitConfigEnv takes -c key=value pairs only.");
    const pair = args[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error("gitConfigEnv takes -c key=value pairs only.");
    env[`GIT_CONFIG_KEY_${count}`] = pair.slice(0, eq);
    env[`GIT_CONFIG_VALUE_${count}`] = pair.slice(eq + 1);
    count++;
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
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
