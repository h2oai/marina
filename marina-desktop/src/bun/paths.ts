// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface AppPaths {
  /** OS-appropriate application data directory */
  dataDir: string;
  /** Default database path */
  defaultDb: string;
  /** Preferences JSON file */
  prefsFile: string;
  /** Room definitions directory */
  roomsDir: string;
  /** Log directory */
  logDir: string;
}

/**
 * Resolve OS-appropriate paths for application data.
 *
 * - macOS:  ~/Library/Application Support/Marina/
 * - Windows: %APPDATA%/Marina/
 * - Linux:  ~/.local/share/marina/
 *
 * Room directory resolution order:
 * 1. Bundled Electrobun app: Contents/Resources/app/resources/rooms/
 *    (cwd is Contents/MacOS/, so ../Resources/app/resources/rooms)
 * 2. Dev mode from desktop/: ../../rooms relative to this file
 * 3. Dev mode from repo root: ./rooms
 */
export function getAppPaths(): AppPaths {
  const home = homedir();
  const platform = process.platform;

  let dataDir: string;
  if (platform === "darwin") {
    dataDir = join(home, "Library", "Application Support", "Marina");
  } else if (platform === "win32") {
    dataDir = join(
      process.env.APPDATA || join(home, "AppData", "Roaming"),
      "Marina",
    );
  } else {
    dataDir = join(home, ".local", "share", "marina");
  }

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
    roomsDir,
    logDir,
  };
}
