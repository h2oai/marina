// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { RoutingError } from "../routing/errors";
import type {
  RoutingChannelMessage,
  RoutingChannelPage,
  RoutingChannelReceipt,
  RoutingEvent,
  RoutingEventInput,
  RoutingEventPage,
  RoutingJoin,
  RoutingMessage,
  RoutingSend,
  RoutingSession,
  RoutingSessionPage,
} from "../sdk/routing-types";
import * as channelsDb from "./db-channels";

const SESSION_COLUMNS = `id, owner_id AS ownerId, client_key AS clientKey, label, kind,
  group_id AS groupId, capabilities, state, created_at AS createdAt,
  last_seen_at AS lastSeenAt, last_sequence AS lastSequence`;
const EVENT_COLUMNS = `event_id AS id, session_id AS sessionId, sequence, kind, payload,
  created_at AS createdAt`;
const MESSAGE_COLUMNS = `id, source_id AS sourceId, target_id AS targetId,
  client_message_id AS clientMessageId, kind, payload, status,
  created_at AS createdAt, acknowledged_at AS acknowledgedAt`;
function session(row: unknown): RoutingSession {
  const r = row as RoutingSession & { capabilities: string };
  return { ...r, capabilities: JSON.parse(r.capabilities) };
}
function payload<T extends { payload: unknown }>(row: unknown): T {
  const r = row as T & { payload: string };
  return { ...r, payload: JSON.parse(r.payload) };
}
function conflict(): never {
  throw new RoutingError(409, "id_conflict", "Idempotency key already used with different content");
}

export function getRoutingSession(db: Database, id: string): RoutingSession | null {
  const row = db.query(`SELECT ${SESSION_COLUMNS} FROM routing_sessions WHERE id = ?`).get(id);
  return row ? session(row) : null;
}

