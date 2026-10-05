// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One place that turns operator configuration into an `EmbeddingProvider`.
 * Shared by the standalone `scripts/memory.ts serve --embeddings ...` CLI and
 * the world server (`MARINA_MEMORY_EMBEDDINGS=...`), so both construct the
 * provider identically. Off (`none`) by default: retrieval stays lexical and
 * `mode:"hybrid"` remains an explicit caller request.
 */
import { dailyCapRefusal, recordSpend } from "../engine/spend-ledger";
import {
  type EmbeddingProvider,
  embedMany,
  ollamaEmbeddings,
  openAIEmbeddings,
} from "./embeddings";
import { localEmbeddings } from "./local-embeddings";
import { MemoryError } from "./service-types";

export const EMBEDDING_KINDS = ["none", "local", "ollama", "openai"] as const;
export type EmbeddingKind = (typeof EMBEDDING_KINDS)[number];

export type EmbeddingConfig =
  | { kind: "none" }
  | { kind: "local"; cacheDirectory: string; localOnly: boolean }
  | { kind: "ollama"; url: string; model: string; revision: string }
  | {
      kind: "openai";
      url: string;
      model: string;
      revision: string;
      apiKey?: string;
      dimensions?: number;
    };

/** Must equal the id the extension constructs; verified when the provider loads. */
export const LOCAL_EMBEDDING_PROVIDER_ID =
  "Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9:onnx1.27-tokenizers0.2-q8-mean-chunks500-v2";

/** The variables one embedding configuration reads (memory and corpora each have their own). */
export interface EmbeddingEnvNames {
  kind: string;
  model: string;
  url: string;
  revision: string;
  cache: string;
  localOnly: string;
  apiKey: string;
  dimensions: string;
}

/** Durable memory (`MemoryService`). */
export const EMBEDDING_ENV = {
  kind: "MARINA_MEMORY_EMBEDDINGS",
  model: "MARINA_MEMORY_EMBEDDING_MODEL",
  url: "MARINA_MEMORY_EMBEDDING_URL",
  revision: "MARINA_MEMORY_EMBEDDING_REVISION",
  cache: "MARINA_MEMORY_EMBEDDING_CACHE",
  localOnly: "MARINA_MEMORY_EMBEDDING_LOCAL_ONLY",
  apiKey: "MARINA_MEMORY_EMBEDDING_API_KEY",
  dimensions: "MARINA_MEMORY_EMBEDDING_DIMENSIONS",
} as const satisfies EmbeddingEnvNames;

/** Local corpora (`src/engine/search-providers/corpus.ts`): query embeddings for hybrid search. */
export const CORPUS_EMBEDDING_ENV = {
  kind: "MARINA_CORPUS_EMBEDDINGS",
  model: "MARINA_CORPUS_EMBEDDING_MODEL",
  url: "MARINA_CORPUS_EMBEDDING_URL",
  revision: "MARINA_CORPUS_EMBEDDING_REVISION",
  cache: "MARINA_CORPUS_EMBEDDING_CACHE",
  localOnly: "MARINA_CORPUS_EMBEDDING_LOCAL_ONLY",
  apiKey: "MARINA_CORPUS_EMBEDDING_API_KEY",
  dimensions: "MARINA_CORPUS_EMBEDDING_DIMENSIONS",
} as const satisfies EmbeddingEnvNames;

const DEFAULT_MODEL_CACHE = "data/memory-models";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

type Env = Record<string, string | undefined>;
const read = (env: Env, key: string) => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

/** Parse (never construct) the configuration. Throws on invalid values so a
 *  typo in `MARINA_MEMORY_EMBEDDINGS` is loud rather than silently lexical. */
