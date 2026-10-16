// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  CONTENT_ATTEMPT_BYTES,
  CONTENT_OBJECT_BYTES,
  CONTENT_OWNER_BYTES,
  InvestigationError,
} from "../investigations/validation";
import type {
  InvestigationContent,
  InvestigationEvent,
  InvestigationEventPage,
} from "../sdk/investigation-types";
import { appendEvent, attemptRow, caseAccess, missing } from "./investigation-records";

export function appendInvestigationEvent(
  db: Database,
  id: string,
  generation: string,
  event: Omit<InvestigationEvent, "attemptId" | "sequence" | "at">,
): InvestigationEvent {
  return db.transaction(() => {
    const row = attemptRow(db, id);
    if (row.state !== "running" || row.generation !== generation) {
      throw new InvestigationError("inactive_attempt", "Attempt is no longer running", 409);
    }
    return appendEvent(db, id, event);
  })();
}

export function storeInvestigationContent(
  db: Database,
  id: string,
  generation: string,
  label: string,
  value: unknown,
): string {
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new InvestigationError("invalid_content", "Content must be JSON serializable");
  const bytes = Buffer.byteLength(json);
  if (bytes > CONTENT_OBJECT_BYTES)
    throw new InvestigationError(
      "content_quota",
      "Stage content exceeds the 2 MiB capture limit",
      413,
    );
  return db.transaction(() => {
    const row = attemptRow(db, id);
    if (row.state !== "running" || row.generation !== generation)
      throw new InvestigationError("inactive_attempt", "Attempt is no longer running", 409);
    const used = db
      .query(`SELECT coalesce(sum(p.bytes),0) AS owner,
      coalesce(sum(CASE WHEN p.attempt_id = ? THEN p.bytes ELSE 0 END),0) AS attempt
      FROM investigation_content p JOIN investigation_attempts a ON a.id=p.attempt_id
      JOIN investigations c ON c.id=a.case_id WHERE c.owner_key=(SELECT owner_key FROM investigations WHERE id=?)`)
      .get(id, row.case_id) as { owner: number; attempt: number };
    if (used.owner + bytes > CONTENT_OWNER_BYTES || used.attempt + bytes > CONTENT_ATTEMPT_BYTES) {
      throw new InvestigationError(
        "content_quota",
        "Evidence storage allowance exhausted; erase unneeded cases before starting more work",
        413,
      );
    }
    const contentId = randomUUID();
    db.run("INSERT INTO investigation_content VALUES (?,?,?,?,?,?,?)", [
      contentId,
      id,
      label.slice(0, 160),
      json,
      bytes,
      createHash("sha256").update(json).digest("hex"),
      Date.now(),
    ]);
    return contentId;
  })();
}

export function getInvestigationContent(
  db: Database,
  principal: string,
  contentId: string,
): InvestigationContent {
  const row = db.query("SELECT * FROM investigation_content WHERE id = ?").get(contentId) as {
    id: string;
    attempt_id: string;
    label: string;
    value_json: string;
    bytes: number;
    hash: string;
    created_at: number;
  } | null;
  if (!row) return missing();
  caseAccess(db, attemptRow(db, row.attempt_id).case_id, principal);
  return {
    id: row.id,
    attemptId: row.attempt_id,
    label: row.label,
    value: JSON.parse(row.value_json),
    bytes: row.bytes,
    hash: row.hash,
    createdAt: row.created_at,
  };
}

export function readInvestigationEvents(
  db: Database,
  principal: string,
  id: string,
  after = 0,
  limit = 100,
): InvestigationEventPage {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  ) {
    throw new InvestigationError(
      "invalid_cursor",
      "Use a nonnegative cursor and a page size of 1–200",
    );
  }
  return db.transaction(() => {
    const row = attemptRow(db, id);
    caseAccess(db, row.case_id, principal);
    const first = db
      .query("SELECT min(sequence) AS n FROM investigation_events WHERE attempt_id=?")
      .get(id) as { n: number | null };
    if (after > row.sequence || (after > 0 && first.n !== null && after < first.n - 1)) {
      return { events: [], cursor: row.sequence, more: false, reset: true };
    }
    const records = db
      .query(
        "SELECT event_json FROM investigation_events WHERE attempt_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(id, after, limit + 1) as { event_json: string }[];
    const events: InvestigationEvent[] = records
      .slice(0, limit)
      .map((r) => JSON.parse(r.event_json));
    return {
      events,
      cursor: events.at(-1)?.sequence ?? after,
      more: records.length > limit,
      reset: false,
    };
  })();
}
