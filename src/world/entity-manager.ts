// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../persistence/database";
import type { Entity, EntityId, EntityKind, RoomId } from "../types";
import { entityId } from "../types";

export class EntityManager {
  private entities = new Map<EntityId, Entity>();
  private nextId = 1;
  private db?: MarinaDB;

  /** Inject database for write-through persistence */
  setDb(db: MarinaDB): void {
    this.db = db;
  }

  create(opts: {
    kind: EntityKind;
    name: string;
    short: string;
    long: string;
    room: RoomId;
    properties?: Record<string, unknown>;
  }): Entity {
    const id = entityId(`e_${this.nextId++}`);
    const entity: Entity = {
      id,
      kind: opts.kind,
      name: opts.name,
      short: opts.short,
      long: opts.long,
      room: opts.room,
      properties: opts.properties ?? {},
      inventory: [],
      createdAt: Date.now(),
    };
    this.entities.set(id, entity);
    if (this.db) {
      try {
        this.db.saveEntity(entity);
      } catch {
        /* DB may be closed during shutdown */
      }
    }
    return entity;
  }

  get(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  remove(id: EntityId): boolean {
    const deleted = this.entities.delete(id);
    if (deleted && this.db) {
      try {
        this.db.deleteEntity(id);
      } catch {
        /* DB may be closed during shutdown */
      }
    }
    return deleted;
  }

  /** All entities currently in a given room */
  inRoom(room: RoomId): Entity[] {
    const result: Entity[] = [];
    for (const e of this.entities.values()) {
      if (e.room === room) result.push(e);
    }
    return result;
  }

  /** Move entity to a new room. Returns false if entity not found. */
  move(id: EntityId, to: RoomId): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;
    entity.room = to;
    if (this.db) {
      try {
        this.db.saveEntity(entity);
      } catch {
        /* DB may be closed during shutdown */
      }
    }
    return true;
  }

  /** Find an active agent entity by exact name (case-insensitive) across all rooms */
  findAgentByName(name: string): Entity | undefined {
    const lower = name.toLowerCase();
    for (const e of this.entities.values()) {
      if (e.kind === "agent" && e.name.toLowerCase() === lower) return e;
    }
    return undefined;
  }

  /** Find entity by name (case-insensitive prefix match) within a room */
  findByName(name: string, room: RoomId): Entity | undefined {
    const lower = name.toLowerCase();
    const inRoom = this.inRoom(room);
    // Exact match first
    const exact = inRoom.find((e) => e.name.toLowerCase() === lower);
    if (exact) return exact;
    // Prefix match
    return inRoom.find((e) => e.name.toLowerCase().startsWith(lower));
  }

  /** Add an entity directly (for restoring from DB) */
  restore(entity: Entity): void {
    this.entities.set(entity.id, entity);
  }

  /** Set the next ID counter (to avoid collisions after restore) */
  setNextId(n: number): void {
    this.nextId = n;
  }

  /** All entities */
  all(): Entity[] {
    return [...this.entities.values()];
  }

  /** Total count */
  get size(): number {
    return this.entities.size;
  }
}
