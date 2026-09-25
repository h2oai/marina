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

// ─── Shadow forecasts (migration 128) ────────────────────────────────────────
// What a candidate forecaster WOULD have filed, recorded before the round locks
// and scored once it resolves — how forecasters that cannot be backtested (web
// research finds published answers) earn their way onto the real entry.

export interface ArenaShadowRow {
  id: number;
  round_id: string;
  forecaster: string;
  /** JSON: { topline? | profile? | ranking? } as it would have been filed. */
  forecast: string;
  /** JSON: the forecaster's working (dossier, proposals, judge scores, fallbacks). */
  detail: string;
  cost_usd: number;
  created_at: number;
}

/** First record per (round, forecaster) wins — a shadow forecast is never revised. */
export function recordArenaShadow(
  db: Database,
  row: { roundId: string; forecaster: string; forecast: string; detail: string; costUsd: number },
): boolean {
  const result = db.run(
    `INSERT OR IGNORE INTO arena_shadow (round_id, forecaster, forecast, detail, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.roundId, row.forecaster, row.forecast, row.detail, row.costUsd, Date.now()],
  );
  return result.changes > 0;
}

export function listArenaShadow(
  db: Database,
  opts: { forecaster?: string; limit?: number } = {},
): ArenaShadowRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2_000);
  return (
    opts.forecaster
      ? db
          .query("SELECT * FROM arena_shadow WHERE forecaster = ? ORDER BY id DESC LIMIT ?")
          .all(opts.forecaster, limit)
      : db.query("SELECT * FROM arena_shadow ORDER BY id DESC LIMIT ?").all(limit)
  ) as ArenaShadowRow[];
}
