// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import type { SpendReceipt } from "../engine/spend-observation";
import type { InvestigationResult } from "../sdk/investigation-types";

/** Late replies may settle a cancelled attempt, never an erased/replaced one. */
export function recordInvestigationSpend(
  db: Database,
  attempt: string,
  generation: string,
  r: SpendReceipt,
): void {
  if (r.usd !== undefined && (!Number.isFinite(r.usd) || r.usd < 0))
    throw new Error("Invalid spend receipt");
  db.run(
    `INSERT INTO investigation_spend_receipts(id,attempt_id,source,model,state,usd,reason,created_at,settled_at)
    SELECT ?,id,?,?,?,?,?,?,? FROM investigation_attempts WHERE id=? AND generation=?
    ON CONFLICT(id) DO UPDATE SET state=excluded.state,usd=excluded.usd,reason=excluded.reason,settled_at=excluded.settled_at
      WHERE investigation_spend_receipts.attempt_id=excluded.attempt_id AND investigation_spend_receipts.state='pending'`,
    [
      r.id,
      r.source,
      r.model ?? null,
      r.state,
      r.usd ?? null,
      r.reason ?? null,
      Date.now(),
      r.state === "pending" ? null : Date.now(),
      attempt,
      generation,
    ],
  );
}

/** Sum each unique upstream attempt once, including owned descendants. */
export function investigationSpendAccounting(
  db: Database,
  id: string,
  base: InvestigationResult["accounting"],
): InvestigationResult["accounting"] {
  const rows = db
    .query(`WITH RECURSIVE owned(id) AS (
    SELECT id FROM investigation_attempts WHERE id=?
    UNION SELECT a.id FROM investigation_attempts a JOIN owned p ON a.parent_attempt_id=p.id
  ) SELECT r.* FROM investigation_spend_receipts r JOIN owned o ON r.attempt_id=o.id`)
    .all(id) as {
    state: string;
    usd: number | null;
    reason: string | null;
  }[];
  const reasons = new Set(base.reasons ?? []);
  if (!rows.length) {
    if (base.knownUsd > 0) reasons.add("Executor reported cost without per-call receipts");
    return {
      ...base,
      complete: base.complete && reasons.size === 0 && base.outstanding === 0,
      ...(reasons.size ? { reasons: [...reasons] } : {}),
    };
  }
  const pending = rows.filter((r) => r.state === "pending").length;
  const unknown = rows.filter((r) => r.state === "unknown").length;
  if (pending) reasons.add("Upstream calls have no settled receipt (possibly interrupted)");
  for (const row of rows)
    if (row.state === "unknown") reasons.add(row.reason ?? "Unknown upstream charge");
  return {
    ...base,
    knownUsd: rows.reduce((sum, r) => sum + (r.usd ?? 0), 0),
    pricedCalls: rows.filter((r) => r.state === "priced").length,
    unknownCalls: unknown,
    outstanding: Math.max(base.outstanding, pending),
    complete: base.complete && reasons.size === 0 && base.outstanding === 0,
    reasons: [...reasons],
  };
}
