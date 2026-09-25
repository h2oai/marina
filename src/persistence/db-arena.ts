// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Social Simulation Arena submissions (migration 127): every signed request
 * Marina sends, kept with its exact bytes and signature so a retry re-sends the
 * SAME request (the arena's idempotency is per request id) and the record can
 * be audited against the arena's public reveal. Append-only by policy — a row's
 * status and the arena's reply are updated in place, its request never is.
 */

import type { Database } from "bun:sqlite";

export type ArenaSubmissionStatus = "prepared" | "accepted" | "rejected" | "error";

export interface ArenaSubmissionRow {
  id: number;
  entrant: string;
  round_id: string;
  request_id: string;
  url: string;
  /** JSON of the signed headers (entrant, key-id, request-id, timestamp, signature). */
  meta: string;
  /** The exact body bytes (UTF-8 JSON) that were signed. */
  body: string;
  status: ArenaSubmissionStatus;
  http_status: number | null;
  response: string | null;
  created_at: number;
  updated_at: number;
}

export interface InsertArenaSubmission {
  entrant: string;
  roundId: string;
  requestId: string;
  url: string;
  meta: string;
  body: string;
}

const MAX_RESPONSE_CHARS = 4_000;

export function insertArenaSubmission(db: Database, row: InsertArenaSubmission): number {
  const now = Date.now();
  const result = db.run(
    `INSERT INTO arena_submissions (entrant, round_id, request_id, url, meta, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
    [row.entrant, row.roundId, row.requestId, row.url, row.meta, row.body, now, now],
  );
  return Number(result.lastInsertRowid);
}

export function updateArenaSubmission(
  db: Database,
  id: number,
  update: { status: ArenaSubmissionStatus; httpStatus?: number; response?: string },
): void {
  db.run(
    "UPDATE arena_submissions SET status = ?, http_status = ?, response = ?, updated_at = ? WHERE id = ?",
    [
      update.status,
      update.httpStatus ?? null,
      update.response === undefined ? null : update.response.slice(0, MAX_RESPONSE_CHARS),
      Date.now(),
      id,
    ],
  );
}

/** The newest submission for a round (what a retry re-sends, or what counts). */
export function latestArenaSubmission(
  db: Database,
  entrant: string,
  roundId: string,
): ArenaSubmissionRow | undefined {
  return (
    (db
      .query(
        "SELECT * FROM arena_submissions WHERE entrant = ? AND round_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(entrant, roundId) as ArenaSubmissionRow | null) ?? undefined
  );
}

export function listArenaSubmissions(
  db: Database,
  opts: { entrant?: string; limit?: number } = {},
): ArenaSubmissionRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  return (
    opts.entrant
      ? db
          .query("SELECT * FROM arena_submissions WHERE entrant = ? ORDER BY id DESC LIMIT ?")
          .all(opts.entrant, limit)
      : db.query("SELECT * FROM arena_submissions ORDER BY id DESC LIMIT ?").all(limit)
  ) as ArenaSubmissionRow[];
}