export function joinRoutingSession(
  db: Database,
  ownerId: string,
  input: RoutingJoin,
): RoutingSession {
  return db.transaction(() => {
    const row = db
      .query(`SELECT ${SESSION_COLUMNS} FROM routing_sessions
      WHERE owner_id = ? AND client_key = ?`)
      .get(ownerId, input.clientKey);
    if (row) {
      const existing = session(row);
      if (
        existing.groupId !== (input.groupId ?? null) ||
        existing.kind !== input.kind ||
        existing.label !== input.label ||
        JSON.stringify(existing.capabilities) !== JSON.stringify(input.capabilities ?? [])
      )
        conflict();
      db.run("UPDATE routing_sessions SET state = 'active', last_seen_at = ? WHERE id = ?", [
        Date.now(),
        existing.id,
      ]);
      return getRoutingSession(db, existing.id)!;
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    db.run(
      `INSERT INTO routing_sessions
      (id, owner_id, client_key, label, kind, group_id, capabilities, state, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        ownerId,
        input.clientKey,
        input.label,
        input.kind,
        input.groupId ?? null,
        JSON.stringify(input.capabilities ?? []),
        now,
        now,
      ],
    );
    return getRoutingSession(db, id)!;
  })();
}

/** Visibility is filtered before pagination. Group membership is checked on every read. */
export function listRoutingSessions(
  db: Database,
  ownerId: string,
  after: string,
  limit: number,
): RoutingSessionPage {
  const rows = db
    .query(`SELECT ${SESSION_COLUMNS} FROM routing_sessions s WHERE id > ? AND
    (owner_id = ? OR EXISTS (SELECT 1 FROM group_members m
      WHERE m.group_id = s.group_id AND m.entity_id = ?)) ORDER BY id LIMIT ?`)
    .all(after, ownerId, ownerId, limit + 1);
  const sessions = rows.slice(0, limit).map(session);
  return { sessions, nextCursor: rows.length > limit ? sessions.at(-1)!.id : null };
}

export function setRoutingSessionState(
  db: Database,
  id: string,
  state: "active" | "left",
): RoutingSession {
  db.run("UPDATE routing_sessions SET state = ?, last_seen_at = ? WHERE id = ?", [
    state,
    Date.now(),
    id,
  ]);
  return getRoutingSession(db, id)!;
}

/** Atomic batches: a conflict rolls back all new events and sequence allocations. */
export function appendRoutingEvents(
  db: Database,
  sessionId: string,
  events: RoutingEventInput[],
): RoutingEvent[] {
  return db.transaction(() =>
    events.map((event) => {
      const encoded = JSON.stringify(event.payload);
      const row = db
        .query(`SELECT ${EVENT_COLUMNS} FROM routing_events
      WHERE session_id = ? AND event_id = ?`)
        .get(sessionId, event.id);
      if (row) {
        const existing = payload<RoutingEvent>(row);
        if (existing.kind !== event.kind || JSON.stringify(existing.payload) !== encoded)
          conflict();
        return existing;
      }
      const next = db
        .query(`UPDATE routing_sessions SET last_sequence = last_sequence + 1,
      last_seen_at = ? WHERE id = ? RETURNING last_sequence AS sequence`)
        .get(Date.now(), sessionId) as { sequence: number };
      const createdAt = Date.now();
      db.run(
        `INSERT INTO routing_events (session_id, event_id, sequence, kind, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
        [sessionId, event.id, next.sequence, event.kind, encoded, createdAt],
      );
      return { ...event, sessionId, sequence: next.sequence, createdAt };
    }),
  )();
}

export function listRoutingEvents(
  db: Database,
  sessionId: string,
  after: number,
  limit: number,
): RoutingEventPage {
  const lastSequence = getRoutingSession(db, sessionId)!.lastSequence;
  const rows = db
    .query(`SELECT ${EVENT_COLUMNS} FROM routing_events
    WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
    .all(sessionId, after, limit + 1);
  const events = rows.slice(0, limit).map((row) => payload<RoutingEvent>(row));
  let expected = after + 1;
  let gap = false;
  for (const event of events) {
    if (event.sequence !== expected) gap = true;
    expected = event.sequence + 1;
  }
  if (rows.length <= limit && expected <= lastSequence) gap = true;
  return {
    events,
    nextCursor: rows.length > limit ? events.at(-1)!.sequence : Math.max(after, lastSequence),
    lastSequence,
    hasMore: rows.length > limit,
    gap,
  };
}

export function sendRoutingMessage(
  db: Database,
  sourceId: string,
  input: RoutingSend,
): RoutingMessage {
  return db.transaction(() => {
    const row = db
      .query(`SELECT ${MESSAGE_COLUMNS} FROM routing_messages
      WHERE source_id = ? AND client_message_id = ?`)
      .get(sourceId, input.clientMessageId);
    if (row) {
      const existing = payload<RoutingMessage>(row);
      if (
        existing.targetId !== input.targetId ||
        existing.kind !== input.kind ||
        JSON.stringify(existing.payload) !== JSON.stringify(input.payload)
      )
        conflict();
      return existing;
    }
    if (getRoutingSession(db, input.targetId)?.state !== "active") {
      throw new RoutingError(
        409,
        "session_left",
        "Recipient has left; rejoin before sending new work",
      );
    }
    const count = db
      .query(`SELECT count(*) AS n FROM routing_messages
      WHERE target_id = ? AND status = 'queued'`)
      .get(input.targetId) as { n: number };
    if (count.n >= 1000)
      throw new RoutingError(
        429,
        "inbox_full",
        "Recipient inbox is full; retry later with the same id",
      );
    const message: RoutingMessage = {
      ...input,
      id: crypto.randomUUID(),
      sourceId,
      status: "queued",
      createdAt: Date.now(),
      acknowledgedAt: null,
    };
    db.run(
      `INSERT INTO routing_messages
      (id, source_id, target_id, client_message_id, kind, payload, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      [
        message.id,
        sourceId,
        input.targetId,
        input.clientMessageId,
        input.kind,
        JSON.stringify(input.payload),
        message.createdAt,
      ],
    );
    return message;
  })();
}

export function listRoutingInbox(
  db: Database,
  sessionId: string,
  limit: number,
  controlsFirst = false,
): RoutingMessage[] {
  return db
    .query(`SELECT ${MESSAGE_COLUMNS} FROM routing_messages WHERE target_id = ?
    AND status = 'queued' ORDER BY ${controlsFirst ? "CASE WHEN kind='marina.control' AND json_extract(payload, '$.action') IN ('respond','interrupt','stop') THEN 0 ELSE 1 END, " : ""}created_at, id LIMIT ?`)
    .all(sessionId, limit)
    .map((row) => payload<RoutingMessage>(row));
}

