// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Synchronous numeric adapters over the canonical repository. A numeric row
 * holds world addressing/ACL metadata; its text lives only in record versions.
 * All callers run these operations inside their originating SQLite transaction. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { embeddingProviderId, parseEmbeddingEnv } from "../memory/embedding-config";
import { MemoryError, type MemoryRecordInput } from "../memory/service-types";
import type { MemoryRecord } from "../sdk/memory-types";
import { numericMemoryBinding } from "./db-memory-resident";
import { confirmPendingResolutions } from "./db-memory-resolve";
import { captureSource, readMemoryRecord, rememberRecord, reviseRecord } from "./db-memory-service";
import { isMemoryUpgrade } from "./db-memory-upgrade-scope";
import { createStoredNote, getStoredNote } from "./db-note-storage";
import type { NoteRow, NoteSourceInput } from "./db-notes";

const model = () => embeddingProviderId(parseEmbeddingEnv(process.env));
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const durableTypes = new Set(["fact", "observation", "decision", "inference", "skill", "episode"]);

export function numericRecord(db: Database, noteId: number) {
  return (
    db
      .query<
        { record_id: string; version: number | null; space_id: string; entity_name: string },
        [number]
      >(`SELECT p.record_id,p.version,r.space_id,n.entity_name
    FROM memory_note_projections p JOIN memory_records r ON r.id=p.record_id JOIN notes n ON n.id=p.note_id
    WHERE p.note_id=? AND r.status='active'`)
      .get(noteId) ?? undefined
  );
}

function current(db: Database, noteId: number, predecessor = false) {
  const mapping = numericRecord(db, noteId);
  if (!mapping || (!predecessor && mapping.version !== null)) return undefined;
  const { actor } = numericMemoryBinding(db, mapping.entity_name);
  const record = readMemoryRecord(db, actor, mapping.space_id, mapping.record_id);
  if (predecessor && mapping.version !== null && mapping.version !== record.version)
    return undefined;
  return { actor, record };
}

function noteInput(note: NoteRow): MemoryRecordInput {
  return {
    content: note.content,
    type: durableTypes.has(note.note_type)
      ? (note.note_type as MemoryRecordInput["type"])
      : "observation",
    tier: note.tier as MemoryRecordInput["tier"],
    importance: Math.max(1, Math.min(10, Math.round(note.importance))),
    ...(note.verification_status === "disputed" || note.verification_status === "superseded"
      ? { valid_time: { from: null, until: Date.now() } }
      : {}),
    metadata: {
      legacy_note_id: note.id,
      legacy_verification: note.verification_status ?? "unverified",
      legacy_verification_confidence: note.confidence ?? 0.5,
      legacy_created_at: note.created_at,
      note_type: note.note_type,
      tier: note.tier,
      ...(note.supersedes_id ? { supersedes_legacy_note_id: note.supersedes_id } : {}),
      ...(note.pool_id ? { pool_id: note.pool_id, shared: true } : {}),
    },
  };
}

/** Attach a server-authorized record without allocating another copy/history.
 * URLs and arbitrary caller metadata never create this association. */
export function bindNumericRecord(
  db: Database,
  noteId: number,
  recordId: string,
  version: number | null = null,
): void {
  const note = getStoredNote(db, noteId);
  if (!note || note.entity_name.startsWith("memory:")) throw new Error("Numeric handle required");
  const { actor } = numericMemoryBinding(db, note.entity_name);
  const row = db
    .query<{ space_id: string }, [string]>("SELECT space_id FROM memory_records WHERE id=?")
    .get(recordId);
  if (!row) throw new MemoryError(404, "record_not_found", "Record not found");
  const record = readMemoryRecord(db, actor, row.space_id, recordId, version ?? undefined);
  const owner = db
    .query<{ owner_id: string }, [string]>("SELECT owner_id FROM memory_spaces WHERE id=?")
    .get(row.space_id);
  if (owner?.owner_id !== actor.principalId)
    throw new MemoryError(
      403,
      "owner_required",
      "Only owned records can have numeric write handles",
    );
  const previous = numericRecord(db, noteId);
  if (previous && previous.record_id !== recordId)
    throw new Error("Numeric handle is already bound");
  if (note.content && note.content !== record.content)
    throw new Error("Numeric handle content does not match its record");
  db.run(
    "INSERT INTO memory_note_projections(note_id,record_id,version) VALUES (?,?,?) ON CONFLICT(note_id) DO UPDATE SET version=excluded.version",
    [noteId, recordId, version],
  );
  // The compatibility row is an address, never a second copy of the assertion.
  db.run("UPDATE notes SET content='' WHERE id=?", [noteId]);
}

