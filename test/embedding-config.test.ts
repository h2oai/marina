// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_EMBEDDING_ENV,
  EMBEDDING_ENV,
  embeddingMaxInputTokens,
  embeddingProviderFromConfig,
  embeddingProviderId,
  LOCAL_EMBEDDING_PROVIDER_ID,
  lazyEmbeddingProvider,
  parseEmbeddingEnv,
} from "../src/memory/embedding-config";
import {
  DEFAULT_EMBEDDING_MAX_INPUT_TOKENS,
  estimateEmbeddingTokens,
  ollamaEmbeddings,
  openAIEmbeddings,
  truncateEmbeddingInput,
} from "../src/memory/embeddings";
import { MemoryError } from "../src/memory/service-types";
import { worldEmbeddingProvider, worldMemoryService } from "../src/memory/world-service";
import { MarinaDB } from "../src/persistence/database";

describe("parseEmbeddingEnv", () => {
  it("defaults to none when unset or blank", () => {
    expect(parseEmbeddingEnv({})).toEqual({ kind: "none" });
    expect(parseEmbeddingEnv({ [EMBEDDING_ENV.kind]: "  " })).toEqual({ kind: "none" });
    expect(parseEmbeddingEnv({ [EMBEDDING_ENV.kind]: "none" })).toEqual({ kind: "none" });
  });

  it("parses local with defaults and overrides, case-insensitively", () => {
    expect(parseEmbeddingEnv({ [EMBEDDING_ENV.kind]: "LOCAL" })).toEqual({
      kind: "local",
      cacheDirectory: "data/memory-models",
      localOnly: false,
    });
    expect(
      parseEmbeddingEnv({
        [EMBEDDING_ENV.kind]: "local",
        [EMBEDDING_ENV.cache]: "/models",
        [EMBEDDING_ENV.localOnly]: "true",
      }),
    ).toEqual({ kind: "local", cacheDirectory: "/models", localOnly: true });
  });

  it("requires model and immutable revision for ollama", () => {
    expect(() => parseEmbeddingEnv({ [EMBEDDING_ENV.kind]: "ollama" })).toThrow(
      /MARINA_MEMORY_EMBEDDING_MODEL.*MARINA_MEMORY_EMBEDDING_REVISION/,
    );
    expect(() =>
      parseEmbeddingEnv({
        [EMBEDDING_ENV.kind]: "ollama",
        [EMBEDDING_ENV.model]: "nomic-embed-text",
      }),
    ).toThrow(/REVISION/);
    expect(
      parseEmbeddingEnv({
        [EMBEDDING_ENV.kind]: "ollama",
        [EMBEDDING_ENV.model]: "nomic-embed-text",
        [EMBEDDING_ENV.revision]: "v1.5",
      }),
    ).toEqual({
      kind: "ollama",
      url: "http://127.0.0.1:11434",
      model: "nomic-embed-text",
      revision: "v1.5",
    });
  });

  it("rejects unknown kinds and malformed booleans loudly", () => {
    expect(() => parseEmbeddingEnv({ [EMBEDDING_ENV.kind]: "cohere" })).toThrow(
      /MARINA_MEMORY_EMBEDDINGS must be one of none, local, ollama, openai \(got "cohere"\)/,
    );
    expect(() =>
      parseEmbeddingEnv({ [EMBEDDING_ENV.kind]: "local", [EMBEDDING_ENV.localOnly]: "yes" }),
    ).toThrow(/LOCAL_ONLY must be true or false/);
  });
});

