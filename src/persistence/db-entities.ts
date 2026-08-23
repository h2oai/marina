// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import type { Session } from "../auth/session-manager";
import type { EngineEvent, Entity, EntityId, RoomId } from "../types";

// ─── Entity Persistence ─────────────────────────────────────────────────

export function saveEntity(db: Database, entity: Entity): void {
  db.run(
    `INSERT OR REPLACE INTO entities (id, kind, name, short, long, room, properties, inventory, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entity.id,
      entity.kind,
      entity.name,
      entity.short,
      entity.long,
      entity.room,
      JSON.stringify(entity.properties),
      JSON.stringify(entity.inventory),
      entity.createdAt,
    ],
  );
}

export function loadEntity(reader: Database, id: EntityId): Entity | undefined {
  const row = reader.query("SELECT * FROM entities WHERE id = ?").get(id) as EntityRow | null;
  if (!row) return undefined;
  return rowToEntity(row);
}

export function loadAllEntities(reader: Database): Entity[] {
  const rows = reader.query("SELECT * FROM entities").all() as EntityRow[];
  return rows.map(rowToEntity);
}

export function deleteEntity(db: Database, id: EntityId): void {
  db.run("DELETE FROM entities WHERE id = ?", [id]);
}

export function loadEntitiesInRoom(db: Database, room: RoomId): Entity[] {
  const rows = db.query("SELECT * FROM entities WHERE room = ?").all(room) as EntityRow[];
  return rows.map(rowToEntity);
}

// ─── Room Key-Value Store ───────────────────────────────────────────────

export function getRoomStoreValue(reader: Database, roomId: RoomId, key: string): unknown {
  const row = reader
    .query("SELECT value FROM room_store WHERE room_id = ? AND key = ?")
    .get(roomId, key) as { value: string } | null;
  if (!row) return undefined;
  return JSON.parse(row.value);
}

export function setRoomStoreValue(db: Database, roomId: RoomId, key: string, value: unknown): void {
  db.run("INSERT OR REPLACE INTO room_store (room_id, key, value) VALUES (?, ?, ?)", [
    roomId,
    key,
    JSON.stringify(value),
  ]);
}

export function deleteRoomStoreValue(db: Database, roomId: RoomId, key: string): void {
  db.run("DELETE FROM room_store WHERE room_id = ? AND key = ?", [roomId, key]);
}

export function getRoomStoreKeys(reader: Database, roomId: RoomId): string[] {
  const rows = reader.query("SELECT key FROM room_store WHERE room_id = ?").all(roomId) as {
    key: string;
  }[];
  return rows.map((r) => r.key);
}

// ─── Event Log ──────────────────────────────────────────────────────────

export function logEvent(db: Database, event: EngineEvent): void {
  db.run("INSERT INTO event_log (type, data, timestamp) VALUES (?, ?, ?)", [
    event.type,
    JSON.stringify(event),
    event.timestamp,
  ]);
}

export function getRecentEvents(db: Database, limit = 100): EngineEvent[] {
  const rows = db.query("SELECT data FROM event_log ORDER BY id DESC LIMIT ?").all(limit) as {
    data: string;
  }[];
  return rows.map((r) => JSON.parse(r.data) as EngineEvent).reverse();
}

export function getRecentTraceEvents(
  db: Database,
  limit = 5000,
  traceId?: string,
): { events: EngineEvent[]; truncated: boolean } {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));
  const params: Array<string | number> = [
    "model_request_lifecycle",
    "agent_turn_start",
    "agent_turn_end",
    "agent_tool_call",
    "agent_tool_result",
  ];
  const traceFilter = traceId ? " AND json_extract(data, '$.traceId') = ?" : "";
  if (traceId) params.push(traceId);
  params.push(boundedLimit + 1);
  const rows = db
    .query(
      `SELECT data FROM event_log
       WHERE type IN (?, ?, ?, ?, ?)
         AND json_extract(data, '$.traceId') IS NOT NULL${traceFilter}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...params) as { data: string }[];
  const truncated = rows.length > boundedLimit;
  return {
    events: rows
      .slice(0, boundedLimit)
      .map((row) => JSON.parse(row.data) as EngineEvent)
      .reverse(),
    truncated,
  };
}

export interface TraceJudgmentInput {
  traceId: string;
  evaluatorEntity: string;
  verdict: "passed" | "failed" | "inconclusive";
  criterion: string;
  rationale: string;
  evidenceSpanIds: string[];
}

export interface TraceJudgmentRow {
  id: string;
  traceId: string;
  evaluatorEntity: string;
  verdict: TraceJudgmentInput["verdict"];
  criterion: string;
  rationale: string;
  evidenceSpanIds: string[];
  createdAt: number;
}