export function materializeNumericNote(db: Database, noteId: number): void {
  const note = getStoredNote(db, noteId);
  if (
    !note ||
    note.entity_name.startsWith("memory:") ||
    !["fact", "reflection", "skill"].includes(note.tier)
  )
    return;
  if (numericRecord(db, noteId)) return;
  const { actor, space } = numericMemoryBinding(db, note.entity_name);
  const previous = note.supersedes_id ? current(db, note.supersedes_id, true) : undefined;
  const input = noteInput(note);
  if (note.pool_id)
    input.metadata!.pool =
      db
        .query<{ name: string }, [string]>("SELECT name FROM memory_pools WHERE id=?")
        .get(note.pool_id)?.name ?? note.pool_id;
  let id: string;
  if (previous && previous.actor.principalId === actor.principalId) {
    const record = previous.record;
    if (record.metadata.legacy_verification === "disputed")
      input.valid_time = { from: record.valid_time?.from ?? null, until: null };
    input.metadata = {
      ...record.metadata,
      ...input.metadata,
      legacy_verification: "unverified",
      legacy_verification_confidence: 0.5,
    };
    // Freeze the old numeric address at the version it originally described.
    db.run("UPDATE memory_note_projections SET version=? WHERE note_id=?", [
      record.version,
      note.supersedes_id!,
    ]);
    id = reviseRecord(
      db,
      actor,
      record.space_id,
      record.id,
      record.version,
      { ...input, metadata: { ...record.metadata, ...input.metadata } },
      `numeric:${noteId}:create`,
      model(),
    ).id;
  } else id = rememberRecord(db, actor, space, input, `numeric:${noteId}:create`, model()).id;
  if (isMemoryUpgrade(db)) {
    db.run(
      "UPDATE notes SET created_at=? WHERE id=(SELECT current_note_id FROM memory_records WHERE id=?)",
      [note.created_at, id],
    );
    if (!previous)
      db.run("UPDATE memory_records SET created_at=? WHERE id=?", [note.created_at, id]);
  }
  bindNumericRecord(db, noteId, id);
}

/** Retirement leaves canonical history and dependents intact. Erasure is the
 * explicit durable forget operation, which also removes every numeric handle. */
export function retireNumericNote(
  db: Database,
  noteId: number,
  reason: "deleted" | "superseded" = "deleted",
  keeperId?: number,
): void {
  const value = current(db, noteId);
  if (!value) return;
  const { actor, record } = value;
  const keeper = keeperId === undefined ? undefined : numericRecord(db, keeperId);
  reviseRecord(
    db,
    actor,
    record.space_id,
    record.id,
    record.version,
    {
      content: `[${reason} legacy note #${noteId}]`,
      importance: 1,
      metadata: {
        ...record.metadata,
        ...(reason === "deleted"
          ? { deleted_legacy_note_id: noteId, deleted_at: Date.now() }
          : {
              retired_legacy_note_id: noteId,
              retired_reason: "consolidated",
              superseded_by_legacy_note_id: keeperId,
              superseded_by_record_id: keeper?.record_id,
            }),
      },
      valid_time: { from: record.valid_time?.from ?? null, until: Date.now() },
    },
    `numeric:${noteId}:${reason}:${record.version}`,
    model(),
  );
  if (reason === "superseded")
    db.run("UPDATE memory_note_projections SET version=? WHERE note_id=?", [
      record.version,
      noteId,
    ]);
}

