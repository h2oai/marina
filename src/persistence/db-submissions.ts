// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Exactly-once submission ledger (`submission_requests`, migration 150).
//
// Native analogue of Pi Durable's `requestId` semantics: a client that retries
// a submission after a crash (or after losing a connection) gets the ORIGINAL
// result back instead of the work being performed twice. The key primitive is
// a two-phase record — `pending` before the work runs, `resolved` after its
// result is committed — so a crash mid-work leaves a `pending` row a resume
// pass can detect rather than an ambiguous absence.

import type { Database } from "bun:sqlite";

export type SubmissionStatus = "pending" | "resolved";

export interface Submission {
  requestId: string;
  /** Namespace scoping the request id (e.g. `command`, `memory`, `gateway`). */
  kind: string;
  status: SubmissionStatus;
  resultJson: string | null;
  createdAt: number;
  settledAt: number | null;
}

/**
 * Claim a request id before doing the work. `started` is true only for the
 * caller that actually inserted the row; a concurrent or post-crash retry sees
 * `started: false` and must await/settle the existing record instead of
 * re-running the work.
 */
export function beginSubmission(
  db: Database,
  requestId: string,
  kind: string,
  now: number,
): { started: boolean } {
  const info = db.run(
    `INSERT OR IGNORE INTO submission_requests
       (request_id, kind, status, result_json, created_at)
     VALUES (?, ?, 'pending', NULL, ?)`,
    [requestId, kind, now],
  );
  return { started: info.changes > 0 };
}

export function getSubmission(db: Database, requestId: string): Submission | undefined {
  const row = db
    .query(
      `SELECT request_id, kind, status, result_json, created_at, settled_at
       FROM submission_requests WHERE request_id = ?`,
    )
    .get(requestId) as {
    request_id: string;
    kind: string;
    status: SubmissionStatus;
    result_json: string | null;
    created_at: number;
    settled_at: number | null;
  } | null;
  if (!row) return undefined;
  return {
    requestId: row.request_id,
    kind: row.kind,
    status: row.status,
    resultJson: row.result_json,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

/**
 * Commit the result of a claimed submission. Returns false when the row was
 * already settled (a retry that raced the original completion) — the caller
 * must then return the existing result, not overwrite it.
 */
export function settleSubmission(
  db: Database,
  requestId: string,
  resultJson: string,
  now: number,
): boolean {
  const info = db.run(
    `UPDATE submission_requests
     SET status = 'resolved', result_json = ?, settled_at = ?
     WHERE request_id = ? AND status = 'pending'`,
    [resultJson, now, requestId],
  );
  return info.changes > 0;
}

/** Submissions stuck `pending` after a crash — candidates for a resume pass. */
export function listPendingSubmissions(db: Database, kind?: string): Submission[] {
  const args = kind === undefined ? [] : [kind];
  const rows = db
    .query(
      `SELECT request_id, kind, status, result_json, created_at, settled_at
       FROM submission_requests
       WHERE status = 'pending'${kind === undefined ? "" : " AND kind = ?"}
       ORDER BY created_at`,
    )
    .all(...args) as Array<{
    request_id: string;
    kind: string;
    status: SubmissionStatus;
    result_json: string | null;
    created_at: number;
    settled_at: number | null;
  }>;
  return rows.map((row) => ({
    requestId: row.request_id,
    kind: row.kind,
    status: row.status,
    resultJson: row.result_json,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  }));
}
