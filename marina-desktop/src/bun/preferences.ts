// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export interface Preferences {
  /** "local" = embedded engine, "remote" = connect to external server */
  mode: "local" | "remote";
  /** Remote server URL (when mode = "remote") */
  remoteUrl: string;
  /** Path to SQLite database file */
  dbPath: string;
  /** WebSocket/HTTP server port */
  wsPort: number;
  /** Telnet server port */
  telnetPort: number;
  /** MCP server port */
  mcpPort: number;
  /** Engine tick interval in milliseconds */
  tickMs: number;
  /** World definition to load (see worlds/ — default, commons, research, ...) */
  world: string;
  /** Starting room for new entities */
  startRoom: string;
  /** Saved window position and size */
  windowBounds: { width: number; height: number; x?: number; y?: number } | null;
  /** Recently opened database files */
  recentDatabases: string[];
  /** Recently connected remote servers */
  recentServers: string[];
}

const DEFAULT_PREFERENCES: Preferences = {
  mode: "local",
  remoteUrl: "",
  dbPath: "",
  wsPort: 3300,
  telnetPort: 4000,
  mcpPort: 3301,
  tickMs: 1000,
  world: "default",
  // Empty means use the selected world's own startRoom.
  startRoom: "",
  windowBounds: null,
  recentDatabases: [],
  recentServers: [],
};

/**
 * Load preferences from a JSON file, returning defaults for missing fields.
 */
export function loadPreferences(filePath: string): Preferences {
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_PREFERENCES, ...parsed };
    }
  } catch {
    // Corrupted file — fall back to defaults
  }
  return { ...DEFAULT_PREFERENCES };
}

/**
 * Save preferences to a JSON file.
 */
export function savePreferences(filePath: string, prefs: Preferences): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(prefs, null, 2), "utf-8");
  } catch (err) {
    console.error("[desktop] Failed to save preferences:", err);
  }
}
