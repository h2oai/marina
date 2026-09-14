// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy-note ↔ durable-record bridge (memory roadmap Phase 1.2).
 *
 * The legacy `note` verbs keep writing to the `notes` table exactly as before;
 * this module makes every such write ALSO land in the caller's durable resident
 * space as a versioned record with a captured source, and records the pairing
 * ("twin") on the legacy side as a `note_sources` row whose url is
 * `marina-memory://record/<recordId>`. No migration: the existing
 * `note_sources` table is the twin registry.
 *
 * Bridging is best-effort and never fatal for the legacy path — an entity with
 * no durable world account (`world_identity_required`) is silently skipped,
 * any other failure is logged and swallowed.
 */

import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { MarinaDB, NoteRow } from "../persistence/database";
import { MemoryClientError } from "../sdk/memory-client";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import { retryMemoryOperation } from "../sdk/memory-retry";
import type { MemoryReceipt, MemoryRecord } from "../sdk/memory-types";
import { residentMemoryOperation } from "./resident-service";

export const DURABLE_TWIN_URL_PREFIX = "marina-memory://record/";
export const ASSISTANCE_ADOPTION_URL_PREFIX = "marina-memory://assistance/";
const LEGACY_SOURCE_SESSION = "legacy-notes";

const logger = new Logger();
/** Bursts of legacy writes can outrun the per-principal request budget; every
 * bridge mutation is idempotently keyed, so a bounded retry is safe. */
const BRIDGE_ATTEMPTS = 3;

function durable(db: MarinaDB, entityName: string, request: MemoryOperationRequest) {
  return retryMemoryOperation(() => residentMemoryOperation(db, entityName, request), {
    attempts: BRIDGE_ATTEMPTS,
  });
}

export interface DurableTwin {
  recordId: string;
  /** Record version the twin row was written at (best-effort; may be stale). */
  version?: number;
  /** Captured durable source holding the note text at that version. */
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

/** Resolve the durable twin recorded on a legacy note, if any. */
export function findDurableTwin(db: MarinaDB, noteId: number): DurableTwin | undefined {
  for (const source of db.getNoteSources(noteId)) {
    const recordId = parseDurableTwinUrl(source.url);
    if (!recordId) continue;
    const meta = parseMetadata(source.metadata);
    return {
      recordId,
      url: source.url,
      version: typeof meta.version === "number" ? meta.version : undefined,
      sourceId: typeof meta.source_id === "string" ? meta.source_id : undefined,
      spaceId: typeof meta.space_id === "string" ? meta.space_id : undefined,
    };
  }
  return undefined;
}

/**
 * Inverse of `findDurableTwin`: the legacy notes owned by `entityName` that are
 * twinned with `recordId`. Several legacy notes can share one record (each
 * correction is a new legacy note pointing at the same record's next version);
 * results are newest-first. Scoped to one owner because twins are only ever
 * written for the note author's own resident space.
 */
export function findLegacyNotesForRecord(
  db: MarinaDB,
  entityName: string,
  recordId: string,
  opts?: { limit?: number; currentOnly?: boolean },
): NoteRow[] {
  // Url-indexed lookup over `note_sources` — no bounded scan of the owner's
  // notes, so twins older than the most recent N are found too.
  const notes = db.getNotesBySourceUrl(durableTwinUrl(recordId), entityName, opts?.limit ?? 50);
  return opts?.currentOnly
    ? notes.filter((note) => note.verification_status !== "superseded")
    : notes;
}

/** Legacy notes owned by `entityName` that adopted assistance job `jobId`. */
export function findAdoptionNotes(db: MarinaDB, entityName: string, jobId: string): NoteRow[] {
  return db.getNotesBySourceUrl(assistanceAdoptionUrl(jobId), entityName);
}

/** Write (or refresh) the twin row on a legacy note. */
export function recordDurableTwin(
  db: MarinaDB,
  noteId: number,
  twin: { recordId: string; version: number; sourceId?: string; spaceId?: string },
  capturedBy?: string,
): void {
  db.addNoteSource(noteId, {
    url: durableTwinUrl(twin.recordId),
    // `source_type` has no DB-level check; the TS union in db-notes is not
    // extended here (not owned by this slice), so the twin is identified by
    // its url scheme + metadata.kind rather than by a new source type.
    sourceType: "artifact",
    title: "durable twin",
    capturedBy,
    // A twin mirrors the note itself; it is provenance, not evidence. Zero
    // credibility keeps it below every trust threshold (`recall … trusted`
    // promotes on sources with credibility >= 0.6) and out of corroboration.
    credibility: 0,
    metadata: {
      kind: "durable-twin",
      record_id: twin.recordId,
      version: twin.version,
      source_id: twin.sourceId,
      space_id: twin.spaceId,
    },
  });
}

const DURABLE_TYPES = new Set(["fact", "observation", "decision", "inference", "skill", "episode"]);
const DURABLE_TIERS = new Set(["fact", "reflection", "skill"]);

function durableType(noteType: string): MemoryRecord["type"] | undefined {
  return DURABLE_TYPES.has(noteType) ? noteType : undefined;
}
function durableTier(tier: string): "fact" | "reflection" | "skill" | undefined {
  return DURABLE_TIERS.has(tier) ? (tier as "fact" | "reflection" | "skill") : undefined;
}
function clampImportance(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value)));
}

