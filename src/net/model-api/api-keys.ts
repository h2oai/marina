// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one parser for `MODEL_API_KEYS`. A dependency-free leaf below
 * `shared.ts`, so the MCP transport, the self-model token, `src/model` access
 * and the ops overview read the variable exactly as `/v1` authentication does.
 *
 * Format: comma-separated entries, each `secret` or `secret:name`. Entries and
 * both halves are trimmed; empty entries and entries with an empty secret are
 * dropped. The split is on the FIRST colon (a name never contains one). `name`
 * binds the key to an entity; the reserved name `*` marks a multi-tenant
 * operator key.
 */

export interface ModelApiKeyEntry {
  secret: string;
  /** The bound entity (`secret:name`), absent for a plain or `*` key. */
  entity?: string;
  /** `secret:*`: a multi-tenant operator key that may name-map. */
  multiTenant?: true;
}

/** Parse one `MODEL_API_KEYS`-format string (absent / empty ⇒ no entries). */
export function parseModelApiKeyList(raw: string | undefined): ModelApiKeyEntry[] {
  if (!raw) return [];
  const entries: ModelApiKeyEntry[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const idx = entry.indexOf(":");
    const secret = (idx < 0 ? entry : entry.slice(0, idx)).trim();
    if (!secret) continue;
    const name = idx < 0 ? "" : entry.slice(idx + 1).trim();
    if (!name) entries.push({ secret });
    else if (name === "*") entries.push({ secret, multiTenant: true });
    else entries.push({ secret, entity: name });
  }
  return entries;
}

/** The configured `MODEL_API_KEYS` entries. */
export function parseModelApiKeys(env: NodeJS.ProcessEnv = process.env): ModelApiKeyEntry[] {
  return parseModelApiKeyList(env.MODEL_API_KEYS);
}

/** The configured `MODEL_API_KEYS` secrets, in order (names never included). */
export function modelApiKeySecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseModelApiKeys(env).map((entry) => entry.secret);
}
