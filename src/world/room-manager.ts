// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  EngineEvent,
  Entity,
  EntityId,
  KeyValueStore,
  RoomBoardAPI,
  RoomChannelAPI,
  RoomContext,
  RoomId,
  RoomModule,
} from "../types";

/** In-memory key-value store scoped per room */
class MemoryStore implements KeyValueStore {
  private data = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.data.set(key, value);
  }

  delete(key: string): boolean {
    return this.data.delete(key);
  }

  keys(): string[] {
    return [...this.data.keys()];
  }
}

export interface LoadedRoom {
  id: RoomId;
  module: RoomModule;
  store: KeyValueStore;
}

export type SendFn = (
  target: EntityId,
  message: string,
  tag?: string,
  metadata?: Record<string, unknown>,
) => void;
export type BroadcastFn = (room: RoomId, message: string, tag?: string) => void;
export type BroadcastExceptFn = (
  room: RoomId,
  exclude: EntityId,
  message: string,
  tag?: string,
) => void;
export type EntitiesInRoomFn = (room: RoomId) => Entity[];
export type FindEntityFn = (name: string, room: RoomId) => Entity | undefined;
export type SpawnNpcFn = (
  room: RoomId,
  opts: { name: string; short: string; long: string; properties?: Record<string, unknown> },
) => EntityId;
export type DespawnNpcFn = (entityId: EntityId) => boolean;
export type RoomFetchFn = (
  roomId: RoomId,
  url: string,
) => Promise<{ status: number; body: string } | { error: string }>;

export class RoomManager {
  private rooms = new Map<string, LoadedRoom>();

  /** Register a room module */
  register(id: RoomId, module: RoomModule): void {
    this.rooms.set(id, {
      id,
      module,
      store: new MemoryStore(),
    });
  }

  /** Replace a room module in-place (hot reload), preserving the store */
  replace(id: RoomId, module: RoomModule): boolean {
    const existing = this.rooms.get(id);
    if (!existing) return false;
    existing.module = module;
    return true;
  }

  get(id: RoomId): LoadedRoom | undefined {
    return this.rooms.get(id);
  }

  has(id: RoomId): boolean {
    return this.rooms.has(id);
  }

  all(): LoadedRoom[] {
    return [...this.rooms.values()];
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Restore a key-value pair into a room's store (for loading from DB) */
  restoreStoreData(roomId: RoomId, key: string, value: unknown): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.store.set(key, value);
  }

  /** Build a RoomContext for a given room, wiring up send/broadcast to engine callbacks */
  buildContext(
    roomId: RoomId,
    deps: {
      send: SendFn;
      broadcast: BroadcastFn;
      broadcastExcept: BroadcastExceptFn;
      entitiesInRoom: EntitiesInRoomFn;
      findEntity: FindEntityFn;
      spawnNpc: SpawnNpcFn;
      despawnNpc: DespawnNpcFn;
      boards?: RoomBoardAPI;
      channels?: RoomChannelAPI;
      roomFetch?: RoomFetchFn;
      brief?: (entityId: EntityId) => void;
      logEvent?: (event: EngineEvent) => void;
      writeSample?: RoomContext["writeSample"];
      spawnAgent?: RoomContext["spawnAgent"];
      spawnRoomAgent?: RoomContext["spawnRoomAgent"];
    },
  ): RoomContext | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;

    return {
      roomId,
      entities: deps.entitiesInRoom(roomId),
      send: deps.send,
      broadcast: (msg: string, tag?: string) => deps.broadcast(roomId, msg, tag),
      broadcastExcept: (exclude: EntityId, msg: string, tag?: string) =>
        deps.broadcastExcept(roomId, exclude, msg, tag),
      getEntity: (id: EntityId) => deps.entitiesInRoom(roomId).find((e) => e.id === id),
      findEntity: (name: string) => deps.findEntity(name, roomId),
      store: room.store,
      spawn: (opts) => deps.spawnNpc(roomId, opts),
      despawn: (entityId: EntityId) => deps.despawnNpc(entityId),
      boards: deps.boards,
      channels: deps.channels,
      fetch: deps.roomFetch ? (url: string) => deps.roomFetch!(roomId, url) : undefined,
      brief: deps.brief,
      logEvent: deps.logEvent,
      writeSample: deps.writeSample,
      spawnAgent: deps.spawnAgent,
      spawnRoomAgent: deps.spawnRoomAgent,
    };
  }
}
