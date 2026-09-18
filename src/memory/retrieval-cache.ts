// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MemoryActor } from "../persistence/db-principals";
import type { MemoryCachedRetrievalResult, MemoryFederatedPin } from "../sdk/memory-types";
import { getFederatedMemoryCache } from "./cache";
import type { MemoryService } from "./service";
import { integer, MemoryError, object } from "./service-types";
import { retrieveMemory } from "./task-retrieval";

/** Explicit-time reuse only: wall-clock eligibility cannot silently invalidate a hit. */
export async function retrieveMemoryCached(
  service: MemoryService,
  actor: MemoryActor,
  space: string,
  body: Record<string, unknown>,
  key: string,
  signal?: AbortSignal,
): Promise<MemoryCachedRetrievalResult> {
  if (
    Object.keys(body).some(
      (field) => !["retrieval", "mounts", "allow_partial", "cache", "ttl_ms"].includes(field),
    )
  )
    throw new MemoryError(400, "invalid_input", "Unknown reusable retrieval option");
  const input = object(body.retrieval);
  integer(input.valid_at, "valid_at (required for reusable retrieval)", 0, Number.MAX_SAFE_INTEGER);
  if (input.use_model || input.observe)
    throw new MemoryError(
      400,
      "invalid_input",
      "Reusable retrieval is deterministic and excludes observation pools",
    );
  const mode = body.cache ?? "read";
  if (!["read", "read_write", "refresh"].includes(String(mode)))
    throw new MemoryError(400, "invalid_input", "cache must be read, read_write or refresh");
  const repo = service.repository;
  const identity = {
    inputs: {
      retrieval: input,
      mounts: body.mounts ?? null,
      allow_partial: body.allow_partial ?? false,
    },
    model: "none",
    policy: "marina-retrieval-v2",
  };
  const cached =
    mode === "refresh"
      ? { hit: false as const, reason: "refresh" }
      : await getFederatedMemoryCache(service, actor, space, identity, signal);
  if (cached.hit)
    return {
      retrieval: cached.value as MemoryCachedRetrievalResult["retrieval"],
      cache: { hit: true, reason: "validated" },
    };
  if (mode !== "read") {
    repo.authorize(actor, space, "memory:write");
    if (!key || key.length > 128)
      throw new MemoryError(400, "idempotency_required", "Cache writes require an Idempotency-Key");
    integer(body.ttl_ms ?? 60000, "ttl_ms", 1000, 86400000);
  }
  const generation = repo.authorize(actor, space).retrieval_generation;
  const retrieval =
    body.mounts === undefined
      ? await retrieveMemory(service, actor, space, input, signal)
      : await service.federation.retrieve(
          actor.principalId,
          body,
          () => repo.authorize(actor, space),
          signal,
        );
  if (mode === "read") return { retrieval, cache: { hit: false, reason: cached.reason } };
  repo.authorize(actor, space, "memory:write");
  const records: { id: string; version: number }[] = [],
    sources: { id: string; content_hash: string }[] = [],
    federated: MemoryFederatedPin[] = [];
  for (const item of retrieval.evidence) {
    const pin =
      item.kind === "record"
        ? { kind: "record" as const, id: item.id, version: item.version }
        : { kind: "source" as const, id: item.id, content_hash: item.content_hash };
    if ("mount" in item)
      federated.push({ ...pin, mount: String(item.mount), space_id: item.space_id });
    else if (pin.kind === "record") records.push(pin);
    else sources.push(pin);
  }
  // Empty or unvisited peers cannot be generation-pinned by the existing cache contract.
  if (
    "peers" in retrieval &&
    retrieval.peers.some(
      (peer) =>
        ["unavailable", "budget_exhausted"].includes(peer.status) ||
        !federated.some((pin) => pin.mount === peer.mount),
    )
  )
    return { retrieval, cache: { hit: false, reason: "incomplete_peer_basis", stored: false } };
  const seals = await service.federation.seal(
    actor.principalId,
    federated,
    () => repo.authorize(actor, space, "memory:write"),
    signal,
  );
  if (
    "peers" in retrieval &&
    seals.some(
      (seal) =>
        retrieval.peers.find((peer) => peer.mount === seal.pin.mount)?.retrieval_generation !==
        seal.generation,
    )
  )
    throw new MemoryError(409, "cache_basis_changed", "Peer changed before cache admission");
  signal?.throwIfAborted();
  if (repo.authorize(actor, space, "memory:write").retrieval_generation !== generation)
    throw new MemoryError(409, "cache_basis_changed", "Memory changed before cache admission");
  repo.cachePutValidated(
    actor,
    space,
    {
      ...identity,
      value: retrieval,
      records,
      sources,
      federated,
      expires_at: Date.now() + integer(body.ttl_ms ?? 60000, "ttl_ms", 1000, 86400000),
    },
    key,
    seals,
  );
  return { retrieval, cache: { hit: false, reason: cached.reason, stored: true } };
}
