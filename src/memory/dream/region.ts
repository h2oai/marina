// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The dream region (Auto-Dreamer's rule): what the agent WROTE in the window
 * ∪ what it was SERVED in the window, with the use evidence on each record,
 * plus the outcomes it resolved and the procedures repeated across its
 * successful tasks (`procedures.ts`), and its newest journal episodes
 * (`journal.ts`). Own fact-like legacy notes only — never
 * a pool, never another owner's space, never the process tier. Byte-capped,
 * newest first; what does not fit waits for the next dream.
 *
 * A POOL region (`scope.ts`, name `pool:<name>`) is the same over a shared
 * pool: the pool's fact-like records written in the window ∪ those served to
 * any member in the window, with use evidence from every member, plus the
 * outcomes of the records' authors. No procedures: a pool proposes merges,
 * links and decays only.
 */

import { createHash } from "node:crypto";
import type { MarinaDB, NoteRow } from "../../persistence/database";
import { itemsServedTo, usefulnessPosterior } from "../../persistence/db-memory-usefulness";
import { gatherEpisodes } from "./journal";
import { gatherProcedures } from "./procedures";
import { type DreamScope, scopeOf } from "./scope";
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

const liveFactLike = (note: NoteRow | undefined): note is NoteRow =>
  !!note && note.verification_status !== "superseded" && FACT_LIKE.includes(note.tier);

/** The scope's live fact-like records written in the window, newest first. */
function writtenIn(db: MarinaDB, scope: DreamScope, since: number, until: number): NoteRow[] {
  const raw = db.memoryRepository().raw;
  return scope.kind === "pool"
    ? raw
        .query<NoteRow, [string, number, number, number]>(
          `SELECT * FROM numeric_notes
           WHERE pool_id = ? AND created_at BETWEEN ? AND ?
             AND verification_status != 'superseded' AND tier IN ('fact','reflection','skill')
           ORDER BY id DESC LIMIT ?`,
        )
        .all(scope.poolId, since, until, REGION_MAX_RECORDS)
    : raw
        .query<NoteRow, [string, number, number, number]>(
          `SELECT * FROM numeric_notes
           WHERE entity_name = ? AND pool_id IS NULL AND created_at BETWEEN ? AND ?
             AND verification_status != 'superseded' AND tier IN ('fact','reflection','skill')
           ORDER BY id DESC LIMIT ?`,
        )
        .all(scope.name, since, until, REGION_MAX_RECORDS);
}

/** Legacy note ids served in the window: to the owner, or (a pool) to any member. */
function servedIn(db: MarinaDB, scope: DreamScope, since: number, until: number): number[] {
  const raw = db.memoryRepository().raw;
  const ids =
    scope.kind === "pool"
      ? raw
          .query<{ item_id: string }, [number, number, string, number]>(
            `SELECT DISTINCT item_id FROM memory_served
             WHERE served_at BETWEEN ? AND ?
               AND item_id IN (SELECT CAST(id AS TEXT) FROM notes WHERE pool_id = ?)
             LIMIT ?`,
          )
          .all(since, until, scope.poolId, REGION_MAX_RECORDS)
          .map((r) => r.item_id)
      : itemsServedTo(raw, scope.name, since, until, REGION_MAX_RECORDS).map((i) => i.itemId);
  return ids.filter((id) => /^\d+$/.test(id)).map(Number);
}

