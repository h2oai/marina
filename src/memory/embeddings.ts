// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { MemoryError } from "./service-types";

export interface EmbeddingProvider {
  /** Include the immutable model revision and preprocessing version. */
  id: string;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  /** Several texts in one request, in order (bulk indexing). Absent ⇒ callers loop over `embed`. */
  embedBatch?(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

/** Embed many texts with `embedBatch` when the provider has it, else one at a time. */
export async function embedMany(
  provider: EmbeddingProvider,
  texts: readonly string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  if (provider.embedBatch) return provider.embedBatch(texts, signal);
  const out: number[][] = [];
  for (const text of texts) out.push(await provider.embed(text, signal));
  return out;
}

export interface OpenAIEmbeddingOptions {
  /** Base URL up to and including `/v1` (e.g. https://openrouter.ai/api/v1, http://127.0.0.1:8080/v1). */
  baseUrl: string;
  model: string;
  /** Operator-declared immutable revision; part of the provider id that keys stored vectors. */
  revision: string;
  apiKey?: string;
  /** Matryoshka truncation requested from the server (`dimensions`), when the model supports it. */
  dimensions?: number;
  timeoutMs?: number;
  /** Called with each response's reported USD cost (OpenRouter reports `usage.cost`). */
  onCost?: (usd: number) => void;
  /** Called before each request; a string refuses it (e.g. the daily spend cap). */
  refuse?: () => string | undefined;
  fetch?: typeof fetch;
}

/**
 * Any OpenAI-compatible `POST {baseUrl}/embeddings` — the operator's existing
 * provider (OpenAI, OpenRouter, a local llama.cpp / vLLM / TEI server). No
 * vendor is assumed; the URL, model and key are operator configuration.
 */
export function openAIEmbeddings(opts: OpenAIEmbeddingOptions): EmbeddingProvider {
  const base = new URL(opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    throw new Error("Invalid embedding server URL");
  if (!opts.model || !opts.revision)
    throw new Error("An embedding model and immutable revision are required");
  const doFetch = opts.fetch ?? fetch;
  const embedBatch = async (texts: readonly string[], signal?: AbortSignal) => {
    if (texts.length === 0) return [];
    const refused = opts.refuse?.();
    if (refused) throw new MemoryError(429, "embedding_unavailable", refused);
    const response = await doFetch(new URL("embeddings", base), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        input: texts,
        ...(opts.dimensions ? { dimensions: opts.dimensions } : {}),
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        ...(signal ? [signal] : []),
      ]),
      redirect: "error",
    });
    if (!response.ok)
      throw new MemoryError(
        503,
        "embedding_unavailable",
        `Embedding provider failed (${response.status})`,
      );
    const data = (await response.json()) as {
      data?: { embedding?: unknown; index?: number }[];
      usage?: { cost?: unknown };
    };
    const rows = Array.isArray(data.data) ? [...data.data] : [];
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = rows.map((row) => row.embedding);
    if (vectors.length !== texts.length || !vectors.every(validEmbedding))
      throw new MemoryError(
        502,
        "invalid_embedding",
        "Embedding provider returned an invalid vector",
      );
    const cost = Number(data.usage?.cost);
    if (Number.isFinite(cost) && cost > 0) opts.onCost?.(cost);
    return vectors as number[][];
  };
  return {
    id: `openai:${opts.model}@${opts.revision}${opts.dimensions ? `:d${opts.dimensions}` : ""}:raw-v1`,
    async embed(text, signal) {
      const [vector] = await embedBatch([text], signal);
      return vector!;
    },
    embedBatch,
  };
}

export function validEmbedding(vector: unknown): vector is number[] {
  return (
    Array.isArray(vector) &&
    vector.length > 0 &&
    vector.length <= 8192 &&
    vector.every((x) => typeof x === "number" && Number.isFinite(x)) &&
    vector.some((x) => x !== 0)
  );
}

/** Configured by the operator, never a URL supplied by a memory API caller.
 * Ollama /api/embed contract: https://docs.ollama.com/api/embed */
export function ollamaEmbeddings(
  baseUrl: string,
  model: string,
  revision: string,
): EmbeddingProvider {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    throw new Error("Invalid embedding server URL");
  if (!model || !revision)
    throw new Error("An embedding model and immutable revision are required");
  return {
    id: `ollama:${model}@${revision}:raw-v1`,
    async embed(text, signal) {
      const response = await fetch(new URL("/api/embed", base), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text, truncate: false }),
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
        redirect: "error",
      });
      if (!response.ok)
        throw new MemoryError(503, "embedding_unavailable", "Embedding provider failed");
      const data = (await response.json()) as { embeddings?: unknown[] };
      const vector = data.embeddings?.[0];
      if (!validEmbedding(vector))
        throw new MemoryError(
          502,
          "invalid_embedding",
          "Embedding provider returned an invalid vector",
        );
      return vector;
    },
  };
}

export function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length)
    throw new MemoryError(503, "embedding_dimension_mismatch", "Query and index dimensions differ");
  // Scale first: finite provider values can still overflow/underflow when
  // squared, silently turning a valid direction into NaN and an empty result.
  const scaleLeft = Math.max(...left.map(Math.abs));
  const scaleRight = Math.max(...right.map(Math.abs));
  if (!Number.isFinite(scaleLeft) || !Number.isFinite(scaleRight) || !scaleLeft || !scaleRight)
    throw new MemoryError(503, "invalid_embedding", "Embedding has no finite nonzero direction");
  let dot = 0,
    a = 0,
    b = 0;
  for (let i = 0; i < left.length; i++) {
    const x = left[i]! / scaleLeft;
    const y = right[i]! / scaleRight;
    dot += x * y;
    a += x * x;
    b += y * y;
  }
  return dot / Math.sqrt(a * b);
}
