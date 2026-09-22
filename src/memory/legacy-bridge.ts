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

import { createHash } from "node:crypto";
import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { MarinaDB, NoteRow } from "../persistence/database";
import { MemoryClientError } from "../sdk/memory-client";
import type { MemoryOperationRequest } from "../sdk/memory-operations";
import { retryMemoryOperation } from "../sdk/memory-retry";
import type { MemoryGraphResult, MemoryReceipt, MemoryRecord } from "../sdk/memory-types";
import { residentMemoryOperation } from "./resident-service";

export const DURABLE_TWIN_URL_PREFIX = "marina-memory://record/";
export const ASSISTANCE_ADOPTION_URL_PREFIX = "marina-memory://assistance/";
/** Capture session for twin text — excluded from every evidence count (a twin
 * mirrors the note, it is not independent evidence). */
export const LEGACY_SOURCE_SESSION = "legacy-notes";
/** Capture session for EXTERNAL references attached with `note source <id> <url>`
 * — these ARE evidence and count toward `evidence_weighted`. `note:`-refs and
 * `marina-memory://` refs stay in `LEGACY_SOURCE_SESSION` (self-derived). */
export const LEGACY_EXTERNAL_SOURCE_SESSION = "legacy-sources";
/** Durable `source_ids` admission cap (`recordInput` in service-types). */
const MAX_RECORD_SOURCES = 32;

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

/**
 * Resolve the durable twin recorded on a legacy note, if any.
 *
 * A pool note can carry two twin rows: the author's RESIDENT twin (written by
 * `pool add`) and an INSTITUTIONAL mirror (written by `pool <name> ratify`,
 * `metadata.mirror = "institutional"`). The resident twin is the one the
 * author's own verbs (verify / delete / consolidate / source) act on, so it
 * wins regardless of row order; the mirror is returned only when it is the
 * sole twin.
 */
