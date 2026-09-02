// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import type { LogEntry, LogLevel } from "../engine/logger";
import { escapeLike } from "./fts";

export interface LogQuery {
  limit?: number;
  beforeId?: number;
  level?: LogLevel;
  category?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  entityId?: string;
  q?: string;
  since?: number;
  until?: number;
}

export interface StoredLogEntry extends LogEntry {
  id: number;
}

export interface LogPage {
  logs: StoredLogEntry[];
  hasMore: boolean;
  nextCursor?: string;
}

export function appendLog(db: Database, entry: LogEntry): number {
  const result = db.run(
    `INSERT INTO structured_logs
      (timestamp, level, category, message, data, trace_id, span_id, request_id, entity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.timestamp,
      entry.level,
      entry.category,
      entry.message,
      entry.data ? JSON.stringify(entry.data) : null,
      entry.traceId ?? null,
      entry.spanId ?? null,
      entry.requestId ?? null,
      entry.entityId ?? null,
    ],
  );
  return Number(result.lastInsertRowid);
}

export function queryLogs(db: Database, input: LogQuery = {}): LogPage {
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 100), 500));
  const where: string[] = [];
  const params: Array<string | number> = [];
  const add = (sql: string, value: string | number | undefined) => {
    if (value === undefined || value === "") return;
    where.push(sql);
    params.push(value);
  };
  add("id < ?", input.beforeId);
  add("level = ?", input.level);
  add("category = ?", input.category);
  add("trace_id = ?", input.traceId);
  add("span_id = ?", input.spanId);
  add("request_id = ?", input.requestId);
  add("entity_id = ?", input.entityId);
  add("timestamp >= ?", input.since);
  add("timestamp <= ?", input.until);
  if (input.q?.trim()) {
    where.push("(message LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(input.q.trim())}%`;
    params.push(pattern, pattern);
  }
  params.push(limit + 1);
  const rows = db
    .query(
      `SELECT id, timestamp, level, category, message, data,
              trace_id, span_id, request_id, entity_id
       FROM structured_logs
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...params) as LogRow[];
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  return {
    logs: pageRows.map(toStoredLog),
    hasMore,
    ...(hasMore && pageRows.length > 0
      ? { nextCursor: encodeCursor(pageRows[pageRows.length - 1]!.id) }
      : {}),
  };
}

export function decodeLogCursor(cursor: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid log cursor.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== "log.v1") {
    throw new Error("Invalid log cursor.");
  }
  const id = parsed[1];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Invalid log cursor.");
  }
  return id;
}

export function pruneLogs(db: Database, keepLast: number): number {
  const keep = Math.max(0, Math.trunc(keepLast));
  if (keep === 0) return db.run("DELETE FROM structured_logs").changes;
  return db.run(
    `DELETE FROM structured_logs
     WHERE id < COALESCE((SELECT id FROM structured_logs ORDER BY id DESC LIMIT 1 OFFSET ?), 0)`,
    [keep - 1],
  ).changes;
}

function encodeCursor(id: number): string {
  return Buffer.from(JSON.stringify(["log.v1", id]), "utf8").toString("base64url");
}

interface LogRow {
  id: number;
  timestamp: number;
  level: LogLevel;
  category: string;
  message: string;
  data: string | null;
  trace_id: string | null;
  span_id: string | null;
  request_id: string | null;
  entity_id: string | null;
}

function toStoredLog(row: LogRow): StoredLogEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    level: row.level,
    category: row.category,
    message: row.message,
    ...(row.data ? { data: JSON.parse(row.data) as Record<string, unknown> } : {}),
    ...(row.trace_id ? { traceId: row.trace_id } : {}),
    ...(row.span_id ? { spanId: row.span_id } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.entity_id ? { entityId: row.entity_id } : {}),
  };
}
