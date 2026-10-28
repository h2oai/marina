// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  InvestigationError,
  investigationKey,
  parseInvestigationRequest,
} from "../investigations/validation";
import type {
  InvestigationAccess,
  InvestigationActor,
  InvestigationAttempt,
  InvestigationCase,
  InvestigationRequest,
  InvestigationSnapshot,
} from "../sdk/investigation-types";
import { getForecastAnswer } from "./db-markets";
import {
  type AttemptRow,
  appendEvent,
  attemptRow,
  type CaseRow,
  caseAccess,
  missing,
  projectAttempt,
  projectCase,
  writableCase,
} from "./investigation-records";

export function createInvestigation(
  db: Database,
  actor: InvestigationActor,
  input: InvestigationRequest,
  key: string,
): { attempt: InvestigationAttempt; created: boolean } {
  const request = parseInvestigationRequest(input);
  const idempotencyKey = investigationKey(key);
  const json = JSON.stringify(request);
  const fingerprint = createHash("sha256").update(json).digest("hex");
  return db.transaction(() => {
    const previous = db
      .query(
        "SELECT fingerprint, attempt_id FROM investigation_admissions WHERE actor_key = ? AND idempotency_key = ?",
      )
      .get(actor.key, idempotencyKey) as { fingerprint: string; attempt_id: string | null } | null;
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new InvestigationError(
          "idempotency_conflict",
          "This key already identifies a different request",
          409,
        );
      if (!previous.attempt_id)
        throw new InvestigationError(
          "erased",
          "This request was erased; choose a new key for new work",
          410,
        );
      const attempt = attemptRow(db, previous.attempt_id);
      caseAccess(db, attempt.case_id, actor.key);
      return { attempt: projectAttempt(db, attempt), created: false };
    }
    const allActive = db
      .query("SELECT count(*) AS n FROM investigation_attempts WHERE state IN ('queued','running')")
      .get() as { n: number };
    if (allActive.n >= 128)
      throw new InvestigationError("capacity", "Investigation executor is at capacity", 429);
    const parent = request.parentAttemptId ? attemptRow(db, request.parentAttemptId) : undefined;
    const parentCase = parent ? writableCase(db, parent.case_id, actor.key) : undefined;
    const existing = request.caseId ? writableCase(db, request.caseId, actor.key) : undefined;
    if (existing && existing.kind !== request.kind)
      throw new InvestigationError(
        "kind_conflict",
        "An existing case retains its result kind",
        409,
      );
    if (existing && parentCase && existing.owner_key !== parentCase.owner_key) {
      throw new InvestigationError(
        "scope_conflict",
        "Nested work must retain the owning scope",
        409,
      );
    }
    const owner = existing ?? parentCase;
    const ownerKey = owner?.owner_key ?? actor.key;
    const retained = db
      .query(
        `SELECT count(*) AS n FROM investigation_attempts a JOIN investigations c ON c.id=a.case_id WHERE c.owner_key=?`,
      )
      .get(ownerKey) as { n: number };
    if (retained.n >= 1000)
      throw new InvestigationError(
        "storage_quota",
        "This owner has 1000 retained attempts; erase unneeded cases first",
        429,
      );
    const active = db
      .query(`SELECT count(*) AS n FROM investigation_attempts a JOIN investigations c ON c.id = a.case_id
      WHERE c.owner_key = ? AND a.state IN ('queued','running')`)
      .get(ownerKey) as { n: number };
    if (active.n >= 32)
      throw new InvestigationError("capacity", "This owner already has 32 active attempts", 429);
    const now = Date.now();
    const id = randomUUID();
    const caseId = existing?.id ?? randomUUID();
    if (!existing) {
      db.run(
        `INSERT INTO investigations(id,owner_key,owner_name,parent_case_id,kind,question,selected_attempt_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          caseId,
          ownerKey,
          owner?.owner_name ?? actor.name,
          parentCase?.id ?? null,
          request.kind,
          request.question,
          id,
          now,
          now,
        ],
      );
    } else {
      db.run(
        "UPDATE investigations SET question = ?, selected_attempt_id = ?, updated_at = ? WHERE id = ?",
        [request.question, id, now, caseId],
      );
    }
    const root =
      parent && (parent.state === "queued" || parent.state === "running")
        ? parent.root_attempt_id
        : id;
    db.run(
      `INSERT INTO investigation_attempts(id,case_id,actor_key,actor_name,parent_attempt_id,root_attempt_id,request_json,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'queued',?,?)`,
      [id, caseId, actor.key, actor.name, parent?.id ?? null, root, json, now, now],
    );
    db.run("INSERT INTO investigation_admissions VALUES (?,?,?,?,?)", [
      actor.key,
      idempotencyKey,
      fingerprint,
      id,
      now,
    ]);
    appendEvent(db, id, { kind: "admitted", actor: actor.name }, now);
    return { attempt: projectAttempt(db, attemptRow(db, id)), created: true };
  })();
}

export function getInvestigation(
  db: Database,
  principal: string,
  caseId: string,
  attemptId?: string,
): InvestigationSnapshot {
  return db.transaction(() => {
    const { row, access } = caseAccess(db, caseId, principal);
    const attempt = attemptRow(db, attemptId ?? row.selected_attempt_id);
    if (attempt.case_id !== caseId) return missing();
    const attempts = db
      .query(
        "SELECT * FROM investigation_attempts WHERE case_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100",
      )
      .all(caseId) as AttemptRow[];
    const answer = attempt.answer_id ? getForecastAnswer(db, attempt.answer_id) : undefined;
    const children = (
      db
        .query(`SELECT a.case_id AS caseId, a.id AS attemptId, json_extract(a.request_json,'$.question') AS question,a.state
      FROM investigation_attempts a WHERE a.parent_attempt_id=? AND a.case_id!=? ORDER BY a.created_at LIMIT 100`)
        .all(attempt.id, caseId) as InvestigationSnapshot["children"]
    ).filter((child) => {
      try {
        caseAccess(db, child.caseId, principal);
        return true;
      } catch (error) {
        if (error instanceof InvestigationError && error.code === "not_found") return false;
        throw error;
      }
    });
    const grants =
      access === "owner"
        ? (db
            .query(
              `SELECT u.name,g.access FROM investigation_grants g JOIN users u ON u.id=g.principal WHERE g.case_id=? ORDER BY u.name`,
            )
            .all(caseId) as NonNullable<InvestigationSnapshot["grants"]>)
        : undefined;
    return {
      case: projectCase(db, row, access),
      attempt: projectAttempt(db, attempt),
      cursor: attempt.sequence,
      children,
      ...(grants ? { grants } : {}),
      ...(answer?.resolved_at
        ? {
            resolution: {
              at: answer.resolved_at,
              value: answer.outcome_json ? JSON.parse(answer.outcome_json) : null,
              loss: answer.score,
            },
          }
        : {}),
      attempts: attempts.map((a) => ({
        id: a.id,
        state: a.state,
        createdAt: a.created_at,
        actor: { key: a.actor_key, name: a.actor_name },
      })),
    };
  })();
}

export function getInvestigationAttempt(
  db: Database,
  principal: string,
  id: string,
): InvestigationAttempt {
  const row = attemptRow(db, id);
  caseAccess(db, row.case_id, principal);
  return projectAttempt(db, row);
}

export function listInvestigations(
  db: Database,
  principal: string,
  before = Number.MAX_SAFE_INTEGER,
): InvestigationCase[] {
  // Discover granted descendants without scanning other owners' private cases.
  const rows = db
    .query(`WITH RECURSIVE visible(id) AS (
    SELECT id FROM investigations WHERE owner_key = ?
    UNION SELECT case_id FROM investigation_grants WHERE principal = ?
    UNION SELECT c.id FROM investigations c JOIN visible p ON c.parent_case_id = p.id
  ) SELECT c.* FROM investigations c JOIN visible v ON c.id = v.id
    WHERE c.updated_at < ? ORDER BY c.updated_at DESC, c.id LIMIT 100`)
    .all(principal, principal, before) as CaseRow[];
  return rows.map((row) => projectCase(db, row, caseAccess(db, row.id, principal).access));
}

export function grantInvestigation(
  db: Database,
  owner: string,
  caseId: string,
  principal: string,
  access: InvestigationAccess | null,
): void {
  db.transaction(() => {
    const row = writableCase(db, caseId, owner, true);
    if (access) {
      if (access !== "read" && access !== "work")
        throw new InvestigationError("invalid_request", "Access must be read or work");
      db.run(
        `INSERT INTO investigation_grants VALUES (?,?,?,?) ON CONFLICT(case_id,principal)
        DO UPDATE SET access=excluded.access, created_at=excluded.created_at`,
        [caseId, principal, access, Date.now()],
      );
    } else
      db.run("DELETE FROM investigation_grants WHERE case_id = ? AND principal = ?", [
        caseId,
        principal,
      ]);
    appendEvent(db, row.selected_attempt_id, { kind: "access_changed", actor: row.owner_name });
  })();
}

export function selectInvestigationAttempt(
  db: Database,
  principal: string,
  id: string,
): InvestigationSnapshot {
  return db.transaction(() => {
    const attempt = attemptRow(db, id);
    writableCase(db, attempt.case_id, principal);
    if (!attempt.result_json)
      throw new InvestigationError("no_result", "This attempt has no published result", 409);
    const request: InvestigationRequest = JSON.parse(attempt.request_json);
    db.run(
      "UPDATE investigations SET selected_attempt_id=?,current_attempt_id=?,question=?,updated_at=? WHERE id=?",
      [id, id, request.question, Date.now(), attempt.case_id],
    );
    appendEvent(db, id, { kind: "selected", actor: principal });
    return getInvestigation(db, principal, attempt.case_id, id);
  })();
}
