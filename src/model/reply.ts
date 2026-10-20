// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** One-shot `(system, user) → text`, the shape every library pipeline calls a model through. */
export type Complete = (system: string, user: string) => Promise<string>;

/** The first JSON object in a reply (tolerates code fences and prose around it). */
export function parseReply(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
