// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Read-only identity/provenance adapter for deprecated numeric memory surfaces.
 * No worker, authenticated client, service startup or mutation belongs here. */
import type { MarinaDB, NoteRow } from "../persistence/database";
import {
  boundMemoryRecordId,
  numericMemoryReference,
  numericNotesForRecord,
} from "../persistence/db-memory-projections";

export const DURABLE_TWIN_URL_PREFIX = "marina-memory://record/";
export const ASSISTANCE_ADOPTION_URL_PREFIX = "marina-memory://assistance/";
/** Historical self-captures are retained for upgrades but never count as
 * independent evidence. New numeric assertions do not create these captures. */
export const LEGACY_SOURCE_SESSION = "legacy-notes";
/** Capture session for EXTERNAL references attached with `note source <id> <url>`
 * — these ARE evidence and count toward `evidence_weighted`. `note:`-refs and
 * `marina-memory://` refs stay in `LEGACY_SOURCE_SESSION` (self-derived). */
export const LEGACY_EXTERNAL_SOURCE_SESSION = "legacy-sources";
export interface DurableTwin {
  recordId: string;
  /** Current or pinned version for numeric handles; historical provenance may omit it. */
  version?: number;
  /** Historical self-capture, if one existed before canonical conversion. */
  sourceId?: string;
  spaceId?: string;
  url: string;
}

export function durableTwinUrl(recordId: string): string {
  return `${DURABLE_TWIN_URL_PREFIX}${encodeURIComponent(recordId)}`;
}

export function parseDurableTwinUrl(url: string): string | undefined {
  if (!url.startsWith(DURABLE_TWIN_URL_PREFIX)) return undefined;
  const raw = url.slice(DURABLE_TWIN_URL_PREFIX.length);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function assistanceAdoptionUrl(jobId: string): string {
  return `${ASSISTANCE_ADOPTION_URL_PREFIX}${encodeURIComponent(jobId)}`;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Resolve the canonical record/version for a numeric handle. Historical source
 * metadata is a read-only fallback for old institutional publication references;
 * it never establishes a write binding. Names retain the old internal vocabulary
 * so historical provenance consumers remain compatible. */
export function findDurableTwin(db: MarinaDB, noteId: number): DurableTwin | undefined {
  const reference = numericMemoryReference(db.memoryRepository().raw, noteId);
  if (reference) return { ...reference, url: durableTwinUrl(reference.recordId) };
  const bound = boundMemoryRecordId(db.memoryRepository().raw, noteId);
  let mirror: DurableTwin | undefined;
  for (const source of db.getNoteSources(noteId)) {
    const recordId = parseDurableTwinUrl(source.url);
    if (!recordId) continue;
    const meta = parseMetadata(source.metadata);
    if (bound ? recordId !== bound : meta.kind !== "durable-twin" || meta.record_id !== recordId)
      continue;
    const twin: DurableTwin = {
      recordId,
      url: source.url,
      version: typeof meta.version === "number" ? meta.version : undefined,
      sourceId: typeof meta.source_id === "string" ? meta.source_id : undefined,
      spaceId: typeof meta.space_id === "string" ? meta.space_id : undefined,
    };
    if (meta.mirror === "institutional") {
      mirror ??= twin;
      continue;
    }
    return twin;
  }
  return mirror;
}

/** Every twin record id recorded on a legacy note (resident twin and mirrors). */
export function durableTwinRecordIds(db: MarinaDB, noteId: number): string[] {
  const bound = boundMemoryRecordId(db.memoryRepository().raw, noteId);
  const ids: string[] = bound ? [bound] : [];
  for (const source of db.getNoteSources(noteId)) {
    const recordId = parseDurableTwinUrl(source.url);
    if (recordId && !ids.includes(recordId)) ids.push(recordId);
  }
  return ids;
}

/** Numeric handles owned by this account and bound to the given record.
 * Corrections keep historical handles pinned to the same record's older versions.
 * The indexed identity table, never caller-supplied source URLs, selects them. */
export function findLegacyNotesForRecord(
  db: MarinaDB,
  entityName: string,
  recordId: string,
  opts?: { limit?: number; currentOnly?: boolean },
): NoteRow[] {
  const notes = numericNotesForRecord(
    db.memoryRepository().raw,
    entityName,
    recordId,
    opts?.limit ?? 50,
  );
  return opts?.currentOnly
    ? notes.filter((note) => note.verification_status !== "superseded")
    : notes;
}

/** Legacy notes owned by `entityName` that adopted assistance job `jobId`. */
export function findAdoptionNotes(db: MarinaDB, entityName: string, jobId: string): NoteRow[] {
  return db.getNotesBySourceUrl(assistanceAdoptionUrl(jobId), entityName);
}
