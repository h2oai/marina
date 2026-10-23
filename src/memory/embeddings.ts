// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "../engine/logger";
import { MemoryError } from "./service-types";

const logger = new Logger();

/**
 * Which side of a retrieval a text is on. Asymmetric embedders (E5, BGE,
 * Qwen3-Embedding, Nemotron) are trained with a different prefix or
 * `input_type` for searches and for the documents searched; a provider with
 * no such configuration embeds both the same way.
 */
export type EmbeddingRole = "query" | "document";

export interface EmbeddingProvider {
  /** Include the immutable model revision and preprocessing version. */
  id: string;
  /** `role` defaults to `document` (what stored vectors are made from). */
  embed(text: string, signal?: AbortSignal, role?: EmbeddingRole): Promise<number[]>;
  /** Several texts in one request, in order (bulk indexing). Absent ⇒ callers loop over `embed`. */
  embedBatch?(
    texts: readonly string[],
    signal?: AbortSignal,
    role?: EmbeddingRole,
  ): Promise<number[][]>;
  /**
   * The most (estimated) tokens one input may carry; longer inputs are cut to
   * it before they are sent (`truncateEmbeddingInput`). Absent ⇒ no limit
   * (the provider chunks itself, e.g. the local MiniLM extension).
   */
  maxInputTokens?: number;
}

/** Default per-input cap for remote embedders (`MARINA_MEMORY_EMBEDDING_MAX_TOKENS`). */
export const DEFAULT_EMBEDDING_MAX_INPUT_TOKENS = 8192;
/**
 * UTF-8 bytes per token assumed when no tokenizer is at hand. BPE tokenizers
 * average ~4 bytes per token on English prose and ~3 on code, markup and JSON;
 * 3 keeps an estimate at or above the real count for most text. A provider
 * that still finds an input too long gets it once more at half the length.
 */
export const EMBEDDING_BYTES_PER_TOKEN = 3;

const encoder = new TextEncoder();

/** Estimated tokens in `text` (UTF-8 bytes / `EMBEDDING_BYTES_PER_TOKEN`, rounded up). */
export function estimateEmbeddingTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / EMBEDDING_BYTES_PER_TOKEN);
}

export interface EmbeddingInput {
  text: string;
  truncated: boolean;
  /** Estimated tokens of the original input. */
  estimatedTokens: number;
}

/**
 * Cut `text` to at most `maxTokens` estimated tokens (the head is kept; a
 * character is never split). Within the limit the text is returned unchanged.
 */
export function truncateEmbeddingInput(
  text: string,
  maxTokens: number | undefined,
): EmbeddingInput {
  const bytes = encoder.encode(text);
  const estimatedTokens = Math.ceil(bytes.length / EMBEDDING_BYTES_PER_TOKEN);
  if (!maxTokens || maxTokens <= 0 || estimatedTokens <= maxTokens)
    return { text, truncated: false, estimatedTokens };
  return {
    text: headUtf8(bytes, Math.floor(maxTokens * EMBEDDING_BYTES_PER_TOKEN)),
    truncated: true,
    estimatedTokens,
  };
}

/** The longest prefix of `bytes` within `max` bytes that ends on a character boundary. */
function headUtf8(bytes: Uint8Array, max: number): string {
  let end = Math.min(max, bytes.length);
  // A UTF-8 continuation byte is 10xxxxxx: back up to the start of its character.
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** An upstream rejection that says the input is too long for the model's context. */
const TOO_LONG = /token|context|too long|too large|maximum|length/i;

/** Embed many texts with `embedBatch` when the provider has it, else one at a time. */
export async function embedMany(
  provider: EmbeddingProvider,
  texts: readonly string[],
  signal?: AbortSignal,
  role?: EmbeddingRole,
): Promise<number[][]> {
  if (provider.embedBatch) return provider.embedBatch(texts, signal, role);
  const out: number[][] = [];
  for (const text of texts) out.push(await provider.embed(text, signal, role));
  return out;
}

/**
 * Per-role input preparation for an asymmetric embedder. Prefixes are
 * prepended verbatim (`"query: "`, an instruct line); `inputType` sends the
 * server's `input_type` field (NVIDIA `query`/`passage`, Cohere
 * `search_query`/`search_document`, Voyage `query`/`document`).
 */
export interface EmbeddingPreprocessing {
  queryPrefix?: string;
  documentPrefix?: string;
  inputType?: { query: string; document: string };
}

/**
 * The preprocessing part of a provider id. Only the document side changes the
 * vectors that are stored, so only it changes the id: no document prefix and
 * no input type ⇒ `raw-v1`, exactly the id before roles existed, and a new
 * query prefix never invalidates an index.
 */
export function embeddingPreprocessingTag(p: EmbeddingPreprocessing = {}): string {
  if (!p.documentPrefix && !p.inputType) return "raw-v1";
  const hash = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([p.documentPrefix ?? "", p.inputType?.document ?? ""]))
    .digest("hex")
    .slice(0, 12);
  return `doc-${hash}-v1`;
}

