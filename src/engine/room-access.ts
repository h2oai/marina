// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Private rooms — an explicit opt-in. Every room is public unless its owner ran
 * `build access <room> private`; nothing else creates a private room. Entering
 * a private room needs the owner, an invite, or an operator. A person and the
 * agents it spawned are one party: an invited person's agents may enter too.
 * Only entry is fenced — `say` already reaches only those present, and tells,
 * channels and groups are not room-scoped.
 */

import type { MarinaDB } from "../persistence/database";
import type { RoomAccess } from "../persistence/db-rooms";
import type { Entity } from "../types";
import { isOperatorPrincipal } from "./challenges";

export type RoomAccessReader = Pick<MarinaDB, "getRoomAccess" | "spawnLineage">;

function norm(name: string): string {
  return name.trim().toLowerCase();
}

/** The access row when the room is private, else undefined (public). */
export function privateRoom(db: RoomAccessReader, room: string): RoomAccess | undefined {
  const access = db.getRoomAccess(room);
  return access?.mode === "private" ? access : undefined;
}

/** Whether `entity` (or the person up its spawn lineage) is the owner or invited. */
export function invitedTo(db: RoomAccessReader, access: RoomAccess, entity: Entity): boolean {
  const allowed = new Set([norm(access.owner), ...access.invites.map(norm)]);
  // spawnLineage starts with the name itself, then each creator up the chain.
  return db.spawnLineage(entity.name).some((name) => allowed.has(norm(name)));
}

/** Why `entity` may not enter `room`, or null when it may. */
export function roomEntryRefusal(
  db: RoomAccessReader,
  entity: Entity,
  room: string,
): string | null {
  const access = privateRoom(db, room);
  if (!access) return null;
  if (isOperatorPrincipal(entity) || invitedTo(db, access, entity)) return null;
  return `${room} is private. Ask its owner (${access.owner}) for an invite: build invite ${room} ${entity.name}`;
}
