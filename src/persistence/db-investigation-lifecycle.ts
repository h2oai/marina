// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { CONTENT_OBJECT_BYTES, InvestigationError } from "../investigations/validation";
import type { InvestigationResult, InvestigationState } from "../sdk/investigation-types";
import { saveForecastAnswer } from "./db-markets";
import { type AttemptRow, appendEvent, attemptRow, writableCase } from "./investigation-records";

export function claimInvestigation(db: Database, id: string): string | undefined {
  return db.transaction(() => {
    const generation = randomUUID();
    if (
      !db.run(
        "UPDATE investigation_attempts SET state='running',generation=? WHERE id=? AND state='queued'",
        [generation, id],
      ).changes
    )
      return undefined;
    const row = attemptRow(db, id);
    appendEvent(db, id, { kind: "started", actor: row.actor_name });
    return generation;
  })();
}

export interface InvestigationCompletion {
  state: Extract<InvestigationState, "completed" | "failed" | "interrupted">;
  result?: InvestigationResult;
  error?: string;
  forecast?: Omit<
    Parameters<typeof saveForecastAnswer>[1],
    "entityName" | "source" | "externalId" | "sampleId" | "evalMode"
  >;
}

export function finishInvestigation(
  db: Database,
  id: string,
  generation: string,
  completion: InvestigationCompletion,
): boolean {
  return db.transaction(() => {
    const row = attemptRow(db, id);
    if (row.state !== "running" || row.generation !== generation) return false;
    if (completion.state === "completed" && !completion.result)
      throw new InvestigationError(
        "missing_result",
        "Completed work must have a recorded result",
        500,
      );
    let answerId: number | undefined;
    if (completion.forecast) {
      if (Buffer.byteLength(completion.forecast.answerJson) > CONTENT_OBJECT_BYTES)
        throw new InvestigationError(
          "content_quota",
          "Filed answer exceeds the capture limit",
          413,
        );
      // The case owns access. Keep these rows out of name-based legacy histories.
      answerId = saveForecastAnswer(db, {
        ...completion.forecast,
        entityName: `investigation:${row.case_id}`,
        source: "investigation",
        externalId: `investigation:${id}`,
      });
    }
    const result = completion.result
      ? { ...completion.result, ...(answerId ? { answerId } : {}) }
      : undefined;
    if (result && Buffer.byteLength(JSON.stringify(result)) > CONTENT_OBJECT_BYTES)
      throw new InvestigationError("content_quota", "Result exceeds the 2 MiB limit", 413);
    const now = Date.now();
    db.run(
      "UPDATE investigation_attempts SET state=?,result_json=?,answer_id=?,error=?,updated_at=? WHERE id=?",
      [
        completion.state,
        result ? JSON.stringify(result) : null,
        answerId ?? null,
        completion.error ?? null,
        now,
        id,
      ],
    );
    if (result)
      db.run(
        "UPDATE investigations SET current_attempt_id=?,updated_at=? WHERE id=? AND selected_attempt_id=?",
        [id, now, row.case_id, id],
      );
    appendEvent(
      db,
      id,
      { kind: "terminal", actor: row.actor_name, message: completion.state },
      now,
    );
    return true;
  })();
}

/** Settlement may arrive after cancellation; it can never change execution or answer state. */
export function settleInvestigation(
  db: Database,
  id: string,
  generation: string,
  accounting: InvestigationResult["accounting"],
): boolean {
  if (
    !Number.isFinite(accounting.knownUsd) ||
    accounting.knownUsd < 0 ||
    !Number.isSafeInteger(accounting.outstanding) ||
    accounting.outstanding < 0
  )
    throw new InvestigationError("invalid_accounting", "Invalid settlement", 500);
  return db.transaction(() => {
    const row = db
      .query("SELECT * FROM investigation_attempts WHERE id=? AND generation=?")
      .get(id, generation) as AttemptRow | null;
    if (!row) return false; // erased or replaced, never recreate it
    const previous: InvestigationResult["accounting"] = JSON.parse(row.accounting_json);
    const next = { ...accounting, knownUsd: Math.max(previous.knownUsd, accounting.knownUsd) };
    const json = JSON.stringify(next);
    if (json === row.accounting_json) return true;
    db.run("UPDATE investigation_attempts SET accounting_json=? WHERE id=?", [json, id]);
    appendEvent(db, id, {
      kind: "accounting",
      actor: row.actor_name,
      message: `${next.outstanding} outstanding; $${next.knownUsd.toFixed(6)} recorded; accounting ${next.complete ? "complete" : "partial"}`,
    });
    return true;
  })();
}

