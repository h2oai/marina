// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The evidence tags a resolved forecast's outcome carries, read from the
 * routing record on its saved answer (`./card-routing.ts`): one `family:` ref
 * per class in the question's class chain, the `method:` that answered (a
 * method-card id), and `q:<id>` when the asker gave a stable question id, so
 * two methods that answered the same question pair up. The same `family:` /
 * `method:` convention the arena and benchmark producers use. Ids and labels
 * only — never question text. Kept free of runtime imports so the outcome
 * path can read it cheaply.
 */

const SAFE = /^[A-Za-z0-9:._/+-]{1,120}$/;

interface RoutingLike {
  families?: unknown;
  method?: unknown;
  question?: unknown;
}

/** An outcome row's refs (`refs_json`), tolerantly. */
export function outcomeRefs(refsJson: string | null | undefined): string[] {
  if (!refsJson) return [];
  try {
    const r = JSON.parse(refsJson);
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Refs for a saved answer's JSON (a typed answer, or a plain answer keeping its typed run). */
export function routingRefs(answerJson: string | null | undefined): string[] {
  if (!answerJson) return [];
  let a: { routing?: RoutingLike; typed?: { routing?: RoutingLike } } | undefined;
  try {
    a = JSON.parse(answerJson);
  } catch {
    return [];
  }
  const r = a?.routing ?? a?.typed?.routing;
  if (!r || typeof r !== "object") return [];
  const refs: string[] = [];
  if (Array.isArray(r.families)) {
    for (const f of r.families.slice(0, 8))
      if (typeof f === "string" && SAFE.test(f)) refs.push(`family:${f}`);
  }
  if (typeof r.method === "string" && SAFE.test(r.method)) refs.push(`method:${r.method}`);
  if (typeof r.question === "string" && SAFE.test(r.question)) refs.push(`q:${r.question}`);
  return refs;
}
