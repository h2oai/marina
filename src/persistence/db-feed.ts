// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

export interface FeedEventRow {
  id: number;
  kind: string;
  entity: string | null;
  ref: string | null;
  summary: string;
  payload: string | null;
  created_at: number;
}

export interface InsertFeedEvent {
  kind: string;
  entity?: string;
  ref?: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export function insertFeedEvent(db: Database, event: InsertFeedEvent): number {
  const result = db.run(
    "INSERT INTO feed_events (kind, entity, ref, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      event.kind,
      event.entity ?? null,
      event.ref ?? null,
      event.summary,
      event.payload ? JSON.stringify(event.payload) : null,
      Date.now(),
    ],
  );
  return Number(result.lastInsertRowid);
}

export interface FeedQuery {
  since?: number;
  until?: number;
  kind?: string;
  entity?: string;
  limit?: number;
}

export function queryFeedEvents(db: Database, q: FeedQuery = {}): FeedEventRow[] {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (q.since !== undefined) {
    clauses.push("created_at >= ?");
    args.push(q.since);
  }
  if (q.until !== undefined) {
    clauses.push("created_at <= ?");
    args.push(q.until);
  }
  if (q.kind) {
    clauses.push("kind = ?");
    args.push(q.kind);
  }
  if (q.entity) {
    clauses.push("entity = ?");
    args.push(q.entity);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 500);
  args.push(limit);
  return db
    .query(`SELECT * FROM feed_events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...args) as FeedEventRow[];
}

/** Hard cap — drop rows older than the cutoff. Called periodically so the table doesn't grow unbounded. */
export function trimFeedEvents(db: Database, keepMs: number): number {
  const cutoff = Date.now() - keepMs;
  const result = db.run("DELETE FROM feed_events WHERE created_at < ?", [cutoff]);
  return result.changes;
}
