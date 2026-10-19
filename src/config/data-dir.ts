// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `MARINA_DATA_DIR`: one directory that holds everything an instance writes.
 *
 * Without it, Marina's defaults are relative to the working directory
 * (`marina.db`, `data/assets`, `data/scratch`, …), which suits a checkout but
 * not an embedder: a host that spawns Marina from its own process tree must
 * know exactly where its state lives, and must never find files appearing in
 * its own working directory. With it, every unset path default moves under the
 * directory; an explicit setting still wins.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnvironment } from "./environment";

/** Path settings rooted at the data directory, and their file names under it. */
export const DATA_DIR_PATHS = {
  DB_PATH: "marina.db",
  BETTER_AUTH_DB_PATH: "marina-auth.db",
  ASSETS_DIR: "assets",
  MARINA_SCRATCH_DIR: "scratch",
  MARINA_MEMORY_EMBEDDING_CACHE: "memory-models",
  MARINA_CORPUS_EMBEDDING_CACHE: "memory-models",
} as const;

/** The configured data directory (absolute), or undefined when unset. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.MARINA_DATA_DIR?.trim();
  return raw ? resolve(raw) : undefined;
}

/**
 * Create the data directory and point every unset path setting into it. Its
 * `.env` (the dashboard settings editor writes there, see `instanceEnvPath`)
 * fills only keys the process environment does not already set. Returns the
 * directory, or undefined when `MARINA_DATA_DIR` is unset (nothing changes).
 */
export function applyDataDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = dataDir(env);
  if (!dir) return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  env.MARINA_DATA_DIR = dir;
  const envFile = join(dir, ".env");
  if (existsSync(envFile)) {
    for (const [key, value] of Object.entries(parseEnvironment(readFileSync(envFile, "utf8")))) {
      if (env[key] === undefined) env[key] = value;
    }
  }
  for (const [key, name] of Object.entries(DATA_DIR_PATHS)) {
    if (!env[key]?.trim()) env[key] = join(dir, name);
  }
  return dir;
}

/** The `.env` the settings editor reads and writes: the data directory's, else the working directory's. */
export function instanceEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env) ?? process.cwd(), ".env");
}

/** Per-entity scratch files (`run`, canvas `file:` uploads): `MARINA_SCRATCH_DIR`, default `data/scratch`. */
export function scratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.MARINA_SCRATCH_DIR?.trim() || "data/scratch";
}
