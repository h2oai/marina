// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../auth/session-manager";
import type { EngineEvent, Entity, EntityId, RoomId } from "../../types";
import type * as entitiesDb from "../db-entities";
import type { ExactKeys } from "./exact-keys";

/** Entities, room KV, sessions, event log, trace judgments and activity tracking (`db-entities.ts`). */
export interface EntitiesStore {
  saveEntity(entity: Entity): void;
  loadEntity(id: EntityId): Entity | undefined;
  loadAllEntities(): Entity[];
  findEntityIdByName(name: string): string | undefined;
  deleteEntity(id: EntityId): void;
  loadEntitiesInRoom(room: RoomId): Entity[];
  getRoomStoreValue(roomId: RoomId, key: string): unknown | undefined;
  setRoomStoreValue(roomId: RoomId, key: string, value: unknown): void;
  deleteRoomStoreValue(roomId: RoomId, key: string): void;
  getRoomStoreKeys(roomId: RoomId): string[];
  logEvent(event: EngineEvent): void;
  getRecentEvents(limit?: number): EngineEvent[];
  getRecentTraceEvents(
    limit?: number,
    traceId?: string,
  ): { events: EngineEvent[]; truncated: boolean };
  getTraceEventsByTraceIds(traceIds: readonly string[]): EngineEvent[];
  getMaxEventId(): number;
  addTraceJudgment(input: entitiesDb.TraceJudgmentInput): entitiesDb.TraceJudgmentRow;
  getTraceJudgments(traceId: string, limit?: number): entitiesDb.TraceJudgmentRow[];
  getTraceJudgmentsByTraceIds(
    traceIds: readonly string[],
    limitPerTrace?: number,
  ): Map<string, entitiesDb.TraceJudgmentRow[]>;
  getEventCount(): number;
  saveSession(session: Session): void;
  loadSession(token: string): Session | undefined;
  deleteSession(token: string): void;
  deleteSessionsByEntity(entityId: EntityId): void;
  deleteExpiredSessions(now: number): number;
  loadSessionByEntity(entityId: EntityId): Session | undefined;
  saveAllEntities(entities: Entity[]): void;
  trackActivity(
    entityName: string,
    activityType: string,
    activityKey: string,
    success?: boolean,
  ): void;
  getActivityStats(entityName: string): {
    roomsVisited: number;
    uniqueCommands: number;
    entitiesInteracted: number;
    totalActions: number;
  };
  getLastActivityAt(entityName: string): number | null;
  getRoomVisitCount(entityName: string, roomId: string): number;
  getActivityByType(
    entityName: string,
    activityType: string,
    limit?: number,
  ): { key: string; count: number; successCount: number; failCount: number; lastSeen: number }[];
  getEventsByEntity(
    entityId: string,
    limit?: number,
  ): { type: string; input?: string; timestamp: number }[];
  getEntityCommandCount(entityId: string): number;
  getLastActivity(
    entityId: string,
  ): { type: string; timestamp: number; input?: string } | undefined;
  getActiveEntities(
    sinceMs: number,
  ): { entityId: string; commandCount: number; lastActivity: number }[];
  migrateEntityId(oldId: string, newId: string): void;
  migrateTaskClaimsByName(entityName: string, newId: string): void;
  /** Get active task claims for an entity by name. */
  getActiveClaimsByName(entityName: string): {
    task_id: number;
    title: string;
    status: string;
    priority: number;
    progress: number;
    claimed_at: number;
  }[];
  /** Get recent activity entries for an entity. */
  getRecentActivity(
    entityName: string,
    limit?: number,
  ): { activity_type: string; activity_key: string; count: number; last_seen: number }[];
}

/** Runtime mirror of `EntitiesStore`'s method names — the drift test compares it to the facade. */
export const ENTITIES_STORE_METHODS = [
  "saveEntity",
  "loadEntity",
  "loadAllEntities",
  "findEntityIdByName",
  "deleteEntity",
  "loadEntitiesInRoom",
  "getRoomStoreValue",
  "setRoomStoreValue",
  "deleteRoomStoreValue",
  "getRoomStoreKeys",
  "logEvent",
  "getRecentEvents",
  "getRecentTraceEvents",
  "getTraceEventsByTraceIds",
  "getMaxEventId",
  "addTraceJudgment",
  "getTraceJudgments",
  "getTraceJudgmentsByTraceIds",
  "getEventCount",
  "saveSession",
  "loadSession",
  "deleteSession",
  "deleteSessionsByEntity",
  "deleteExpiredSessions",
  "loadSessionByEntity",
  "saveAllEntities",
  "trackActivity",
  "getActivityStats",
  "getLastActivityAt",
  "getRoomVisitCount",
  "getActivityByType",
  "getEventsByEntity",
  "getEntityCommandCount",
  "getLastActivity",
  "getActiveEntities",
  "migrateEntityId",
  "migrateTaskClaimsByName",
  "getActiveClaimsByName",
  "getRecentActivity",
] as const satisfies readonly (keyof EntitiesStore)[];

export const ENTITIES_STORE_COMPLETE: ExactKeys<EntitiesStore, typeof ENTITIES_STORE_METHODS> =
  true;
