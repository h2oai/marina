// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `marina.world.v1` content profile of `marina.learned.v1`: a whole world
 * carried as items. A Marina world module is code (`WorldDefinition.seed`,
 * room handlers, `afterAgentsReady`). A bundle never carries it as code:
 *
 *   world        the data-only world document. Unknown keys are refused, so
 *                a seed, lifecycle hook or bootstrap command cannot ride along.
 *   room_source  room source as inert text, flagged `requires_gate: world.code`.
 *                Import stores it for review and never compiles, registers or
 *                executes it.
 *
 * Pure: validation only.
 */

import type { RoomSourceItem, WorldDocument } from "./format";

const ROOM_ID = /^[a-z0-9][a-z0-9_/-]{0,79}$/;
const WORLD_KEYS = new Set(["name", "description", "start_room", "rooms", "guide_notes", "quests"]);
const ROOM_KEYS = new Set(["id", "short", "long", "exits", "grid"]);
const MAX_TEXT = 8_000;
const MAX_ROOMS = 500;
/** Largest room source accepted as an item (inert text for review). */
export const MAX_ROOM_SOURCE_BYTES = 256 * 1024;

function text(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Problems with a world document (empty = valid). */
export function validateWorldDocument(doc: WorldDocument): string[] {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["world must be an object"];
  const problems: string[] = [];
  for (const key of Object.keys(doc))
    if (!WORLD_KEYS.has(key)) problems.push(`world: unsupported key "${key}" (data only)`);
  if (!text(doc.name, 64)) problems.push("world: name required");
  if (typeof doc.description !== "string" || doc.description.length > MAX_TEXT)
    problems.push("world: description invalid");
  if (!Array.isArray(doc.rooms) || doc.rooms.length === 0 || doc.rooms.length > MAX_ROOMS)
    return [...problems, `world: rooms must be a non-empty array (≤ ${MAX_ROOMS})`];
  const ids = new Set<string>();
  for (const room of doc.rooms) {
    if (!room || typeof room !== "object") {
      problems.push("world: room must be an object");
      continue;
    }
    for (const key of Object.keys(room))
      if (!ROOM_KEYS.has(key)) problems.push(`room ${room.id}: unsupported key "${key}"`);
    if (!ROOM_ID.test(String(room.id)) || ids.has(room.id))
      problems.push(`room id invalid or duplicate: ${room.id}`);
    ids.add(room.id);
    if (!text(room.short, 200)) problems.push(`room ${room.id}: short required`);
    if (room.long !== undefined && !text(room.long)) problems.push(`room ${room.id}: long invalid`);
    if (
      room.grid !== undefined &&
      !(Number.isInteger(room.grid?.row) && Number.isInteger(room.grid?.col))
    )
      problems.push(`room ${room.id}: grid invalid`);
  }
  for (const room of doc.rooms)
    for (const [dir, target] of Object.entries(room?.exits ?? {}))
      if (!/^[a-z]{1,16}$/.test(dir) || !ids.has(target))
        problems.push(`room ${room.id}: exit ${dir} → unknown room ${target}`);
  if (!ids.has(doc.start_room)) problems.push("world: start_room must be one of rooms");
  for (const note of doc.guide_notes ?? [])
    if (!text(note?.content) || typeof note.importance !== "number" || !text(note.type, 32))
      problems.push("world: guide note invalid");
  for (const quest of doc.quests ?? [])
    if (!text(quest?.id, 64) || !text(quest.name, 200) || !text(quest.description))
      problems.push("world: quest description invalid");
  return problems;
}

/** Problems with a room-source item (empty = valid). Never parses or evaluates the source. */
export function validateRoomSource(item: Omit<RoomSourceItem, "content_hash">): string[] {
  const problems: string[] = [];
  if (!ROOM_ID.test(String(item.room_id))) problems.push("room_source: room_id invalid");
  if (item.language !== "typescript") problems.push("room_source: language must be typescript");
  if (item.requires_gate !== "world.code")
    problems.push("room_source: requires_gate must be world.code");
  if (typeof item.source !== "string" || item.source.length === 0)
    problems.push("room_source: source required");
  else if (Buffer.byteLength(item.source, "utf8") > MAX_ROOM_SOURCE_BYTES)
    problems.push(`room_source: source exceeds ${MAX_ROOM_SOURCE_BYTES} bytes`);
  return problems;
}
