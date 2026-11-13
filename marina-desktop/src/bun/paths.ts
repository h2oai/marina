// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { marinaPath } from "../../../src/config/marina-home";

export interface AppPaths {
  /** OS-appropriate application data directory */
  dataDir: string;
  /** Default database path */
  defaultDb: string;
  /** Preferences JSON file */
  prefsFile: string;
  /** App-generated secret used to encrypt provider keys in the local database. */
  keySecretFile: string;
  /** Room definitions directory */
  roomsDir: string;
  /** Log directory */
  logDir: string;
}

/**
 * Resolve paths for application data: `desktop/` in Marina's one home
 * (`~/.marina/desktop`, or under `MARINA_HOME`), so removing Marina removes it.
 * Data an older version kept in the OS location (macOS
 * `~/Library/Application Support/Marina/`, Windows `%APPDATA%/Marina/`, Linux
 * `~/.local/share/marina/`) is moved there on first start.
 *
 * Room directory resolution order:
 * 1. Bundled Electrobun app: ../Resources/app/resources/worlds/
 *    relative to Contents/MacOS/ (macOS) or bin/ (Linux/Windows)
 * 2. Dev mode: the checkout's worlds/ relative to this module
 * 3. Dev mode from repo root: ./worlds
 */
export function getAppPaths(): AppPaths {
  const home = homedir();
  const platform = process.platform;

  let legacyDir: string;
  if (platform === "darwin") {
    legacyDir = join(home, "Library", "Application Support", "Marina");
  } else if (platform === "win32") {
    legacyDir = join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Marina");
  } else {
    const xdg = process.env.XDG_DATA_HOME;
    legacyDir = join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "marina");
  }
  const dataDir = adoptDesktopData(marinaPath("desktop"), legacyDir);

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const logDir = join(dataDir, "logs");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  // Worlds base directory. Each world owns a room folder under here (e.g.
  // worlds/default/). In dev the world definition's absolute roomsDir is used
  // directly; this base is the bundled-app fallback that EngineHost joins the
  // world's folder name onto. Try multiple strategies:
  const roomsCandidates = [
    // Bundled Electrobun app: cwd is Contents/MacOS/
    // worlds/ copied to Contents/Resources/app/resources/worlds/
    resolve("../Resources/app/resources/worlds"),
    // Dev mode: import.meta.dir is marina-desktop/src/bun/, go up to repo root
    join(import.meta.dir, "../../../worlds"),
    // Fallback: cwd-relative
    resolve("worlds"),
  ];

  let roomsDir = roomsCandidates[roomsCandidates.length - 1]!;
  for (const candidate of roomsCandidates) {
    if (existsSync(candidate)) {
      roomsDir = candidate;
      break;
    }
  }

  return {
    dataDir,
    defaultDb: join(dataDir, "marina.db"),
    prefsFile: join(dataDir, "preferences.json"),
    keySecretFile: join(dataDir, ".key-secret"),
    roomsDir,
    logDir,
  };
}

/**
 * Move an older version's desktop data into the home once. On Linux the old
 * folder also held other tools' data (`corpora/`, which the corpus store
 * moves itself), so only the desktop's own entries move. A move that fails
 * keeps the old folder in use, so nothing is stranded.
 */
export function adoptDesktopData(dataDir: string, legacyDir: string): string {
  if (existsSync(dataDir) || !existsSync(legacyDir)) return dataDir;
  const others = new Set(["corpora", "live-acceptance"]);
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(legacyDir))
      if (!others.has(name)) renameSync(join(legacyDir, name), join(dataDir, name));
    if (readdirSync(legacyDir).length === 0) rmdirSync(legacyDir);
    return dataDir;
  } catch {
    return legacyDir;
  }
}
