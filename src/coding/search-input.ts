// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { parseModifiers } from "../engine/parse-input";

/** Code commands normally split on whitespace. Only the structured search path
 * needs quoting; the query after `--` stays literal, including colons/quotes. */
export function parseCodeSearchInput(raw: string): { query: string; path?: string } {
  const quoted = /^path:("(?:[^"\\]|\\.)*")\s+--(?:\s+|$)([\s\S]*)$/.exec(raw.trim());
  if (quoted) return { path: JSON.parse(quoted[1]!), query: quoted[2]!.trim() };
  if (raw.trim().startsWith('path:"'))
    throw new Error('Usage: code search path:"relative path" -- <query>');
  const parsed = parseModifiers(raw.trim().split(/\s+/), { path: { type: "string" } });
  if (parsed.errors.length) throw new Error(parsed.errors.join("; "));
  return { query: parsed.rest.join(" "), path: parsed.values.path as string | undefined };
}
