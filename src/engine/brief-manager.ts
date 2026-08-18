// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EntityId } from "../types";

/**
 * Manages brief compass subscriptions for entities.
 *
 * Extracted from Engine to reduce god-object surface area.
 * Entities subscribe to periodic brief pulses at a given tick interval.
 * The Engine calls `getReadySubscribers()` each tick to determine which
 * entities should receive a brief.
 */
export class BriefManager {
  private subscribers = new Map<EntityId, number>(); // entityId -> tick interval

  /** Subscribe an entity to periodic brief pulses. */
  subscribe(entityId: EntityId, interval: number): void {
    this.subscribers.set(entityId, interval);
  }

  /** Unsubscribe an entity from periodic brief pulses. */
  unsubscribe(entityId: EntityId): void {
    this.subscribers.delete(entityId);
  }

  /** Check if an entity is subscribed to brief pulses. */
  isSubscribed(entityId: EntityId): boolean {
    return this.subscribers.has(entityId);
  }

  /**
   * Get entity IDs that are due for a brief pulse on the given tick count.
   * Returns a snapshot to avoid mutation during iteration.
   */
  getReadySubscribers(tickCount: number): EntityId[] {
    const ready: EntityId[] = [];
    for (const [eid, interval] of this.subscribers) {
      if (tickCount % interval === 0) {
        ready.push(eid);
      }
    }
    return ready;
  }
}
