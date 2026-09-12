// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { integer, MemoryError, object, textValue } from "../memory/service-types";
import type { MemoryCacheResult } from "../sdk/memory-types";
import { authorizeMemorySpace, event, hash, mutation } from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

function identity(raw: unknown, principal: string) {
  const input = object(raw);
  if (!Object.hasOwn(input, "inputs"))
    throw new MemoryError(400, "invalid_input", "Cache inputs are required");
  const model = textValue(input.model, "model", 256),
    policy = textValue(input.policy, "policy", 256);
  if (Buffer.byteLength(JSON.stringify(input.inputs)) > 32768)
    throw new MemoryError(413, "cache_capacity", "Cache inputs exceed 32 KiB");
  return { input, name: `cache:${hash({ principal, inputs: input.inputs, model, policy })}` };
}
function pins(input: Record<string, unknown>) {
  const raw = {
    ...input,
    records: input.records === undefined ? [] : input.records,
    sources: input.sources === undefined ? [] : input.sources,
  };
  if (
    !Array.isArray(raw.records) ||
    !Array.isArray(raw.sources) ||
    raw.records.length + raw.sources.length < 1 ||
    raw.records.length + raw.sources.length > 32
  )
    throw new MemoryError(400, "cache_provenance_required", "Declare 1–32 source or record pins");
  return {
    records: raw.records.map((value) => {
      const item = object(value);
      return {
        id: textValue(item.id, "record", 128),
        version: integer(item.version, "version", 1, Number.MAX_SAFE_INTEGER),
      };
    }),
    sources: raw.sources.map((value) => {
      const item = object(value);
      return {
        id: textValue(item.id, "source", 128),
        content_hash: textValue(item.content_hash, "content_hash", 128),
      };
    }),
  };
}
function eligible(db: Database, space: string, proof: ReturnType<typeof pins>) {
  for (const record of proof.records) {
    const live = db
      .query(
        "SELECT version,stale FROM memory_records WHERE id=? AND space_id=? AND status='active'",
      )
      .get(record.id, space) as { version: number; stale: number } | null;
    if (!live || live.version !== record.version || live.stale) return false;
  }
  for (const source of proof.sources)
    if (
      !db
        .query("SELECT 1 FROM memory_sources WHERE id=? AND space_id=? AND content_hash=?")
        .get(source.id, space, source.content_hash)
    )
      return false;
  return true;
}

/** Explicit reuse, kept outside authored memories and checkpoints. It never becomes
 * a fact or bypasses live authorization. Forgetting clears reusable outputs. */
export function putMemoryCache(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  key: string,
) {
  const { input, name } = identity(raw, actor.principalId),
    proof = pins(input);
  const expires = integer(input.expires_at, "expires_at", 1, Number.MAX_SAFE_INTEGER);
  if (!Object.hasOwn(input, "value"))
    throw new MemoryError(400, "invalid_input", "Cache value is required");
  if (Buffer.byteLength(JSON.stringify(input)) > 65536)
    throw new MemoryError(413, "cache_capacity", "Cache entry exceeds 64 KiB");
  return mutation(db, actor, space, key, "cache.put", input, () => {
    if (expires <= Date.now())
      throw new MemoryError(400, "cache_expired", "Cache expiration must be in the future");
    const current = authorizeMemorySpace(db, actor, space, "memory:write");
    if (!eligible(db, space, proof))
      throw new MemoryError(
        409,
        "cache_basis_changed",
        "Declared cache evidence changed or is unavailable",
      );
    const prior = db
      .query(
        "SELECT version FROM memory_cached_results WHERE space_id=? AND principal_id=? AND name=?",
      )
      .get(space, actor.principalId, name) as { version: number } | null;
    const version = (prior?.version ?? 0) + 1;
    const data = {
      format: "marina.memory.cache.v1",
      name,
      principal_id: actor.principalId,
      value: input.value,
      ...proof,
      expires_at: expires,
      retrieval_generation: current.retrieval_generation,
    };
    db.run(
      `INSERT INTO memory_cached_results VALUES (?,?,?,?,?,?) ON CONFLICT(space_id,principal_id,name)
      DO UPDATE SET version=excluded.version,data=excluded.data,updated_at=excluded.updated_at`,
      [space, actor.principalId, name, version, JSON.stringify(data), Date.now()],
    );
    return { id: name, version, seq: event(db, actor, space, "cache.saved", name, version) };
  });
}
export function getMemoryCache(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
): MemoryCacheResult {
  const { name } = identity(raw, actor.principalId);
  return db.transaction((): MemoryCacheResult => {
    const current = authorizeMemorySpace(db, actor, space);
    const row = db
      .query(
        "SELECT data FROM memory_cached_results WHERE space_id=? AND principal_id=? AND name=?",
      )
      .get(space, actor.principalId, name) as { data: string } | null;
    if (!row) return { hit: false, reason: "missing" };
    const data = JSON.parse(row.data) as Record<string, unknown>;
    if (
      data.format !== "marina.memory.cache.v1" ||
      data.name !== name ||
      data.principal_id !== actor.principalId
    )
      return { hit: false, reason: "invalid" };
    if (typeof data.expires_at !== "number" || data.expires_at <= Date.now())
      return { hit: false, reason: "expired" };
    if (data.retrieval_generation !== current.retrieval_generation)
      return { hit: false, reason: "memory_changed" };
    let proof: ReturnType<typeof pins>;
    try {
      proof = pins(data);
    } catch {
      return { hit: false, reason: "invalid" };
    }
    if (!eligible(db, space, proof)) return { hit: false, reason: "basis_changed" };
    return { hit: true, value: data.value, ...proof, expires_at: data.expires_at };
  })();
}

/** Explicitly discard this principal's reusable result without touching authored memory. */
export function deleteMemoryCache(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  key: string,
) {
  const { input, name } = identity(raw, actor.principalId);
  return mutation(db, actor, space, key, "cache.delete", input, () => {
    const removed =
      db.run("DELETE FROM memory_cached_results WHERE space_id=? AND principal_id=? AND name=?", [
        space,
        actor.principalId,
        name,
      ]).changes > 0;
    return { id: name, removed, seq: event(db, actor, space, "cache.deleted", name) };
  });
}
