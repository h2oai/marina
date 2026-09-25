// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local profile's model-API key. On a single-operator, loopback-only
 * instance the model API still requires a bearer token — but nobody should
 * have to invent one before an OpenAI-compatible client works. So when the
 * LOCAL profile runs with neither MODEL_API_KEYS nor MARINA_OPEN_API, Marina
 * creates one random key, keeps it next to the database (mode 0600, reused on
 * every restart) and uses it exactly as a configured MODEL_API_KEYS entry.
 * Shared and public profiles never get one: they must configure their keys.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

export function localApiKeyPath(dbPath: string): string {
  return `${dbPath}.local-api-key`;
}

/** Load the key at `path`, creating it (0600) when missing or unreadable to others only. */
export function loadOrCreateLocalApiKey(path: string): { key: string; created: boolean } {
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) chmodSync(path, 0o600);
    const key = readFileSync(path, "utf8").trim();
    if (/^mk_local_[A-Za-z0-9_-]{32,}$/.test(key)) return { key, created: false };
  }
  const key = `mk_local_${randomBytes(24).toString("base64url")}`;
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { key, created: true };
}
