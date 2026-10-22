// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the `marina` CLI reads its settings — the same everywhere, like other
 * coding CLIs, and never from the project it is pointed at.
 *
 * Highest first:
 *   1. the shell environment
 *   2. the instance's own `.env` — a folder session's home
 *      (`~/.marina/projects/<slug>/.env`), or the working directory for
 *      `marina start` (a server's folder is its instance)
 *   3. `~/.marina/.env` — the user's settings for every folder (`marina init`)
 *   4. the source checkout's `.env`, when running from one
 *
 * The project folder's own `.env` belongs to the project: it is never read.
 * The bin's shebang passes `--no-env-file` so Bun does not load it, and the
 * compiled binary is built without dotenv autoload, so the shell snapshot
 * below is the real shell environment. Bun given `--env-file` explicitly means
 * the caller chose the files: then no settings file is read here.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnvironment } from "../src/config/environment";
import { IS_COMPILED, MARINA_ROOT } from "../src/runtime-paths";

/** The environment the CLI was started with, before any settings file. */
const SHELL_ENV: Readonly<NodeJS.ProcessEnv> = { ...process.env };

/** `~/.marina` — the user's Marina home (settings, per-folder instances, sessions). */
export function userMarinaDir(env: NodeJS.ProcessEnv = SHELL_ENV): string {
  return join(env.HOME?.trim() || homedir(), ".marina");
}

export interface SettingsOptions {
  /** The instance's home, whose `.env` is the highest settings file. */
  instanceDir?: string;
  /** The shell environment; defaults to the snapshot taken at startup. */
  env?: NodeJS.ProcessEnv;
  /** The source checkout; defaults to this one (none in the compiled binary). */
  checkoutDir?: string;
}

/** Bun was started with `--env-file`: the caller's files are the whole configuration. */
const EXPLICIT_ENV_FILES = process.execArgv.some((arg) => arg.startsWith("--env-file"));

/** The settings files in precedence order (highest first), present or not. */
export function settingsFiles(opts: SettingsOptions = {}): string[] {
  const env = opts.env ?? SHELL_ENV;
  const checkout = "checkoutDir" in opts ? opts.checkoutDir : IS_COMPILED ? undefined : MARINA_ROOT;
  return [
    ...(opts.instanceDir ? [join(opts.instanceDir, ".env")] : []),
    join(userMarinaDir(env), ".env"),
    ...(checkout ? [join(checkout, ".env")] : []),
  ];
}

/** The shell environment filled from the settings files; a higher layer always wins. */
export function cliEnvironment(opts: SettingsOptions = {}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...(opts.env ?? SHELL_ENV) };
  if (EXPLICIT_ENV_FILES && !opts.env) return merged;
  for (const file of settingsFiles(opts)) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnvironment(readFileSync(file, "utf8")))) {
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}

/** Apply `cliEnvironment(opts)` to `process.env`. Callable again once the instance is known. */
export function applyCliEnvironment(opts: { instanceDir?: string } = {}): void {
  Object.assign(process.env, cliEnvironment(opts));
}
