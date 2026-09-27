// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Database } from "bun:sqlite";

export interface LegacyBridgeIntent {
  id: number;
  operation: string;
  args: string;
  attempts: number;
  last_error: string | null;
}

export function enqueueLegacyBridge(db: Database, operation: string, args: unknown[]): number {
  const encoded = JSON.stringify(args);
  db.run("INSERT OR IGNORE INTO legacy_memory_outbox(operation, args) VALUES (?, ?)", [
    operation,
    encoded,
  ]);
  return db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM legacy_memory_outbox WHERE operation = ? AND args = ?",
    )
    .get(operation, encoded)!.id;
}

export function pendingLegacyBridges(db: Database, limit = 100): LegacyBridgeIntent[] {
  return db
    .query<LegacyBridgeIntent, [number]>(
      "SELECT * FROM legacy_memory_outbox ORDER BY attempts, id LIMIT ?",
    )
    .all(limit);
}

export function completeLegacyBridge(db: Database, id: number): void {
  db.run("DELETE FROM legacy_memory_outbox WHERE id = ?", [id]);
}

export function failLegacyBridge(db: Database, id: number, code: string): void {
  db.run("UPDATE legacy_memory_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?", [
    code,
    id,
  ]);
}

/** A worker can crash after the durable commit but before acknowledging its
 * outbox row. Check the canonical receipt before recomputing a CAS version. */
export function committedLegacyReview(
  db: Database,
  owner: string,
  space: string,
  key: string,
  recordId: string,
): boolean {
  return !!db
    .query(`SELECT 1 FROM memory_requests q JOIN users u ON u.id=q.principal_id
    WHERE u.name=? AND q.space_id=? AND q.request_key=? AND json_extract(q.response,'$.id')=?`)
    .get(owner, space, key, recordId);
}

/** Retirement may only affect the author's own canonical record. Ratified
 * institutional publications have independent ownership and survive deletion
 * of the original note. A previously forgotten record needs no retirement. */
export function legacyRetirementSpace(
  db: Database,
  owner: string,
  recordId: string,
): string | undefined {
  return db
    .query<{ space_id: string }, [string, string]>(`
    SELECT r.space_id FROM memory_records r JOIN memory_spaces s ON s.id=r.space_id
    JOIN users u ON u.id=s.owner_id WHERE u.name=? AND r.id=?
      AND r.status='active' AND s.status='active'`)
    .get(owner, recordId)?.space_id;
}

/** Bounded, resumable backfill over existing numeric notes; identity remains server-resolved. */
export function queueLegacyBridgeBackfill(
  db: Database,
  owner?: string,
  afterId = 0,
  limit = 500,
): { scanned: number; afterId: number } {
  if (
    !Number.isSafeInteger(afterId) ||
    afterId < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error("Invalid backfill cursor or page size");
  return db.transaction(() => {
    const rows = db
      .query<
        {
          id: number;
          entity_name: string;
          pool_id: string | null;
          supersedes_id: number | null;
          pool: string | null;
          content: string;
          confidence: number;
          verification_status: string;
        },
        [number, string | null, string | null, number]
      >(`
      SELECT n.id, n.entity_name, n.pool_id, n.supersedes_id, n.content,
        n.confidence, n.verification_status, p.name AS pool
      FROM notes n LEFT JOIN memory_pools p ON p.id = n.pool_id
      WHERE n.id > ? AND (? IS NULL OR n.entity_name = ?)
        AND n.entity_name NOT LIKE 'memory:%'
        AND n.tier IN ('fact','reflection','skill')
        AND EXISTS (SELECT 1 FROM users u JOIN principals pr ON pr.principal_id = u.id
          WHERE u.name = n.entity_name AND pr.status = 'active')
      ORDER BY n.id LIMIT ?`)
      .all(afterId, owner ?? null, owner ?? null, limit);
    for (const note of rows) {
      const operation = note.supersedes_id
        ? "bridgeLegacyRevision"
        : note.pool_id
          ? "bridgeLegacyPoolNote"
          : "bridgeLegacyNote";
      const args = note.supersedes_id
        ? [note.entity_name, note.supersedes_id, note.id]
        : note.pool_id
          ? [note.entity_name, note.id, note.pool]
          : [note.entity_name, note.id];
      enqueueLegacyBridge(db, operation, args);
      // Historical provenance predates the write triggers. Backfill it with
      // the record, rather than converting sourced facts to bare text.
      for (const source of db
        .query<
          {
            url: string;
            source_type: string;
            credibility: number;
            observed_at: number | null;
            source_note_id: number | null;
          },
          [number]
        >(`
        SELECT url,source_type,credibility,observed_at,source_note_id FROM note_sources
        WHERE note_id=? AND url NOT LIKE 'marina-memory://%' ORDER BY id`)
        .all(note.id))
        enqueueLegacyBridge(db, "bridgeLegacySource", [
          note.entity_name,
          note.id,
          {
            url: source.url,
            sourceType: source.source_type,
            credibility: source.credibility,
            observedAt: source.observed_at,
            sourceNoteId: source.source_note_id,
          },
        ]);
      if (["verified", "disputed"].includes(note.verification_status))
        enqueueLegacyBridge(db, "bridgeLegacyVerification", [
          note.entity_name,
          note.id,
          note.verification_status,
          {
            key: `legacy-note-${note.id}-backfill-verification`,
            confidence: note.confidence,
            expectedContent: note.content,
          },
        ]);
      for (const link of db
        .query<{ target_id: number; relationship: string }, [number]>(
          "SELECT target_id,relationship FROM note_links WHERE source_id=? ORDER BY id",
        )
        .all(note.id))
        enqueueLegacyBridge(db, "bridgeLegacyLink", [
          note.entity_name,
          note.id,
          link.target_id,
          link.relationship,
        ]);
    }
    return { scanned: rows.length, afterId: rows.at(-1)?.id ?? afterId };
  })();
}
