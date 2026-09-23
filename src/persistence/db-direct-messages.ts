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
        status, created_at, delivered_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?)`,
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
    ],
  );
  return getDirectMessage(db, Number(result.lastInsertRowid))!;
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

export function acknowledgeDirectMessage(
  db: Database,
  id: number,
  targetId: string,
  replyMessageId?: number,
): boolean {
  const result = db.run(
    `UPDATE direct_messages SET status = 'acknowledged', acknowledged_at = ?,
       reply_message_id = COALESCE(?, reply_message_id)
       WHERE id = ? AND target_id = ? AND status = 'delivered'`,
    [Date.now(), replyMessageId ?? null, id, targetId],
  );
  return result.changes > 0;
}

export function expireDirectMessages(db: Database, now = Date.now()): number {
  const result = db.run(
    `UPDATE direct_messages SET status = 'expired'
       WHERE status = 'delivered' AND deadline_at IS NOT NULL AND deadline_at <= ?`,
    [now],
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
  status: "delivered" | "acknowledged" | "expired";
  created_at: number;
  delivered_at: number | null;
  deadline_at: number | null;
  acknowledged_at: number | null;
  reply_message_id: number | null;
}
