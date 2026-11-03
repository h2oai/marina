// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a dream is over. An ENTITY dream is the pass over one agent's own
 * records (`entity_name` = the agent). A POOL dream (phase 5, cross-agent) is
 * the same pass over a shared pool's records — every member's — recorded
 * under the name `pool:<name>`, so the dream rows, proposals and the judge
 * ledger need no second key. Nothing a pool dream proposes is applied by the
 * dream: every op waits for a ratifier (`pool <name> dream ratify`).
 */

import type { MarinaDB } from "../../persistence/database";

export const POOL_SCOPE_PREFIX = "pool:";

export type DreamScope =
  | { kind: "entity"; name: string }
  | { kind: "pool"; name: string; poolId: string };

export const poolScopeName = (poolName: string) => `${POOL_SCOPE_PREFIX}${poolName}`;
export const isPoolScopeName = (name: string) => name.startsWith(POOL_SCOPE_PREFIX);

/** The scope a dream name means; undefined for a pool that does not exist. */
export function scopeOf(db: MarinaDB, name: string): DreamScope | undefined {
  if (!isPoolScopeName(name)) return { kind: "entity", name };
  const pool = db.getMemoryPool(name.slice(POOL_SCOPE_PREFIX.length));
  return pool ? { kind: "pool", name: pool.name, poolId: pool.id } : undefined;
}

/** Recall as the probes see it: the owner's notes, or the pool's. */
export function scopeRecall(db: MarinaDB, name: string, query: string): { id: number }[] {
  const scope = scopeOf(db, name);
  if (!scope) return [];
  return scope.kind === "pool"
    ? db.recallPoolNotes(scope.poolId, query)
    : db.recallNotes(name, query);
}

/** Whether a note is in the scope: the owner's own (no pool), or the pool's. */
export function inScope(
  scope: DreamScope,
  note: { entity_name: string; pool_id: string | null } | undefined,
): boolean {
  if (!note) return false;
  return scope.kind === "pool"
    ? note.pool_id === scope.poolId
    : note.entity_name === scope.name && note.pool_id == null;
}
