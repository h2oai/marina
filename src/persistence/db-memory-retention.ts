// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { integer, MemoryError, textValue } from "../memory/service-types";
import { authorizeMemorySpace } from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

/** Caller explicitly confirms it has consumed these outcomes. No new retry
 * receipt is generated for this idempotent acknowledgement operation. */
export function acknowledgeMemoryRequests(
  db: Database,
  actor: MemoryActor,
  space: string,
  keys: unknown,
) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 100)
    throw new MemoryError(400, "invalid_input", "Acknowledge 1–100 request keys");
  const distinct = [...new Set(keys.map((key) => textValue(key, "request key", 128)))];
  return db.transaction(() => {
    authorizeMemorySpace(db, actor, space, "memory:write", true);
    const acknowledged: string[] = [],
      missing: string[] = [];
    for (const key of distinct) {
      const changed = db.run(
        "UPDATE memory_requests SET acknowledged_at=coalesce(acknowledged_at,?) WHERE principal_id=? AND (space_id=? OR (space_id='' AND json_extract(response,'$.id')=?)) AND request_key=?",
        [Date.now(), actor.principalId, space, space, key],
      );
      (changed.changes ? acknowledged : missing).push(key);
    }
    return { acknowledged, missing };
  })();
}

/** Operator-only bounded maintenance. Unacknowledged requests are never selected;
 * compacted keys remain tombstones forever, preventing delayed retry duplication. */
export function compactMemoryReceipts(
  db: Database,
  options: { before: number; limit?: number; apply?: boolean },
) {
  const before = integer(options.before, "before", 0, Date.now()),
    limit = integer(options.limit ?? 1000, "limit", 1, 10000);
  return db.transaction(() => {
    const rows = db
      .query(`SELECT principal_id,space_id,request_key,response FROM memory_requests
      WHERE acknowledged_at<=? AND retired_at IS NULL ORDER BY acknowledged_at,principal_id,space_id,request_key LIMIT ?`)
      .all(before, limit) as {
      principal_id: string;
      space_id: string;
      request_key: string;
      response: string;
    }[];
    let released = 0;
    for (const row of rows) {
      const receipt = JSON.parse(row.response);
      const compact = JSON.stringify({ id: receipt.id, retired: true });
      released += Buffer.byteLength(row.response) - Buffer.byteLength(compact);
      if (options.apply)
        db.run(
          "UPDATE memory_requests SET response=?,retired_at=? WHERE principal_id=? AND space_id=? AND request_key=?",
          [compact, Date.now(), row.principal_id, row.space_id, row.request_key],
        );
    }
    return {
      schema: "marina.memory.receipt-retention.v1",
      applied: options.apply === true,
      selected: rows.length,
      logical_payload_bytes_released: released,
      unacknowledged_untouched: true,
      retired_keys_reusable: false,
    };
  })();
}
