// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hermetic git for tests. Every call ignores the developer's and the runner's
 * global and system git config, uses a fixed identity, never prompts, and
 * turns off automatic maintenance: since git 2.56 `git commit` may start a
 * detached `git maintenance run --auto` that keeps writing inside `.git` after
 * the command returns, racing tests that delete or move `.git` right away.
 */

/** `-c` flags applied to every test git invocation. */
export const TEST_GIT_CONFIG: readonly string[] = [
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
  "-c",
  "init.defaultBranch=main",
];

/** The process environment with git isolated from host configuration. */
export function testGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // A caller running inside a git hook or worktree must not leak its repository.
    if (value === undefined || /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY)$/.test(key))
      continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

/** Run `git <args>` in `cwd`; throws with stderr on a non-zero exit, returns trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...TEST_GIT_CONFIG, ...args], {
    cwd,
    env: testGitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

/** `git init --quiet` in `dir` (default branch `main`). */
export function gitInit(dir: string, ...args: string[]): void {
  git(dir, "init", "--quiet", ...args);
}