describe("openai-compatible embeddings", () => {
  const base = {
    [EMBEDDING_ENV.kind]: "openai",
    [EMBEDDING_ENV.model]: "qwen/qwen3-embedding-8b",
    [EMBEDDING_ENV.revision]: "2026-10",
  };

  it("requires a URL (no default vendor) and keeps vendor keys on their own hosts", () => {
    expect(() => parseEmbeddingEnv(base)).toThrow(/MARINA_MEMORY_EMBEDDING_URL/);
    expect(
      parseEmbeddingEnv({
        ...base,
        [EMBEDDING_ENV.url]: "https://openrouter.ai/api/v1",
        OPENROUTER_API_KEY: "or-key",
        OPENAI_API_KEY: "oa-key",
      }),
    ).toEqual({
      kind: "openai",
      url: "https://openrouter.ai/api/v1",
      model: "qwen/qwen3-embedding-8b",
      revision: "2026-10",
      apiKey: "or-key",
    });
    const local = parseEmbeddingEnv({
      ...base,
      [EMBEDDING_ENV.url]: "http://127.0.0.1:8080/v1",
      OPENROUTER_API_KEY: "or-key",
      [EMBEDDING_ENV.dimensions]: "1024",
    });
    expect(local).not.toHaveProperty("apiKey");
    expect(local).toMatchObject({ dimensions: 1024 });
    expect(() =>
      parseEmbeddingEnv({
        ...base,
        [EMBEDDING_ENV.url]: "http://x/v1",
        [EMBEDDING_ENV.dimensions]: "0",
      }),
    ).toThrow(/positive integer/);
    expect(embeddingProviderId(local)).toBe("openai:qwen/qwen3-embedding-8b@2026-10:d1024:raw-v1");
  });

  it("reads a separate variable family for corpora", () => {
    expect(
      parseEmbeddingEnv({ ...base, [EMBEDDING_ENV.url]: "http://x/v1" }, CORPUS_EMBEDDING_ENV),
    ).toEqual({ kind: "none" });
    expect(
      parseEmbeddingEnv(
        {
          MARINA_CORPUS_EMBEDDINGS: "ollama",
          MARINA_CORPUS_EMBEDDING_MODEL: "m",
          MARINA_CORPUS_EMBEDDING_REVISION: "r",
        },
        CORPUS_EMBEDDING_ENV,
      ),
    ).toMatchObject({ kind: "ollama", model: "m" });
  });

  it("batches, orders by index, reports cost and refuses at the cap", async () => {
    const calls: Array<{
      url: string;
      body: { input: string[]; dimensions?: number };
      auth?: string;
    }> = [];
    const costs: number[] = [];
    let refuse: string | undefined;
    const provider = openAIEmbeddings({
      baseUrl: "http://127.0.0.1:9/v1",
      model: "m",
      revision: "r",
      apiKey: "k",
      dimensions: 2,
      onCost: (usd) => costs.push(usd),
      refuse: () => refuse,
      fetch: (async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        calls.push({
          url: String(url),
          body,
          auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
        });
        return new Response(
          JSON.stringify({
            data: body.input
              .map((_: string, i: number) => ({
                index: i,
                embedding: [i + 1, 1],
              }))
              .reverse(),
            usage: { cost: 0.000002 },
          }),
        );
      }) as typeof fetch,
    });
    expect(provider.id).toBe("openai:m@r:d2:raw-v1");
    expect(await provider.embedBatch!(["a", "b"])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(await provider.embed("c")).toEqual([1, 1]);
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:9/v1/embeddings",
      body: { input: ["a", "b"], dimensions: 2 },
      auth: "Bearer k",
    });
    expect(costs).toEqual([0.000002, 0.000002]);
    refuse = "daily spend cap reached";
    await expect(provider.embed("d")).rejects.toThrow(/daily spend cap/);
    expect(calls).toHaveLength(2);
  });

  it("rejects a malformed reply as invalid_embedding", async () => {
    const provider = openAIEmbeddings({
      baseUrl: "http://127.0.0.1:9/v1",
      model: "m",
      revision: "r",
      fetch: (async () =>
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [0, 0] }] }),
        )) as unknown as typeof fetch,
    });
    const error = await provider.embed("x").catch((e) => e);
    expect((error as MemoryError).code).toBe("invalid_embedding");
  });
});

describe("embedding provider ids", () => {
  it("derives the ollama id identically to the provider", () => {
    const config = {
      kind: "ollama",
      url: "http://127.0.0.1:11434",
      model: "m",
      revision: "r",
    } as const;
    expect(embeddingProviderId(config)).toBe(ollamaEmbeddings(config.url, "m", "r").id);
    expect(embeddingProviderId({ kind: "none" })).toBeUndefined();
  });

  it("keeps the local id in lockstep with the extension source", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "extensions", "local-embeddings", "index.ts"),
      "utf8",
    );
    const model = source.match(/LOCAL_EMBEDDING_MODEL = "([^"]+)"/)?.[1];
    const revision = source.match(/LOCAL_EMBEDDING_REVISION = "([^"]+)"/)?.[1];
    const suffix = source.match(/\$\{LOCAL_EMBEDDING_REVISION\}:([^`]+)`/)?.[1];
    expect(model && revision && suffix).toBeTruthy();
    expect(LOCAL_EMBEDDING_PROVIDER_ID).toBe(`${model}@${revision}:${suffix}`);
    expect(embeddingProviderId({ kind: "local", cacheDirectory: "x", localOnly: true })).toBe(
      LOCAL_EMBEDDING_PROVIDER_ID,
    );
  });
});

