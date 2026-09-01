// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export const JOURNEY_LINK_KINDS = [
  "goal",
  "project",
  "task",
  "agent",
  "note",
  "board_post",
  "canvas_node",
  "trace",
  "watch",
  "experiment",
  "artifact",
  "chronicle",
  "other",
] as const;

export type JourneyLinkKind = (typeof JOURNEY_LINK_KINDS)[number];

export const JOURNEY_EVENT_KINDS = [
  "interpretation",
  "grounding",
  "action_started",
  "evidence",
  "challenge",
  "result",
  "waiting",
  "continuation",
  "dormant",
  "resumed",
] as const;

export type JourneyEventKind = (typeof JOURNEY_EVENT_KINDS)[number];

export interface JourneyRow {
  id: string;
  requester_id: string;
  requester_name: string;
  expression: string;
  created_at: number;
}

export interface JourneyLinkRow {
  id: number;
  journey_id: string;
  kind: JourneyLinkKind;
  ref: string;
  relationship: string;
  actor_id: string;
  actor_name: string;
  metadata_json: string;
  created_at: number;
}

export interface JourneyEventRow {
  id: number;
  journey_id: string;
  kind: JourneyEventKind;
  summary: string;
  actor_id: string;
  actor_name: string;
  ref_kind: JourneyLinkKind | null;
  ref: string | null;
  data_json: string;
  created_at: number;
}

export interface JourneyWitnessRow {
  journey_id: string;
  viewer_id: string;
  witnessed_event_id: number;
  witnessed_at: number;
}

export function createJourney(
  db: Database,
  input: { requesterId: string; requesterName: string; expression: string; id?: string },
): JourneyRow {
  const row: JourneyRow = {
    id: input.id ?? `journey_${randomUUID().slice(0, 12)}`,
    requester_id: input.requesterId,
    requester_name: input.requesterName,
    expression: input.expression,
    created_at: Date.now(),
  };
  db.run(
    `INSERT INTO journeys (id, requester_id, requester_name, expression, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [row.id, row.requester_id, row.requester_name, row.expression, row.created_at],
  );
  return row;
}

export function getJourney(db: Database, id: string): JourneyRow | undefined {
  return (
    (db.query("SELECT * FROM journeys WHERE id = ?").get(id) as JourneyRow | null) ?? undefined
  );
}

export function getLatestJourneyForRequester(
  db: Database,
  requesterId: string,
): JourneyRow | undefined {
  return (
    (db
      .query(
        "SELECT * FROM journeys WHERE requester_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(requesterId) as JourneyRow | null) ?? undefined
  );
}

export function listJourneys(
  db: Database,
  input: { requesterId?: string; limit?: number } = {},
): JourneyRow[] {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  if (input.requesterId) {
    return db
      .query(
        "SELECT * FROM journeys WHERE requester_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(input.requesterId, limit) as JourneyRow[];
  }
  return db
    .query("SELECT * FROM journeys ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(limit) as JourneyRow[];
}

export function addJourneyLink(
  db: Database,
  input: {
    journeyId: string;
    kind: JourneyLinkKind;
    ref: string;
    relationship?: string;
    actorId: string;
    actorName: string;
    metadata?: Record<string, unknown>;
  },
): JourneyLinkRow {
  const now = Date.now();
  const relationship = input.relationship ?? "related_to";
  const metadata = JSON.stringify(input.metadata ?? {});
  db.run(
    `INSERT INTO journey_links
       (journey_id, kind, ref, relationship, actor_id, actor_name, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(journey_id, kind, ref, relationship) DO NOTHING`,
    [
      input.journeyId,
      input.kind,
      input.ref,
      relationship,
      input.actorId,
      input.actorName,
      metadata,
      now,
    ],
  );
  return db
    .query(
      `SELECT * FROM journey_links
       WHERE journey_id = ? AND kind = ? AND ref = ? AND relationship = ?`,
    )
    .get(input.journeyId, input.kind, input.ref, relationship) as JourneyLinkRow;
}

export function listJourneyLinks(db: Database, journeyId: string): JourneyLinkRow[] {
  return db
    .query("SELECT * FROM journey_links WHERE journey_id = ? ORDER BY created_at, id")
    .all(journeyId) as JourneyLinkRow[];
}

export function appendJourneyEvent(
  db: Database,
  input: {
    journeyId: string;
    kind: JourneyEventKind;
    summary: string;
    actorId: string;
    actorName: string;
    refKind?: JourneyLinkKind;
    ref?: string;
    data?: Record<string, unknown>;
  },
): JourneyEventRow {
  const now = Date.now();
  const result = db.run(
    `INSERT INTO journey_events
       (journey_id, kind, summary, actor_id, actor_name, ref_kind, ref, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.journeyId,
      input.kind,
      input.summary,
      input.actorId,
      input.actorName,
      input.refKind ?? null,
      input.ref ?? null,
      JSON.stringify(input.data ?? {}),
      now,
    ],
  );
  return db
    .query("SELECT * FROM journey_events WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as JourneyEventRow;
}

export function listJourneyEvents(db: Database, journeyId: string, limit = 200): JourneyEventRow[] {
  const bounded = Math.max(1, Math.min(limit, 1000));
  return db
    .query(
      `SELECT * FROM (
         SELECT * FROM journey_events WHERE journey_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
       ) ORDER BY created_at, id`,
    )
    .all(journeyId, bounded) as JourneyEventRow[];
}

export function getJourneyWitness(
  db: Database,
  journeyId: string,
  viewerId: string,
): JourneyWitnessRow | undefined {
  return (
    (db
      .query("SELECT * FROM journey_witnesses WHERE journey_id = ? AND viewer_id = ?")
      .get(journeyId, viewerId) as JourneyWitnessRow | null) ?? undefined
  );
}

export function witnessJourney(
  db: Database,
  journeyId: string,
  viewerId: string,
  eventId: number,
): JourneyWitnessRow {
  const witnessedAt = Date.now();
  db.run(
    `INSERT INTO journey_witnesses
       (journey_id, viewer_id, witnessed_event_id, witnessed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(journey_id, viewer_id) DO UPDATE SET
       witnessed_event_id = MAX(journey_witnesses.witnessed_event_id, excluded.witnessed_event_id),
       witnessed_at = excluded.witnessed_at`,
    [journeyId, viewerId, eventId, witnessedAt],
  );
  return db
    .query("SELECT * FROM journey_witnesses WHERE journey_id = ? AND viewer_id = ?")
    .get(journeyId, viewerId) as JourneyWitnessRow;
}