export function getRoutingMessage(db: Database, id: string): RoutingMessage | null {
  const row = db.query(`SELECT ${MESSAGE_COLUMNS} FROM routing_messages WHERE id = ?`).get(id);
  return row ? payload<RoutingMessage>(row) : null;
}

export function acknowledgeRoutingMessage(
  db: Database,
  sessionId: string,
  id: string,
): RoutingMessage | null {
  db.run(
    `UPDATE routing_messages SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, ?)
    WHERE id = ? AND target_id = ?`,
    [Date.now(), id, sessionId],
  );
  const message = getRoutingMessage(db, id);
  return message?.targetId === sessionId ? message : null;
}

export function getRoutingChannelAccess(
  db: Database,
  ownerId: string,
  channelId: string,
): { canRead: boolean; canWrite: boolean } {
  const row = db
    .query(`SELECT can_read, can_write FROM channel_members
    WHERE channel_id = ? AND entity_id = ?`)
    .get(channelId, ownerId) as { can_read: number; can_write: number } | null;
  return { canRead: !!row?.can_read, canWrite: !!row?.can_write };
}
const CHANNEL_COLUMNS = `id, channel_id AS channelId, sender_id AS senderId,
  sender_name AS senderName, content, created_at AS createdAt`;
export function listRoutingChannelMessages(
  db: Database,
  channelId: string,
  after: number,
  limit: number,
): RoutingChannelPage {
  const rows = db
    .query(`SELECT ${CHANNEL_COLUMNS} FROM channel_messages
    WHERE channel_id = ? AND id > ? ORDER BY id LIMIT ?`)
    .all(channelId, after, limit + 1) as RoutingChannelMessage[];
  const messages = rows.slice(0, limit);
  return { messages, nextCursor: messages.at(-1)?.id ?? after, hasMore: rows.length > limit };
}

/** Commit the canonical channel message and its transport dedup receipt together. */
export function publishRoutingChannelMessage(
  db: Database,
  sessionId: string,
  clientMessageId: string,
  channelId: string,
  senderId: string,
  senderName: string,
  content: string,
): RoutingChannelReceipt {
  return db.transaction(() => {
    const hash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify([channelId, content]))
      .digest("hex");
    const prior = db
      .query(`SELECT message_id, content_hash FROM routing_channel_receipts
      WHERE session_id = ? AND client_message_id = ?`)
      .get(sessionId, clientMessageId) as { message_id: number; content_hash: string } | null;
    if (prior) {
      if (prior.content_hash !== hash) conflict();
      const message = db
        .query(`SELECT ${CHANNEL_COLUMNS} FROM channel_messages WHERE id = ?`)
        .get(prior.message_id) as RoutingChannelMessage | null;
      if (!message)
        throw new RoutingError(
          410,
          "message_expired",
          "The channel message was already published but its history has expired",
        );
      return { message, duplicate: true };
    }
    const id = channelsDb.addChannelMessage(db, channelId, senderId, senderName, content);
    db.run(
      `INSERT INTO routing_channel_receipts (session_id, client_message_id, message_id, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?)`,
      [sessionId, clientMessageId, id, hash, Date.now()],
    );
    const message = db
      .query(`SELECT ${CHANNEL_COLUMNS} FROM channel_messages WHERE id = ?`)
      .get(id) as RoutingChannelMessage;
    return { message, duplicate: false };
  })();
}

export function listRoutingDeliveries(
  db: Database,
  sessionId: string,
  limit: number,
): RoutingMessage[] {
  return db
    .query(`SELECT ${MESSAGE_COLUMNS} FROM routing_messages WHERE source_id = ? OR target_id = ?
    ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(sessionId, sessionId, limit)
    .map((row) => payload<RoutingMessage>(row));
}

/** Latest runtime evidence is indexed; readers never scan a token stream to find controls. */
export function getRoutingRuntimeState(db: Database, sessionId: string): unknown | null {
  const row = db
    .query(`SELECT payload FROM routing_events WHERE session_id = ?
    AND kind = 'runtime.state' ORDER BY sequence DESC LIMIT 1`)
    .get(sessionId) as { payload: string } | null;
  return row ? JSON.parse(row.payload) : null;
}
