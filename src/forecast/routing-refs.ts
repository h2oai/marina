// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The evidence tags a resolved forecast's outcome carries, read from the
 * routing record on its saved answer (`./card-routing.ts`): one `family:` ref
 * per class in the question's class chain, the `method:` that answered (a
 * method-card id), and `q:<id>` when the asker gave a stable question id, so
 * two methods that answered the same question pair up. A shadow challenger's
 * answer also carries `shadow`, `card:<id>`, `model:<spec>` and, without a
 * question id, `pair:forecast:<live id>` (what it pairs with). The same
 * `family:` / `method:` convention the arena and benchmark producers use. Ids and labels
 * only — never question text. Kept free of runtime imports so the outcome
 * path can read it cheaply.
 */

// `|` joins a binary question's option ids in its group (`group:binary:no|yes`,
// `answerGroup`); without it every yes/no outcome lost its coarsest class tag.
const SAFE = /^[A-Za-z0-9:._/+|-]{1,120}$/;

/**
 * Shadow challengers (`./shadow.ts`): a sampled live forecast's challenger
 * card, filed under this system owner (never a person or resident: an
 * `eval_mode` filing earns no standing) as source `shadow`, one per live
 * answer, settled with the live answer when it resolves.
 */
export const SHADOW_OWNER = "marina:shadow";
export const SHADOW_SOURCE = "shadow";
/** The shadow filing's external id for live answer `liveId`. */
export const shadowExternalId = (liveId: number) => `shadow:forecast:${liveId}`;

interface RoutingLike {
  families?: unknown;
  method?: unknown;
  question?: unknown;
}

interface ShadowLike {
  /** What it pairs with when the asker gave no question id (the live answer's subject). */
  pair?: unknown;
  card?: unknown;
  models?: unknown;
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
  let a:
    | { routing?: RoutingLike; typed?: { routing?: RoutingLike }; shadow?: ShadowLike }
    | undefined;
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
  // A shadow challenger: marked, paired with its live answer, its card and models named.
  const sh = a?.shadow;
  if (sh && typeof sh === "object") {
    refs.push("shadow");
    if (typeof sh.pair === "string" && SAFE.test(sh.pair) && !refs.some((x) => x.startsWith("q:")))
      refs.push(`pair:${sh.pair}`);
    if (typeof sh.card === "string" && SAFE.test(sh.card)) refs.push(`card:${sh.card}`);
    if (Array.isArray(sh.models)) {
      for (const m of sh.models.slice(0, 4))
        if (typeof m === "string" && SAFE.test(m)) refs.push(`model:${m}`);
    }
  }
  return refs;
}
