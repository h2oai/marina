// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { hash } from "../persistence/db-memory-service";
import type { MemoryActor } from "../persistence/db-principals";
import { withMemoryAbort } from "../sdk/memory-abort";
import type { MemoryCacheResult } from "../sdk/memory-types";
import { federatedCachePins, type MemoryFederatedSeal } from "./federation";
import type { MemoryService } from "./service";
import { MemoryError, object } from "./service-types";

export async function putFederatedMemoryCache(
  service: MemoryService,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  key: string,
  signal?: AbortSignal,
) {
  const repo = service.repository;
  signal?.throwIfAborted();
  const replay = repo.cacheReceipt(actor, space, raw, key);
  if (replay) return replay;
  const input = object(raw),
    pins = federatedCachePins(input.federated);
  if (!pins.length) return repo.cachePut(actor, space, raw, key);
  const authorize = () => repo.authorize(actor, space, "memory:write");
  let seals: MemoryFederatedSeal[];
  try {
    seals = await withMemoryAbort(
      () => service.federation.seal(actor.principalId, pins, authorize, signal),
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    authorize();
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(
      503,
      "peer_unavailable",
      "A selected peer could not validate cache evidence",
    );
  }
  authorize();
  signal?.throwIfAborted();
  return repo.cachePutValidated(actor, space, raw, key, seals);
}

export async function getFederatedMemoryCache(
  service: MemoryService,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  signal?: AbortSignal,
): Promise<MemoryCacheResult> {
  signal?.throwIfAborted();
  const repo = service.repository,
    before = repo.cacheCandidate(actor, space, raw);
  if (!before.hit) return before;
  const { seals, stamp, ...result } = before;
  if (!before.federated?.length) return result;
  const authorize = () => repo.authorize(actor, space);
  try {
    const fresh = await withMemoryAbort(
      () => service.federation.seal(actor.principalId, before.federated!, authorize, signal),
      signal,
    );
    authorize();
    signal?.throwIfAborted();
    if (hash(fresh) !== hash(seals)) return { hit: false, reason: "peer_basis_changed" };
    const after = repo.cacheCandidate(actor, space, raw);
    if (!after.hit) return after;
    if (after.stamp !== stamp) return { hit: false, reason: "cache_changed" };
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    authorize();
    return {
      hit: false,
      reason:
        error instanceof MemoryError && error.code === "cache_basis_changed"
          ? "peer_basis_changed"
          : "peer_unavailable",
    };
  }
}
