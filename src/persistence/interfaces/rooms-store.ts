// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoomSourceRow, RoomTemplateRow } from "../db-rooms";
import type { ExactKeys } from "./exact-keys";

/** Room sources and templates (`db-rooms.ts`). */
export interface RoomsStore {
  saveRoomSource(opts: {
    roomId: string;
    source: string;
    authorId: string;
    authorName: string;
    valid?: boolean;
  }): number;
  getRoomSource(roomId: string, version?: number): RoomSourceRow | undefined;
  getRoomSourceHistory(roomId: string, limit?: number): RoomSourceRow[];
  getLatestRoomSourceVersion(roomId: string): number;
  getAllRoomSourceIds(): string[];
  markRoomSourceValid(roomId: string, version: number): void;
  deleteRoomSources(roomId: string): void;
  saveRoomTemplate(opts: {
    name: string;
    source: string;
    authorId: string;
    authorName: string;
    description?: string;
  }): void;
  getRoomTemplate(name: string): RoomTemplateRow | undefined;
  getAllRoomTemplates(): RoomTemplateRow[];
  deleteRoomTemplate(name: string): void;
  clearDynamicRooms(): void;
}

/** Runtime mirror of `RoomsStore`'s method names — the drift test compares it to the facade. */
export const ROOMS_STORE_METHODS = [
  "saveRoomSource",
  "getRoomSource",
  "getRoomSourceHistory",
  "getLatestRoomSourceVersion",
  "getAllRoomSourceIds",
  "markRoomSourceValid",
  "deleteRoomSources",
  "saveRoomTemplate",
  "getRoomTemplate",
  "getAllRoomTemplates",
  "deleteRoomTemplate",
  "clearDynamicRooms",
] as const satisfies readonly (keyof RoomsStore)[];

export const ROOMS_STORE_COMPLETE: ExactKeys<RoomsStore, typeof ROOMS_STORE_METHODS> = true;