export function cancelInvestigation(db: Database, principal: string, id: string): string[] {
  return db.transaction(() => {
    const row = attemptRow(db, id);
    writableCase(db, row.case_id, principal);
    if (row.state !== "queued" && row.state !== "running") return [];
    // Recursion follows owned child links, not shared evidence references or worker identities.
    const active = db
      .query(`WITH RECURSIVE owned(id) AS (
      SELECT id FROM investigation_attempts WHERE id=?
      UNION SELECT a.id FROM investigation_attempts a JOIN owned p ON a.parent_attempt_id=p.id
        WHERE a.root_attempt_id = ?
    ) SELECT a.* FROM investigation_attempts a JOIN owned o ON a.id=o.id
      WHERE a.state IN ('queued','running')`)
      .all(id, row.root_attempt_id) as AttemptRow[];
    for (const a of active) {
      db.run("UPDATE investigation_attempts SET state='cancelled' WHERE id=?", [a.id]);
      appendEvent(db, a.id, { kind: "terminal", actor: principal, message: "cancelled" });
    }
    return active.map((a) => a.id);
  })();
}

export function recoverInvestigations(db: Database): number {
  return db.transaction(() => {
    const rows = db
      .query("SELECT * FROM investigation_attempts WHERE state IN ('queued','running')")
      .all() as AttemptRow[];
    for (const row of rows) {
      db.run("UPDATE investigation_attempts SET state='interrupted',error=? WHERE id=?", [
        "Executor stopped. Start a new attempt to retry; prior provider calls were not replayed.",
        row.id,
      ]);
      appendEvent(db, row.id, { kind: "terminal", actor: "system", message: "interrupted" });
    }
    return rows.length;
  })();
}

/** True even after case erasure: the private source marker survives on the tombstone. */
export function isPrivateForecast(db: Database, answerId: number): boolean {
  return !!db
    .query("SELECT 1 FROM forecast_answers WHERE id=? AND source='investigation'")
    .get(answerId);
}

/** Owner-authorized erasure, including all case-owned descendants and canonical text copies. */
export function eraseInvestigation(db: Database, principal: string, caseId: string): void {
  db.transaction(() => {
    writableCase(db, caseId, principal, true);
    const descendants = db
      .query(`WITH RECURSIVE owned(id) AS (
      SELECT id FROM investigations WHERE id=?
      UNION SELECT c.id FROM investigations c JOIN owned p ON c.parent_case_id=p.id
    ) SELECT a.id,a.answer_id FROM investigation_attempts a JOIN owned o ON a.case_id=o.id`)
      .all(caseId) as { id: string; answer_id: number | null }[];
    for (const row of descendants) {
      if (row.answer_id !== null) {
        // Preserve the canonical ID/private marker while removing sensitive labels and values.
        db.run(
          `UPDATE forecast_answers SET entity_name='[erased]',question='[erased]',answer_json='{}',
          probability=NULL,mean=NULL,sd=NULL,prediction=NULL,outcome_json=NULL,score=NULL WHERE id=?`,
          [row.answer_id],
        );
        // Outcome labels can contain user-defined choices; account erasure is the audited exception.
        db.run(
          "DELETE FROM decision_outcomes WHERE outcome_id IN (SELECT id FROM outcomes WHERE subject=?)",
          [`forecast:${row.answer_id}`],
        );
        db.run(
          "DELETE FROM outcome_deliveries WHERE outcome_id IN (SELECT id FROM outcomes WHERE subject=?)",
          [`forecast:${row.answer_id}`],
        );
        db.run("DELETE FROM outcomes WHERE subject=?", [`forecast:${row.answer_id}`]);
      }
      db.run("UPDATE investigation_admissions SET attempt_id=NULL WHERE attempt_id=?", [row.id]);
    }
    db.run("DELETE FROM investigations WHERE id=?", [caseId]);
  })();
}

export function eraseOwnerInvestigations(db: Database, principal: string): number {
  const rows = db
    .query("SELECT id FROM investigations WHERE owner_key=? AND parent_case_id IS NULL")
    .all(principal) as { id: string }[];
  for (const row of rows) eraseInvestigation(db, principal, row.id);
  db.run("DELETE FROM investigation_grants WHERE principal=?", [principal]);
  db.run("DELETE FROM investigation_admissions WHERE actor_key=?", [principal]);
  return rows.length;
}
