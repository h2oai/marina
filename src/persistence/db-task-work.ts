// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

export interface TaskWorkRevisionRow {
  task_id: number;
  revision: number;
  author_id: string;
  author_name: string;
  action: string;
  document: string;
  created_at: number;
}

export interface TaskWorkRevisionInput {
  taskId: number;
  expectedRevision: number;
  authorId: string;
  authorName: string;
  action: string;
  document: string;
}

export interface TaskWorkCheckRow {
  id: number;
  task_id: number;
  reviewer_id: string;
  fingerprint: string;
  report: string;
  created_at: number;
  expires_at: number;
}

export interface TaskWorkCheckInput {
  taskId: number;
  reviewerId: string;
  fingerprint: string;
  report: string;
  createdAt: number;
  expiresAt: number;
}

/** Account erasure is the explicit exception to shared revision immutability. */
export function eraseTaskWorkAccount(db: Database, accountId: string, erased: string) {
  const rows = db
    .query(
      `SELECT task_id,revision FROM task_work_revisions r WHERE author_id=? OR EXISTS
     (SELECT 1 FROM json_tree(r.document) j WHERE j.key='authorId' AND j.value=?)`,
    )
    .all(accountId, accountId) as Array<{ task_id: number; revision: number }>;
  for (const row of rows) {
    const paths = db
      .query(
        `SELECT j.fullkey FROM task_work_revisions r, json_tree(r.document) j
       WHERE r.task_id=? AND r.revision=? AND j.key='authorId' AND j.value=?`,
      )
      .all(row.task_id, row.revision, accountId) as Array<{ fullkey: string }>;
    for (const { fullkey } of paths)
      db.run(
        "UPDATE task_work_revisions SET document=json_set(document,?,?) WHERE task_id=? AND revision=?",
        [fullkey, erased, row.task_id, row.revision],
      );
  }
  db.run("UPDATE task_work_revisions SET author_id=?,author_name=? WHERE author_id=?", [
    erased,
    erased,
    accountId,
  ]);
  const checks = db.run("DELETE FROM task_work_checks WHERE reviewer_id=?", [accountId]).changes;
  return rows.length || checks ? { revisions: rows.length, checks } : undefined;
}

export function getTaskWorkRevision(
  db: Database,
  taskId: number,
  revision?: number,
): TaskWorkRevisionRow | undefined {
  return (
    ((revision === undefined
      ? db
          .query(
            "SELECT * FROM task_work_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1",
          )
          .get(taskId)
      : db
          .query("SELECT * FROM task_work_revisions WHERE task_id = ? AND revision = ?")
          .get(taskId, revision)) as TaskWorkRevisionRow | null) ?? undefined
  );
}

/** The newest `limit` revisions' metadata (who did what, when) — never their documents. */
export function listTaskWorkRevisions(
  db: Database,
  taskId: number,
  limit = 20,
): Array<Pick<TaskWorkRevisionRow, "revision" | "author_name" | "action" | "created_at">> {
  return db
    .query(
      `SELECT revision, author_name, action, created_at FROM task_work_revisions
       WHERE task_id = ? ORDER BY revision DESC LIMIT ?`,
    )
    .all(taskId, Math.max(1, Math.min(200, Math.trunc(limit)))) as Array<
    Pick<TaskWorkRevisionRow, "revision" | "author_name" | "action" | "created_at">
  >;
}

/** Atomic revision comparison prevents one contributor overwriting another's changes. */
export function appendTaskWorkRevision(
  db: Database,
  input: TaskWorkRevisionInput,
): TaskWorkRevisionRow | undefined {
  return db.transaction(() => {
    const current = getTaskWorkRevision(db, input.taskId)?.revision ?? 0;
    if (current !== input.expectedRevision) return undefined;
    db.run(
      "INSERT INTO task_work_revisions(task_id,revision,author_id,author_name,action,document,created_at) VALUES(?,?,?,?,?,?,?)",
      [
        input.taskId,
        current + 1,
        input.authorId,
        input.authorName,
        input.action,
        input.document,
        Date.now(),
      ],
    );
    return getTaskWorkRevision(db, input.taskId)!;
  })();
}

export function getTaskWorkCheck(
  db: Database,
  taskId: number,
  reviewerId: string,
  fingerprint: string,
  now: number,
): TaskWorkCheckRow | undefined {
  return (
    (db
      .query(
        "SELECT * FROM task_work_checks WHERE task_id=? AND reviewer_id=? AND fingerprint=? AND created_at<=? AND expires_at>?",
      )
      .get(taskId, reviewerId, fingerprint, now, now) as TaskWorkCheckRow | null) ?? undefined
  );
}

export function putTaskWorkCheck(db: Database, input: TaskWorkCheckInput): TaskWorkCheckRow {
  db.run(
    `INSERT INTO task_work_checks(task_id,reviewer_id,fingerprint,report,created_at,expires_at)
     VALUES(?,?,?,?,?,?) ON CONFLICT(task_id,reviewer_id,fingerprint) DO UPDATE SET
     report=excluded.report,created_at=excluded.created_at,expires_at=excluded.expires_at`,
    [
      input.taskId,
      input.reviewerId,
      input.fingerprint,
      input.report,
      input.createdAt,
      input.expiresAt,
    ],
  );
  return db
    .query("SELECT * FROM task_work_checks WHERE task_id=? AND reviewer_id=? AND fingerprint=?")
    .get(input.taskId, input.reviewerId, input.fingerprint) as TaskWorkCheckRow;
}