export function parseEmbeddingEnv(
  env: Env = process.env,
  names: EmbeddingEnvNames = EMBEDDING_ENV,
): EmbeddingConfig {
  const kind = (read(env, names.kind) ?? "none").toLowerCase();
  if (!(EMBEDDING_KINDS as readonly string[]).includes(kind))
    throw new Error(`${names.kind} must be one of ${EMBEDDING_KINDS.join(", ")} (got "${kind}")`);
  if (kind === "none") return { kind: "none" };
  if (kind === "local") {
    const localOnly = (read(env, names.localOnly) ?? "false").toLowerCase();
    if (!["true", "false", "1", "0"].includes(localOnly))
      throw new Error(`${names.localOnly} must be true or false`);
    return {
      kind: "local",
      cacheDirectory: read(env, names.cache) ?? DEFAULT_MODEL_CACHE,
      localOnly: localOnly === "true" || localOnly === "1",
    };
  }
  const model = read(env, names.model);
  const revision = read(env, names.revision);
  if (!model || !revision)
    throw new Error(
      `${names.kind}=${kind} requires ${names.model} and ${names.revision} (an immutable model revision)`,
    );
  if (kind === "ollama")
    return { kind: "ollama", url: read(env, names.url) ?? DEFAULT_OLLAMA_URL, model, revision };
  // openai: any OpenAI-compatible /v1/embeddings the operator names — no default vendor.
  const url = read(env, names.url);
  if (!url)
    throw new Error(
      `${names.kind}=openai requires ${names.url} (an OpenAI-compatible base URL ending in /v1)`,
    );
  const rawDimensions = read(env, names.dimensions);
  const dimensions = rawDimensions === undefined ? undefined : Number(rawDimensions);
  if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1))
    throw new Error(`${names.dimensions} must be a positive integer`);
  const apiKey = read(env, names.apiKey) ?? vendorEmbeddingKey(url, env);
  return {
    kind: "openai",
    url,
    model,
    revision,
    ...(apiKey ? { apiKey } : {}),
    ...(dimensions ? { dimensions } : {}),
  };
}

/** A vendor key only ever goes to that vendor's own host. */
function vendorEmbeddingKey(url: string, env: Env): string | undefined {
  if (/^https:\/\/openrouter\.ai\//.test(url)) return read(env, "OPENROUTER_API_KEY");
  if (/^https:\/\/api\.openai\.com\//.test(url)) return read(env, "OPENAI_API_KEY");
  return undefined;
}

/** Construct the provider for a parsed configuration. `none` → undefined. */
export async function embeddingProviderFromConfig(
  config: EmbeddingConfig,
): Promise<EmbeddingProvider | undefined> {
  if (config.kind === "none") return undefined;
  if (config.kind === "ollama") return ollamaEmbeddings(config.url, config.model, config.revision);
  if (config.kind === "openai")
    return openAIEmbeddings({
      baseUrl: config.url,
      model: config.model,
      revision: config.revision,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.dimensions ? { dimensions: config.dimensions } : {}),
      // A paid embedding is a retrieval call: the daily cap refuses it, and the
      // cost the provider reports joins the ledger as `search`.
      refuse: () => dailyCapRefusal(),
      onCost: (usd) => recordSpend("search", usd),
    });
  try {
    return await localEmbeddings(config.cacheDirectory, config.localOnly);
  } catch (error) {
    throw new Error(
      `Local embeddings are unavailable (${
        error instanceof Error ? error.message : String(error)
      }). Install the optional extension from the repository root: ` +
        "bun install --cwd extensions/local-embeddings --frozen-lockfile — " +
        `or set ${EMBEDDING_ENV.kind}=none.`,
    );
  }
}

/** The provider id is known before the (async, optional) extension loads.
 *  Callers that need a synchronous `MemoryService` — the world server —
 *  wrap the load so the first `embed` awaits it; a load failure surfaces as
 *  `embedding_unavailable` on every call instead of a silent lexical fallback. */
export function lazyEmbeddingProvider(
  id: string,
  load: () => Promise<EmbeddingProvider | undefined>,
): EmbeddingProvider {
  let pending: Promise<EmbeddingProvider> | undefined;
  const resolve = () =>
    (pending ??= load().then((provider) => {
      if (!provider) throw new Error("No embedding provider was constructed");
      if (provider.id !== id)
        throw new Error(`Embedding provider id mismatch: expected ${id}, loaded ${provider.id}`);
      return provider;
    }));
  const loaded = async () => {
    try {
      return await resolve();
    } catch (error) {
      pending = undefined;
      throw new MemoryError(
        503,
        "embedding_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return {
    id,
    async embed(text, signal) {
      return (await loaded()).embed(text, signal);
    },
    async embedBatch(texts, signal) {
      return embedMany(await loaded(), texts, signal);
    },
  };
}

/** Synchronous id for a configuration, so the lazy wrapper can be built. */
export function embeddingProviderId(config: EmbeddingConfig): string | undefined {
  if (config.kind === "none") return undefined;
  if (config.kind === "local") return LOCAL_EMBEDDING_PROVIDER_ID;
  if (config.kind === "openai")
    return `openai:${config.model}@${config.revision}${config.dimensions ? `:d${config.dimensions}` : ""}:raw-v1`;
  return `ollama:${config.model}@${config.revision}:raw-v1`;
}