/** Serve counts in the window and citation counts, per item, as the scope sees them. */
function useEvidence(
  db: MarinaDB,
  scope: DreamScope,
  since: number,
  until: number,
): { serves: Map<string, number>; cited: Map<string, number> } {
  const raw = db.memoryRepository().raw;
  const serves = new Map<string, number>();
  const cited = new Map<string, number>();
  if (scope.kind === "pool") {
    for (const row of raw
      .query<{ item_id: string; n: number }, [number, number, string]>(
        `SELECT item_id, count(*) AS n FROM memory_served
         WHERE served_at BETWEEN ? AND ?
           AND item_id IN (SELECT CAST(id AS TEXT) FROM notes WHERE pool_id = ?)
         GROUP BY item_id`,
      )
      .all(since, until, scope.poolId))
      serves.set(row.item_id, row.n);
    for (const row of raw
      .query<{ item_id: string; n: number }, [string]>(
        `SELECT item_id, count(*) AS n FROM memory_ratings
         WHERE rater = 'citation'
           AND item_id IN (SELECT CAST(id AS TEXT) FROM notes WHERE pool_id = ?)
         GROUP BY item_id`,
      )
      .all(scope.poolId))
      cited.set(row.item_id, row.n);
    return { serves, cited };
  }
  for (const row of raw
    .query<{ item_id: string; n: number }, [string, number, number]>(
      `SELECT item_id, count(*) AS n FROM memory_served
       WHERE entity_name = ? AND served_at BETWEEN ? AND ? GROUP BY item_id`,
    )
    .all(scope.name, since, until))
    serves.set(row.item_id, row.n);
  for (const row of raw
    .query<{ item_id: string; n: number }, [string]>(
      `SELECT item_id, count(*) AS n FROM memory_ratings
       WHERE rater = 'citation' AND rater_entity = ? GROUP BY item_id`,
    )
    .all(scope.name))
    cited.set(row.item_id, row.n);
  return { serves, cited };
}

export function gatherRegion(
  db: MarinaDB,
  entityName: string,
  since: number,
  until = Date.now(),
): DreamRegion {
  const scope = scopeOf(db, entityName);
  const empty: DreamRegion = {
    entityName,
    since,
    until,
    records: [],
    outcomes: { total: 0, succeeded: 0, failed: 0 },
    newRecords: 0,
    procedures: [],
    episodes: [],
    journalBytes: 0,
    hash: "",
    bytes: 0,
  };
  if (!scope) return empty;
  const written = writtenIn(db, scope, since, until);
  const newRecords = written.length;
  const byId = new Map<number, NoteRow>(written.map((n) => [n.id, n]));
  // Served records of the scope: part of the region too.
  for (const id of servedIn(db, scope, since, until)) {
    if (byId.has(id)) continue;
    const note = db.getNote(id);
    if (!liveFactLike(note)) continue;
    if (scope.kind === "pool" ? note.pool_id !== scope.poolId : note.entity_name !== scope.name)
      continue;
    if (scope.kind === "entity" && note.pool_id != null) continue;
    byId.set(id, note);
  }
  const ids = [...byId.keys()].sort((a, b) => b - a);
  const { serves, cited } = useEvidence(db, scope, since, until);
  const posterior = usefulnessPosterior(
    db.memoryRepository().raw,
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
  // Outcomes: the owner's, or every record author's (a pool).
  const owners =
    scope.kind === "pool" ? [...new Set(ids.map((id) => byId.get(id)!.entity_name))] : [scope.name];
  let total = 0;
  let succeeded = 0;
  for (const owner of owners) {
    const outcomes = db.listOutcomes({ owner, since, limit: 200 });
    total += outcomes.length;
    succeeded += outcomes.filter((o) => o.succeeded === 1).length;
  }
  // The owner's own episodes (never a pool's members'): evidence for the model, never stored.
  const journal =
    scope.kind === "entity"
      ? gatherEpisodes(db, entityName, since, until)
      : { episodes: [], bytes: 0, parts: 0 };
  const hash = createHash("sha256")
    .update(JSON.stringify(records.map((r) => [r.id, r.createdAt])))
    .digest("hex")
    .slice(0, 16);
  return {
    entityName,
    since,
    until,
    records,
    outcomes: { total, succeeded, failed: total - succeeded },
    newRecords,
    procedures: scope.kind === "pool" ? [] : gatherProcedures(db, entityName, since, until),
    episodes: journal.episodes,
    journalBytes: journal.bytes,
    ...(scope.kind === "pool" ? { pool: { id: scope.poolId, name: scope.name } } : {}),
    hash,
    bytes,
  };
}
