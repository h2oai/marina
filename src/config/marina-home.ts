// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina's one home on a machine: `~/.marina`, or `MARINA_HOME`.
 *
 * Everything Marina writes for a person lives under it, so removing Marina is
 * removing this folder (`marina uninstall`):
 *
 *   app/        the code (setup.sh installs here)
 *   bin/        the `marina` command (the one folder put on PATH)
 *   bun/        Bun, only when Marina had to install it
 *   world/      the world `marina start` runs
 *   projects/   one world per folder (`marina .`)
 *   worktrees/  Code Mode's isolated checkouts of your repositories
 *   mcp/        the Claude Code plugin's world
 *   desktop/    the desktop app's data
 *   sessions/, history/, relay/, runners/, connected/, world-view/, cli.json, .env
 *   cache/      downloads and indexes that can be rebuilt
 *   tools/      operator and benchmark tools' state
 *
 * Never import anything heavy here: the CLI, the server and the desktop app
 * all read it at startup.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

/** `MARINA_HOME`, else `~/.marina` (absolute). */
export function marinaHome(env: Env = process.env): string {
  const set = env.MARINA_HOME?.trim();
  if (set) return resolve(set);
  return join(env.HOME?.trim() || homedir(), ".marina");
}

/** A path under Marina's home. */
export function marinaPath(...parts: string[]): string {
  return join(marinaHome(), ...parts);
}

/** The same, for a given environment (tests, child processes). */
export function marinaPathIn(env: Env, ...parts: string[]): string {
  return join(marinaHome(env), ...parts);
}

/**
 * A home path that used to live elsewhere: the new path, after moving the old
 * one there when only the old one exists (same disk: a rename). A move that
 * fails (another disk, permissions) leaves the old path in use, so nothing is
 * ever stranded.
 */
export function adoptLegacyPath(path: string, legacy: string): string {
  if (existsSync(path) || !existsSync(legacy)) return path;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    renameSync(legacy, path);
    return path;
  } catch {
    return legacy;
  }
}

/**
 * A home path for state something outside Marina may point at by its absolute
 * path (an operator's timer runs a script in it, saved records name it): the
 * old location while it exists, never moved; new setups get the home path.
 */
export function legacyOrHome(path: string, legacy: string): string {
  return !existsSync(path) && existsSync(legacy) ? legacy : path;
}

/**
 * Every location older versions of Marina wrote to outside its home, for
 * `marina uninstall` (each is removed only when it exists).
 */
export function legacyLocations(env: Env = process.env): string[] {
  const home = env.HOME?.trim() || homedir();
  const xdgData = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  return [
    join(xdgData, "marina"),
    join(xdgData, "dev.marina.desktop"),
    join(home, ".cache", "marina"),
    join(home, ".cache", "dev.marina.desktop"),
    join(home, "Library", "Application Support", "Marina"),
    join(home, "Library", "Caches", "dev.marina.desktop"),
    join(env.APPDATA?.trim() || join(home, "AppData", "Roaming"), "Marina"),
    join(xdgData, "marina-repro"),
    join(xdgData, "marina-swebench"),
    join(xdgData, "marina-metaculus"),
    join(home, ".config", "marina-metaculus"),
    join(env.XDG_STATE_HOME?.trim() || join(home, ".local", "state"), "marina-monitor.json"),
  ];
}
