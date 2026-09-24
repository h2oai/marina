// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../persistence/database";
import type { Entity, EntityId, EntityKind, RoomId } from "../types";
import { entityId } from "../types";

export class EntityManager {
  private entities = new Map<EntityId, Entity>();
  private nextId = 1;
  private db?: MarinaDB;
  // Lookup indexes. Every room/name change must go through add/restore/move/
  // remove so they stay in sync — never assign `entity.room` directly. Name
  // indexes are first-wins (the order the old linear scans returned) and
  // re-point to a remaining same-named entity when the indexed one leaves.
  private roomIndex = new Map<RoomId, Set<EntityId>>();
  private agentNameIndex = new Map<string, EntityId>();
  private roomNameIndex = new Map<RoomId, Map<string, EntityId>>();

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
    this.addToIndexes(entity);
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
    const entity = this.entities.get(id);
    if (!entity) return false;
    this.entities.delete(id);
    this.removeFromIndexes(id, entity);
    if (this.db) {
      try {
        this.db.deleteEntity(id);
      } catch {
        /* DB may be closed during shutdown */
      }
    }
    return true;
  }

  /** All entities currently in a given room */
  inRoom(room: RoomId): Entity[] {
    const ids = this.roomIndex.get(room);
    if (!ids) return [];
    const result: Entity[] = [];
    for (const id of ids) {
      const e = this.entities.get(id);
      if (e) result.push(e);
    }
    return result;
  }

  /** Move entity to a new room. Returns false if entity not found. */
  move(id: EntityId, to: RoomId): boolean {
    const entity = this.entities.get(id);
    if (!entity) return false;
    const from = entity.room;
    entity.room = to;
    this.updateRoomIndex(id, from, to);
    this.updateRoomNameIndex(entity, from, to);
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
    const id = this.agentNameIndex.get(name.toLowerCase());
    return id ? this.entities.get(id) : undefined;
  }

  /** Find entity by name (case-insensitive prefix match) within a room */
  findByName(name: string, room: RoomId): Entity | undefined {
    const lower = name.toLowerCase();
    const roomNames = this.roomNameIndex.get(room);
    if (roomNames) {
      const exact = roomNames.get(lower);
      if (exact) return this.entities.get(exact);
    }
    const inRoom = this.inRoom(room);
    return inRoom.find((e) => e.name.toLowerCase().startsWith(lower));
  }

  /** Add an entity directly (for restoring from DB) */
  restore(entity: Entity): void {
    this.entities.set(entity.id, entity);
    this.addToIndexes(entity);
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

  private addToIndexes(entity: Entity): void {
    const { id, room, kind, name } = entity;
    const key = name.toLowerCase();
    this.addToRoom(id, room);
    if (kind === "agent" && !this.agentNameIndex.has(key)) this.agentNameIndex.set(key, id);
    this.addRoomName(room, key, id);
  }

  private removeFromIndexes(id: EntityId, entity: Entity): void {
    const key = entity.name.toLowerCase();
    this.removeFromRoom(id, entity.room);
    this.removeRoomName(entity.room, key, id);
    if (entity.kind === "agent" && this.agentNameIndex.get(key) === id) {
      this.agentNameIndex.delete(key);
      for (const e of this.entities.values()) {
        if (e.kind === "agent" && e.name.toLowerCase() === key) {
          this.agentNameIndex.set(key, e.id);
          break;
        }
      }
    }
  }

  private updateRoomIndex(id: EntityId, from: RoomId, to: RoomId): void {
    this.removeFromRoom(id, from);
    this.addToRoom(id, to);
  }

  private updateRoomNameIndex(entity: Entity, from: RoomId, to: RoomId): void {
    const key = entity.name.toLowerCase();
    this.removeRoomName(from, key, entity.id);
    this.addRoomName(to, key, entity.id);
  }

  private addToRoom(id: EntityId, room: RoomId): void {
    let set = this.roomIndex.get(room);
    if (!set) {
      set = new Set<EntityId>();
      this.roomIndex.set(room, set);
    }
    set.add(id);
  }

  private removeFromRoom(id: EntityId, room: RoomId): void {
    const set = this.roomIndex.get(room);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.roomIndex.delete(room);
  }

  private addRoomName(room: RoomId, key: string, id: EntityId): void {
    let names = this.roomNameIndex.get(room);
    if (!names) {
      names = new Map<string, EntityId>();
      this.roomNameIndex.set(room, names);
    }
    if (!names.has(key)) names.set(key, id);
  }

  /** Drop `id` from a room's name index, re-pointing to another same-named occupant. */
  private removeRoomName(room: RoomId, key: string, id: EntityId): void {
    const names = this.roomNameIndex.get(room);
    if (!names || names.get(key) !== id) return;
    names.delete(key);
    for (const other of this.roomIndex.get(room) ?? []) {
      if (other !== id && this.entities.get(other)?.name.toLowerCase() === key) {
        names.set(key, other);
        break;
      }
    }
    if (names.size === 0) this.roomNameIndex.delete(room);
  }
}
