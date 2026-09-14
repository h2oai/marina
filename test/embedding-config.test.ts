// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDING_ENV,
  embeddingProviderFromConfig,
  embeddingProviderId,
  LOCAL_EMBEDDING_PROVIDER_ID,
  lazyEmbeddingProvider,
  parseEmbeddingEnv,
} from "../src/memory/embedding-config";
import { ollamaEmbeddings } from "../src/memory/embeddings";
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
    expect(() => parseEmbeddingEnv({ [EMBEDDING_ENV.kind]: "openai" })).toThrow(
      /MARINA_MEMORY_EMBEDDINGS must be one of none, local, ollama \(got "openai"\)/,
    );
    expect(() =>
      parseEmbeddingEnv({ [EMBEDDING_ENV.kind]: "local", [EMBEDDING_ENV.localOnly]: "yes" }),
    ).toThrow(/LOCAL_ONLY must be true or false/);
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
