import type { Database } from "bun:sqlite";
import {
  DAY_MS,
  DEFAULT_NOTE_IMPORTANCE,
  DEFAULT_WEIGHT_IMPORTANCE,
  DEFAULT_WEIGHT_RECENCY,
  DEFAULT_WEIGHT_RELEVANCE,
  FACT_LIKE_TIERS,
  NOTE_LINKED_DECAY_DAYS,
  NOTE_ORPHAN_DECAY_DAYS,
  NOTE_WELL_LINKED_THRESHOLD,
  type NoteTier,
  PROCESS_TIER_QUOTA,
  SIMILAR_NOTE_RELEVANCE_THRESHOLD,
} from "../engine/constants";

// ─── Tier inference ────────────────────────────────────────────────────
//
// Callers that don't pass an explicit tier get one inferred from their
// noteType + content. Keep rules specific-to-general so the transient
// `[compaction]` path always ends up in 'process' regardless of noteType.

export function inferTier(content: string, noteType?: string): NoteTier {
  if (content.startsWith("[compaction]")) return "process";
  if (noteType === "skill") return "skill";
  if (noteType === "reflection") return "reflection";
  return "fact";
}

function factLikeClause(alias: string): string {
  const tiers = FACT_LIKE_TIERS.map((t) => `'${t}'`).join(", ");
  return `${alias}.tier IN (${tiers})`;
}

// ─── Notes Persistence ──────────────────────────────────────────────────

export function createNote(
  db: Database,
  entityName: string,
  content: string,
  roomId?: string,
  opts?: {
    importance?: number;
    noteType?: string;
    poolId?: string;
    supersedesId?: number;
    tier?: NoteTier;
    /** Skip write-path dedup check. Default false. Dedup is skipped
     *  automatically for pool notes and process-tier notes (they are
     *  expected to be noisy and shouldn't merge with real insights). */
    skipDedup?: boolean;
    confidence?: number;
    verificationStatus?: string;
    claimKey?: string;
  },
): number {
  const noteType = opts?.noteType ?? "observation";
  const tier = opts?.tier ?? inferTier(content, noteType);

  // Write-path dedup — mem0 / Letta / Zep all catch duplicates at write time.
  // We only dedup within the same author + note_type + fact-like tier,
  // non-pool notes. Exact content match (conservative). Process tier
  // intentionally skips dedup: the point of [compaction] notes is that each
  // one records a distinct consolidation window.
  if (!opts?.skipDedup && !opts?.poolId && !opts?.supersedesId && FACT_LIKE_TIERS.includes(tier)) {
    const similar = findDuplicateForWrite(db, entityName, content, noteType);
    if (similar) return similar.id;
  }

  const result = db.run(
    "INSERT INTO notes (entity_name, room_id, content, importance, note_type, pool_id, supersedes_id, tier, confidence, verification_status, claim_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      entityName,
      roomId ?? null,
      content,
      opts?.importance ?? DEFAULT_NOTE_IMPORTANCE,
      noteType,
      opts?.poolId ?? null,
      opts?.supersedesId ?? null,
      tier,
      Math.max(0, Math.min(1, opts?.confidence ?? 0.5)),
      opts?.verificationStatus ?? "unverified",
      opts?.claimKey ?? normalizeClaim(content),
      Date.now(),
    ],
  );
  const id = Number(result.lastInsertRowid);

  // Process-tier quota: bound unbounded growth. On insert-over-cap, drop the
  // oldest lowest-importance process notes for this entity. Non-pool only;
  // pool notes are coordination artifacts and are counted separately.
  if (tier === "process" && !opts?.poolId) {
    enforceProcessQuota(db, entityName);
  }

  return id;
}

/** Look for an existing note with the exact same content + note_type from
 *  the same entity. Exact-match is the conservative mem0-style discipline:
 *  no false merges, catches agents re-writing the same fact verbatim.
 *  Fuzzy matching is a separate concern handled by reflection/consolidation
 *  passes. */
function findDuplicateForWrite(
  db: Database,
  entityName: string,
  content: string,
  noteType: string,
): NoteRow | undefined {
  if (!content) return undefined;
  try {
    const row = db
      .query(
        `SELECT * FROM notes
         WHERE entity_name = ?
           AND pool_id IS NULL
           AND note_type = ?
           AND ${factLikeClause("notes")}
           AND content = ?
         LIMIT 1`,
      )
      .get(entityName, noteType, content) as NoteRow | null;
    return row ?? undefined;
  } catch {
    return undefined;
  }
}

/** Process-tier quota enforcement. Keeps the N most recent process-tier
 *  notes for the entity (by id desc); deletes the rest. Cheap — runs only
 *  on writes to the process tier. */
