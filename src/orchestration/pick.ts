// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON pick contract a checker model answers with when it chooses ONE of
 * several whole drafts: `{"pick": <1-based index>, "reason": "…"}`. Shared by
 * the passthru ensemble (`src/net/model-api/ensemble.ts`) and the free-text
 * pattern protocols (`src/orchestration/text-patterns.ts`). Pure, no imports.
 */

/** The checker's pick (0-based) when it names a draft in 1..n; undefined otherwise. */
export function parsePick(text: string, n: number): { index: number; reason: string } | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as { pick?: unknown; reason?: unknown };
    const pick = typeof j.pick === "string" ? Number(j.pick) : j.pick;
    if (typeof pick !== "number" || !Number.isInteger(pick) || pick < 1 || pick > n)
      return undefined;
    return { index: pick - 1, reason: typeof j.reason === "string" ? j.reason.trim() : "" };
  } catch {
    return undefined;
  }
}