export interface BridgeResult {
  recordId: string;
  version: number;
  /** Absent for twins written without a captured source (e.g. adopted reflections). */
  sourceId?: string;
  spaceId?: string;
}

function asResult(twin: DurableTwin): BridgeResult {
  return {
    recordId: twin.recordId,
    version: twin.version ?? 1,
    sourceId: twin.sourceId,
    spaceId: twin.spaceId,
  };
}

async function captureNoteText(
  db: MarinaDB,
  entityName: string,
  note: NoteRow,
  version: number,
): Promise<{ sourceId: string; spaceId?: string }> {
  const captured = await durable(db, entityName, {
    operation: "capture",
    input: { content: note.content, session_id: LEGACY_SOURCE_SESSION },
    key: `legacy-note-${note.id}-source-v${version}`,
  });
  return { sourceId: (captured.result as MemoryReceipt).id, spaceId: captured.space_id };
}

/**
 * Twin a freshly created legacy note: capture its text as a durable source and
 * `remember` a record citing that source. Idempotent per note via the
 * `legacy-note-<id>-v1` key. Throws on failure — callers wanting the non-fatal
 * behaviour use `bridgeLegacyNoteQuietly`.
 */
export async function bridgeLegacyNote(
  db: MarinaDB,
  entityName: string,
  noteId: number,
): Promise<BridgeResult | undefined> {
  const note = db.getNote(noteId);
  if (!note || note.entity_name !== entityName || note.pool_id) return undefined;
  const existing = findDurableTwin(db, noteId);
  if (existing) return asResult(existing);
  const { sourceId, spaceId } = await captureNoteText(db, entityName, note, 1);
  const remembered = await durable(db, entityName, {
    operation: "remember",
    input: {
      content: note.content,
      type: durableType(note.note_type),
      tier: durableTier(note.tier),
      importance: clampImportance(note.importance),
      metadata: {
        legacy_note_id: note.id,
        note_type: note.note_type,
        importance: note.importance,
      },
      source_ids: [sourceId],
    },
    key: `legacy-note-${note.id}-v1`,
  });
  const receipt = remembered.result as MemoryReceipt;
  const version = receipt.version ?? 1;
  recordDurableTwin(db, note.id, { recordId: receipt.id, version, sourceId, spaceId }, entityName);
  return { recordId: receipt.id, version, sourceId, spaceId };
}

/**
 * Propagate a legacy supersession (`note correct` / `note evolve`) to the
 * durable twin: revise the predecessor's record (CAS on its current version)
 * with the successor's content, and point the successor legacy note at the
 * same record's new version. A predecessor without a twin gets a fresh twin
 * created for the successor instead, so the pair still ends up in both silos.
 */
export async function bridgeLegacyRevision(
  db: MarinaDB,
  entityName: string,
  predecessorId: number,
  successorId: number,
): Promise<BridgeResult | undefined> {
  const successor = db.getNote(successorId);
  if (!successor || successor.entity_name !== entityName || successor.pool_id) return undefined;
  const already = findDurableTwin(db, successorId);
  if (already) return asResult(already);
  const twin = findDurableTwin(db, predecessorId);
  if (!twin) return bridgeLegacyNote(db, entityName, successorId);
  const current = (await durable(db, entityName, { operation: "get", id: twin.recordId }))
    .result as MemoryRecord;
  const nextVersion = current.version + 1;
  const { sourceId, spaceId } = await captureNoteText(db, entityName, successor, nextVersion);
  const revised = await durable(db, entityName, {
    operation: "revise",
    id: twin.recordId,
    input: {
      expected_version: current.version,
      content: successor.content,
      type: durableType(successor.note_type),
      tier: durableTier(successor.tier),
      importance: clampImportance(successor.importance),
      metadata: {
        legacy_note_id: successor.id,
        note_type: successor.note_type,
        importance: successor.importance,
        supersedes_legacy_note_id: predecessorId,
      },
      source_ids: [sourceId],
    },
    key: `legacy-note-${successor.id}-v${nextVersion}`,
  });
  const receipt = revised.result as MemoryReceipt;
  const version = receipt.version ?? nextVersion;
  recordDurableTwin(
    db,
    successor.id,
    { recordId: receipt.id, version, sourceId, spaceId },
    entityName,
  );
  return { recordId: receipt.id, version, sourceId, spaceId };
}

