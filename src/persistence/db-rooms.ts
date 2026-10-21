// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Room sources and templates ────────────────────────────────────────────

export function saveRoomSource(
  db: Database,
  opts: { roomId: string; source: string; authorId: string; authorName: string; valid?: boolean },
): number {
  const version = getLatestRoomSourceVersion(db, opts.roomId) + 1;
  db.run(
    `INSERT INTO room_sources (room_id, version, source, author_id, author_name, valid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.roomId,
      version,
      opts.source,
      opts.authorId,
      opts.authorName,
      opts.valid ? 1 : 0,
      Date.now(),
    ],
  );
  return version;
}

export function getRoomSource(
  db: Database,
  roomId: string,
  version?: number,
): RoomSourceRow | undefined {
  if (version !== undefined) {
    return (
      (db
        .query("SELECT * FROM room_sources WHERE room_id = ? AND version = ?")
        .get(roomId, version) as RoomSourceRow | null) ?? undefined
    );
  }
  // Latest version
  return (
    (db
      .query("SELECT * FROM room_sources WHERE room_id = ? ORDER BY version DESC LIMIT 1")
      .get(roomId) as RoomSourceRow | null) ?? undefined
  );
}

export function getRoomSourceHistory(db: Database, roomId: string, limit = 20): RoomSourceRow[] {
  return db
    .query("SELECT * FROM room_sources WHERE room_id = ? ORDER BY version DESC LIMIT ?")
    .all(roomId, limit) as RoomSourceRow[];
}

export function getLatestRoomSourceVersion(db: Database, roomId: string): number {
  const row = db
    .query("SELECT MAX(version) as max_version FROM room_sources WHERE room_id = ?")
    .get(roomId) as { max_version: number | null } | null;
  return row?.max_version ?? 0;
}

export function getAllRoomSourceIds(db: Database): string[] {
  return (
    db.query("SELECT DISTINCT room_id FROM room_sources ORDER BY room_id").all() as {
      room_id: string;
    }[]
  ).map((r) => r.room_id);
}

export function markRoomSourceValid(db: Database, roomId: string, version: number): void {
  db.run("UPDATE room_sources SET valid = 1 WHERE room_id = ? AND version = ?", [roomId, version]);
}

export function deleteRoomSources(db: Database, roomId: string): void {
  db.run("DELETE FROM room_sources WHERE room_id = ?", [roomId]);
}

export function saveRoomTemplate(
  db: Database,
  opts: {
    name: string;
    source: string;
    authorId: string;
    authorName: string;
    description?: string;
  },
): void {
  db.run(
    `INSERT OR REPLACE INTO room_templates (name, source, author_id, author_name, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [opts.name, opts.source, opts.authorId, opts.authorName, opts.description ?? "", Date.now()],
  );
}

export function getRoomTemplate(db: Database, name: string): RoomTemplateRow | undefined {
  return (
    (db.query("SELECT * FROM room_templates WHERE name = ?").get(name) as RoomTemplateRow | null) ??
    undefined
  );
}

export function getAllRoomTemplates(db: Database): RoomTemplateRow[] {
  return db.query("SELECT * FROM room_templates ORDER BY name").all() as RoomTemplateRow[];
}

export function deleteRoomTemplate(db: Database, name: string): void {
  db.run("DELETE FROM room_templates WHERE name = ?", [name]);
}

export function clearDynamicRooms(db: Database): void {
  db.run("DELETE FROM room_sources");
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface RoomSourceRow {
  room_id: string;
  version: number;
  source: string;
  author_id: string;
  author_name: string;
  valid: number;
  created_at: number;
}

export interface RoomTemplateRow {
  name: string;
  source: string;
  author_id: string;
  author_name: string;
  description: string;
  created_at: number;
}

// ─── Room log (migration 175) ──────────────────────────────────────────────

/** Most recent entries kept per room; older ones are pruned on write. */
export const ROOM_LOG_KEEP = 200;

export type RoomLogKind = "say" | "emote" | "arrive" | "leave";

export interface RoomLogInput {
  room: string;
  entity: string;
  kind: RoomLogKind;
  content: string;
  cause?: string;
  depth?: number;
  at: number;
}

export interface RoomLogRow {
  id: number;
  room: string;
  entity: string;
  kind: RoomLogKind;
  content: string;
  cause: string | null;
  depth: number;
  at: number;
}

export function appendRoomLog(db: Database, entry: RoomLogInput): number {
  const { id } = db
    .query(
      `INSERT INTO room_log (room, entity, kind, content, cause, depth, at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      entry.room,
      entry.entity,
      entry.kind,
      entry.content,
      entry.cause ?? null,
      Math.max(0, Math.floor(entry.depth ?? 0)),
      entry.at,
    ) as { id: number };
  db.run(
    `DELETE FROM room_log WHERE room = ? AND id <= (
       SELECT id FROM room_log WHERE room = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    [entry.room, entry.room, ROOM_LOG_KEEP],
  );
  return id;
}

/** Oldest-first entries of a room since `since` (ms epoch), newest `limit` of them. */
export function readRoomLog(db: Database, room: string, since = 0, limit = 50): RoomLogRow[] {
  const rows = db
    .query("SELECT * FROM room_log WHERE room = ? AND at >= ? ORDER BY id DESC LIMIT ?")
    .all(room, since, Math.max(1, Math.min(ROOM_LOG_KEEP, limit))) as RoomLogRow[];
  return rows.reverse();
}
