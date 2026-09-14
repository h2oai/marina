// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../persistence/database";
import {
  type EmbeddingConfig,
  embeddingProviderFromConfig,
  embeddingProviderId,
  lazyEmbeddingProvider,
  parseEmbeddingEnv,
} from "./embedding-config";
import type { EmbeddingProvider } from "./embeddings";
import { MemoryService } from "./service";

const services = new WeakMap<MarinaDB, MemoryService>();

/** Env-configured provider for the world server. Off by default — retrieval
 *  stays lexical and `mode:"hybrid"` remains an explicit request. The provider
 *  loads lazily behind its synchronously-known id so this stays synchronous;
 *  an invalid configuration throws here (loudly, on first memory use) rather
 *  than degrading to lexical without saying so. */
export function worldEmbeddingProvider(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider | undefined {
  const config: EmbeddingConfig = parseEmbeddingEnv(env);
  const id = embeddingProviderId(config);
  if (!id) return undefined;
  return lazyEmbeddingProvider(id, () => embeddingProviderFromConfig(config));
}

/** HTTP and resident commands share the same service and canonical records. */
export function worldMemoryService(
  db: MarinaDB,
  env: Record<string, string | undefined> = process.env,
): MemoryService {
  let service = services.get(db);
  if (!service) {
    service = new MemoryService(db, worldEmbeddingProvider(env));
    if (service.embeddings) service.startWorker();
    services.set(db, service);
  }
  return service;
}