export function addTraceJudgment(db: Database, input: TraceJudgmentInput): TraceJudgmentRow {
  const row: TraceJudgmentRow = {
    id: `tj-${crypto.randomUUID()}`,
    traceId: cleanJudgmentText(input.traceId),
    evaluatorEntity: cleanJudgmentText(input.evaluatorEntity),
    verdict: input.verdict,
    criterion: cleanJudgmentText(input.criterion),
    rationale: cleanJudgmentText(input.rationale),
    evidenceSpanIds: [...new Set(input.evidenceSpanIds.map(cleanJudgmentText))],
    createdAt: Date.now(),
  };
  if (!row.traceId || !row.evaluatorEntity || !row.criterion || !row.rationale) {
    throw new Error(
      "Trace judgment attribution, criterion, and rationale must contain visible text",
    );
  }
  db.query(
    `INSERT INTO trace_judgments
      (id, trace_id, evaluator_entity, verdict, criterion, rationale, evidence_span_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.traceId,
    row.evaluatorEntity,
    row.verdict,
    row.criterion,
    row.rationale,
    JSON.stringify(row.evidenceSpanIds),
    row.createdAt,
  );
  return row;
}

function cleanJudgmentText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
}

export function getTraceJudgments(db: Database, traceId: string, limit = 100): TraceJudgmentRow[] {
  const rows = db
    .query(
      `SELECT id, trace_id, evaluator_entity, verdict, criterion, rationale,
              evidence_span_ids, created_at
       FROM trace_judgments WHERE trace_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(traceId, Math.max(1, Math.min(Math.trunc(limit), 500))) as Array<{
    id: string;
    trace_id: string;
    evaluator_entity: string;
    verdict: TraceJudgmentRow["verdict"];
    criterion: string;
    rationale: string;
    evidence_span_ids: string;
    created_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    traceId: row.trace_id,
    evaluatorEntity: row.evaluator_entity,
    verdict: row.verdict,
    criterion: row.criterion,
    rationale: row.rationale,
    evidenceSpanIds: JSON.parse(row.evidence_span_ids) as string[],
    createdAt: row.created_at,
  }));
}

export function getEventCount(db: Database): number {
  const row = db.query("SELECT COUNT(*) as count FROM event_log").get() as {
    count: number;
  };
  return row.count;
}

export function pruneEvents(db: Database, keepLast: number): void {
  db.run(
    "DELETE FROM event_log WHERE id NOT IN (SELECT id FROM event_log ORDER BY id DESC LIMIT ?)",
    [keepLast],
  );
}

// ─── Session Persistence ─────────────────────────────────────────────────

