// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One place that turns operator configuration into an `EmbeddingProvider`.
 * Shared by the standalone `scripts/memory.ts serve --embeddings ...` CLI and
 * the world server (`MARINA_MEMORY_EMBEDDINGS=...`), so both construct the
 * provider identically. Off (`none`) by default: retrieval stays lexical and
 * `mode:"hybrid"` remains an explicit caller request.
 */
import { type EmbeddingProvider, ollamaEmbeddings } from "./embeddings";
import { localEmbeddings } from "./local-embeddings";
import { MemoryError } from "./service-types";

export const EMBEDDING_KINDS = ["none", "local", "ollama"] as const;
export type EmbeddingKind = (typeof EMBEDDING_KINDS)[number];

export type EmbeddingConfig =
  | { kind: "none" }
  | { kind: "local"; cacheDirectory: string; localOnly: boolean }
  | { kind: "ollama"; url: string; model: string; revision: string };

/** Must equal the id the extension constructs; verified when the provider loads. */
export const LOCAL_EMBEDDING_PROVIDER_ID =
  "Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9:onnx1.27-tokenizers0.2-q8-mean-chunks500-v2";

export const EMBEDDING_ENV = {
  kind: "MARINA_MEMORY_EMBEDDINGS",
  model: "MARINA_MEMORY_EMBEDDING_MODEL",
  url: "MARINA_MEMORY_EMBEDDING_URL",
  revision: "MARINA_MEMORY_EMBEDDING_REVISION",
  cache: "MARINA_MEMORY_EMBEDDING_CACHE",
  localOnly: "MARINA_MEMORY_EMBEDDING_LOCAL_ONLY",
} as const;

const DEFAULT_MODEL_CACHE = "data/memory-models";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

type Env = Record<string, string | undefined>;
const read = (env: Env, key: string) => {
  const value = env[key]?.trim();
  return value ? value : undefined;
};

/** Parse (never construct) the configuration. Throws on invalid values so a
 *  typo in `MARINA_MEMORY_EMBEDDINGS` is loud rather than silently lexical. */
export function parseEmbeddingEnv(env: Env = process.env): EmbeddingConfig {
  const kind = (read(env, EMBEDDING_ENV.kind) ?? "none").toLowerCase();
  if (!(EMBEDDING_KINDS as readonly string[]).includes(kind))
    throw new Error(
      `${EMBEDDING_ENV.kind} must be one of ${EMBEDDING_KINDS.join(", ")} (got "${kind}")`,
    );
  if (kind === "none") return { kind: "none" };
  if (kind === "local") {
    const localOnly = (read(env, EMBEDDING_ENV.localOnly) ?? "false").toLowerCase();
    if (!["true", "false", "1", "0"].includes(localOnly))
      throw new Error(`${EMBEDDING_ENV.localOnly} must be true or false`);
    return {
      kind: "local",
      cacheDirectory: read(env, EMBEDDING_ENV.cache) ?? DEFAULT_MODEL_CACHE,
      localOnly: localOnly === "true" || localOnly === "1",
    };
  }
  const model = read(env, EMBEDDING_ENV.model);
  const revision = read(env, EMBEDDING_ENV.revision);
  if (!model || !revision)
    throw new Error(
      `${EMBEDDING_ENV.kind}=ollama requires ${EMBEDDING_ENV.model} and ${EMBEDDING_ENV.revision} (an immutable model revision)`,
    );
  return {
    kind: "ollama",
    url: read(env, EMBEDDING_ENV.url) ?? DEFAULT_OLLAMA_URL,
    model,
    revision,
  };
}

/** Construct the provider for a parsed configuration. `none` → undefined. */
export async function embeddingProviderFromConfig(
  config: EmbeddingConfig,
): Promise<EmbeddingProvider | undefined> {
  if (config.kind === "none") return undefined;
  if (config.kind === "ollama") return ollamaEmbeddings(config.url, config.model, config.revision);
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
  return {
    id,
    async embed(text, signal) {
      let provider: EmbeddingProvider;
      try {
        provider = await resolve();
      } catch (error) {
        pending = undefined;
        throw new MemoryError(
          503,
          "embedding_unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
      return provider.embed(text, signal);
    },
  };
}

/** Synchronous id for a configuration, so the lazy wrapper can be built. */
export function embeddingProviderId(config: EmbeddingConfig): string | undefined {
  if (config.kind === "none") return undefined;
  if (config.kind === "local") return LOCAL_EMBEDDING_PROVIDER_ID;
  return `ollama:${config.model}@${config.revision}:raw-v1`;
}