export function verifyNumericNote(
  db: Database,
  noteId: number,
  verifier: string,
  status: "unverified" | "verified" | "disputed",
  confidence: number,
  verificationId: number,
  rationale?: string,
  caseId?: number,
): void {
  const value = current(db, noteId);
  const note = getStoredNote(db, noteId);
  if (!value || verifier !== note?.entity_name) return;
  const { actor, record } = value;
  const wasDisputed = record.metadata.legacy_verification === "disputed";
  reviseRecord(
    db,
    actor,
    record.space_id,
    record.id,
    record.version,
    {
      content: record.content,
      importance: record.importance,
      metadata: {
        ...record.metadata,
        legacy_verification: status,
        legacy_verification_confidence: confidence,
        legacy_verification_rationale: rationale,
        legacy_verification_case_id: caseId,
        legacy_verified_at: Date.now(),
      },
      ...(status === "disputed"
        ? { valid_time: { from: record.valid_time?.from ?? null, until: Date.now() } }
        : wasDisputed
          ? { valid_time: { from: record.valid_time?.from ?? null, until: null } }
          : {}),
    },
    `numeric:verify:${verificationId}`,
    model(),
  );
  if (status === "verified") confirmPendingResolutions(db, record.space_id, record.id);
}

export function sourceNumericNote(db: Database, noteId: number, source: NoteSourceInput): void {
  if (source.url.startsWith("marina-memory://")) return;
  const note = getStoredNote(db, noteId);
  if (!note || (source.capturedBy && source.capturedBy !== note.entity_name)) return;
  const value = current(db, noteId);
  if (!value) return;
  const { actor, record } = value;
  const selfDerived = source.sourceNoteId !== undefined || source.url.startsWith("note:");
  const captured = captureSource(
    db,
    actor,
    record.space_id,
    source.url,
    selfDerived ? "legacy-notes" : "legacy-sources",
    `numeric:${noteId}:source:${digest(source.url)}`,
  );
  const sourceIds = [...new Set([...record.source_ids, captured.id])];
  if (sourceIds.length > 32 && !isMemoryUpgrade(db))
    throw new MemoryError(409, "source_capacity", "Source limit reached");
  const prior = Array.isArray(record.metadata.legacy_sources)
    ? (record.metadata.legacy_sources as Record<string, unknown>[])
    : [];
  const ref = {
    url: source.url,
    source_id: captured.id,
    source_type: source.sourceType ?? "url",
    credibility: source.credibility ?? 0.5,
    observed_at: source.observedAt ?? null,
    source_note_id: source.sourceNoteId ?? null,
  };
  if (JSON.stringify(prior.find((s) => s.url === source.url)) === JSON.stringify(ref)) return;
  reviseRecord(
    db,
    actor,
    record.space_id,
    record.id,
    record.version,
    {
      content: record.content,
      importance: record.importance,
      source_ids: sourceIds,
      metadata: {
        ...record.metadata,
        legacy_sources: [...prior.filter((s) => s.url !== source.url), ref],
      },
    },
    `numeric:${noteId}:source:${digest(source.url)}:${record.version}`,
    model(),
  );
}

export function findNumericRelation(
  db: Database,
  owner: string,
  source: string,
  relationship: string,
  target: string,
  spaceId?: string,
): MemoryRecord | undefined {
  const binding = numericMemoryBinding(db, owner);
  const actor = binding.actor,
    space = spaceId ?? binding.space;
  const row = db
    .query<
      { record_id: string },
      [string, string, string, string]
    >(`SELECT c.record_id FROM memory_claims c JOIN memory_records r ON r.id=c.record_id
    WHERE c.space_id=? AND c.subject=? AND c.predicate=? AND json_extract(c.object_json,'$.id')=? AND r.status='active'
    AND json_extract(r.metadata,'$.kind')='legacy-link' ORDER BY r.created_at,r.id LIMIT 1`)
    .get(space, source, relationship, target);
  return row ? readMemoryRecord(db, actor, space, row.record_id) : undefined;
}