export const DELETED_TWIN_CONTENT_PREFIX = "[deleted legacy note #";

/**
 * Propagate a legacy `note delete` to the durable twin by RETIRING it: a
 * `revise` to the tombstone `[deleted legacy note #<id>]` with metadata
 * `{deleted_legacy_note_id}` and validity closed at the deletion instant.
 *
 * Why not `forget`? The durable `forget {record_ids}` is record-targeted but
 * transitive by design: it also forgets every record that `depends_on` the
 * twin (e.g. an adopted reflection citing it), deletes every version's note,
 * and invalidates ALL checkpoints and cached results in the space — and the
 * resident space is the same one that holds the continuity journal. A legacy
 * `note delete` must not have that blast radius, so the twin is retired in
 * place: the current version stops matching the deleted text, temporal reads
 * (`valid_at`) exclude it, dependents go `stale` for review via the ordinary
 * revision path, and history stays inspectable. This is retirement, not
 * erasure — the captured source text and prior versions remain in lineage;
 * erasure is the explicit `forget` operation on the service.
 *
 * Must be called with the twin resolved BEFORE the legacy row is deleted
 * (`note_sources` cascades on note delete). Skipped when the record's current
 * version belongs to a different legacy note (the deleted note was already
 * superseded — its successor still owns the record). Idempotent per note.
 */
export async function retireDurableTwin(
  db: MarinaDB,
  entityName: string,
  noteId: number,
  twin: DurableTwin,
): Promise<BridgeResult | undefined> {
  const current = (await durable(db, entityName, { operation: "get", id: twin.recordId }))
    .result as MemoryRecord;
  const meta = current.metadata ?? {};
  if (meta.deleted_legacy_note_id !== undefined) {
    return { recordId: current.id, version: current.version, spaceId: current.space_id };
  }
  if (meta.legacy_note_id !== undefined && meta.legacy_note_id !== noteId) return undefined;
  const now = Date.now();
  const revised = await durable(db, entityName, {
    operation: "revise",
    id: twin.recordId,
    input: {
      expected_version: current.version,
      content: `${DELETED_TWIN_CONTENT_PREFIX}${noteId}]`,
      importance: 1,
      metadata: {
        deleted_legacy_note_id: noteId,
        deleted_at: now,
        superseded_content_version: current.version,
      },
      valid_time: { from: current.valid_time?.from ?? null, until: now },
    },
    key: `legacy-note-${noteId}-deleted`,
  });
  const receipt = revised.result as MemoryReceipt;
  return {
    recordId: receipt.id,
    version: receipt.version ?? current.version + 1,
    spaceId: revised.space_id,
  };
}

/** Swallow bridge failures: identity-less entities are skipped silently, the
 * rest is logged. The legacy write has already succeeded by the time this runs. */
async function quietly<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MemoryClientError && error.code === "world_identity_required") {
      logger.debug("legacy-bridge", `${what} skipped: no durable world account`);
      return undefined;
    }
    logger.warn("legacy-bridge", `${what} failed`, { error: getErrorMessage(error) });
    return undefined;
  }
}

/**
 * In-flight bridge registry. Command handlers fire the twin write and return
 * immediately (a `note` must reply — and count for quest progress — in the
 * same tick); callers that need sequencing (tests, batch tools) await
 * `awaitPendingBridges()` instead of the command's promise.
 */
const inflight = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
  const tracked: Promise<unknown> = p.finally(() => inflight.delete(tracked));
  inflight.add(tracked);
  return p;
}

/** Resolve once every bridge started so far has settled (new ones included). */
export async function awaitPendingBridges(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

export function bridgeLegacyNoteQuietly(
  db: MarinaDB,
  entityName: string,
  noteId: number,
): Promise<BridgeResult | undefined> {
  return track(quietly(`twin for note #${noteId}`, () => bridgeLegacyNote(db, entityName, noteId)));
}

export function bridgeLegacyRevisionQuietly(
  db: MarinaDB,
  entityName: string,
  predecessorId: number,
  successorId: number,
): Promise<BridgeResult | undefined> {
  return track(
    quietly(`twin revision #${predecessorId} → #${successorId}`, () =>
      bridgeLegacyRevision(db, entityName, predecessorId, successorId),
    ),
  );
}

/** Fire-and-forget twin retirement for a deleted legacy note; `twin` must
 * have been resolved before the legacy row was deleted. */
export function retireDurableTwinQuietly(
  db: MarinaDB,
  entityName: string,
  noteId: number,
  twin: DurableTwin,
): Promise<BridgeResult | undefined> {
  return track(
    quietly(`twin retirement for deleted note #${noteId}`, () =>
      retireDurableTwin(db, entityName, noteId, twin),
    ),
  );
}
