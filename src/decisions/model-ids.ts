// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A caller may name the configured model, or that model family's `-latest`
 * alias — what TypeSafe clients send by default (`jev-latest`,
 * `~typesafe/jev-latest`) — so `langchain-typesafe` works unchanged. Any other
 * model is refused rather than silently answered by a different one.
 */
export function acceptsRequestedModel(requested: unknown, configured: string): boolean {
  if (typeof requested !== "string") return false;
  if (requested === configured) return true;
  const bare = (id: string) => id.trim().replace(/^~/, "").split("/").pop() ?? "";
  const family = (id: string) => bare(id).replace(/-(latest|\d[\w.]*)$/, "");
  return bare(requested).endsWith("-latest") && family(requested) === family(configured);
}
