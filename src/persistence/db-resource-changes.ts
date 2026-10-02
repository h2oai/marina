// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Database } from "bun:sqlite";
import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";

export interface ResourceChange {
  resource: "coding" | "participant";
  id?: string;
}
const logger = new Logger();
const listeners = new WeakMap<Database, Set<(change: ResourceChange) => void>>();
const pending = new WeakMap<Database, Map<string, ResourceChange>>();

/** Invalidation hints only. Delivery follows the synchronous transaction, including rollback;
 * consumers always reread committed state through the resource's own authorization boundary. */
export function notifyResourceChange(db: Database, change: ResourceChange): void {
  if (!listeners.get(db)?.size) return;
  let batch = pending.get(db);
  if (!batch) {
    batch = new Map();
    pending.set(db, batch);
    const changes = batch;
    queueMicrotask(() => {
      pending.delete(db);
      for (const item of changes.values())
        for (const listener of listeners.get(db) ?? []) {
          try {
            listener(item);
          } catch (error) {
            logger.warn("resource-change", "Invalidation listener failed", {
              error: getErrorMessage(error),
            });
          }
        }
    });
  }
  // Overflow becomes a content-free resync hint, never an unbounded event backlog.
  if (batch.has(change.resource)) return;
  if (batch.size >= 128) {
    for (const [key, value] of batch) if (value.resource === change.resource) batch.delete(key);
    batch.set(change.resource, { resource: change.resource });
  } else batch.set(`${change.resource}:${change.id ?? ""}`, change);
}
export function subscribeResourceChanges(
  db: Database,
  listener: (change: ResourceChange) => void,
): () => void {
  let set = listeners.get(db);
  if (!set) {
    set = new Set();
    listeners.set(db, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
