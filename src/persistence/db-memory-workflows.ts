// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { integer, MemoryError, textValue } from "../memory/service-types";
import type { MemoryChange, MemoryChanges } from "../sdk/memory-workflows";
import { authorizeMemorySpace } from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

/** Payload-free, authorized cursor feed over canonical service events. No public watch pool. */
export function memoryChanges(
  db: Database,
  actor: MemoryActor,
  space: string,
  after: unknown = 0,
  ids: unknown = [],
  count: unknown = 50,
): MemoryChanges {
  const cursor = integer(after, "cursor", 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(count, "limit", 1, 100);
  if (!Array.isArray(ids) || ids.length > 32)
    throw new MemoryError(400, "invalid_input", "Watch at most 32 identifiers");
  const references = ids.map((id) => textValue(id, "id", 128));
  return db.transaction(() => {
    authorizeMemorySpace(db, actor, space);
    const head = db
      .query("SELECT coalesce(max(seq),0) AS seq FROM memory_service_events WHERE space_id=?")
      .get(space) as { seq: number };
    if (cursor > head.seq)
      throw new MemoryError(
        409,
        "cursor_ahead",
        "Cursor is ahead of this space; restart from zero",
      );
    const rows = db
      .query(`SELECT seq,operation,reference_id,version,created_at FROM memory_service_events
      WHERE space_id=? AND seq>? AND (?=0 OR reference_id IN (SELECT value FROM json_each(?)) OR operation IN ('grant.set','grant.revoked','space.forgotten','forget.completed'))
      ORDER BY seq LIMIT ?`)
      .all(
        space,
        cursor,
        references.length,
        JSON.stringify(references),
        limit + 1,
      ) as MemoryChange[];
    const events = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return {
      space_id: space,
      events,
      cursor: hasMore ? events.at(-1)!.seq : head.seq,
      high_watermark: head.seq,
      has_more: hasMore,
    };
  })();
}
