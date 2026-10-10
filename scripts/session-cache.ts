// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function serverUrl(input: string, rootOnly: boolean): string {
  const url = new URL(input);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (rootOnly && !["/", "/ws", "/ws/"].includes(url.pathname))
  )
    throw new Error(
      `Use a Marina http(s) or ws(s) ${rootOnly ? "root " : ""}URL without credentials, query or fragment.`,
    );
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  if (rootOnly) url.pathname = "/";
  return url.toString().replace(/\/+$/, "");
}

/** Root participant endpoint only; credentials never travel in URLs. */
export function participantUrl(input: string): string {
  return serverUrl(input, true);
}

/** Comparable form of a cached server URL (keeps a reverse-proxy base path). */
export function cachedServerUrl(input: string): string {
  return serverUrl(input, false);
}

export const SESSION_DIRECTORY = join(homedir(), ".marina", "sessions");

export interface CachedParticipant {
  name: string;
  /** Normalized server URL the credential is bound to. */
  url: string;
}

/**
 * Identities with a usable cached credential, sorted by name. Only names that are
 * valid Marina account names are listed; tokens are never returned.
 */
export function listCachedParticipants(directory = SESSION_DIRECTORY): CachedParticipant[] {
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch {
    return [];
  }
  const identities: CachedParticipant[] = [];
  for (const file of files) {
    const match = /^([a-zA-Z0-9_]{1,20})\.json$/.exec(file);
    if (!match) continue;
    try {
      const cached = JSON.parse(readFileSync(join(directory, file), "utf8")) as {
        url?: unknown;
        token?: unknown;
      };
      if (typeof cached.url !== "string" || typeof cached.token !== "string" || !cached.token)
        continue;
      identities.push({ name: match[1]!, url: serverUrl(cached.url, false) });
    } catch {
      // A malformed or unbound cache entry is not an identity.
    }
  }
  return identities.sort((a, b) => a.name.localeCompare(b.name));
}

function sessionPath(name: string, directory: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    throw new Error(
      "Account name must contain only letters, digits, underscores or hyphens (1–64 characters)",
    );
  return join(directory, `${name}.json`);
}

/** Never choose an arbitrary cached account or reuse credentials on another server. */
export function cachedParticipantToken(
  name: string,
  url: string,
  directory = SESSION_DIRECTORY,
): string | undefined {
  const path = sessionPath(name, directory);
  // Existing connect/route clients can use a reverse-proxy base path. Keep that
  // path in the credential binding instead of imposing connected coding's root-only CLI.
  const expected = serverUrl(url, false);
  try {
    const cached = JSON.parse(readFileSync(path, "utf8")) as { url?: unknown; token?: unknown };
    if (
      typeof cached.url === "string" &&
      serverUrl(cached.url, false) === expected &&
      typeof cached.token === "string" &&
      cached.token
    )
      return cached.token;
  } catch {
    // Missing, malformed or unbound credentials require explicit authentication.
  }
  return undefined;
}

/** Reconnect rotates credentials; persist the replacement atomically and privately. */
export function saveParticipantToken(
  name: string,
  url: string,
  token: string,
  directory = SESSION_DIRECTORY,
): void {
  const path = sessionPath(name, directory);
  const normalized = serverUrl(url, false);
  if (!token) throw new Error("Cannot cache an empty session token");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ token, url: normalized }), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
