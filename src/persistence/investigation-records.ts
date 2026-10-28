// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { InvestigationError, MAX_INVESTIGATION_EVENTS } from "../investigations/validation";
import {
  INVESTIGATION_SCHEMA,
  type InvestigationAccess,
  type InvestigationAttempt,
  type InvestigationCase,
  type InvestigationEvent,
  type InvestigationKind,
  type InvestigationState,
} from "../sdk/investigation-types";
import { investigationSpendAccounting } from "./db-investigation-spend";

export interface CaseRow {
  id: string;
  owner_key: string;
  owner_name: string;
  parent_case_id: string | null;
  kind: InvestigationKind;
  question: string;
  selected_attempt_id: string;
  current_attempt_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AttemptRow {
  id: string;
  case_id: string;
  actor_key: string;
  actor_name: string;
  parent_attempt_id: string | null;
  root_attempt_id: string;
  request_json: string;
  state: InvestigationState;
  generation: string | null;
  sequence: number;
  result_json: string | null;
  accounting_json: string;
  answer_id: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export function missing(): never {
  throw new InvestigationError("not_found", "Investigation not found or unavailable", 404);
}

export function attemptRow(db: Database, id: string): AttemptRow {
  return (
    (db.query("SELECT * FROM investigation_attempts WHERE id = ?").get(id) as AttemptRow | null) ??
    missing()
  );
}

export function caseAccess(
  db: Database,
  id: string,
  principal: string,
): { row: CaseRow; access: InvestigationCase["access"] } {
  const row = db.query("SELECT * FROM investigations WHERE id = ?").get(id) as CaseRow | null;
  if (!row) return missing();
  if (row.owner_key === principal) return { row, access: "owner" };
  // Child grants follow the live parent chain: revocation never leaves copied grants behind.
  const grant = db
    .query(`WITH RECURSIVE lineage(id, parent_case_id) AS (
    SELECT id, parent_case_id FROM investigations WHERE id = ?
    UNION SELECT c.id, c.parent_case_id FROM investigations c JOIN lineage l ON c.id = l.parent_case_id
  ) SELECT g.access FROM investigation_grants g JOIN lineage l ON g.case_id = l.id
    WHERE g.principal = ? ORDER BY CASE g.access WHEN 'work' THEN 0 ELSE 1 END LIMIT 1`)
    .get(id, principal) as { access: InvestigationAccess } | null;
  return grant ? { row, access: grant.access } : missing();
}

export function writableCase(
  db: Database,
  id: string,
  principal: string,
  ownerOnly = false,
): CaseRow {
  const found = caseAccess(db, id, principal);
  if (found.access === "read" || (ownerOnly && found.access !== "owner")) {
    throw new InvestigationError(
      "forbidden",
      ownerOnly ? "Only the owner can change access or erase a case" : "Work access required",
      403,
    );
  }
  return found.row;
}

export function projectCase(
  db: Database,
  row: CaseRow,
  access: InvestigationCase["access"],
): InvestigationCase {
  const instance = db.query("SELECT uuid FROM investigation_instance WHERE id = 1").get() as {
    uuid: string;
  };
  return {
    schema: INVESTIGATION_SCHEMA,
    id: row.id,
    instanceId: instance.uuid,
    owner: { key: row.owner_key, name: row.owner_name },
    kind: row.kind,
    question: row.question,
    selectedAttemptId: row.selected_attempt_id,
    ...(row.current_attempt_id ? { currentAttemptId: row.current_attempt_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    access,
  };
}

export function projectAttempt(db: Database, row: AttemptRow): InvestigationAttempt {
  return {
    id: row.id,
    caseId: row.case_id,
    actor: { key: row.actor_key, name: row.actor_name },
    ...(row.parent_attempt_id ? { parentAttemptId: row.parent_attempt_id } : {}),
    rootAttemptId: row.root_attempt_id,
    request: JSON.parse(row.request_json),
    state: row.state,
    ...(row.generation ? { generation: row.generation } : {}),
    sequence: row.sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accounting: investigationSpendAccounting(db, row.id, JSON.parse(row.accounting_json)),
    ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

/** Called inside the transaction that changes state. */
export function appendEvent(
  db: Database,
  id: string,
  event: Omit<InvestigationEvent, "attemptId" | "sequence" | "at">,
  now = Date.now(),
): InvestigationEvent {
  const row = attemptRow(db, id);
  // Reserve the last entries for terminal state even when an executor overproduces events.
  if (
    row.sequence >= MAX_INVESTIGATION_EVENTS &&
    !["terminal", "access_changed", "accounting"].includes(event.kind)
  ) {
    throw new InvestigationError("event_quota", "Investigation event limit reached", 429);
  }
  const next: InvestigationEvent = { ...event, attemptId: id, sequence: row.sequence + 1, at: now };
  db.run("UPDATE investigation_attempts SET sequence = ?, updated_at = ? WHERE id = ?", [
    next.sequence,
    now,
    id,
  ]);
  db.run("INSERT INTO investigation_events VALUES (?, ?, ?, ?)", [
    id,
    next.sequence,
    JSON.stringify(next),
    now,
  ]);
  return next;
}
