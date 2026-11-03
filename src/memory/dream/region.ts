// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The dream region (Auto-Dreamer's rule): what the agent WROTE in the window
 * ∪ what it was SERVED in the window, with the use evidence on each record,
 * plus the outcomes it resolved and the procedures repeated across its
 * successful tasks (`procedures.ts`). Own fact-like legacy notes only — never
 * a pool, never another owner's space, never the process tier. Byte-capped,
 * newest first; what does not fit waits for the next dream.
 */

import { createHash } from "node:crypto";
import type { MarinaDB, NoteRow } from "../../persistence/database";
import { itemsServedTo, usefulnessPosterior } from "../../persistence/db-memory-usefulness";
import { gatherProcedures } from "./procedures";
import type { DreamRegion, RegionRecord } from "./types";

/** Newest own records considered per dream. */
export const REGION_MAX_RECORDS = 200;
/** Content bytes the model is shown, at most. */
export const REGION_MAX_BYTES = 24_000;
/** Content shown per record, at most. */
export const REGION_RECORD_MAX_CHARS = 400;

const FACT_LIKE = ["fact", "reflection", "skill"];

function trimContent(content: string): string {
  return content.length > REGION_RECORD_MAX_CHARS
    ? `${content.slice(0, REGION_RECORD_MAX_CHARS - 1)}…`
    : content;
}

export function gatherRegion(
  db: MarinaDB,
  entityName: string,
  since: number,
  until = Date.now(),
): DreamRegion {
  const raw = db.memoryRepository().raw;
  const written = raw
    .query<NoteRow, [string, number, number, number]>(
      `SELECT * FROM numeric_notes
       WHERE entity_name = ? AND pool_id IS NULL AND created_at BETWEEN ? AND ?
         AND verification_status != 'superseded' AND tier IN ('fact','reflection','skill')
       ORDER BY id DESC LIMIT ?`,
    )
    .all(entityName, since, until, REGION_MAX_RECORDS);
  const newRecords = written.length;
  const byId = new Map<number, NoteRow>(written.map((n) => [n.id, n]));
  // Served legacy notes (numeric item ids) that the owner wrote: part of the region too.
  const served = itemsServedTo(raw, entityName, since, until, REGION_MAX_RECORDS);
  for (const item of served) {
    if (!/^\d+$/.test(item.itemId)) continue;
    const id = Number(item.itemId);
    if (byId.has(id)) continue;
    const note = db.getNote(id);
    if (
      !note ||
      note.entity_name !== entityName ||
      note.pool_id != null ||
      note.verification_status === "superseded" ||
      !FACT_LIKE.includes(note.tier)
    )
      continue;
    byId.set(id, note);
  }
  const ids = [...byId.keys()].sort((a, b) => b - a);
  const serves = new Map<string, number>();
  for (const row of raw
    .query<{ item_id: string; n: number }, [string, number, number]>(
      `SELECT item_id, count(*) AS n FROM memory_served
       WHERE entity_name = ? AND served_at BETWEEN ? AND ? GROUP BY item_id`,
    )
    .all(entityName, since, until))
    serves.set(row.item_id, row.n);
  const cited = new Map<string, number>();
  for (const row of raw
    .query<{ item_id: string; n: number }, [string]>(
      `SELECT item_id, count(*) AS n FROM memory_ratings
       WHERE rater = 'citation' AND rater_entity = ? GROUP BY item_id`,
    )
    .all(entityName))
    cited.set(row.item_id, row.n);
  const posterior = usefulnessPosterior(
    raw,
    ids.map((id) => String(id)),
  );

  const records: RegionRecord[] = [];
  let bytes = 0;
  for (const id of ids) {
    const note = byId.get(id)!;
    const content = trimContent(note.content);
    const size = Buffer.byteLength(content, "utf8");
    if (bytes + size > REGION_MAX_BYTES) break;
    bytes += size;
    const p = posterior.get(String(id));
    records.push({
      id,
      tier: note.tier,
      noteType: note.note_type,
      importance: note.importance,
      verified: note.verification_status === "verified",
      createdAt: note.created_at,
      content,
      serves: serves.get(String(id)) ?? 0,
      cited: cited.get(String(id)) ?? 0,
      mean: p?.mean ?? 0.5,
      ratings: p?.n ?? 0,
    });
  }
  const outcomes = db.listOutcomes({ owner: entityName, since, limit: 200 });
  const succeeded = outcomes.filter((o) => o.succeeded === 1).length;
  const hash = createHash("sha256")
    .update(JSON.stringify(records.map((r) => [r.id, r.createdAt])))
    .digest("hex")
    .slice(0, 16);
  return {
    entityName,
    since,
    until,
    records,
    outcomes: { total: outcomes.length, succeeded, failed: outcomes.length - succeeded },
    newRecords,
    procedures: gatherProcedures(db, entityName, since, until),
    hash,
    bytes,
  };
}