export function saveSession(db: Database, session: Session): void {
  db.run(
    `INSERT OR REPLACE INTO sessions (token, entity_id, name, created_at, last_seen, expires_at, granted_rank)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      session.token,
      session.entityId,
      session.name,
      session.createdAt,
      session.lastSeen,
      session.expiresAt,
      session.grantedRank ?? null,
    ],
  );
}

export function loadSession(db: Database, token: string): Session | undefined {
  const row = db.query("SELECT * FROM sessions WHERE token = ?").get(token) as SessionRow | null;
  if (!row) return undefined;
  return rowToSession(row);
}

export function deleteSession(db: Database, token: string): void {
  db.run("DELETE FROM sessions WHERE token = ?", [token]);
}

export function deleteSessionsByEntity(db: Database, entityId: EntityId): void {
  db.run("DELETE FROM sessions WHERE entity_id = ?", [entityId]);
}

export function deleteExpiredSessions(db: Database, now: number): number {
  const result = db.run("DELETE FROM sessions WHERE expires_at < ?", [now]);
  return result.changes;
}

export function loadSessionByEntity(db: Database, entityId: EntityId): Session | undefined {
  const row = db
    .query("SELECT * FROM sessions WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(entityId) as SessionRow | null;
  if (!row) return undefined;
  return rowToSession(row);
}

// ─── Bulk Operations ────────────────────────────────────────────────────

export function saveAllEntities(db: Database, entities: Entity[]): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO entities (id, kind, name, short, long, room, properties, inventory, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const saveAll = db.transaction(() => {
    for (const entity of entities) {
      insert.run(
        entity.id,
        entity.kind,
        entity.name,
        entity.short,
        entity.long,
        entity.room,
        JSON.stringify(entity.properties),
        JSON.stringify(entity.inventory),
        entity.createdAt,
      );
    }
  });

  saveAll();
}

// ─── Entity Activity Tracking ─────────────────────────────────────────

export function trackActivity(
  db: Database,
  entityName: string,
  activityType: string,
  activityKey: string,
  success?: boolean,
): void {
  const now = Date.now();
  const successInc = success === true ? 1 : 0;
  const failInc = success === false ? 1 : 0;
  db.run(
    `INSERT INTO entity_activity (entity_name, activity_type, activity_key, count, success_count, fail_count, first_seen, last_seen)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(entity_name, activity_type, activity_key)
     DO UPDATE SET count = count + 1, success_count = success_count + ?, fail_count = fail_count + ?, last_seen = ?`,
    [
      entityName,
      activityType,
      activityKey,
      successInc,
      failInc,
      now,
      now,
      successInc,
      failInc,
      now,
    ],
  );
}

export function getActivityStats(
  db: Database,
  entityName: string,
): {
  roomsVisited: number;
  uniqueCommands: number;
  entitiesInteracted: number;
  totalActions: number;
} {
  const rooms = db
    .query(
      "SELECT COUNT(*) as c FROM entity_activity WHERE entity_name = ? AND activity_type = 'room_visit'",
    )
    .get(entityName) as { c: number };
  const commands = db
    .query(
      "SELECT COUNT(*) as c FROM entity_activity WHERE entity_name = ? AND activity_type = 'command'",
    )
    .get(entityName) as { c: number };
  const entities = db
    .query(
      "SELECT COUNT(*) as c FROM entity_activity WHERE entity_name = ? AND activity_type = 'interaction'",
    )
    .get(entityName) as { c: number };
  const total = db
    .query("SELECT COALESCE(SUM(count), 0) as c FROM entity_activity WHERE entity_name = ?")
    .get(entityName) as { c: number };
  return {
    roomsVisited: rooms.c,
    uniqueCommands: commands.c,
    entitiesInteracted: entities.c,
    totalActions: total.c,
  };
}

export function getLastActivityAt(db: Database, entityName: string): number | null {
  const row = db
    .query("SELECT MAX(last_seen) as t FROM entity_activity WHERE entity_name = ?")
    .get(entityName) as { t: number | null } | null;
  return row?.t ?? null;
}

export function getRoomVisitCount(db: Database, entityName: string, roomId: string): number {
  const row = db
    .query(
      "SELECT count FROM entity_activity WHERE entity_name = ? AND activity_type = 'room_visit' AND activity_key = ?",
    )
    .get(entityName, roomId) as { count: number } | null;
  return row?.count ?? 0;
}

export function getActivityByType(
  db: Database,
  entityName: string,
  activityType: string,
  limit = 20,
): { key: string; count: number; successCount: number; failCount: number; lastSeen: number }[] {
  return db
    .query(
      "SELECT activity_key, count, success_count, fail_count, last_seen FROM entity_activity WHERE entity_name = ? AND activity_type = ? ORDER BY count DESC LIMIT ?",
    )
    .all(entityName, activityType, limit)
    .map((row: unknown) => {
      const r = row as {
        activity_key: string;
        count: number;
        success_count: number;
        fail_count: number;
        last_seen: number;
      };
      return {
        key: r.activity_key,
        count: r.count,
        successCount: r.success_count,
        failCount: r.fail_count,
        lastSeen: r.last_seen,
      };
    });
}

// ─── Event Queries (for observe) ──────────────────────────────────────

export function getEventsByEntity(
  db: Database,
  entityId: string,
  limit = 20,
): { type: string; input?: string; timestamp: number }[] {
  return db
    .query(
      "SELECT type, data, timestamp FROM event_log WHERE json_extract(data, '$.entity') = ? ORDER BY id DESC LIMIT ?",
    )
    .all(entityId, limit)
    .map((row: unknown) => {
      const r = row as { type: string; data: string; timestamp: number };
      const data = JSON.parse(r.data) as Record<string, unknown>;
      return {
        type: r.type,
        input: data.input as string | undefined,
        timestamp: r.timestamp,
      };
    });
}

export function getEntityCommandCount(db: Database, entityId: string): number {
  const row = db
    .query(
      "SELECT COUNT(*) as count FROM event_log WHERE type = 'command' AND json_extract(data, '$.entity') = ?",
    )
    .get(entityId) as { count: number };
  return row.count;
}

export function getLastActivity(
  db: Database,
  entityId: string,
): { type: string; timestamp: number; input?: string } | undefined {
  const row = db
    .query(
      "SELECT type, data, timestamp FROM event_log WHERE json_extract(data, '$.entity') = ? ORDER BY id DESC LIMIT 1",
    )
    .get(entityId) as { type: string; data: string; timestamp: number } | null;
  if (!row) return undefined;
  const data = JSON.parse(row.data) as Record<string, unknown>;
  return {
    type: row.type,
    timestamp: row.timestamp,
    input: data.input as string | undefined,
  };
}

export function getActiveEntities(
  db: Database,
  sinceMs: number,
): { entityId: string; commandCount: number; lastActivity: number }[] {
  const now = Date.now();
  const cutoff = now < 0 ? Number.MIN_SAFE_INTEGER : now - sinceMs;
  return db
    .query(
      `SELECT json_extract(data, '$.entity') as entity_id,
              COUNT(*) as command_count,
              MAX(timestamp) as last_activity
       FROM event_log
       WHERE type = 'command' AND timestamp > ? AND json_extract(data, '$.entity') IS NOT NULL
       GROUP BY json_extract(data, '$.entity')`,
    )
    .all(cutoff)
    .map((row: unknown) => {
      const r = row as { entity_id: string; command_count: number; last_activity: number };
      return {
        entityId: r.entity_id,
        commandCount: r.command_count,
        lastActivity: r.last_activity,
      };
    });
}

// ─── Entity Migration ───────────────────────────────────────────────────

export function migrateEntityId(db: Database, oldId: string, newId: string): void {
  db.transaction(() => {
    db.run("UPDATE OR REPLACE channel_members SET entity_id = ? WHERE entity_id = ?", [
      newId,
      oldId,
    ]);
    db.run("UPDATE OR REPLACE group_members SET entity_id = ? WHERE entity_id = ?", [newId, oldId]);
    db.run("UPDATE groups_ SET leader_id = ? WHERE leader_id = ?", [newId, oldId]);
    db.run("UPDATE task_claims SET entity_id = ? WHERE entity_id = ?", [newId, oldId]);
    db.run("UPDATE OR REPLACE board_votes SET entity_id = ? WHERE entity_id = ?", [newId, oldId]);
    db.run("UPDATE OR REPLACE entity_standing SET entity_id = ? WHERE entity_id = ?", [
      newId,
      oldId,
    ]);
    db.run("UPDATE board_posts SET author_id = ? WHERE author_id = ?", [newId, oldId]);
    db.run("UPDATE macros SET author_id = ? WHERE author_id = ?", [newId, oldId]);
  })();
}

export function migrateTaskClaimsByName(db: Database, entityName: string, newId: string): void {
  db.run(
    "UPDATE task_claims SET entity_id = ? WHERE entity_name = ? AND status IN ('claimed', 'submitted')",
    [newId, entityName],
  );
}

export function getActiveClaimsByName(
  db: Database,
  entityName: string,
): {
  task_id: number;
  title: string;
  status: string;
  priority: number;
  progress: number;
  claimed_at: number;
}[] {
  return db
    .query(
      `SELECT tc.task_id, t.title, tc.status, t.priority, t.progress, tc.claimed_at
       FROM task_claims tc JOIN tasks t ON tc.task_id = t.id
       WHERE tc.entity_name = ? AND tc.status IN ('claimed', 'submitted')
       ORDER BY t.priority DESC, tc.claimed_at DESC`,
    )
    .all(entityName) as {
    task_id: number;
    title: string;
    status: string;
    priority: number;
    progress: number;
    claimed_at: number;
  }[];
}

export function getRecentActivity(
  db: Database,
  entityName: string,
  limit = 5,
): { activity_type: string; activity_key: string; count: number; last_seen: number }[] {
  return db
    .query(
      `SELECT activity_type, activity_key, count, last_seen
       FROM entity_activity
       WHERE entity_name = ?
       ORDER BY last_seen DESC
       LIMIT ?`,
    )
    .all(entityName, limit) as {
    activity_type: string;
    activity_key: string;
    count: number;
    last_seen: number;
  }[];
}

// ─── Row Types & Helpers ────────────────────────────────────────────────

interface EntityRow {
  id: string;
  kind: string;
  name: string;
  short: string;
  long: string;
  room: string;
  properties: string;
  inventory: string;
  created_at: number;
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id as EntityId,
    kind: row.kind as Entity["kind"],
    name: row.name,
    short: row.short,
    long: row.long,
    room: row.room as RoomId,
    properties: JSON.parse(row.properties) as Record<string, unknown>,
    inventory: JSON.parse(row.inventory) as EntityId[],
    createdAt: row.created_at,
  };
}

interface SessionRow {
  token: string;
  entity_id: string;
  name: string;
  created_at: number;
  last_seen: number;
  expires_at: number;
  granted_rank: number | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    token: row.token,
    entityId: row.entity_id as EntityId,
    name: row.name,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    expiresAt: row.expires_at,
    grantedRank: row.granted_rank ?? undefined,
  };
}
