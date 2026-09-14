// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { isLocalProfile } from "../engine/trust-profile";
import { MemoryError } from "../memory/service-types";
import type { MemoryStorageAmounts } from "../sdk/memory-types";

export const DEFAULT_MEMORY_LIMITS: Readonly<MemoryStorageAmounts> = Object.freeze({
  logical_bytes: 1073741824,
  sources: 100000,
  revisions: 100000,
  spaces: 256,
});
const policies = new WeakMap<Database, Readonly<MemoryStorageAmounts>>();

export function configureMemoryStorage(db: Database, input: Partial<MemoryStorageAmounts> = {}) {
  const limits = { ...DEFAULT_MEMORY_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Memory storage limit ${name} must be a positive safe integer`);
  policies.set(db, Object.freeze(limits));
}

export function memoryLimitsFromEnv(env = process.env): Partial<MemoryStorageAmounts> {
  const limits: Partial<MemoryStorageAmounts> = {};
  // LOCAL trust profile: admission budgets are off unless set explicitly —
  // the operator's own disk is the only budget that matters.
  if (isLocalProfile(env)) {
    for (const key of ["logical_bytes", "sources", "revisions", "spaces"] as const)
      limits[key] = Number.MAX_SAFE_INTEGER;
  }
  for (const [key, name] of [
    ["logical_bytes", "MARINA_MEMORY_MAX_BYTES"],
    ["sources", "MARINA_MEMORY_MAX_SOURCES"],
    ["revisions", "MARINA_MEMORY_MAX_REVISIONS"],
    ["spaces", "MARINA_MEMORY_MAX_SPACES"],
  ] as const) {
    if (env[name] !== undefined) {
      if (!/^\d+$/.test(env[name]!)) throw new Error(`${name} must be a positive integer`);
      limits[key] = Number(env[name]);
    }
  }
  return limits;
}

/** Owner aggregate, including retained history and receipts in forgotten spaces.
 * Callers must separately authorize whose totals they are allowed to see. */
export function memoryStorageUsage(db: Database, owner: string) {
  const usage = db
    .query(`SELECT coalesce(sum(u.logical_bytes),0) AS logical_bytes,
    coalesce(sum(u.sources),0) AS sources,coalesce(sum(u.revisions),0) AS revisions,
    coalesce(sum(s.status='active'),0) AS spaces FROM memory_spaces s
    LEFT JOIN memory_storage_usage u ON u.space_id=s.id WHERE s.owner_id=?`)
    .get(owner) as MemoryStorageAmounts;
  const limits = policies.get(db) ?? DEFAULT_MEMORY_LIMITS;
  return {
    owner_id: owner,
    usage,
    limits,
    over_limit: (Object.keys(limits) as (keyof MemoryStorageAmounts)[]).filter(
      (key) => usage[key] > limits[key],
    ),
  };
}

/** Inside the write transaction. Existing over-budget data stays readable;
 * admission rejects growing dimensions, never evicts sources or authored history. */
export function enforceMemoryStorage(db: Database, owner: string, before: MemoryStorageAmounts) {
  const after = memoryStorageUsage(db, owner);
  if (after.over_limit.some((key) => after.usage[key] > before[key]))
    throw new MemoryError(
      507,
      "quota_exceeded",
      "Memory owner storage budget exceeded; inspect usage, explicitly forget data, or ask the operator to raise the budget",
    );
}

/** Operator snapshot import rebuilds projections from canonical rows. */
export function rebuildMemoryStorage(db: Database) {
  db.run("DELETE FROM memory_storage_items");
  db.run("DELETE FROM memory_storage_usage");
  db.run("INSERT INTO memory_storage_items SELECT * FROM memory_storage_projection");
}