function enforceProcessQuota(db: Database, entityName: string): void {
  const row = db
    .query(
      "SELECT COUNT(*) as c FROM notes WHERE entity_name = ? AND tier = 'process' AND pool_id IS NULL",
    )
    .get(entityName) as { c: number };
  if (row.c <= PROCESS_TIER_QUOTA) return;

  const overflow = row.c - PROCESS_TIER_QUOTA;
  // Evict oldest first, tiebreak by lowest importance. Clear FK references
  // on note_links so the delete doesn't fail (orphaned links are swept by
  // the snapshot-compaction pass).
  const victims = db
    .query(
      `SELECT id FROM notes
       WHERE entity_name = ? AND tier = 'process' AND pool_id IS NULL
       ORDER BY importance ASC, id ASC
       LIMIT ?`,
    )
    .all(entityName, overflow) as { id: number }[];
  if (victims.length === 0) return;

  const placeholders = victims.map(() => "?").join(",");
  const ids = victims.map((v) => v.id);
  // Atomic: link cleanup, supersedes nulling, and the delete must commit
  // together so an interruption can't leave dangling supersedes_id pointers.
  db.transaction(() => {
    db.run(
      `DELETE FROM note_links WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      [...ids, ...ids],
    );
    db.run(`UPDATE notes SET supersedes_id = NULL WHERE supersedes_id IN (${placeholders})`, ids);
    db.run(`DELETE FROM notes WHERE id IN (${placeholders})`, ids);
  })();
}

export function getNotesByEntity(db: Database, entityName: string, limit = 50): NoteRow[] {
  return db
    .query("SELECT * FROM notes WHERE entity_name = ? ORDER BY id DESC LIMIT ?")
    .all(entityName, limit) as NoteRow[];
}

export function getNotesByRoom(db: Database, roomId: string, limit = 50): NoteRow[] {
  return db
    .query("SELECT * FROM notes WHERE room_id = ? ORDER BY id DESC LIMIT ?")
    .all(roomId, limit) as NoteRow[];
}

/**
 * Search notes across all entities — not scoped by author. Used by the
 * forecast→resolution calibration loop: when a market resolves, we need
 * to find every agent's forecast notes for that market, regardless of
 * who wrote them.
 */
export function searchAllNotes(db: Database, query: string, limit = 20): NoteRow[] {
  const safeQuery = query.replace(/['"*()]/g, "").trim();
  if (!safeQuery) return [];
  const ftsQuery = safeQuery
    .split(/\s+/)
    .map((term) => `"${term}"`)
    .join(" ");
  try {
    return db
      .query(
        `SELECT n.* FROM notes n
         JOIN notes_fts fts ON n.id = fts.rowid
         WHERE notes_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as NoteRow[];
  } catch (err) {
    console.warn("[db] searchAllNotes FTS5 query failed:", (err as Error).message);
    return [];
  }
}

export function searchNotes(db: Database, entityName: string, query: string): NoteRow[] {
  const safeQuery = query.replace(/['"*()]/g, "").trim();
  if (!safeQuery) return [];
  const ftsQuery = safeQuery
    .split(/\s+/)
    .map((term) => `"${term}"`)
    .join(" ");
  return db
    .query(
      `SELECT n.* FROM notes n
       JOIN notes_fts fts ON n.id = fts.rowid
       WHERE n.entity_name = ? AND notes_fts MATCH ?
       ORDER BY fts.rank
       LIMIT 20`,
    )
    .all(entityName, ftsQuery) as NoteRow[];
}

export function deleteNote(db: Database, id: number, entityName: string): boolean {
  const note = db
    .query("SELECT id FROM notes WHERE id = ? AND entity_name = ?")
    .get(id, entityName);
  if (!note) return false;
  // Clear FK references before deleting
  db.run("DELETE FROM note_links WHERE source_id = ? OR target_id = ?", [id, id]);
  db.run("UPDATE notes SET supersedes_id = NULL WHERE supersedes_id = ?", [id]);
  const result = db.run("DELETE FROM notes WHERE id = ? AND entity_name = ?", [id, entityName]);
  return result.changes > 0;
}

export function getNote(db: Database, id: number): NoteRow | undefined {
  return (db.query("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | null) ?? undefined;
}

function normalizeClaim(content: string): string {
  return content
    .toLowerCase()
    .replace(/\b(not|never|no)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join(" ");
}

export interface NoteSourceInput {
  url: string;
  title?: string;
  publisher?: string;
  observedAt?: number;
  contentHash?: string;
  sourceType?: "url" | "note" | "message" | "observation" | "artifact" | "dataset";
  sourceNoteId?: number;
  sourceEntity?: string;
  capturedBy?: string;
  excerpt?: string;
  credibility?: number;
  metadata?: Record<string, unknown>;
}

export interface NoteSourceRow {
  id: number;
  note_id: number;
  url: string;
  title: string | null;
  publisher: string | null;
  observed_at: number | null;
  retrieved_at: number;
  content_hash: string | null;
  source_type: string;
  source_note_id: number | null;
  source_entity: string | null;
  captured_by: string | null;
  excerpt: string | null;
  credibility: number;
  metadata: string | null;
}

export function addNoteSource(db: Database, noteId: number, source: NoteSourceInput): number {
  const result = db.run(
    `INSERT INTO note_sources (note_id, url, title, publisher, observed_at, retrieved_at, content_hash,
       source_type, source_note_id, source_entity, captured_by, excerpt, credibility, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(note_id, url) DO UPDATE SET title=excluded.title, publisher=excluded.publisher,
       observed_at=excluded.observed_at, retrieved_at=excluded.retrieved_at, content_hash=excluded.content_hash,
       source_type=excluded.source_type, source_note_id=excluded.source_note_id,
       source_entity=excluded.source_entity, captured_by=excluded.captured_by, excerpt=excluded.excerpt,
       credibility=excluded.credibility, metadata=excluded.metadata`,
    [
      noteId,
      source.url,
      source.title ?? null,
      source.publisher ?? null,
      source.observedAt ?? null,
      Date.now(),
      source.contentHash ?? null,
      source.sourceType ?? "url",
      source.sourceNoteId ?? null,
      source.sourceEntity ?? null,
      source.capturedBy ?? null,
      source.excerpt ?? null,
      Math.max(0, Math.min(1, source.credibility ?? 0.5)),
      source.metadata ? JSON.stringify(source.metadata) : null,
    ],
  );
  return Number(result.lastInsertRowid);
}

export interface NoteVerificationRow {
  id: number;
  note_id: number;
  verifier: string;
  status: "unverified" | "verified" | "disputed";
  confidence: number;
  rationale: string | null;
  evidence_source_id: number | null;
  created_at: number;
}

export function recordNoteVerification(
  db: Database,
  noteId: number,
  verifier: string,
  status: "unverified" | "verified" | "disputed",
  confidence: number,
  rationale?: string,
  evidenceSourceId?: number,
): number {
  const bounded = Math.max(0, Math.min(1, confidence));
  const result = db.run(
    `INSERT INTO note_verifications (note_id,verifier,status,confidence,rationale,evidence_source_id,created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [noteId, verifier, status, bounded, rationale ?? null, evidenceSourceId ?? null, Date.now()],
  );
  db.run("UPDATE notes SET confidence=?,verification_status=? WHERE id=?", [
    bounded,
    status,
    noteId,
  ]);
  return Number(result.lastInsertRowid);
}

export function getNoteVerifications(db: Database, noteId: number): NoteVerificationRow[] {
  return db
    .query("SELECT * FROM note_verifications WHERE note_id=? ORDER BY created_at DESC,id DESC")
    .all(noteId) as NoteVerificationRow[];
}

export function getNoteSources(db: Database, noteId: number): NoteSourceRow[] {
  return db
    .query("SELECT * FROM note_sources WHERE note_id = ? ORDER BY retrieved_at DESC")
    .all(noteId) as NoteSourceRow[];
}

export function updateNoteQuality(
  db: Database,
  id: number,
  entityName: string,
  confidence: number,
  verification: string,
): boolean {
  if (!["unverified", "verified", "disputed", "superseded"].includes(verification)) return false;
  return (
    db.run(
      "UPDATE notes SET confidence = ?, verification_status = ? WHERE id = ? AND entity_name = ?",
      [Math.max(0, Math.min(1, confidence)), verification, id, entityName],
    ).changes > 0
  );
}

export interface ContradictionCandidate {
  left: NoteRow;
  right: NoteRow;
  reason: string;
}

export function findMemoryContradictions(
  db: Database,
  entityName: string,
): ContradictionCandidate[] {
  const notes = db
    .query(
      `SELECT * FROM notes WHERE entity_name = ? AND pool_id IS NULL AND verification_status != 'superseded' ORDER BY id DESC LIMIT 500`,
    )
    .all(entityName) as NoteRow[];
  const groups = new Map<string, NoteRow[]>();
  for (const note of notes) {
    if (!note.claim_key) continue;
    const group = groups.get(note.claim_key) ?? [];
    group.push(note);
    groups.set(note.claim_key, group);
  }
  const found: ContradictionCandidate[] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const aNeg = /\b(no|not|never|cannot|isn't|doesn't)\b/i.test(a.content);
        const bNeg = /\b(no|not|never|cannot|isn't|doesn't)\b/i.test(b.content);
        if (aNeg !== bNeg)
          found.push({ left: a, right: b, reason: "same claim with opposite polarity" });
      }
  }
  return found.slice(0, 50);
}

export function consolidateNotes(
  db: Database,
  entityName: string,
  keeperId: number,
  duplicateIds: number[],
): number {
  const keeper = getNote(db, keeperId);
  if (!keeper || keeper.entity_name !== entityName) return 0;
  let changed = 0;
  db.transaction(() => {
    for (const id of [...new Set(duplicateIds)]) {
      if (id === keeperId) continue;
      const note = getNote(db, id);
      if (!note || note.entity_name !== entityName || note.verification_status === "superseded")
        continue;
      db.run(
        "UPDATE notes SET verification_status = 'superseded', supersedes_id = ? WHERE id = ?",
        [keeperId, id],
      );
      db.run(
        "INSERT OR IGNORE INTO note_links (source_id, target_id, relationship, created_at) VALUES (?, ?, 'supersedes', ?)",
        [keeperId, id, Date.now()],
      );
      changed++;
    }
  })();
  return changed;
}

export function touchNote(db: Database, id: number): void {
  db.run("UPDATE notes SET last_accessed = ?, recall_count = recall_count + 1 WHERE id = ?", [
    Date.now(),
    id,
  ]);
}

export function recallNotes(
  db: Database,
  entityName: string,
  query: string,
  opts?: {
    weightImportance?: number;
    weightRecency?: number;
    weightRelevance?: number;
    /** If true, include process-tier notes in results. Default false.
     *  Keep this off for agent-facing recall — process notes are transient
     *  consolidation metadata, not wisdom. */
    includeProcess?: boolean;
  },
): ScoredNoteRow[] {
  const safeQuery = query.replace(/['"*()]/g, "").trim();
  if (!safeQuery) return [];
  const ftsQuery = safeQuery
    .split(/\s+/)
    .map((term) => `"${term}"`)
    .join(" OR ");
  const alpha = opts?.weightImportance ?? DEFAULT_WEIGHT_IMPORTANCE;
  const beta = opts?.weightRecency ?? DEFAULT_WEIGHT_RECENCY;
  const gamma = opts?.weightRelevance ?? DEFAULT_WEIGHT_RELEVANCE;
  const now = Date.now();
  const tierClause = opts?.includeProcess ? "" : `AND ${factLikeClause("n")}`;
  return db
    .query(
      `SELECT n.*,
        (? * (n.importance / 10.0)) +
        (? * (1.0 / (1.0 + (? - COALESCE(n.last_accessed, n.created_at)) / 86400000.0))) +
        (? * (-fts.rank)) + (0.10 * n.confidence) +
        CASE n.verification_status WHEN 'verified' THEN 0.10 WHEN 'disputed' THEN -0.10 ELSE 0 END +
        COALESCE((SELECT 0.05 / (1.0 + (? - COALESCE(MAX(ns.observed_at), MAX(ns.retrieved_at))) / 2592000000.0)
          FROM note_sources ns WHERE ns.note_id=n.id), 0) +
        COALESCE((SELECT 0.05 * AVG(ns.credibility) FROM note_sources ns WHERE ns.note_id=n.id),0)
        AS score
      FROM notes n
      JOIN notes_fts fts ON n.id = fts.rowid
      WHERE n.entity_name = ? AND n.pool_id IS NULL AND n.verification_status != 'superseded' ${tierClause} AND notes_fts MATCH ?
      ORDER BY score DESC
      LIMIT 20`,
    )
    .all(alpha, beta, now, gamma, now, entityName, ftsQuery) as ScoredNoteRow[];
}

export function recallNotesWithType(
  db: Database,
  entityName: string,
  query: string,
  noteType: string,
  opts?: { weightImportance?: number; weightRecency?: number; weightRelevance?: number },
): ScoredNoteRow[] {
  const safeQuery = query.replace(/['"*()]/g, "").trim();
  if (!safeQuery) return [];
  const ftsQuery = safeQuery
    .split(/\s+/)
    .map((term) => `"${term}"`)
    .join(" OR ");
  const alpha = opts?.weightImportance ?? DEFAULT_WEIGHT_IMPORTANCE;
  const beta = opts?.weightRecency ?? DEFAULT_WEIGHT_RECENCY;
  const gamma = opts?.weightRelevance ?? DEFAULT_WEIGHT_RELEVANCE;
  const now = Date.now();
  return db
    .query(
      `SELECT n.*,
        (? * (n.importance / 10.0)) +
        (? * (1.0 / (1.0 + (? - COALESCE(n.last_accessed, n.created_at)) / 86400000.0))) +
        (? * (-fts.rank)) + (0.10 * n.confidence) +
        CASE n.verification_status WHEN 'verified' THEN 0.10 WHEN 'disputed' THEN -0.10 ELSE 0 END +
        COALESCE((SELECT 0.05 / (1.0 + (? - COALESCE(MAX(ns.observed_at), MAX(ns.retrieved_at))) / 2592000000.0)
          FROM note_sources ns WHERE ns.note_id=n.id), 0) +
        COALESCE((SELECT 0.05 * AVG(ns.credibility) FROM note_sources ns WHERE ns.note_id=n.id),0)
        AS score
      FROM notes n
      JOIN notes_fts fts ON n.id = fts.rowid
      WHERE n.entity_name = ? AND n.pool_id IS NULL AND n.note_type = ? AND n.verification_status != 'superseded' AND notes_fts MATCH ?
      ORDER BY score DESC
      LIMIT 20`,
    )
    .all(alpha, beta, now, gamma, now, entityName, noteType, ftsQuery) as ScoredNoteRow[];
}

export function findSimilarNotes(
  db: Database,
  entityName: string,
  content: string,
  excludeId?: number,
): NoteRow[] {
  const safeQuery = content.replace(/['"*()]/g, "").trim();
  if (!safeQuery) return [];
  // Take first few meaningful words for FTS search
  const words = safeQuery.split(/\s+/).slice(0, 5);
  if (words.length === 0) return [];
  const ftsQuery = words.map((term) => `"${term}"`).join(" OR ");
  try {
    const rows = db
      .query(
        `SELECT n.*, -fts.rank as relevance FROM notes n
         JOIN notes_fts fts ON n.id = fts.rowid
         WHERE n.entity_name = ? AND n.pool_id IS NULL AND ${factLikeClause("n")} AND notes_fts MATCH ?
         ORDER BY relevance DESC
         LIMIT 5`,
      )
      .all(entityName, ftsQuery) as (NoteRow & { relevance: number })[];
    return rows.filter((r) => r.id !== excludeId && r.relevance > SIMILAR_NOTE_RELEVANCE_THRESHOLD);
  } catch (err) {
    console.warn("[db] findSimilarNotes FTS5 query failed:", (err as Error).message);
    return [];
  }
}

export function countMatchingNotes(
  db: Database,
  entityName: string,
  query: string,
): { total: number; fading: number } {
  const safeQuery = query.replace(/['"*()]/g, "").trim();
  if (!safeQuery) return { total: 0, fading: 0 };
  const ftsQuery = safeQuery
    .split(/\s+/)
    .map((term) => `"${term}"`)
    .join(" ");
  try {
    const row = db
      .query(
        `SELECT COUNT(*) as total,
          SUM(CASE WHEN n.importance <= 2 THEN 1 ELSE 0 END) as fading
         FROM notes n
         JOIN notes_fts fts ON n.id = fts.rowid
         WHERE n.entity_name = ? AND n.pool_id IS NULL AND ${factLikeClause("n")} AND notes_fts MATCH ?`,
      )
      .get(entityName, ftsQuery) as { total: number; fading: number } | null;
    return { total: row?.total ?? 0, fading: row?.fading ?? 0 };
  } catch (err) {
    console.warn("[db] countMatchingNotes FTS5 query failed:", (err as Error).message);
    return { total: 0, fading: 0 };
  }
}

export function adjustNoteImportance(db: Database): { boosted: number; decayed: number } {
  let boostedCount = 0;
  let decayedCount = 0;

  db.transaction(() => {
    const now = Date.now();
    const sevenDaysAgo = now - NOTE_ORPHAN_DECAY_DAYS * DAY_MS;
    const fourteenDaysAgo = now - NOTE_LINKED_DECAY_DAYS * DAY_MS;

    // Boost: notes recalled 3+ times, importance < 10
    const boosted = db.run(
      "UPDATE notes SET importance = MIN(importance + 1, 10) WHERE recall_count >= 3 AND importance < 10 AND pool_id IS NULL",
    );

    // Decay with structural protection:
    // - Well-linked notes (3+ links) only decay after 14 days instead of 7
    // - Unlinked notes decay normally after 7 days
    const decayed = db.run(
      `UPDATE notes SET importance = MAX(importance - 1, 1)
       WHERE recall_count = 0 AND importance > 1 AND pool_id IS NULL
       AND id NOT IN (
         SELECT n.id FROM notes n
         JOIN note_links nl ON n.id = nl.source_id OR n.id = nl.target_id
         WHERE n.recall_count = 0 AND n.pool_id IS NULL
         GROUP BY n.id
         HAVING COUNT(*) >= ${NOTE_WELL_LINKED_THRESHOLD}
       )
       AND created_at < ?`,
      [sevenDaysAgo],
    );

    // Decay well-linked notes on slower schedule (14 days)
    const decayedLinked = db.run(
      `UPDATE notes SET importance = MAX(importance - 1, 1)
       WHERE recall_count = 0 AND importance > 1 AND pool_id IS NULL
       AND id IN (
         SELECT n.id FROM notes n
         JOIN note_links nl ON n.id = nl.source_id OR n.id = nl.target_id
         WHERE n.recall_count = 0 AND n.pool_id IS NULL
         GROUP BY n.id
         HAVING COUNT(*) >= ${NOTE_WELL_LINKED_THRESHOLD}
       )
       AND created_at < ?`,
      [fourteenDaysAgo],
    );

    // Reduce recall counts: boosted notes (3+) get reset, others keep accumulating
    db.run("UPDATE notes SET recall_count = MAX(recall_count - 3, 0) WHERE recall_count >= 3");

    boostedCount = boosted.changes;
    decayedCount = decayed.changes + decayedLinked.changes;
  })();

  return { boosted: boostedCount, decayed: decayedCount };
}

export function calibrateMemoryConfidence(db: Database): number {
  const verified = db.run(
    `UPDATE notes SET confidence=MAX(confidence,0.75) WHERE verification_status='verified'
     AND EXISTS (SELECT 1 FROM note_sources ns WHERE ns.note_id=notes.id)`,
  ).changes;
  const disputed = db.run(
    "UPDATE notes SET confidence=MIN(confidence,0.25) WHERE verification_status='disputed'",
  ).changes;
  const corroborated = db.run(
    `UPDATE notes SET confidence=MAX(confidence,0.60) WHERE verification_status='unverified'
     AND (SELECT COUNT(*) FROM note_sources ns WHERE ns.note_id=notes.id) >= 2`,
  ).changes;
  return verified + disputed + corroborated;
}

// ─── Core Memory Persistence ───────────────────────────────────────────

export function setCoreMemory(db: Database, entityName: string, key: string, value: string): void {
  const existing = getCoreMemory(db, entityName, key);
  if (existing) {
    db.run(
      "INSERT INTO core_memory_history (entity_name, key, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?)",
      [entityName, key, existing.value, value, Date.now()],
    );
    db.run(
      "UPDATE core_memory SET value = ?, version = version + 1, updated_at = ? WHERE entity_name = ? AND key = ?",
      [value, Date.now(), entityName, key],
    );
  } else {
    const now = Date.now();
    db.run(
      "INSERT INTO core_memory (entity_name, key, value, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      [entityName, key, value, now, now],
    );
  }
}

export function getCoreMemory(
  db: Database,
  entityName: string,
  key: string,
): CoreMemoryRow | undefined {
  return (
    (db
      .query("SELECT * FROM core_memory WHERE entity_name = ? AND key = ?")
      .get(entityName, key) as CoreMemoryRow | null) ?? undefined
  );
}

export function listCoreMemory(db: Database, entityName: string): CoreMemoryRow[] {
  return db
    .query("SELECT * FROM core_memory WHERE entity_name = ? ORDER BY key")
    .all(entityName) as CoreMemoryRow[];
}

export function deleteCoreMemory(db: Database, entityName: string, key: string): boolean {
  const result = db.run("DELETE FROM core_memory WHERE entity_name = ? AND key = ?", [
    entityName,
    key,
  ]);
  return result.changes > 0;
}

export function getCoreMemoryHistory(
  db: Database,
  entityName: string,
  key: string,
  limit = 10,
): CoreMemoryHistoryRow[] {
  return db
    .query(
      "SELECT * FROM core_memory_history WHERE entity_name = ? AND key = ? ORDER BY id DESC LIMIT ?",
    )
    .all(entityName, key, limit) as CoreMemoryHistoryRow[];
}

// ─── Note Links (Knowledge Graph) ─────────────────────────────────────

export function createNoteLink(
  db: Database,
  sourceId: number,
  targetId: number,
  relationship: string,
): number {
  const result = db.run(
    "INSERT INTO note_links (source_id, target_id, relationship, created_at) VALUES (?, ?, ?, ?)",
    [sourceId, targetId, relationship, Date.now()],
  );
  return Number(result.lastInsertRowid);
}

export function getNoteLinks(db: Database, noteId: number): NoteLinkRow[] {
  return db
    .query("SELECT * FROM note_links WHERE source_id = ? OR target_id = ?")
    .all(noteId, noteId) as NoteLinkRow[];
}

export function removeNoteLink(
  db: Database,
  sourceId: number,
  targetId: number,
  relationship: string,
): boolean {
  const result = db.run(
    "DELETE FROM note_links WHERE source_id = ? AND target_id = ? AND relationship = ?",
    [sourceId, targetId, relationship],
  );
  return result.changes > 0;
}

/**
 * Returns the current most-active notes (ordered by last_accessed DESC, falling
 * back to created_at) and every link touching those notes. Bounded by `limit`
 * so the knowledge-graph snapshot stays small enough to stream on connect.
 */
export function getGraphSnapshot(
  db: Database,
  limit = 500,
): { notes: NoteRow[]; links: NoteLinkRow[] } {
  const notes = db
    .query("SELECT * FROM notes ORDER BY COALESCE(last_accessed, created_at) DESC LIMIT ?")
    .all(limit) as NoteRow[];
  if (notes.length === 0) return { notes: [], links: [] };
  const ids = notes.map((n) => n.id);
  const placeholders = ids.map(() => "?").join(",");
  const links = db
    .query(
      `SELECT * FROM note_links WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
    )
    .all(...ids, ...ids) as NoteLinkRow[];
  return { notes, links };
}

export function traceNoteGraph(
  db: Database,
  noteId: number,
  depth = 2,
): { note: NoteRow; links: NoteLinkRow[]; depth: number }[] {
  const visited = new Set<number>();
  const results: { note: NoteRow; links: NoteLinkRow[]; depth: number }[] = [];
  const queue: { id: number; depth: number }[] = [{ id: noteId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    const note = getNote(db, current.id);
    if (!note) continue;

    const links = getNoteLinks(db, current.id);
    results.push({ note, links, depth: current.depth });

    if (current.depth < depth) {
      for (const link of links) {
        const nextId = link.source_id === current.id ? link.target_id : link.source_id;
        if (!visited.has(nextId)) {
          queue.push({ id: nextId, depth: current.depth + 1 });
        }
      }
    }
  }

  return results;
}

export function countNoteLinks(db: Database, entityName: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) as c FROM note_links nl
       JOIN notes n ON nl.source_id = n.id OR nl.target_id = n.id
       WHERE n.entity_name = ?`,
    )
    .get(entityName) as { c: number };
  return row.c;
}

export function countLinksForNote(db: Database, noteId: number): number {
  const row = db
    .query("SELECT COUNT(*) as c FROM note_links WHERE source_id = ? OR target_id = ?")
    .get(noteId, noteId) as { c: number };
  return row.c;
}

// ─── Memory Pools ─────────────────────────────────────────────────────

export function createMemoryPool(
  db: Database,
  id: string,
  name: string,
  createdBy: string,
  groupId?: string,
): void {
  db.run(
    "INSERT INTO memory_pools (id, name, group_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, name, groupId ?? null, createdBy, Date.now()],
  );
}

export function getMemoryPool(db: Database, name: string): MemoryPoolRow | undefined {
  return (
    (db.query("SELECT * FROM memory_pools WHERE name = ?").get(name) as MemoryPoolRow | null) ??
    undefined
  );
}

export function listMemoryPools(db: Database): MemoryPoolRow[] {
  return db.query("SELECT * FROM memory_pools ORDER BY name").all() as MemoryPoolRow[];
}

export function addPoolNote(
  db: Database,
  poolId: string,
  entityName: string,
  content: string,
  importance?: number,
  noteType?: string,
): number {
  return createNote(db, entityName, content, undefined, {
    importance,
    noteType,
    poolId,
  });
}

export function getPoolNotes(db: Database, poolId: string, limit = 100): NoteRow[] {
  return db
    .query("SELECT * FROM notes WHERE pool_id = ? ORDER BY id DESC LIMIT ?")
    .all(poolId, limit) as NoteRow[];
}

export function countPoolNotes(db: Database, poolId: string): number {
  return (
    db.query("SELECT COUNT(*) as c FROM notes WHERE pool_id = ?").get(poolId) as {
      c: number;
    }
  ).c;
}

export function recallPoolNotes(
  db: Database,
  poolId: string,
  query: string,
  opts?: { weightImportance?: number; weightRecency?: number; weightRelevance?: number },
): ScoredNoteRow[] {
  const safeQuery = query.replace(/['"*()]/g, "").trim();
  if (!safeQuery) return [];
  const ftsQuery = safeQuery
    .split(/\s+/)
    .map((term) => `"${term}"`)
    .join(" OR ");
  const alpha = opts?.weightImportance ?? DEFAULT_WEIGHT_IMPORTANCE;
  const beta = opts?.weightRecency ?? DEFAULT_WEIGHT_RECENCY;
  const gamma = opts?.weightRelevance ?? DEFAULT_WEIGHT_RELEVANCE;
  const now = Date.now();
  return db
    .query(
      `SELECT n.*,
        (? * (n.importance / 10.0)) +
        (? * (1.0 / (1.0 + (? - COALESCE(n.last_accessed, n.created_at)) / 86400000.0))) +
        (? * (-fts.rank)) + (0.10 * n.confidence) +
        CASE n.verification_status WHEN 'verified' THEN 0.10 WHEN 'disputed' THEN -0.10 ELSE 0 END +
        COALESCE((SELECT 0.05 / (1.0 + (? - COALESCE(MAX(ns.observed_at), MAX(ns.retrieved_at))) / 2592000000.0)
          FROM note_sources ns WHERE ns.note_id=n.id), 0) +
        COALESCE((SELECT 0.05 * AVG(ns.credibility) FROM note_sources ns WHERE ns.note_id=n.id),0)
        AS score
      FROM notes n
      JOIN notes_fts fts ON n.id = fts.rowid
      WHERE n.pool_id = ? AND n.verification_status != 'superseded' AND notes_fts MATCH ?
      ORDER BY score DESC
      LIMIT 20`,
    )
    .all(alpha, beta, now, gamma, now, poolId, ftsQuery) as ScoredNoteRow[];
}

// ─── Memory API Keys ────────────────────────────────────────────────

export function createMemApiKey(db: Database, id: string, secret: string, agentName: string): void {
  db.run("INSERT INTO mem_api_keys (id, secret, agent_name, created_at) VALUES (?, ?, ?, ?)", [
    id,
    secret,
    agentName,
    Date.now(),
  ]);
}

export function validateMemApiKey(db: Database, secret: string): MemApiKeyRow | undefined {
  const row = db
    .query("SELECT * FROM mem_api_keys WHERE secret = ?")
    .get(secret) as MemApiKeyRow | null;
  if (row) {
    db.run("UPDATE mem_api_keys SET last_used_at = ? WHERE id = ?", [Date.now(), row.id]);
  }
  return row ?? undefined;
}

export function listMemApiKeys(db: Database): MemApiKeyRow[] {
  return db.query("SELECT * FROM mem_api_keys ORDER BY created_at DESC").all() as MemApiKeyRow[];
}

export function deleteMemApiKey(db: Database, id: string): boolean {
  return db.run("DELETE FROM mem_api_keys WHERE id = ?", [id]).changes > 0;
}

export function getMemStats(
  db: Database,
  agentName: string,
): {
  notes: number;
  links: number;
  coreKeys: number;
  pools: number;
} {
  const notes = (
    db
      .query("SELECT COUNT(*) as c FROM notes WHERE entity_name = ? AND pool_id IS NULL")
      .get(agentName) as { c: number }
  ).c;
  const links = countNoteLinks(db, agentName);
  const coreKeys = (
    db.query("SELECT COUNT(*) as c FROM core_memory WHERE entity_name = ?").get(agentName) as {
      c: number;
    }
  ).c;
  const pools = (
    db.query("SELECT COUNT(*) as c FROM memory_pools WHERE created_by = ?").get(agentName) as {
      c: number;
    }
  ).c;
  return { notes, links, coreKeys, pools };
}

export function countNotes(db: Database, entityName: string, noteType?: string): number {
  if (noteType) {
    return (
      db
        .query(
          "SELECT COUNT(*) as c FROM notes WHERE entity_name = ? AND pool_id IS NULL AND note_type = ?",
        )
        .get(entityName, noteType) as { c: number }
    ).c;
  }
  return (
    db
      .query("SELECT COUNT(*) as c FROM notes WHERE entity_name = ? AND pool_id IS NULL")
      .get(entityName) as { c: number }
  ).c;
}

// ─── Row Types ──────────────────────────────────────────────────────────

export interface NoteRow {
  id: number;
  entity_name: string;
  room_id: string | null;
  content: string;
  importance: number;
  last_accessed: number | null;
  note_type: string;
  pool_id: string | null;
  supersedes_id: number | null;
  tier: NoteTier;
  created_at: number;
  confidence?: number;
  verification_status?: "unverified" | "verified" | "disputed" | "superseded";
  claim_key?: string | null;
}

export interface ScoredNoteRow extends NoteRow {
  score: number;
}

export interface CoreMemoryRow {
  entity_name: string;
  key: string;
  value: string;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface CoreMemoryHistoryRow {
  id: number;
  entity_name: string;
  key: string;
  old_value: string;
  new_value: string;
  changed_at: number;
}

export interface NoteLinkRow {
  id: number;
  source_id: number;
  target_id: number;
  relationship: string;
  created_at: number;
}

export interface MemoryPoolRow {
  id: string;
  name: string;
  group_id: string | null;
  created_by: string;
  created_at: number;
}

export interface MemApiKeyRow {
  id: string;
  secret: string;
  agent_name: string;
  created_at: number;
  last_used_at: number | null;
}
