// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Schedules (migration 165) ──────────────────────────────────────────────
//
// A schedule is a command an owner arranged to run later or repeatedly. It is
// keyed by the owner's durable account key (`users.id`); `owner_name` is the
// account name the run executes as. Run history is append-only.

export interface ScheduleRow {
  id: number;
  owner_key: string;
  owner_name: string;
  name: string;
  command: string;
  trigger_json: string;
  catch_up: "none" | "once";
  max_runs: number | null;
  enabled: number;
  next_run_at: number | null;
  runs: number;
  consecutive_failures: number;
  last_status: string | null;
  last_run_at: number | null;
  created_rank: number;
  created_at: number;
  updated_at: number;
}

export interface ScheduleRunRow {
  id: number;
  schedule_id: number;
  owner_key: string;
  due_at: number;
  started_at: number;
  finished_at: number;
  status: string;
  error_class: string | null;
  error: string | null;
  duration_ms: number;
}

export interface NewSchedule {
  ownerKey: string;
  ownerName: string;
  name: string;
  command: string;
  triggerJson: string;
  catchUp: "none" | "once";
  maxRuns?: number;
  nextRunAt: number | null;
  createdRank: number;
}

export function createSchedule(db: Database, s: NewSchedule): ScheduleRow {
  const now = Date.now();
  const row = db
    .query(
      `INSERT INTO schedules (owner_key, owner_name, name, command, trigger_json, catch_up,
         max_runs, enabled, next_run_at, created_rank, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      s.ownerKey,
      s.ownerName,
      s.name,
      s.command,
      s.triggerJson,
      s.catchUp,
      s.maxRuns ?? null,
      s.nextRunAt,
      s.createdRank,
      now,
      now,
    ) as ScheduleRow;
  return row;
}

export function getSchedule(db: Database, id: number): ScheduleRow | undefined {
  return (
    (db.query("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | null) ?? undefined
  );
}

export function getScheduleByName(
  db: Database,
  ownerKey: string,
  name: string,
): ScheduleRow | undefined {
  return (
    (db
      .query("SELECT * FROM schedules WHERE owner_key = ? AND name = ? COLLATE NOCASE")
      .get(ownerKey, name) as ScheduleRow | null) ?? undefined
  );
}

/** An owner's schedules, or every schedule when `ownerKey` is omitted. */
export function listSchedules(db: Database, ownerKey?: string, limit = 200): ScheduleRow[] {
  if (ownerKey)
    return db
      .query("SELECT * FROM schedules WHERE owner_key = ? ORDER BY name LIMIT ?")
      .all(ownerKey, limit) as ScheduleRow[];
  return db
    .query("SELECT * FROM schedules ORDER BY owner_name, name LIMIT ?")
    .all(limit) as ScheduleRow[];
}

export function countSchedules(db: Database, ownerKey: string): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM schedules WHERE owner_key = ?").get(ownerKey) as {
      n: number;
    }
  ).n;
}

/** Enabled schedules whose next run is at or before `now`, oldest first. */
export function dueSchedules(db: Database, now: number, limit = 50): ScheduleRow[] {
  return db
    .query(
      `SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at LIMIT ?`,
    )
    .all(now, limit) as ScheduleRow[];
}

/** Advance a schedule after a run (or a skipped slot): its next time and run state. */
export function updateScheduleState(
  db: Database,
  id: number,
  state: {
    nextRunAt: number | null;
    enabled?: boolean;
    ran?: boolean;
    lastStatus?: string;
    lastRunAt?: number;
    consecutiveFailures?: number;
  },
): void {
  db.run(
    `UPDATE schedules SET next_run_at = ?,
       enabled = COALESCE(?, enabled),
       runs = runs + ?,
       last_status = COALESCE(?, last_status),
       last_run_at = COALESCE(?, last_run_at),
       consecutive_failures = COALESCE(?, consecutive_failures),
       updated_at = ?
     WHERE id = ?`,
    [
      state.nextRunAt,
      state.enabled === undefined ? null : state.enabled ? 1 : 0,
      state.ran ? 1 : 0,
      state.lastStatus ?? null,
      state.lastRunAt ?? null,
      state.consecutiveFailures ?? null,
      Date.now(),
      id,
    ],
  );
}

/** Pause or resume; resuming sets the next run the caller computed. */
export function setScheduleEnabled(
  db: Database,
  id: number,
  enabled: boolean,
  nextRunAt: number | null,
): void {
  db.run(
    "UPDATE schedules SET enabled = ?, next_run_at = ?, consecutive_failures = 0, updated_at = ? WHERE id = ?",
    [enabled ? 1 : 0, nextRunAt, Date.now(), id],
  );
}

export function deleteSchedule(db: Database, id: number): boolean {
  return db.run("DELETE FROM schedules WHERE id = ?", [id]).changes > 0;
}

export function recordScheduleRun(db: Database, run: Omit<ScheduleRunRow, "id">): ScheduleRunRow {
  return db
    .query(
      `INSERT INTO schedule_runs (schedule_id, owner_key, due_at, started_at, finished_at, status,
         error_class, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      run.schedule_id,
      run.owner_key,
      run.due_at,
      run.started_at,
      run.finished_at,
      run.status,
      run.error_class,
      run.error,
      run.duration_ms,
    ) as ScheduleRunRow;
}

/** A schedule's runs, newest first. */
export function listScheduleRuns(db: Database, scheduleId: number, limit = 20): ScheduleRunRow[] {
  return db
    .query("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ?")
    .all(scheduleId, limit) as ScheduleRunRow[];
}
