// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Durable direct-message receipts ───────────────────────────────────────

export function createDirectMessage(
  db: Database,
  message: {
    correlationId: string;
    dedupeKey: string;
    senderId: string;
    senderName: string;
    targetId: string;
    targetName: string;
    content: string;
    deadlineAt?: number;
    /** Causal envelope (`src/engine/message-envelope.ts`). */
    cause?: string;
    depth?: number;
  },
): DirectMessageRow {
  const now = Date.now();
  expireDirectMessages(db, now);
  const duplicate = db
    .query(
      `SELECT * FROM direct_messages WHERE sender_id = ? AND target_id = ? AND dedupe_key = ?
         AND created_at >= ? AND status IN ('delivered', 'acknowledged') ORDER BY id DESC LIMIT 1`,
    )
    .get(
      message.senderId,
      message.targetId,
      message.dedupeKey,
      now - 30_000,
    ) as DirectMessageRow | null;
  if (duplicate) return duplicate;
  const result = db.run(
    `INSERT INTO direct_messages
       (correlation_id, dedupe_key, sender_id, sender_name, target_id, target_name, content,
        status, created_at, delivered_at, deadline_at, cause, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?, ?)`,
    [
      message.correlationId,
      message.dedupeKey,
      message.senderId,
      message.senderName,
      message.targetId,
      message.targetName,
      message.content,
      now,
      now,
      message.deadlineAt ?? now + 5 * 60_000,
      message.cause ?? null,
      message.depth ?? 0,
    ],
  );
  return getDirectMessage(db, Number(result.lastInsertRowid))!;
}

/** How long a tell waits for an offline account to connect before it expires. */
export const QUEUED_TELL_TTL_MS = 30 * 24 * 60 * 60_000;
/** The most tells one sender may have waiting for one offline account. */
export const QUEUED_TELLS_PER_SENDER = 20;

/**
 * A tell for an account that is not connected: stored `queued` against the
 * account's durable id (entity ids are per session) and handed over by
 * `takeQueuedDirectMessages` when the account next connects. The same text
 * from the same sender while one is waiting returns the waiting row; a sender
 * with `QUEUED_TELLS_PER_SENDER` waiting for this account gets `full`.
 */
export function queueDirectMessage(
  db: Database,
  message: {
    correlationId: string;
    dedupeKey: string;
    senderId: string;
    senderName: string;
    accountId: string;
    targetName: string;
    content: string;
    cause?: string;
    depth?: number;
  },
): { row: DirectMessageRow; duplicate: boolean } | { full: true } {
  const now = Date.now();
  expireDirectMessages(db, now);
  const duplicate = db
    .query(
      `SELECT * FROM direct_messages WHERE sender_name = ? AND target_id = ? AND dedupe_key = ?
         AND status = 'queued' ORDER BY id DESC LIMIT 1`,
    )
    .get(message.senderName, message.accountId, message.dedupeKey) as DirectMessageRow | null;
  if (duplicate) return { row: duplicate, duplicate: true };
  const waiting = (
    db
      .query(
        `SELECT count(*) AS n FROM direct_messages
           WHERE sender_name = ? AND target_id = ? AND status = 'queued'`,
      )
      .get(message.senderName, message.accountId) as { n: number }
  ).n;
  if (waiting >= QUEUED_TELLS_PER_SENDER) return { full: true };
  const result = db.run(
    `INSERT INTO direct_messages
       (correlation_id, dedupe_key, sender_id, sender_name, target_id, target_name, content,
        status, created_at, delivered_at, deadline_at, cause, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?)`,
    [
      message.correlationId,
      message.dedupeKey,
      message.senderId,
      message.senderName,
      message.accountId,
      message.targetName,
      message.content,
      now,
      message.cause ?? null,
      message.depth ?? 0,
    ],
  );
  return { row: getDirectMessage(db, Number(result.lastInsertRowid))!, duplicate: false };
}

/**
 * Hand the tells waiting for an account to its live entity: each becomes an
 * ordinary `delivered` receipt addressed to `entityId` (so `tell inbox`,
 * `tell ack` and `re` work on it) and is returned, oldest first, to be shown.
 */
export function takeQueuedDirectMessages(
  db: Database,
  accountId: string,
  entityId: string,
  now = Date.now(),
): DirectMessageRow[] {
  expireDirectMessages(db, now);
  const rows = db
    .query(
      `SELECT * FROM direct_messages WHERE target_id = ? AND status = 'queued' ORDER BY id ASC`,
    )
    .all(accountId) as DirectMessageRow[];
  if (rows.length === 0) return [];
  db.run(
    `UPDATE direct_messages SET status = 'delivered', target_id = ?, delivered_at = ?
       WHERE target_id = ? AND status = 'queued'`,
    [entityId, now, accountId],
  );
  return rows.map((row) => ({
    ...row,
    status: "delivered",
    target_id: entityId,
    delivered_at: now,
  }));
}

export function getDirectMessage(db: Database, id: number): DirectMessageRow | undefined {
  expireDirectMessages(db);
  return (
    (db.query("SELECT * FROM direct_messages WHERE id = ?").get(id) as DirectMessageRow | null) ??
    undefined
  );
}

export function listDirectMessageInbox(
  db: Database,
  targetId: string,
  limit = 20,
): DirectMessageRow[] {
  expireDirectMessages(db);
  return db
    .query("SELECT * FROM direct_messages WHERE target_id = ? ORDER BY id DESC LIMIT ?")
    .all(targetId, limit) as DirectMessageRow[];
}

/**
 * The recipient answered or acknowledged a tell. A tell past its deadline
 * (`expired` = unanswered in time) is still settled by a late answer: the
 * reply happened, so the receipt says so, and `acknowledged_at` after
 * `deadline_at` keeps the lateness visible. Expiry never removes content,
 * so nothing is restored here.
 */
export function acknowledgeDirectMessage(
  db: Database,
  id: number,
  targetId: string,
  replyMessageId?: number,
): boolean {
  const result = db.run(
    `UPDATE direct_messages SET status = 'acknowledged', acknowledged_at = ?,
       reply_message_id = COALESCE(?, reply_message_id)
       WHERE id = ? AND target_id = ? AND status IN ('delivered', 'expired')`,
    [Date.now(), replyMessageId ?? null, id, targetId],
  );
  return result.changes > 0;
}

export function expireDirectMessages(db: Database, now = Date.now()): number {
  const result = db.run(
    `UPDATE direct_messages SET status = 'expired'
       WHERE (status = 'delivered' AND deadline_at IS NOT NULL AND deadline_at <= ?)
          OR (status = 'queued' AND created_at <= ?)`,
    [now, now - QUEUED_TELL_TTL_MS],
  );
  return result.changes;
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface DirectMessageRow {
  id: number;
  correlation_id: string;
  dedupe_key: string;
  sender_id: string;
  sender_name: string;
  target_id: string;
  target_name: string;
  content: string;
  /** `queued`: waiting for an offline account (`target_id` is then the account id). */
  status: "queued" | "delivered" | "acknowledged" | "expired";
  created_at: number;
  delivered_at: number | null;
  deadline_at: number | null;
  acknowledged_at: number | null;
  reply_message_id: number | null;
  /** Ref of the message this one answers (migration 171), or null. */
  cause: string | null;
  /** Causal depth: the cause's depth + 1, else 0. */
  depth: number;
}
