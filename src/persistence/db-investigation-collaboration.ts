// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { maskSensitiveText } from "../decisions/gate";
import { InvestigationError } from "../investigations/validation";
import type { InvestigationActor } from "../sdk/investigation-types";
import { appendEvent, attemptRow, writableCase } from "./investigation-records";

/** Case-local review evidence. Messaging remains Marina's existing tell/channel system. */
export function reviewInvestigation(
  db: Database,
  actor: InvestigationActor,
  id: string,
  text: string,
) {
  if (typeof text !== "string" || !text.trim() || text.length > 4000)
    throw new InvestigationError("invalid_review", "A review must contain 1–4000 characters");
  return db.transaction(() => {
    const attempt = attemptRow(db, id);
    writableCase(db, attempt.case_id, actor.key);
    const count = db
      .query(
        "SELECT count(*) AS n FROM investigation_events WHERE attempt_id=? AND json_extract(event_json,'$.kind')='review'",
      )
      .get(id) as { n: number };
    if (count.n >= 100)
      throw new InvestigationError(
        "review_quota",
        "This attempt already has 100 reviews; create a new iteration",
        429,
      );
    return appendEvent(db, id, {
      kind: "review",
      actor: actor.name,
      message: maskSensitiveText(text.trim(), 4000),
    });
  })();
}

/** Internal authorization seam for the existing scorer; no second scoring implementation. */
export function investigationResolutionTarget(db: Database, principal: string, id: string): number {
  const attempt = attemptRow(db, id);
  writableCase(db, attempt.case_id, principal);
  if (!attempt.answer_id)
    throw new InvestigationError(
      "no_answer",
      "This attempt has no filed prediction to resolve",
      409,
    );
  return attempt.answer_id;
}

export function recordInvestigationResolution(
  db: Database,
  actor: InvestigationActor,
  id: string,
): void {
  const attempt = attemptRow(db, id);
  writableCase(db, attempt.case_id, actor.key);
  appendEvent(db, id, {
    kind: "resolved",
    actor: actor.name,
    message: "Outcome filed through Marina's forecast scorer",
  });
}
