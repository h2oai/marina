// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * First-move retrieval for hard multi-constraint questions: decompose the
 * question into atomic clues (one model call), search each clue deeply, fuse
 * the rankings, and rerank the union with any model Marina serves (a listwise
 * LLM reranker — no hosted cross-encoder needed), keeping the top k as the
 * opening context. Engine-agnostic: the caller supplies `search` (a local
 * corpus, the web chain, anything that returns ids with text).
 *
 * Every model step fails open: no clues ⇒ the question itself is the only
 * query; a reranker that fails or answers junk ⇒ the fused order stands. The
 * result records which happened.
 */

export interface Candidate {
  id: string;
  title?: string;
  text: string;
}

export interface FirstMoveModel {
  name?: string;
  complete: (system: string, user: string) => Promise<string>;
}

export interface FirstMoveOptions {
  /** Searches one query; returns ranked candidates (best first). */
  search: (query: string, depth: number) => Promise<Candidate[]>;
  /** Decomposes the question (none ⇒ the question is the only query). */
  decomposer?: FirstMoveModel;
  /** Reranks the fused candidates (none ⇒ the fused order). */
  reranker?: FirstMoveModel;
  /** Results per clue (default 100). */
  depth?: number;
  /** Fused candidates shown to the reranker (default 30). */
  rerankPool?: number;
  /** Characters of each candidate shown to the reranker (default 500). */
  rerankChars?: number;
  /** Candidates returned (default 5). */
  k?: number;
}

export interface FirstMove {
  clues: string[];
  candidates: Candidate[];
  /** How the order was decided. */
  order: "reranked" | "fused";
  error?: string;
}

const MAX_CLUES = 12;

const DECOMPOSE_SYSTEM = [
  "Break the question into its atomic clues: each one a short, independently searchable fact or constraint (a name, a date, a place, a description, a relation).",
  'Reply with ONE JSON object: {"clues": ["<short search query>", …]} — at most 12, most distinctive first. Do not answer the question.',
].join(" ");

const RERANK_SYSTEM = [
  "You rank documents by how useful each is for answering the question: documents that satisfy several of its clues, or name the answer, first.",
  'Reply with ONE JSON object: {"ranking": ["<id>", …]} listing the ids of the useful documents, best first. Leave out documents that do not help.',
].join(" ");

/** The first JSON object in a model reply, else undefined. */
function jsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic clues for a question (empty when the model fails or answers junk). */
export async function decomposeQuestion(
  question: string,
  model: FirstMoveModel,
): Promise<string[]> {
  try {
    const reply = jsonObject(await model.complete(DECOMPOSE_SYSTEM, `Question: ${question}`));
    const clues = Array.isArray(reply?.clues) ? reply.clues : [];
    return [
      ...new Set(
        clues
          .filter((c): c is string => typeof c === "string" && c.trim().length > 1)
          .map((c) => c.trim().slice(0, 200)),
      ),
    ].slice(0, MAX_CLUES);
  } catch {
    return [];
  }
}

/**
 * Reciprocal-rank fusion of several rankings (k = 60, the usual constant);
 * a candidate keeps the first text seen for it.
 */
export function fuseRankings(rankings: Candidate[][]): Candidate[] {
  const score = new Map<string, { c: Candidate; s: number }>();
  for (const list of rankings) {
    list.forEach((c, rank) => {
      const had = score.get(c.id);
      const add = 1 / (60 + rank + 1);
      if (had) had.s += add;
      else score.set(c.id, { c, s: add });
    });
  }
  return [...score.values()].sort((a, b) => b.s - a.s).map((x) => x.c);
}

/**
 * Listwise reranking by a model: the candidates it names come first in its
 * order; the rest keep their fused order after them. Junk ids are ignored.
 */
export async function llmRerank(
  question: string,
  candidates: Candidate[],
  model: FirstMoveModel,
  chars = 500,
): Promise<{ ranked: Candidate[]; ok: boolean; error?: string }> {
  if (candidates.length <= 1) return { ranked: candidates, ok: true };
  const listing = candidates
    .map(
      (c) =>
        `[${c.id}]${c.title ? ` ${c.title.replace(/\s+/g, " ").slice(0, 120)} —` : ""} ${c.text.replace(/\s+/g, " ").slice(0, chars)}`,
    )
    .join("\n");
  try {
    const reply = jsonObject(
      await model.complete(RERANK_SYSTEM, `Question: ${question}\n\nDocuments:\n${listing}`),
    );
    const ids = Array.isArray(reply?.ranking) ? reply.ranking.map(String) : [];
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const picked: Candidate[] = [];
    for (const id of ids) {
      const c = byId.get(id.replace(/^\[|\]$/g, ""));
      if (c && !picked.includes(c)) picked.push(c);
    }
    if (picked.length === 0) return { ranked: candidates, ok: false, error: "no usable ranking" };
    return { ranked: [...picked, ...candidates.filter((c) => !picked.includes(c))], ok: true };
  } catch (err) {
    return {
      ranked: candidates,
      ok: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    };
  }
}

/** Decompose → search each clue → fuse → rerank → top k (see the module comment). */
export async function firstMove(question: string, opts: FirstMoveOptions): Promise<FirstMove> {
  const depth = opts.depth ?? 100;
  const k = opts.k ?? 5;
  const clues = opts.decomposer ? await decomposeQuestion(question, opts.decomposer) : [];
  // The question itself always searches too: a clue list never loses its baseline.
  const queries = [question, ...clues];
  const rankings = await Promise.all(queries.map((q) => opts.search(q, depth).catch(() => [])));
  const fused = fuseRankings(rankings);
  if (!opts.reranker) return { clues, candidates: fused.slice(0, k), order: "fused" };
  const pool = fused.slice(0, opts.rerankPool ?? 30);
  const r = await llmRerank(question, pool, opts.reranker, opts.rerankChars ?? 500);
  return {
    clues,
    candidates: [...r.ranked, ...fused.slice(pool.length)].slice(0, k),
    order: r.ok ? "reranked" : "fused",
    ...(r.error ? { error: r.error } : {}),
  };
}