export function findDurableTwin(db: MarinaDB, noteId: number): DurableTwin | undefined {
  let mirror: DurableTwin | undefined;
  for (const source of db.getNoteSources(noteId)) {
    const recordId = parseDurableTwinUrl(source.url);
    if (!recordId) continue;
    const meta = parseMetadata(source.metadata);
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
  const ids: string[] = [];
  for (const source of db.getNoteSources(noteId)) {
    const recordId = parseDurableTwinUrl(source.url);
    if (recordId) ids.push(recordId);
  }
  return ids;
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
  /** Extra twin-row metadata, e.g. `{ mirror: "institutional" }` for a ratified copy. */
  extra?: Record<string, unknown>,
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
      ...extra,
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
  return twinLegacyNote(db, entityName, note, {});
}

/**
 * Twin a pool deposit (`pool <name> add`, `skill share`, `reflect --share`) in
 * the AUTHOR's resident space, tagged with the pool so the durable side knows
 * it was shared. The record is the author's own statement — the same standing
 * as a plain `note` twin — not the pool's canon: institutional canon is the
 * separate ratification mirror written by `pool <name> ratify`.
 */
export async function bridgeLegacyPoolNote(
  db: MarinaDB,
  entityName: string,
  noteId: number,
  poolName: string,
): Promise<BridgeResult | undefined> {
  const note = db.getNote(noteId);
  if (!note || note.entity_name !== entityName || !note.pool_id) return undefined;
  return twinLegacyNote(db, entityName, note, {
    pool_id: note.pool_id,
    pool: poolName,
    shared: true,
  });
}

async function twinLegacyNote(
  db: MarinaDB,
  entityName: string,
  note: NoteRow,
  extraMetadata: Record<string, unknown>,
): Promise<BridgeResult> {
  const existing = findDurableTwin(db, note.id);
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
        tier: note.tier,
        importance: note.importance,
        ...extraMetadata,
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

async function getRecord(db: MarinaDB, entityName: string, recordId: string) {
  return (await durable(db, entityName, { operation: "get", id: recordId })).result as MemoryRecord;
}

/** The legacy note id a retired twin was retired for, if it was retired. */
function retiredFor(meta: Record<string, unknown>): unknown {
  return meta.deleted_legacy_note_id ?? meta.retired_legacy_note_id;
}

/**
 * The twin's current version, if this legacy note still owns it. `undefined`
 * when the record was retired or its current version belongs to a successor
 * legacy note (the note was superseded by `note correct` / `note evolve`).
 */
async function ownedCurrent(
  db: MarinaDB,
  entityName: string,
  noteId: number,
  twin: DurableTwin,
): Promise<MemoryRecord | undefined> {
  const current = await getRecord(db, entityName, twin.recordId);
  const meta = current.metadata ?? {};
  if (retiredFor(meta) !== undefined) return undefined;
  if (meta.legacy_note_id !== undefined && meta.legacy_note_id !== noteId) return undefined;
  return current;
}

function validityOpen(record: { valid_time?: { until: number | null } | null }, now: number) {
  const until = record.valid_time?.until;
  return until === null || until === undefined || until > now;
}

function receiptResult(receipt: MemoryReceipt, fallbackVersion: number, spaceId?: string) {
  return { recordId: receipt.id, version: receipt.version ?? fallbackVersion, spaceId };
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
export const SUPERSEDED_TWIN_CONTENT_PREFIX = "[superseded legacy note #";

export interface RetireTwinOptions {
  /** `deleted` (default, `note delete`) or `superseded` (`note consolidate` loser). */
  reason?: "deleted" | "superseded";
  /** The keeper legacy note id when `reason` is `superseded`. */
  supersededBy?: number;
}

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
  opts: RetireTwinOptions = {},
): Promise<BridgeResult | undefined> {
  const reason = opts.reason ?? "deleted";
  const current = await getRecord(db, entityName, twin.recordId);
  const meta = current.metadata ?? {};
  if (retiredFor(meta) !== undefined) {
    return { recordId: current.id, version: current.version, spaceId: current.space_id };
  }
  if (meta.legacy_note_id !== undefined && meta.legacy_note_id !== noteId) return undefined;
  const now = Date.now();
  const keeperTwin =
    reason === "superseded" && opts.supersededBy !== undefined
      ? findDurableTwin(db, opts.supersededBy)
      : undefined;
  const revised = await durable(db, entityName, {
    operation: "revise",
    id: twin.recordId,
    input: {
      expected_version: current.version,
      content: `${reason === "deleted" ? DELETED_TWIN_CONTENT_PREFIX : SUPERSEDED_TWIN_CONTENT_PREFIX}${noteId}]`,
      importance: 1,
      metadata:
        reason === "deleted"
          ? {
              deleted_legacy_note_id: noteId,
              deleted_at: now,
              superseded_content_version: current.version,
            }
          : {
              retired_legacy_note_id: noteId,
              retired_reason: "consolidated",
              retired_at: now,
              superseded_by_legacy_note_id: opts.supersededBy,
              superseded_by_record_id: keeperTwin?.recordId,
              superseded_content_version: current.version,
            },
      valid_time: { from: current.valid_time?.from ?? null, until: now },
    },
    key: `legacy-note-${noteId}-${reason}`,
  });
  return receiptResult(revised.result as MemoryReceipt, current.version + 1, revised.space_id);
}

/**
 * `note consolidate <keeper> <dup…>`: every duplicate the legacy side marked
 * `superseded` gets its twin retired as a `[superseded legacy note #<id>]`
 * tombstone pointing at the keeper (same mechanism as `note delete`, different
 * reason). The keeper's twin is untouched. Idempotent per duplicate.
 */
export async function bridgeLegacyConsolidation(
  db: MarinaDB,
  entityName: string,
  keeperId: number,
  supersededIds: number[],
): Promise<BridgeResult[]> {
  const out: BridgeResult[] = [];
  for (const id of new Set(supersededIds)) {
    if (id === keeperId) continue;
    const twin = findDurableTwin(db, id);
    if (!twin) continue;
    const result = await retireDurableTwin(db, entityName, id, twin, {
      reason: "superseded",
      supersededBy: keeperId,
    });
    if (result) out.push(result);
  }
  return out;
}

export type LegacyVerdict = "unverified" | "verified" | "disputed";

export interface VerificationBridgeOptions {
  /** Stable idempotency key for this verification event, e.g.
   * `legacy-note-<id>-verify-<verificationId>` or `legacy-case-<case>-note-<id>-disputed`. */
  key: string;
  confidence?: number;
  rationale?: string;
  caseId?: number;
}

/**
 * `note verify` / `note resolve` → the durable twin.
 *
 * - `disputed`: the twin's validity is CLOSED at the verification instant
 *   (`valid_time.until = now`) and the content kept — the same representation
 *   the durable `resolve` gives a losing rival, and exactly what
 *   `servableRecord` drops from the `[evidence]` tier. Metadata records
 *   `legacy_verification: "disputed"` plus confidence / rationale / case.
 * - `verified` / `unverified` on a twin WE closed: validity reopens
 *   (`until: null`) via `revise`, metadata updated.
 * - `verified` on an open twin: durable `reaffirm` (explicit review of an
 *   independent assertion, `dependency_versions: {}`) — it also settles any
 *   `await_confirmation` set the record belongs to.
 * - `unverified` on an open twin: no-op (that is already the default state).
 *
 * Skipped when the note has no twin, the twin was retired, or its current
 * version belongs to a successor legacy note.
 */
export async function bridgeLegacyVerification(
  db: MarinaDB,
  entityName: string,
  noteId: number,
  verdict: LegacyVerdict,
  opts: VerificationBridgeOptions,
): Promise<BridgeResult | undefined> {
  const note = db.getNote(noteId);
  if (!note || note.entity_name !== entityName) return undefined;
  const twin = findDurableTwin(db, noteId);
  if (!twin) return undefined;
  const current = await ownedCurrent(db, entityName, noteId, twin);
  if (!current) return undefined;
  const meta = current.metadata ?? {};
  const now = Date.now();
  const closedByLegacyDispute =
    meta.legacy_verification === "disputed" && !validityOpen(current, now);
  const stamp = {
    legacy_verification: verdict,
    legacy_verification_confidence: opts.confidence,
    legacy_verification_rationale: opts.rationale,
    legacy_verification_case_id: opts.caseId,
    legacy_verified_at: now,
  };
  const unchanged = { recordId: current.id, version: current.version, spaceId: current.space_id };

  if (verdict === "disputed") {
    if (closedByLegacyDispute) return unchanged;
    const revised = await durable(db, entityName, {
      operation: "revise",
      id: twin.recordId,
      input: {
        expected_version: current.version,
        content: current.content,
        importance: current.importance,
        metadata: { ...meta, ...stamp, disputed_at: now },
        valid_time: { from: current.valid_time?.from ?? null, until: now },
      },
      key: opts.key,
    });
    return receiptResult(revised.result as MemoryReceipt, current.version + 1, revised.space_id);
  }

  if (closedByLegacyDispute) {
    const { disputed_at: _dropped, ...rest } = meta;
    const revised = await durable(db, entityName, {
      operation: "revise",
      id: twin.recordId,
      input: {
        expected_version: current.version,
        content: current.content,
        importance: current.importance,
        metadata: { ...rest, ...stamp },
        valid_time: { from: current.valid_time?.from ?? null, until: null },
      },
      key: opts.key,
    });
    return receiptResult(revised.result as MemoryReceipt, current.version + 1, revised.space_id);
  }

  if (verdict !== "verified") return unchanged;
  const reaffirmed = await durable(db, entityName, {
    operation: "reaffirm",
    id: twin.recordId,
    input: { expected_version: current.version, dependency_versions: {} },
    key: opts.key,
  });
  return receiptResult(
    reaffirmed.result as MemoryReceipt,
    current.version + 1,
    reaffirmed.space_id,
  );
}

/**
 * `note resolve <case> left|right|both|neither`: mirror the legacy verdicts —
 * winners are reaffirmed, losers closed as disputed (see
 * `bridgeLegacyVerification`). Follows the legacy semantics exactly: `neither`
 * disputes BOTH notes, `both` verifies both; there is no "untouched" outcome
 * because the legacy side always records a verification for every member.
 */
export async function bridgeLegacyResolution(
  db: MarinaDB,
  entityName: string,
  caseId: number,
  outcome: { winners: number[]; losers: number[]; rationale?: string },
): Promise<BridgeResult[]> {
  const out: BridgeResult[] = [];
  for (const id of outcome.losers) {
    const result = await bridgeLegacyVerification(db, entityName, id, "disputed", {
      key: `legacy-case-${caseId}-note-${id}-disputed`,
      confidence: db.getNote(id)?.confidence ?? undefined,
      rationale: outcome.rationale,
      caseId,
    });
    if (result) out.push(result);
  }
  for (const id of outcome.winners) {
    const result = await bridgeLegacyVerification(db, entityName, id, "verified", {
      key: `legacy-case-${caseId}-note-${id}-verified`,
      confidence: db.getNote(id)?.confidence ?? undefined,
      rationale: outcome.rationale,
      caseId,
    });
    if (result) out.push(result);
  }
  return out;
}

export const LEGACY_LINK_METADATA_KIND = "legacy-link";

function linkKey(sourceNoteId: number, targetNoteId: number, relationship: string): string {
  return `legacy-link-${sourceNoteId}-${targetNoteId}-${relationship}`;
}

/** The durable relation record (`relate` = `remember` with an entity-object
 * claim) mirroring `note link <a> <b> <rel>`, open or closed, if one exists. */
export async function findDurableRelation(
  db: MarinaDB,
  entityName: string,
  subjectRecordId: string,
  relationship: string,
  objectRecordId: string,
): Promise<MemoryRecord | undefined> {
  const graph = (
    await durable(db, entityName, {
      operation: "graph",
      input: {
        subject: subjectRecordId,
        predicates: [relationship],
        direction: "out",
        include_stale: true,
        max_depth: 1,
        limit: 100,
      },
    })
  ).result as MemoryGraphResult;
  return graph.edges
    .map((edge) => edge.record)
    .find(
      (record) =>
        record.claim?.object.kind === "entity" && record.claim.object.id === objectRecordId,
    );
}

/**
 * `note link <a> <b> <rel>` → durable `relate`: a relation record whose claim
 * is `<twinA> <rel> <twinB>` (entity object), readable with `memory graph
 * <twinA record id>`. Content is the two record ids only, so the relation never
 * matches a natural-language `search` and cannot leak into `[evidence]`.
 * Requires BOTH notes to have twins (a relation to an untwinned or foreign
 * note has nothing durable to point at — skipped). A relation closed by
 * `note unlink` is reopened rather than duplicated. Idempotent per link.
 */
export async function bridgeLegacyLink(
  db: MarinaDB,
  entityName: string,
  sourceNoteId: number,
  targetNoteId: number,
  relationship: string,
): Promise<BridgeResult | undefined> {
  const source = db.getNote(sourceNoteId);
  if (!source || source.entity_name !== entityName) return undefined;
  const twinA = findDurableTwin(db, sourceNoteId);
  const twinB = findDurableTwin(db, targetNoteId);
  if (!twinA || !twinB) return undefined;
  const existing = await findDurableRelation(
    db,
    entityName,
    twinA.recordId,
    relationship,
    twinB.recordId,
  );
  const now = Date.now();
  if (existing) {
    if (validityOpen(existing, now)) {
      return { recordId: existing.id, version: existing.version, spaceId: existing.space_id };
    }
    const { unlinked_at: _dropped, ...meta } = existing.metadata ?? {};
    const revised = await durable(db, entityName, {
      operation: "revise",
      id: existing.id,
      input: {
        expected_version: existing.version,
        content: existing.content,
        importance: existing.importance,
        metadata: { ...meta, relinked_at: now },
        valid_time: { from: existing.valid_time?.from ?? null, until: null },
      },
      key: `${linkKey(sourceNoteId, targetNoteId, relationship)}-relink-v${existing.version + 1}`,
    });
    return receiptResult(revised.result as MemoryReceipt, existing.version + 1, revised.space_id);
  }
  const remembered = await durable(db, entityName, {
    operation: "remember",
    input: {
      content: `${twinA.recordId} -> ${twinB.recordId}`,
      type: "observation",
      importance: 1,
      subject: twinA.recordId,
      claim: {
        subject: twinA.recordId,
        predicate: relationship,
        object: { kind: "entity", id: twinB.recordId },
      },
      metadata: {
        kind: LEGACY_LINK_METADATA_KIND,
        legacy_source_note_id: sourceNoteId,
        legacy_target_note_id: targetNoteId,
        relationship,
        linked_at: now,
      },
    },
    key: linkKey(sourceNoteId, targetNoteId, relationship),
  });
  return receiptResult(remembered.result as MemoryReceipt, 1, remembered.space_id);
}

/**
 * `note unlink <a> <b> <rel>` → the inverse of `relate`: the relation record's
 * validity is closed at the unlink instant (`valid_time.until = now`), so
 * `memory graph … valid_at <now>` and every validity-filtered read exclude it
 * while history stays inspectable. (The durable service has no destructive
 * un-relate short of `forget`, whose blast radius — every dependent record,
 * checkpoint and cached result in the space — a legacy unlink must not have.)
 * No-op when there is no open relation.
 */
export async function bridgeLegacyUnlink(
  db: MarinaDB,
  entityName: string,
  sourceNoteId: number,
  targetNoteId: number,
  relationship: string,
): Promise<BridgeResult | undefined> {
  const twinA = findDurableTwin(db, sourceNoteId);
  const twinB = findDurableTwin(db, targetNoteId);
  if (!twinA || !twinB) return undefined;
  const existing = await findDurableRelation(
    db,
    entityName,
    twinA.recordId,
    relationship,
    twinB.recordId,
  );
  const now = Date.now();
  if (!existing || !validityOpen(existing, now)) return undefined;
  const revised = await durable(db, entityName, {
    operation: "revise",
    id: existing.id,
    input: {
      expected_version: existing.version,
      content: existing.content,
      importance: existing.importance,
      metadata: { ...(existing.metadata ?? {}), unlinked_at: now },
      valid_time: { from: existing.valid_time?.from ?? null, until: now },
    },
    key: `${linkKey(sourceNoteId, targetNoteId, relationship)}-unlink-v${existing.version + 1}`,
  });
  return receiptResult(revised.result as MemoryReceipt, existing.version + 1, revised.space_id);
}

export interface LegacySourceRef {
  url: string;
  sourceType?: string;
  credibility?: number;
  observedAt?: number;
  excerpt?: string;
  /** Set when the reference is another legacy note (`note:<id>` / `note derive`). */
  sourceNoteId?: number;
}

function sourceDigest(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * `note source <id> <url>` / `note claim … source <url>` / `note derive` → the
 * twin's sources: the reference is `capture`d as a durable source (body = the
 * url, so two notes citing the same url share one `content_hash` and count as
 * ONE independent source) and appended to the record's `source_ids` via
 * `revise`; `metadata.legacy_sources` keeps type / credibility / observation.
 * External urls use `LEGACY_EXTERNAL_SOURCE_SESSION` (they are evidence);
 * `note:` and `marina-memory://` references stay self-derived. A note without
 * a twin is twinned first (pool notes are skipped). Idempotent per (note, url).
 */
export async function bridgeLegacySource(
  db: MarinaDB,
  entityName: string,
  noteId: number,
  source: LegacySourceRef,
): Promise<BridgeResult | undefined> {
  const note = db.getNote(noteId);
  if (!note || note.entity_name !== entityName) return undefined;
  // A twin row is provenance of the bridge itself, never a source to mirror.
  if (parseDurableTwinUrl(source.url) || source.url.startsWith(ASSISTANCE_ADOPTION_URL_PREFIX))
    return undefined;
  const twin = findDurableTwin(db, noteId) ?? (await bridgeLegacyNote(db, entityName, noteId));
  if (!twin) return undefined;
  const current = await ownedCurrent(db, entityName, noteId, {
    recordId: twin.recordId,
    url: durableTwinUrl(twin.recordId),
  });
  if (!current) return undefined;
  const selfDerived =
    source.sourceNoteId !== undefined ||
    source.url.startsWith("note:") ||
    source.url.startsWith("marina-memory://");
  const digest = sourceDigest(source.url);
  const captured = await durable(db, entityName, {
    operation: "capture",
    input: {
      content: source.url,
      session_id: selfDerived ? LEGACY_SOURCE_SESSION : LEGACY_EXTERNAL_SOURCE_SESSION,
    },
    key: `legacy-note-${noteId}-source-${digest}`,
  });
  const sourceId = (captured.result as MemoryReceipt).id;
  if (current.source_ids.includes(sourceId)) {
    return { recordId: current.id, version: current.version, spaceId: current.space_id };
  }
  if (current.source_ids.length >= MAX_RECORD_SOURCES) {
    logger.warn("legacy-bridge", `twin for note #${noteId} is at the source cap; url not mirrored`);
    return { recordId: current.id, version: current.version, spaceId: current.space_id };
  }
  const meta = current.metadata ?? {};
  const previous = Array.isArray(meta.legacy_sources) ? meta.legacy_sources : [];
  const revised = await durable(db, entityName, {
    operation: "revise",
    id: twin.recordId,
    input: {
      expected_version: current.version,
      content: current.content,
      importance: current.importance,
      source_ids: [...current.source_ids, sourceId],
      metadata: {
        ...meta,
        legacy_sources: [
          ...previous,
          {
            url: source.url,
            source_id: sourceId,
            source_type: source.sourceType,
            credibility: source.credibility,
            observed_at: source.observedAt,
            source_note_id: source.sourceNoteId,
          },
        ],
      },
    },
    key: `legacy-note-${noteId}-source-${digest}-v${current.version + 1}`,
  });
  return receiptResult(revised.result as MemoryReceipt, current.version + 1, revised.space_id);
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

export function bridgeLegacyPoolNoteQuietly(
  db: MarinaDB,
  entityName: string,
  noteId: number,
  poolName: string,
): Promise<BridgeResult | undefined> {
  return track(
    quietly(`twin for pool note #${noteId}`, () =>
      bridgeLegacyPoolNote(db, entityName, noteId, poolName),
    ),
  );
}

export function bridgeLegacyConsolidationQuietly(
  db: MarinaDB,
  entityName: string,
  keeperId: number,
  supersededIds: number[],
): Promise<BridgeResult[] | undefined> {
  return track(
    quietly(`twin retirement for notes consolidated into #${keeperId}`, () =>
      bridgeLegacyConsolidation(db, entityName, keeperId, supersededIds),
    ),
  );
}

export function bridgeLegacyVerificationQuietly(
  db: MarinaDB,
  entityName: string,
  noteId: number,
  verdict: LegacyVerdict,
  opts: VerificationBridgeOptions,
): Promise<BridgeResult | undefined> {
  return track(
    quietly(`twin verification (${verdict}) for note #${noteId}`, () =>
      bridgeLegacyVerification(db, entityName, noteId, verdict, opts),
    ),
  );
}

export function bridgeLegacyResolutionQuietly(
  db: MarinaDB,
  entityName: string,
  caseId: number,
  outcome: { winners: number[]; losers: number[]; rationale?: string },
): Promise<BridgeResult[] | undefined> {
  return track(
    quietly(`twin verdicts for contradiction case #${caseId}`, () =>
      bridgeLegacyResolution(db, entityName, caseId, outcome),
    ),
  );
}

export function bridgeLegacyLinkQuietly(
  db: MarinaDB,
  entityName: string,
  sourceNoteId: number,
  targetNoteId: number,
  relationship: string,
): Promise<BridgeResult | undefined> {
  return track(
    quietly(`durable relation #${sourceNoteId} ${relationship} #${targetNoteId}`, () =>
      bridgeLegacyLink(db, entityName, sourceNoteId, targetNoteId, relationship),
    ),
  );
}

export function bridgeLegacyUnlinkQuietly(
  db: MarinaDB,
  entityName: string,
  sourceNoteId: number,
  targetNoteId: number,
  relationship: string,
): Promise<BridgeResult | undefined> {
  return track(
    quietly(`durable relation close #${sourceNoteId} ${relationship} #${targetNoteId}`, () =>
      bridgeLegacyUnlink(db, entityName, sourceNoteId, targetNoteId, relationship),
    ),
  );
}

export function bridgeLegacySourceQuietly(
  db: MarinaDB,
  entityName: string,
  noteId: number,
  source: LegacySourceRef,
): Promise<BridgeResult | undefined> {
  return track(
    quietly(`twin source for note #${noteId}`, () =>
      bridgeLegacySource(db, entityName, noteId, source),
    ),
  );
}