export function linkNumericNotes(
  db: Database,
  sourceId: number,
  targetId: number,
  relationship: string,
  unlink = false,
): void {
  const a = numericRecord(db, sourceId),
    b = numericRecord(db, targetId);
  if (
    !a ||
    !b ||
    a.entity_name !== b.entity_name ||
    a.space_id !== b.space_id ||
    a.record_id === b.record_id
  )
    return;
  const { actor } = numericMemoryBinding(db, a.entity_name);
  const space = a.space_id;
  const existing = findNumericRelation(
    db,
    a.entity_name,
    a.record_id,
    relationship,
    b.record_id,
    space,
  );
  const open =
    existing && (existing.valid_time?.until == null || existing.valid_time.until > Date.now());
  if (existing) {
    if (Boolean(open) === !unlink) return;
    reviseRecord(
      db,
      actor,
      space,
      existing.id,
      existing.version,
      {
        content: existing.content,
        importance: existing.importance,
        metadata: {
          ...existing.metadata,
          unlinked_at: unlink ? Date.now() : undefined,
          ...(!unlink ? { relinked_at: Date.now() } : {}),
        },
        valid_time: { from: existing.valid_time?.from ?? null, until: unlink ? Date.now() : null },
      },
      `numeric:link:${existing.id}:${existing.version}`,
      model(),
    );
  } else if (!unlink)
    rememberRecord(
      db,
      actor,
      space,
      {
        content: `${a.record_id} -> ${b.record_id}`,
        type: "observation",
        importance: 1,
        subject: a.record_id,
        claim: {
          subject: a.record_id,
          predicate: relationship,
          object: { kind: "entity", id: b.record_id },
        },
        metadata: {
          kind: "legacy-link",
          legacy_source_note_id: sourceId,
          legacy_target_note_id: targetId,
          relationship,
          linked_at: Date.now(),
        },
      },
      `numeric:link:${sourceId}:${targetId}:${digest(relationship)}`,
      model(),
    );
}

export function createNumericHandle(
  db: Database,
  owner: string,
  recordId: string,
  roomId?: string,
  opts?: {
    noteType?: string;
    tier?: import("../engine/constants").NoteTier;
    confidence?: number;
    verificationStatus?: string;
    poolId?: string;
  },
): number {
  return db.transaction(() => {
    const { actor } = numericMemoryBinding(db, owner);
    const row = db
      .query<{ space_id: string }, [string]>("SELECT space_id FROM memory_records WHERE id=?")
      .get(recordId);
    if (!row) throw new MemoryError(404, "record_not_found", "Record not found");
    const record = readMemoryRecord(db, actor, row.space_id, recordId);
    const existing = db
      .query<
        { note_id: number },
        [string, string]
      >(`SELECT p.note_id FROM memory_note_projections p JOIN notes n ON n.id=p.note_id
      WHERE p.record_id=? AND n.entity_name=? AND p.version IS NULL LIMIT 1`)
      .get(recordId, owner);
    if (existing) return existing.note_id;
    const id = createStoredNote(db, owner, "", roomId, {
      ...opts,
      noteType: opts?.noteType ?? record.type,
      tier: opts?.tier ?? (record.tier as import("../engine/constants").NoteTier),
      importance: record.importance,
    });
    bindNumericRecord(db, id, recordId);
    return id;
  })();
}

export function setNumericImportance(db: Database, noteId: number, importance: number): void {
  const value = current(db, noteId);
  if (!value) {
    db.run("UPDATE notes SET importance=? WHERE id=?", [importance, noteId]);
    return;
  }
  const { actor, record } = value;
  if (record.importance === importance) return;
  reviseRecord(
    db,
    actor,
    record.space_id,
    record.id,
    record.version,
    { content: record.content, importance },
    `numeric:importance:${noteId}:${record.version}`,
    model(),
  );
}