function rolePrefix(p: EmbeddingPreprocessing, role: EmbeddingRole): string {
  return (role === "query" ? p.queryPrefix : p.documentPrefix) ?? "";
}

export interface OpenAIEmbeddingOptions extends EmbeddingPreprocessing {
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
  /** Per-input cap in estimated tokens (default `DEFAULT_EMBEDDING_MAX_INPUT_TOKENS`; 0 = none). */
  maxInputTokens?: number;
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
  const maxInputTokens = opts.maxInputTokens ?? DEFAULT_EMBEDDING_MAX_INPUT_TOKENS;
  const embedBatch = async (
    texts: readonly string[],
    signal?: AbortSignal,
    role: EmbeddingRole = "document",
  ) => {
    if (texts.length === 0) return [];
    // The cap applies to the content; the prefix is added after the cut so it is never lost.
    const prefix = rolePrefix(opts, role);
    const inputs = texts.map((text) => truncateEmbeddingInput(text, maxInputTokens));
    const cut = inputs.filter((input) => input.truncated).length;
    if (cut > 0)
      logger.info("memory", "embedding inputs truncated", {
        inputs: cut,
        maxInputTokens,
        largestEstimatedTokens: Math.max(...inputs.map((input) => input.estimatedTokens)),
      });
    try {
      return await request(
        inputs.map((input) => prefix + input.text),
        signal,
        role,
      );
    } catch (error) {
      if (!(error instanceof TooLong)) throw error;
      // The estimate was short for this tokenizer: once more at half the length, labelled.
      const halved = inputs.map(
        (input) =>
          prefix +
          truncateEmbeddingInput(input.text, Math.floor(estimateEmbeddingTokens(input.text) / 2))
            .text,
      );
      logger.warn("memory", "embedding input over the provider's limit; retrying at half length", {
        inputs: halved.length,
        maxInputTokens,
      });
      return request(halved, signal, role);
    }
  };
  const request = async (
    texts: readonly string[],
    signal: AbortSignal | undefined,
    role: EmbeddingRole,
  ) => {
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
        ...(opts.inputType ? { input_type: opts.inputType[role] } : {}),
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        ...(signal ? [signal] : []),
      ]),
      redirect: "error",
    });
    if (!response.ok) {
      const detail =
        response.status === 400 || response.status === 413
          ? // allow-empty-catch: the error body is optional detail; the status is reported regardless
            await response.text().catch(() => "")
          : "";
      if (TOO_LONG.test(detail)) throw new TooLong(response.status);
      throw new MemoryError(
        503,
        "embedding_unavailable",
        `Embedding provider failed (${response.status})`,
      );
    }
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
    id: `openai:${opts.model}@${opts.revision}${opts.dimensions ? `:d${opts.dimensions}` : ""}:${embeddingPreprocessingTag(opts)}`,
    async embed(text, signal, role) {
      const [vector] = await embedBatch([text], signal, role);
      return vector!;
    },
    embedBatch,
    ...(maxInputTokens > 0 ? { maxInputTokens } : {}),
  };
}

/** The provider rejected an input as longer than its context (retried once at half length). */
class TooLong extends MemoryError {
  constructor(status: number) {
    super(503, "embedding_unavailable", `Embedding provider failed (${status}): input too long`);
  }
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
  maxInputTokens = DEFAULT_EMBEDDING_MAX_INPUT_TOKENS,
  preprocessing: Omit<EmbeddingPreprocessing, "inputType"> = {},
): EmbeddingProvider {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    throw new Error("Invalid embedding server URL");
  if (!model || !revision)
    throw new Error("An embedding model and immutable revision are required");
  return {
    id: `ollama:${model}@${revision}:${embeddingPreprocessingTag(preprocessing)}`,
    ...(maxInputTokens > 0 ? { maxInputTokens } : {}),
    async embed(text, signal, role = "document") {
      const response = await fetch(new URL("/api/embed", base), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input:
            rolePrefix(preprocessing, role) + truncateEmbeddingInput(text, maxInputTokens).text,
          truncate: false,
        }),
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