describe("embeddingProviderFromConfig", () => {
  it("returns undefined for none and never touches the network for ollama", async () => {
    expect(await embeddingProviderFromConfig({ kind: "none" })).toBeUndefined();
    const provider = await embeddingProviderFromConfig({
      kind: "ollama",
      url: "http://127.0.0.1:1",
      model: "m",
      revision: "r",
    });
    expect(provider?.id).toBe("ollama:m@r:raw-v1");
  });

  it("explains how to install the extension when local embeddings are unavailable", async () => {
    // Either the extension is not installed, or it is but the pinned model is
    // not in this empty cache and downloads are forbidden. Both must point the
    // operator at the extension without downloading anything.
    const cache = mkdtempSync(join(tmpdir(), "marina-embed-cache-"));
    try {
      await expect(
        embeddingProviderFromConfig({ kind: "local", cacheDirectory: cache, localOnly: true }),
      ).rejects.toThrow(/extensions\/local-embeddings/);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe("lazyEmbeddingProvider", () => {
  it("exposes the id synchronously and surfaces load failures as 503 embedding_unavailable", async () => {
    let loads = 0;
    const failing = lazyEmbeddingProvider("x", async () => {
      loads++;
      throw new Error("extension missing");
    });
    expect(failing.id).toBe("x");
    const error = await failing.embed("hello").catch((e) => e);
    expect(error).toBeInstanceOf(MemoryError);
    expect((error as MemoryError).status).toBe(503);
    expect((error as MemoryError).code).toBe("embedding_unavailable");
    expect((error as MemoryError).message).toContain("extension missing");
    // A failed load is retried on the next call rather than cached forever.
    await failing.embed("again").catch(() => undefined);
    expect(loads).toBe(2);
  });

  it("refuses a loaded provider whose id differs and passes through a matching one", async () => {
    const mismatch = lazyEmbeddingProvider("expected", async () => ({
      id: "other",
      embed: async () => [1],
    }));
    await expect(mismatch.embed("q")).rejects.toThrow(/id mismatch/);
    let calls = 0;
    const ok = lazyEmbeddingProvider("same", async () => {
      calls++;
      return { id: "same", embed: async (text) => [text.length] };
    });
    expect(await ok.embed("abc")).toEqual([3]);
    expect(await ok.embed("abcd")).toEqual([4]);
    expect(calls).toBe(1);
  });
});

describe("worldMemoryService embeddings", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-world-embed-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("stays lexical by default and is explicit-only", () => {
    expect(worldEmbeddingProvider({})).toBeUndefined();
    const db = new MarinaDB(join(directory, "a.db"));
    try {
      const service = worldMemoryService(db, {});
      expect(service.embeddings).toBeUndefined();
      expect(service.capabilities().semantic).toBeNull();
      // Memoized per database: a later env cannot silently swap the provider in.
      expect(worldMemoryService(db, { [EMBEDDING_ENV.kind]: "ollama" })).toBe(service);
    } finally {
      db.close();
    }
  });

  it("constructs a configured provider lazily without network access", () => {
    const db = new MarinaDB(join(directory, "b.db"));
    try {
      const service = worldMemoryService(db, {
        [EMBEDDING_ENV.kind]: "ollama",
        [EMBEDDING_ENV.url]: "http://127.0.0.1:1",
        [EMBEDDING_ENV.model]: "m",
        [EMBEDDING_ENV.revision]: "r",
      });
      expect(service.embeddings?.id).toBe("ollama:m@r:raw-v1");
      expect(service.capabilities().semantic).toBe("ollama:m@r:raw-v1");
      service.stopWorker();
    } finally {
      db.close();
    }
  });

  it("fails loudly on an invalid configuration instead of degrading to lexical", () => {
    const db = new MarinaDB(join(directory, "c.db"));
    try {
      expect(() => worldMemoryService(db, { [EMBEDDING_ENV.kind]: "pinecone" })).toThrow(
        /MARINA_MEMORY_EMBEDDINGS/,
      );
    } finally {
      db.close();
    }
  });
});

describe("embedding input limits", () => {
  it("cuts an input past the cap to its head on a character boundary and says so", () => {
    expect(truncateEmbeddingInput("short", 8)).toEqual({
      text: "short",
      truncated: false,
      estimatedTokens: 2,
    });
    const long = "é".repeat(40); // 80 bytes ⇒ 27 estimated tokens
    const cut = truncateEmbeddingInput(long, 5); // 15 bytes ⇒ 7 whole characters
    expect(cut).toMatchObject({ truncated: true, estimatedTokens: 27 });
    expect(cut.text).toBe("é".repeat(7));
    expect(estimateEmbeddingTokens(cut.text)).toBeLessThanOrEqual(5);
    expect(truncateEmbeddingInput(long, 0).truncated).toBe(false);
    expect(truncateEmbeddingInput(long, undefined).truncated).toBe(false);
  });

  it("parses the per-input cap and rejects junk", () => {
    const base = {
      [EMBEDDING_ENV.kind]: "openai",
      [EMBEDDING_ENV.url]: "http://127.0.0.1:9/v1",
      [EMBEDDING_ENV.model]: "m",
      [EMBEDDING_ENV.revision]: "r",
    };
    const config = parseEmbeddingEnv({ ...base, [EMBEDDING_ENV.maxTokens]: "32768" });
    expect(config).toMatchObject({ maxInputTokens: 32768 });
    expect(embeddingMaxInputTokens(config)).toBe(32768);
    expect(embeddingMaxInputTokens(parseEmbeddingEnv(base))).toBe(
      DEFAULT_EMBEDDING_MAX_INPUT_TOKENS,
    );
    expect(
      embeddingMaxInputTokens(parseEmbeddingEnv({ ...base, [EMBEDDING_ENV.maxTokens]: "0" })),
    ).toBeUndefined();
    expect(() => parseEmbeddingEnv({ ...base, [EMBEDDING_ENV.maxTokens]: "-1" })).toThrow(
      EMBEDDING_ENV.maxTokens,
    );
    expect(
      worldEmbeddingProvider({ ...base, [EMBEDDING_ENV.maxTokens]: "64" })?.maxInputTokens,
    ).toBe(64);
  });

  it("sends at most the cap, and retries once at half length when the provider says too long", async () => {
    const sent: string[][] = [];
    let limit = Number.POSITIVE_INFINITY;
    const provider = openAIEmbeddings({
      baseUrl: "http://127.0.0.1:9/v1",
      model: "m",
      revision: "r",
      maxInputTokens: 10,
      fetch: (async (_url: string | URL, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body)).input as string[];
        sent.push(input);
        if (input.some((t) => t.length > limit))
          return new Response(
            JSON.stringify({ error: { message: "maximum context length is 40960 tokens" } }),
            { status: 400 },
          );
        return new Response(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0] })) }));
      }) as typeof fetch,
    });
    expect(provider.maxInputTokens).toBe(10);
    await provider.embed("x".repeat(100));
    expect(sent[0]![0]).toHaveLength(30);
    limit = 20;
    await provider.embed("x".repeat(100));
    expect(sent.slice(1).map((s) => s[0]!.length)).toEqual([30, 15]);
    limit = 5;
    await expect(provider.embed("x".repeat(100))).rejects.toBeInstanceOf(MemoryError);
    // A refusal that is not about length is not retried.
    const before = sent.length;
    const plain = openAIEmbeddings({
      baseUrl: "http://127.0.0.1:9/v1",
      model: "m",
      revision: "r",
      fetch: (async () => {
        sent.push([]);
        return new Response("bad key", { status: 401 });
      }) as unknown as typeof fetch,
    });
    await expect(plain.embed("x")).rejects.toThrow("(401)");
    expect(sent.length - before).toBe(1);
  });
});
