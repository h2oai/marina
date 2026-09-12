// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { MemoryError } from "./service-types";

export interface EmbeddingProvider {
  /** Include the immutable model revision and preprocessing version. */
  id: string;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
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
