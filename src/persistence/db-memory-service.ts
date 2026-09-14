// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  integer,
  type MemoryCheckpoint,
  type MemoryClaim,
  MemoryError,
  type MemoryGraphQuery,
  type MemoryGraphResult,
  type MemoryQuery,
  type MemoryQueryResult,
  type MemoryReceipt,
  type MemoryRecord,
  type MemoryRecordInput,
  type MemorySource,
  type MemorySpace,
  recordInput,
} from "../memory/service-types";
import type { MemorySourceSearch } from "../sdk/memory-types";
import { requireMemoryWriter } from "./db-memory-admission";
import { memoryAssistanceRepository } from "./db-memory-assistance";
import { exportMemoryBundle, importMemoryBundle } from "./db-memory-bundles";
import { deleteMemoryCache, getMemoryCache, putMemoryCache } from "./db-memory-cache";
import { captureMemoryBatch } from "./db-memory-capture";
import {
  memoryVocabulary,
  saveMemoryVocabulary,
  validateMemoryContract,
} from "./db-memory-contracts";
import {
  pinMemoryDependencies,
  staleMemoryDependents,
  storeMemoryDependencyVersions,
} from "./db-memory-dependencies";
import { memoryKnowledgeGraph } from "./db-memory-knowledge-graph";
import { memoryDatabaseHealth } from "./db-memory-maintenance";
import { rankMemoryVectors } from "./db-memory-ranking";
import { acknowledgeMemoryRequests } from "./db-memory-retention";
import { reaffirmMemory, reviewMemory } from "./db-memory-review";
import { readMemorySourceRange, searchMemorySources } from "./db-memory-sources";
import { enforceMemoryStorage, memoryStorageUsage } from "./db-memory-storage";
import { memoryJsonStore } from "./db-memory-store";
import {
  joinMemory,
  materializeMemoryRule,
  runMemoryRule,
  saveMemoryRule,
} from "./db-memory-symbolic";
import {
  abortMemoryTransfer,
  appendMemoryTransfer,
  beginMemoryTransfer,
  commitMemoryTransfer,
  exportMemoryTransferPage,
  listMemoryTransfers,
  memoryTransferStatus,
} from "./db-memory-transfer";
import { createNote, deleteNote, getNote, reviseNote } from "./db-notes";
import type { MemoryActor, MemoryScope } from "./db-principals";
import { buildFtsQuery } from "./fts";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function hash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function requireActor(db: Database, actor: MemoryActor, scope: MemoryScope) {
  const row = db
    .query(`SELECT c.scopes FROM principal_credentials c JOIN principals p ON p.principal_id=c.principal_id
    WHERE c.credential_id=? AND c.principal_id=? AND c.audience='marina:memory' AND c.revoked_at IS NULL
    AND c.expires_at>? AND p.status='active'`)
    .get(actor.credentialId, actor.principalId, Date.now()) as { scopes: string } | null;
  if (!row) throw new MemoryError(401, "invalid_credential", "Memory credential is inactive");
  if (!(JSON.parse(row.scopes) as string[]).includes(scope))
    throw new MemoryError(403, "scope_required", `Credential requires ${scope}`);
}

export function authorizeMemorySpace(
  db: Database,
  actor: MemoryActor,
  id: string,
  scope: MemoryScope = "memory:read",
  allowForgotten = false,
): MemorySpace {
  requireActor(db, actor, scope);
  const space = db.query("SELECT * FROM memory_spaces WHERE id=?").get(id) as MemorySpace | null;
  const grant = db
    .query("SELECT role FROM memory_grants WHERE space_id=? AND principal_id=?")
    .get(id, actor.principalId) as { role: string } | null;
  if (
    !space ||
    (space.owner_id !== actor.principalId &&
      (!grant || scope === "memory:share" || (scope === "memory:write" && grant.role !== "writer")))
  )
    throw new MemoryError(404, "space_not_found", "Memory space not found");
  if (space.status === "forgotten" && !allowForgotten)
    throw new MemoryError(410, "space_forgotten", "Memory space has been forgotten");
  return space;
}

export function event(
  db: Database,
  actor: MemoryActor,
  space: string,
  operation: string,
  ref?: string,
  version?: number,
): number {
  const row = db.run(
    "INSERT INTO memory_service_events(space_id,operation,reference_id,version,actor_id,created_at) VALUES (?,?,?,?,?,?)",
    [space, operation, ref ?? null, version ?? null, actor.principalId, Date.now()],
  );
  db.run("UPDATE memory_spaces SET generation=generation+1 WHERE id=?", [space]);
  if (
    operation !== "checkpoint.saved" &&
    operation !== "memory.reindex" &&
    operation !== "cache.saved" &&
    operation !== "cache.deleted" &&
    !operation.startsWith("assistance.") &&
    !(operation.startsWith("transfer.") && operation !== "transfer.committed")
  )
    db.run("UPDATE memory_spaces SET retrieval_generation=retrieval_generation+1 WHERE id=?", [
      space,
    ]);
  return Number(row.lastInsertRowid);
}

export function mutation<T extends MemoryReceipt>(
  db: Database,
  actor: MemoryActor,
  space: string,
  key: string,
  operation: string,
  input: unknown,
  run: () => T,
): T {
  requireMemoryWriter(db);
  if (!key || key.length > 128)
    throw new MemoryError(
      400,
      "idempotency_required",
      "An Idempotency-Key of 1–128 characters is required",
    );
  const fingerprint = hash({ operation, input });
  return db.transaction(() => {
    if (space)
      authorizeMemorySpace(
        db,
        actor,
        space,
        operation === "space.grant" ? "memory:share" : "memory:write",
        operation === "memory.forget",
      );
    else requireActor(db, actor, "memory:write");
    const previous = db
      .query(
        "SELECT request_hash,response,retired_at FROM memory_requests WHERE principal_id=? AND space_id=? AND request_key=?",
      )
      .get(actor.principalId, space, key) as {
      request_hash: string;
      response: string;
      retired_at: number | null;
    } | null;
    if (previous) {
      if (previous.request_hash !== fingerprint)
        throw new MemoryError(409, "idempotency_conflict", "This key was used for different input");
      if (previous.retired_at !== null)
        throw new MemoryError(
          410,
          "receipt_retired",
          "This acknowledged request key was permanently retired; it cannot execute again",
        );
      return JSON.parse(previous.response) as T;
    }
    const owner = space
      ? (
          db.query("SELECT owner_id FROM memory_spaces WHERE id=?").get(space) as {
            owner_id: string;
          }
        ).owner_id
      : actor.principalId;
    const before = memoryStorageUsage(db, owner).usage;
    const result = run();
    db.run(
      "INSERT INTO memory_requests(principal_id,space_id,request_key,request_hash,response,created_at) VALUES (?,?,?,?,?,?)",
      [actor.principalId, space, key, fingerprint, JSON.stringify(result), Date.now()],
    );
    // Explicit removal and revocation remain possible at the admission limit.
    if (
      operation !== "memory.forget" &&
      operation !== "cache.delete" &&
      operation !== "transfer.abort" &&
      !(operation === "space.grant" && (input as { role?: unknown }).role === null)
    )
      enforceMemoryStorage(db, owner, before);
    return result;
  })();
}

/** Recover an already committed response before an optional remote validation.
 * A receipt is acknowledgement, never permission to reuse its cached value. */
export function memoryMutationReceipt(
  db: Database,
  actor: MemoryActor,
  space: string,
  key: string,
  operation: string,
  input: unknown,
): MemoryReceipt | undefined {
  authorizeMemorySpace(db, actor, space, "memory:write");
  if (!key || key.length > 128)
    throw new MemoryError(
      400,
      "idempotency_required",
      "Use an Idempotency-Key of 1–128 characters",
    );
  const row = db
    .query(
      "SELECT request_hash,response,retired_at FROM memory_requests WHERE principal_id=? AND space_id=? AND request_key=?",
    )
    .get(actor.principalId, space, key) as {
    request_hash: string;
    response: string;
    retired_at: number | null;
  } | null;
  if (!row) return undefined;
  if (row.request_hash !== hash({ operation, input }))
    throw new MemoryError(409, "idempotency_conflict", "This key was used for different input");
  if (row.retired_at !== null)
    throw new MemoryError(410, "receipt_retired", "This acknowledged key was permanently retired");
  return JSON.parse(row.response) as MemoryReceipt;
}

export function createMemorySpace(
  db: Database,
  actor: MemoryActor,
  name: string,
  key: string,
): MemoryReceipt {
  requireActor(db, actor, "memory:write");
  return mutation(db, actor, "", key, "space.create", { name }, () => {
    const id = randomUUID();
    db.run("INSERT INTO memory_spaces(id,owner_id,name,created_at) VALUES (?,?,?,?)", [
      id,
      actor.principalId,
      name,
      Date.now(),
    ]);
    return { id, seq: event(db, actor, id, "space.created", id) };
  });
}

export function listMemorySpaces(db: Database, actor: MemoryActor): MemorySpace[] {
  requireActor(db, actor, "memory:read");
  return db
    .query(`SELECT s.* FROM memory_spaces s WHERE status='active' AND (owner_id=? OR EXISTS
    (SELECT 1 FROM memory_grants g WHERE g.space_id=s.id AND g.principal_id=?)) ORDER BY created_at,id`)
    .all(actor.principalId, actor.principalId) as MemorySpace[];
}

export function grantMemorySpace(
  db: Database,
  actor: MemoryActor,
  space: string,
  principal: string,
  role: "reader" | "writer" | null,
  key: string,
): MemoryReceipt {
  authorizeMemorySpace(db, actor, space, "memory:share");
  return mutation(db, actor, space, key, "space.grant", { principal, role }, () => {
    if (
      !db.query("SELECT 1 FROM principals WHERE principal_id=? AND status='active'").get(principal)
    )
      throw new MemoryError(404, "principal_not_found", "Target principal is not active");
    if (role)
      db.run(
        "INSERT INTO memory_grants VALUES (?,?,?) ON CONFLICT(space_id,principal_id) DO UPDATE SET role=excluded.role",
        [space, principal, role],
      );
    else
      db.run("DELETE FROM memory_grants WHERE space_id=? AND principal_id=?", [space, principal]);
    return {
      id: space,
      seq: event(db, actor, space, role ? "grant.set" : "grant.revoked", principal),
    };
  });
}

type RecordRow = {
  stale: number;
  stale_reason: string | null;
  id: string;
  space_id: string;
  version: number;
  current_note_id: number | null;
  subject: string | null;
  metadata: string;
  status: string;
  created_at: number;
};
function row(db: Database, space: string, id: string): RecordRow {
  const found = db
    .query("SELECT * FROM memory_records WHERE id=? AND space_id=? AND status='active'")
    .get(id, space) as RecordRow | null;
  if (!found?.current_note_id) throw new MemoryError(404, "memory_not_found", "Memory not found");
  return found;
}
function hydrate(db: Database, entry: RecordRow, version = entry.version): MemoryRecord {
  const v = db
    .query("SELECT note_id,attributes FROM memory_record_versions WHERE record_id=? AND version=?")
    .get(entry.id, version) as { note_id: number; attributes: string | null } | null;
  const note = v ? getNote(db, v.note_id) : undefined;
  if (!note) throw new MemoryError(404, "version_not_found", "Memory version not found");
  const attributes = v?.attributes
    ? JSON.parse(v.attributes)
    : {
        subject: version === entry.version ? entry.subject : null,
        metadata: version === entry.version ? JSON.parse(entry.metadata) : {},
        source_ids: [],
        depends_on: [],
      };
  return {
    id: entry.id,
    space_id: entry.space_id,
    version,
    content: note.content,
    type: note.note_type,
    tier: note.tier,
    importance: note.importance,
    created_at: note.created_at,
    ...attributes,
    freshness: version !== entry.version ? "historical" : entry.stale ? "stale" : "current",
    stale_reason:
      version === entry.version && entry.stale_reason ? JSON.parse(entry.stale_reason) : null,
  };
}

// Read current contents and version attributes together instead of two extra
// lookups per record. Historical reads still use hydrate() with an explicit version.
const currentColumns = `r.*,n.content AS note_content,n.note_type,n.tier AS note_tier,
 n.importance AS note_importance,n.created_at AS note_created_at,v.attributes`;
const currentTables = `memory_records r JOIN notes n ON n.id=r.current_note_id
 JOIN memory_record_versions v ON v.record_id=r.id AND v.version=r.version AND v.note_id=n.id`;
type CurrentRecordRow = RecordRow & {
  note_content: string;
  note_type: string;
  note_tier: string;
  note_importance: number;
  note_created_at: number;
  attributes: string | null;
};
function hydrateCurrent(entry: CurrentRecordRow): MemoryRecord {
  return {
    id: entry.id,
    space_id: entry.space_id,
    version: entry.version,
    content: entry.note_content,
    type: entry.note_type,
    tier: entry.note_tier,
    importance: entry.note_importance,
    created_at: entry.note_created_at,
    ...(entry.attributes
      ? JSON.parse(entry.attributes)
      : {
          subject: entry.subject,
          metadata: JSON.parse(entry.metadata),
          source_ids: [],
          depends_on: [],
        }),
    freshness: entry.stale ? "stale" : "current",
    stale_reason: entry.stale_reason ? JSON.parse(entry.stale_reason) : null,
  };
}

export function readCurrentMemoryRecords(
  db: Database,
  actor: MemoryActor,
  space: string,
  ids: string[],
): MemoryRecord[] {
  authorizeMemorySpace(db, actor, space);
  if (!ids.length) return [];
  const rows = db
    .query(`SELECT ${currentColumns} FROM ${currentTables}
    WHERE r.space_id=? AND r.status='active' AND n.verification_status!='superseded'
    AND r.id IN (SELECT value FROM json_each(?))`)
    .all(space, JSON.stringify(ids)) as CurrentRecordRow[];
  return rows.map(hydrateCurrent);
}

export function readMemoryRecord(
  db: Database,
  actor: MemoryActor,
  space: string,
  id: string,
  version?: number,
): MemoryRecord {
  authorizeMemorySpace(db, actor, space);
  return hydrate(db, row(db, space, id), version);
}

function dependencies(db: Database, space: string, id: string, input: MemoryRecordInput) {
  for (const source of new Set(input.source_ids ?? [])) {
    if (!db.query("SELECT 1 FROM memory_sources WHERE id=? AND space_id=?").get(source, space))
      throw new MemoryError(404, "source_not_found", "Source must belong to this space");
    db.run("INSERT OR IGNORE INTO memory_derivations VALUES (?,?)", [id, source]);
  }
  for (const dependency of new Set(input.depends_on ?? [])) {
    row(db, space, dependency);
    if (id === dependency)
      throw new MemoryError(409, "dependency_cycle", "A memory cannot depend on itself");
    const cycle = db
      .query(`WITH RECURSIVE parents(id) AS (SELECT depends_on_id FROM memory_dependencies WHERE record_id=?
      UNION SELECT d.depends_on_id FROM memory_dependencies d JOIN parents p ON d.record_id=p.id) SELECT 1 FROM parents WHERE id=?`)
      .get(dependency, id);
    if (cycle)
      throw new MemoryError(409, "dependency_cycle", "Memory dependencies must be acyclic");
    db.run("INSERT OR IGNORE INTO memory_dependencies VALUES (?,?)", [id, dependency]);
  }
}

function writeClaim(
  db: Database,
  space: string,
  id: string,
  claim: MemoryClaim | null | undefined,
) {
  if (claim === undefined) return;
  db.run("DELETE FROM memory_claims WHERE record_id=?", [id]);
  if (claim)
    db.run("INSERT INTO memory_claims VALUES (?,?,?,?,?,?)", [
      id,
      space,
      claim.subject,
      claim.predicate,
      canonical(claim.object),
      claim.object.kind === "entity" ? claim.object.id : null,
    ]);
}

function indexJob(
  db: Database,
  space: string,
  record: string,
  note: number,
  model?: string,
): string | undefined {
  if (!model) return undefined;
  const id = randomUUID();
  db.run(
    "INSERT INTO memory_index_jobs(id,space_id,record_id,note_id,model,created_at) VALUES (?,?,?,?,?,?)",
    [id, space, record, note, model, Date.now()],
  );
  return id;
}

export function reindexMemorySpace(
  db: Database,
  actor: MemoryActor,
  space: string,
  expected: number,
  model: string,
  key: string,
  page: { cursor?: string; limit?: number } = {},
) {
  authorizeMemorySpace(db, actor, space, "memory:write");
  const limit = integer(page.limit ?? 1000, "limit", 1, 10000);
  return mutation(
    db,
    actor,
    space,
    key,
    "memory.reindex",
    Object.keys(page).length ? { expected, model, ...page } : { expected, model },
    () => {
      if (authorizeMemorySpace(db, actor, space, "memory:write").generation !== expected)
        throw new MemoryError(409, "generation_conflict", "Space generation is stale");
      const current = authorizeMemorySpace(db, actor, space, "memory:write");
      let after = "";
      if (page.cursor) {
        let cursor: { space: string; model: string; generation: number; after: string };
        try {
          cursor = JSON.parse(Buffer.from(page.cursor, "base64url").toString());
        } catch {
          throw new MemoryError(400, "invalid_cursor", "Malformed reindex cursor");
        }
        if (
          !cursor ||
          cursor.space !== space ||
          cursor.model !== model ||
          typeof cursor.after !== "string"
        )
          throw new MemoryError(
            400,
            "invalid_cursor",
            "Reindex cursor belongs to another space/model",
          );
        if (cursor.generation !== current.retrieval_generation)
          throw new MemoryError(
            409,
            "query_changed",
            "Evidence changed; restart reindex pagination",
          );
        after = cursor.after;
      }
      const rows = db
        .query(`SELECT id,current_note_id FROM memory_records
      WHERE space_id=? AND status='active' AND id>? ORDER BY id LIMIT ?`)
        .all(space, after, limit + 1) as { id: string; current_note_id: number }[];
      const records = rows.slice(0, limit);
      const jobs: string[] = [];
      for (const record of records) {
        if (
          db
            .query("SELECT 1 FROM memory_vectors WHERE note_id=? AND model=?")
            .get(record.current_note_id, model)
        )
          continue;
        const pending = db
          .query(`SELECT id FROM memory_index_jobs WHERE note_id=? AND model=?
        AND state IN ('pending','running') ORDER BY created_at LIMIT 1`)
          .get(record.current_note_id, model) as { id: string } | null;
        jobs.push(pending?.id ?? indexJob(db, space, record.id, record.current_note_id, model)!);
      }
      return {
        id: space,
        seq: event(db, actor, space, "memory.reindex", space),
        model,
        job_ids: jobs,
        examined: records.length,
        next_cursor:
          rows.length > limit
            ? Buffer.from(
                JSON.stringify({
                  space,
                  model,
                  generation: current.retrieval_generation,
                  after: records.at(-1)!.id,
                }),
              ).toString("base64url")
            : null,
        generation: current.generation + 1,
      };
    },
  );
}

export function rememberRecord(
  db: Database,
  actor: MemoryActor,
  space: string,
  input: MemoryRecordInput,
  key: string,
  model?: string,
): MemoryReceipt {
  authorizeMemorySpace(db, actor, space, "memory:write");
  input = recordInput(input);
  return mutation(db, actor, space, key, "memory.remember", input, () => {
    const pins = pinMemoryDependencies(
      db,
      space,
      input.depends_on ?? [],
      input.dependency_versions,
    );
    const vocabularyVersion = validateMemoryContract(db, actor, space, input);
    const id = randomUUID();
    const note = createNote(db, `memory:${actor.principalId}`, input.content, undefined, {
      noteType: input.type ?? "fact",
      tier: input.tier ?? (input.type === "skill" ? "skill" : "fact"),
      importance: input.importance,
      skipDedup: true,
    });
    db.run(
      "INSERT INTO memory_records(id,space_id,version,current_note_id,subject,metadata,created_at) VALUES (?,?,1,?,?,?,?)",
      [id, space, note, input.subject ?? null, JSON.stringify(input.metadata ?? {}), Date.now()],
    );
    db.run(
      "INSERT INTO memory_record_versions(record_id,version,note_id,attributes) VALUES (?,1,?,?)",
      [
        id,
        note,
        JSON.stringify({
          subject: input.subject ?? null,
          metadata: input.metadata ?? {},
          source_ids: [...new Set(input.source_ids ?? [])],
          depends_on: [...new Set(input.depends_on ?? [])],
          dependency_versions: pins,
          claim: input.claim ?? null,
          valid_time: input.valid_time ?? null,
          vocabulary_version: vocabularyVersion,
        }),
      ],
    );
    dependencies(db, space, id, input);
    storeMemoryDependencyVersions(db, id, 1, input.depends_on ?? [], pins);
    writeClaim(db, space, id, input.claim);
    db.run("UPDATE memory_records SET valid_from=?,valid_until=? WHERE id=?", [
      input.valid_time?.from ?? null,
      input.valid_time?.until ?? null,
      id,
    ]);
    return {
      id,
      version: 1,
      seq: event(db, actor, space, "memory.created", id, 1),
      job_id: indexJob(db, space, id, note, model),
    };
  });
}

export function reviseRecord(
  db: Database,
  actor: MemoryActor,
  space: string,
  id: string,
  expected: number,
  input: MemoryRecordInput,
  key: string,
  model?: string,
): MemoryReceipt {
  authorizeMemorySpace(db, actor, space, "memory:write");
  input = recordInput(input);
  return mutation(db, actor, space, key, "memory.revise", { id, expected, input }, () => {
    const previous = row(db, space, id);
    if (previous.version !== expected)
      throw new MemoryError(409, "version_conflict", "Expected version is stale");
    const previousAttributes = hydrate(db, previous);
    const dependencyIds = input.depends_on ?? previousAttributes.depends_on;
    const rebinding = input.depends_on !== undefined || input.dependency_versions !== undefined;
    if (previous.stale && rebinding && dependencyIds.length && !input.dependency_versions)
      throw new MemoryError(
        409,
        "dependency_review_required",
        "Supply dependency_versions after reviewing changed premises",
      );
    const pins = rebinding
      ? pinMemoryDependencies(db, space, dependencyIds, input.dependency_versions)
      : (previousAttributes.dependency_versions ?? {});
    staleMemoryDependents(db, space, id, expected + 1);
    const validTime =
      input.valid_time === undefined ? previousAttributes.valid_time : input.valid_time;
    const vocabularyVersion = validateMemoryContract(
      db,
      actor,
      space,
      {
        ...input,
        valid_time: validTime,
        claim: input.claim === undefined ? previousAttributes.claim : input.claim,
      },
      id,
    );
    if (
      input.claim === undefined &&
      previousAttributes.claim &&
      input.subject !== undefined &&
      input.subject !== previousAttributes.claim.subject
    )
      throw new MemoryError(
        400,
        "subject_conflict",
        "Revise or remove the claim when changing its subject",
      );
    const old = getNote(db, previous.current_note_id!)!;
    const note = reviseNote(db, old.entity_name, old.id, input.content, {
      importance: input.importance,
      noteType: input.type,
    });
    if (!note) throw new MemoryError(409, "version_conflict", "Predecessor is no longer current");
    if (input.tier) db.run("UPDATE notes SET tier=? WHERE id=?", [input.tier, note]);
    const version = expected + 1;
    db.run(
      "UPDATE memory_records SET version=?,current_note_id=?,subject=?,metadata=? WHERE id=?",
      [
        version,
        note,
        input.subject ?? previous.subject,
        input.metadata ? JSON.stringify(input.metadata) : previous.metadata,
        id,
      ],
    );
    db.run(
      "INSERT INTO memory_record_versions(record_id,version,note_id,attributes) VALUES (?,?,?,?)",
      [
        id,
        version,
        note,
        JSON.stringify({
          subject: input.subject ?? previousAttributes.subject,
          metadata: input.metadata ?? previousAttributes.metadata,
          source_ids: [...new Set(input.source_ids ?? previousAttributes.source_ids)],
          depends_on: [...new Set(input.depends_on ?? previousAttributes.depends_on)],
          dependency_versions: pins,
          claim: input.claim === undefined ? (previousAttributes.claim ?? null) : input.claim,
          valid_time: validTime ?? null,
          vocabulary_version: vocabularyVersion,
        }),
      ],
    );
    // Lineage is cumulative across versions: forgetting a source must reach old
    // revisions too. New evidence never erases historical source dependencies.
    dependencies(db, space, id, input);
    storeMemoryDependencyVersions(db, id, version, dependencyIds, pins);
    if (rebinding) db.run("UPDATE memory_records SET stale=0,stale_reason=NULL WHERE id=?", [id]);
    writeClaim(db, space, id, input.claim);
    db.run("UPDATE memory_records SET valid_from=?,valid_until=? WHERE id=?", [
      validTime?.from ?? null,
      validTime?.until ?? null,
      id,
    ]);
    db.run(
      "UPDATE memory_index_jobs SET state='cancelled',lease_token=NULL WHERE record_id=? AND state IN ('pending','running')",
      [id],
    );
    return {
      id,
      version,
      seq: event(db, actor, space, "memory.revised", id, version),
      job_id: indexJob(db, space, id, note, model),
    };
  });
}

export function captureSource(
  db: Database,
  actor: MemoryActor,
  space: string,
  body: unknown,
  session: string | undefined,
  key: string,
): MemoryReceipt {
  authorizeMemorySpace(db, actor, space, "memory:write");
  return mutation(db, actor, space, key, "source.capture", { body, session }, () => {
    const id = randomUUID();
    const result = db.run(
      "INSERT INTO memory_sources(id,space_id,session_id,body,content_hash,created_at) VALUES (?,?,?,?,?,?)",
      [id, space, session ?? null, JSON.stringify(body), hash(body), Date.now()],
    );
    event(db, actor, space, "source.captured", id);
    return { id, seq: Number(result.lastInsertRowid) };
  });
}

export function memorySources(
  db: Database,
  actor: MemoryActor,
  space: string,
  after = 0,
  limit = 100,
): MemorySource[] {
  authorizeMemorySpace(db, actor, space);
  return (
    db
      .query("SELECT * FROM memory_sources WHERE space_id=? AND seq>? ORDER BY seq LIMIT ?")
      .all(space, after, limit) as (Omit<MemorySource, "body"> & { body: string })[]
  ).map((source) => ({ ...source, body: JSON.parse(source.body) }));
}

export function memorySourceHeaders(
  db: Database,
  actor: MemoryActor,
  space: string,
  after = 0,
  limit = 20,
) {
  authorizeMemorySpace(db, actor, space);
  return db
    .query(
      "SELECT id,space_id,seq,session_id,content_hash,created_at FROM memory_sources WHERE space_id=? AND seq>? ORDER BY seq LIMIT ?",
    )
    .all(space, after, limit) as Omit<MemorySource, "body">[];
}

export function saveMemoryCheckpoint(
  db: Database,
  actor: MemoryActor,
  space: string,
  name: string,
  expected: number,
  data: Record<string, unknown>,
  cursor: number,
  key: string,
  sourceIds: string[] = [],
): MemoryReceipt {
  authorizeMemorySpace(db, actor, space, "memory:write");
  return mutation(
    db,
    actor,
    space,
    key,
    "checkpoint.save",
    { name, expected, data, cursor, sourceIds },
    () => {
      const previous = db
        .query("SELECT version FROM memory_checkpoints WHERE space_id=? AND name=?")
        .get(space, name) as { version: number } | null;
      if ((previous?.version ?? 0) !== expected)
        throw new MemoryError(409, "version_conflict", "Checkpoint version is stale");
      if (
        !Array.isArray(sourceIds) ||
        sourceIds.length > 4096 ||
        sourceIds.some((id) => typeof id !== "string" || !id || id.length > 128)
      )
        throw new MemoryError(
          400,
          "invalid_sources",
          "Checkpoint supports at most 4096 source references",
        );
      const distinct = [...new Set(sourceIds)];
      const captured = db
        .query(
          "SELECT count(*) AS count FROM memory_sources WHERE space_id=? AND id IN (SELECT value FROM json_each(?))",
        )
        .get(space, JSON.stringify(distinct)) as { count: number };
      if (captured.count !== distinct.length)
        throw new MemoryError(
          409,
          "source_not_found",
          "A checkpoint source is missing or no longer accessible",
        );
      if (
        cursor &&
        !db.query("SELECT 1 FROM memory_sources WHERE seq=? AND space_id=?").get(cursor, space)
      )
        throw new MemoryError(
          409,
          "invalid_cursor",
          "Source cursor has not been committed in this space",
        );
      const version = expected + 1;
      db.run(
        "INSERT INTO memory_checkpoints VALUES (?,?,?,?,?,?) ON CONFLICT(space_id,name) DO UPDATE SET version=excluded.version,source_cursor=excluded.source_cursor,data=excluded.data,updated_at=excluded.updated_at",
        [space, name, version, cursor, JSON.stringify(data), Date.now()],
      );
      return { id: name, version, seq: event(db, actor, space, "checkpoint.saved", name, version) };
    },
  );
}

export function readMemoryCheckpoint(
  db: Database,
  actor: MemoryActor,
  space: string,
  name: string,
): MemoryCheckpoint {
  authorizeMemorySpace(db, actor, space);
  const result = db
    .query(
      "SELECT name,version,source_cursor,data,updated_at FROM memory_checkpoints WHERE space_id=? AND name=?",
    )
    .get(space, name) as (Omit<MemoryCheckpoint, "data"> & { data: string }) | null;
  if (!result) throw new MemoryError(404, "checkpoint_not_found", "Checkpoint not found");
  return { ...result, data: JSON.parse(result.data) };
}

export interface MemoryFilter {
  include_stale?: boolean;
  subject?: string;
  type?: string;
  tier?: string;
}
/** Fixed column names and bound values keep optional filters selective and injection-safe. */
export function memoryFilters(filter: MemoryFilter) {
  if (filter.include_stale !== undefined && typeof filter.include_stale !== "boolean")
    throw new MemoryError(400, "invalid_input", "include_stale must be boolean");
  const conditions: string[] = [],
    values: string[] = [];
  for (const [key, column] of [
    ["subject", "r.subject"],
    ["type", "n.note_type"],
    ["tier", "n.tier"],
  ] as const) {
    if (filter[key] !== undefined) {
      conditions.push(`${column}=?`);
      values.push(filter[key]!);
    }
  }
  if (!filter.include_stale) conditions.push("r.stale=0");
  return { sql: conditions.length ? ` AND ${conditions.join(" AND ")}` : "", values };
}

export function memoryCandidates(
  db: Database,
  actor: MemoryActor,
  space: string,
  filter: MemoryFilter = {},
  limit = 10001,
): { record: MemoryRecord; noteId: number }[] {
  authorizeMemorySpace(db, actor, space);
  const filters = memoryFilters(filter);
  const rows = db
    .query(`SELECT ${currentColumns} FROM ${currentTables}
    WHERE r.space_id=? AND r.status='active' AND n.verification_status!='superseded'
    ${filters.sql} ORDER BY r.created_at,r.id LIMIT ?`)
    .all(space, ...filters.values, limit) as CurrentRecordRow[];
  return rows.map((entry) => ({ record: hydrateCurrent(entry), noteId: entry.current_note_id! }));
}

/** Ranking needs identities, not every record's content, metadata and evidence. */
export function memoryHeads(
  db: Database,
  actor: MemoryActor,
  space: string,
  filter: MemoryFilter = {},
) {
  authorizeMemorySpace(db, actor, space);
  const filters = memoryFilters(filter);
  return db
    .query(`SELECT r.id,r.current_note_id AS noteId FROM memory_records r
    JOIN notes n ON n.id=r.current_note_id WHERE r.space_id=? AND r.status='active'
    AND n.verification_status!='superseded' ${filters.sql} ORDER BY r.id LIMIT 10001`)
    .all(space, ...filters.values) as { id: string; noteId: number }[];
}

export function lexicalMemoryCandidates(
  db: Database,
  actor: MemoryActor,
  space: string,
  query: string,
  filter: MemoryFilter = {},
): string[] {
  authorizeMemorySpace(db, actor, space);
  const fts = buildFtsQuery(query, "or");
  if (!fts) return [];
  return (
    db
      .query(`SELECT r.id FROM notes_fts f CROSS JOIN memory_records r INDEXED BY idx_memory_records_note ON r.current_note_id=f.rowid CROSS JOIN notes n ON n.id=f.rowid
    WHERE notes_fts MATCH ? AND r.space_id=? AND r.status='active' AND n.verification_status!='superseded'
    ${filter.include_stale === true ? "" : "AND r.stale=0"}
    AND (? IS NULL OR r.subject=?) AND (? IS NULL OR n.note_type=?) AND (? IS NULL OR n.tier=?)
    ORDER BY f.rank LIMIT 200`)
      .all(
        fts,
        space,
        filter.subject ?? null,
        filter.subject ?? null,
        filter.type ?? null,
        filter.type ?? null,
        filter.tier ?? null,
        filter.tier ?? null,
      ) as { id: string }[]
  ).map((x) => x.id);
}

export interface MemoryIndexJob {
  id: string;
  space_id: string;
  record_id: string;
  note_id: number;
  model: string;
  state: string;
  attempts: number;
  lease_until: number | null;
  lease_token: string | null;
  error: string | null;
  created_at: number;
}
export function claimMemoryIndexJob(
  db: Database,
  model: string,
): (MemoryIndexJob & { content: string }) | undefined {
  return db.transaction(() => {
    const job = db
      .query(`SELECT j.*,n.content FROM memory_index_jobs j JOIN notes n ON n.id=j.note_id
      JOIN memory_records r ON r.id=j.record_id AND r.current_note_id=j.note_id JOIN memory_spaces s ON s.id=j.space_id
      WHERE j.model=? AND r.status='active' AND s.status='active' AND j.state IN ('pending','running')
      AND (j.lease_until IS NULL OR j.lease_until<=?) ORDER BY j.created_at,j.id LIMIT 1`)
      .get(model, Date.now()) as (MemoryIndexJob & { content: string }) | null;
    if (!job) return undefined;
    const lease = randomUUID();
    db.run(
      "UPDATE memory_index_jobs SET state='running',attempts=attempts+1,lease_until=?,lease_token=? WHERE id=?",
      [Date.now() + 60_000, lease, job.id],
    );
    return {
      ...job,
      state: "running",
      attempts: job.attempts + 1,
      lease_token: lease,
      lease_until: Date.now() + 60_000,
    };
  })();
}

export function finishMemoryIndexJob(
  db: Database,
  job: MemoryIndexJob,
  vector?: number[],
  failure: "embedding_failed" | "quota_exceeded" = "embedding_failed",
): boolean {
  return db.transaction(() => {
    const current = db
      .query(`SELECT j.id FROM memory_index_jobs j JOIN memory_records r ON r.id=j.record_id
      JOIN memory_spaces s ON s.id=j.space_id WHERE j.id=? AND j.lease_token=? AND j.state='running'
      AND j.lease_until>? AND r.current_note_id=j.note_id AND r.status='active' AND s.status='active'`)
      .get(job.id, job.lease_token, Date.now());
    if (!current) return false;
    if (!vector) {
      db.run(
        "UPDATE memory_index_jobs SET state=?,error=?,lease_token=NULL,lease_until=? WHERE id=?",
        [
          job.attempts >= 3 ? "failed" : "pending",
          failure,
          Date.now() + 1000 * 2 ** Math.min(job.attempts, 6),
          job.id,
        ],
      );
      return true;
    }
    if (
      !vector.length ||
      vector.length > 8192 ||
      vector.some((x) => !Number.isFinite(x)) ||
      !vector.some((x) => x !== 0)
    )
      throw new MemoryError(502, "invalid_embedding", "Embedding vector is invalid");
    const dimension = db
      .query("SELECT dimensions FROM memory_vectors WHERE model=? LIMIT 1")
      .get(job.model) as { dimensions: number } | null;
    if (dimension && dimension.dimensions !== vector.length)
      throw new MemoryError(
        502,
        "embedding_dimension_changed",
        "Embedding dimensions changed without a model version change",
      );
    const owner = (
      db.query("SELECT owner_id FROM memory_spaces WHERE id=?").get(job.space_id) as {
        owner_id: string;
      }
    ).owner_id;
    const before = memoryStorageUsage(db, owner).usage;
    db.run(
      "INSERT INTO memory_vectors VALUES (?,?,?,?) ON CONFLICT(note_id,model) DO UPDATE SET dimensions=excluded.dimensions,vector=excluded.vector",
      [job.note_id, job.model, vector.length, JSON.stringify(vector)],
    );
    db.run(
      "UPDATE memory_index_jobs SET state='ready',error=NULL,lease_token=NULL,lease_until=NULL WHERE id=?",
      [job.id],
    );
    enforceMemoryStorage(db, owner, before);
    return true;
  })();
}

export function memoryVectors(
  db: Database,
  actor: MemoryActor,
  space: string,
  model: string,
): { note_id: number; vector: number[] }[] {
  authorizeMemorySpace(db, actor, space);
  return (
    db
      .query(`SELECT v.note_id,v.vector FROM memory_vectors v JOIN memory_records r ON r.current_note_id=v.note_id
    WHERE r.space_id=? AND r.status='active' AND v.model=?`)
      .all(space, model) as { note_id: number; vector: string }[]
  ).map((v) => ({ note_id: v.note_id, vector: JSON.parse(v.vector) }));
}

export function readMemoryIndexJob(
  db: Database,
  actor: MemoryActor,
  space: string,
  id: string,
): Omit<MemoryIndexJob, "lease_token"> {
  authorizeMemorySpace(db, actor, space);
  const job = db
    .query("SELECT * FROM memory_index_jobs WHERE id=? AND space_id=?")
    .get(id, space) as MemoryIndexJob | null;
  if (!job) throw new MemoryError(404, "job_not_found", "Index job not found");
  const { lease_token: _lease, ...publicJob } = job;
  return publicJob;
}

export interface ForgetMemoryInput {
  record_ids?: string[];
  source_ids?: string[];
  all?: boolean;
  expected_generation?: number;
}
export function forgetMemory(
  db: Database,
  actor: MemoryActor,
  space: string,
  input: ForgetMemoryInput,
  key: string,
): MemoryReceipt {
  authorizeMemorySpace(db, actor, space, "memory:write", true);
  return mutation(db, actor, space, key, "memory.forget", input, () => {
    const current = authorizeMemorySpace(db, actor, space, "memory:write");
    if (
      input.all &&
      (current.owner_id !== actor.principalId || current.generation !== input.expected_generation)
    )
      throw new MemoryError(
        409,
        "version_conflict",
        "Forgetting a space requires its owner and current generation",
      );
    const ids = new Set(input.record_ids ?? []);
    for (const id of ids) row(db, space, id);
    // Assistance task text may quote evidence without machine-readable links.
    // Like opaque checkpoints, retire these request sources conservatively on
    // forgetting. Their derived results are removed by the ordinary cascade.
    const sourceIds = new Set(input.source_ids ?? []);
    for (const item of db
      .query(
        "SELECT id FROM memory_sources WHERE space_id=? AND json_extract(body,'$.format')='marina.memory.assistance.request.v1'",
      )
      .all(space) as { id: string }[])
      sourceIds.add(item.id);
    for (const source of sourceIds) {
      if (!db.query("SELECT 1 FROM memory_sources WHERE id=? AND space_id=?").get(source, space))
        throw new MemoryError(404, "source_not_found", "Source not found");
      for (const item of db
        .query("SELECT record_id FROM memory_derivations WHERE source_id=?")
        .all(source) as { record_id: string }[])
        ids.add(item.record_id);
    }
    if (input.all)
      for (const record of db
        .query("SELECT id FROM memory_records WHERE space_id=? AND status='active'")
        .all(space) as { id: string }[])
        ids.add(record.id);
    for (const id of ids) {
      for (const item of db
        .query("SELECT record_id FROM memory_dependencies WHERE depends_on_id=?")
        .all(id) as { record_id: string }[])
        ids.add(item.record_id);
    }
    for (const id of ids) {
      const versions = db
        .query("SELECT note_id FROM memory_record_versions WHERE record_id=?")
        .all(id) as { note_id: number }[];
      db.run(
        "UPDATE memory_records SET status='forgotten',metadata='{}',subject=NULL,current_note_id=NULL,stale=0,stale_reason=NULL WHERE id=?",
        [id],
      );
      for (const version of versions) {
        const note = getNote(db, version.note_id);
        if (note) deleteNote(db, note.id, note.entity_name);
      }
      db.run("DELETE FROM memory_derivations WHERE record_id=?", [id]);
      db.run("DELETE FROM memory_claims WHERE record_id=?", [id]);
      db.run("DELETE FROM memory_dependencies WHERE record_id=? OR depends_on_id=?", [id, id]);
      db.run("DELETE FROM memory_revision_dependencies WHERE record_id=? OR depends_on_id=?", [
        id,
        id,
      ]);
      event(db, actor, space, "memory.forgotten", id);
    }
    for (const source of sourceIds)
      db.run("DELETE FROM memory_sources WHERE id=? AND space_id=?", [source, space]);
    // Opaque checkpoints may contain copied context. Invalidate all checkpoints
    // in the affected space rather than pretending to infer their dependencies.
    db.run("DELETE FROM memory_checkpoints WHERE space_id=?", [space]);
    db.run("DELETE FROM memory_cached_results WHERE space_id=?", [space]);
    // Compatibility receipts may contain authored tool results. Explicit
    // forgetting retires those keys and removes their copied content as well.
    db.run(
      "UPDATE memory_requests SET response=json_object('id',space_id,'retired',1),retired_at=? WHERE space_id=? AND retired_at IS NULL AND json_extract(response,'$.compat_graph')=1",
      [Date.now(), space],
    );
    db.run("DELETE FROM memory_transfer_parts WHERE space_id=?", [space]);
    db.run(
      "UPDATE memory_transfers SET state='aborted',cursor=NULL WHERE space_id=? AND state IN ('receiving','ready')",
      [space],
    );
    if (input.all) {
      db.run("DELETE FROM memory_vocabularies WHERE space_id=?", [space]);
      db.run("DELETE FROM memory_sources WHERE space_id=?", [space]);
      db.run("DELETE FROM memory_grants WHERE space_id=?", [space]);
      db.run("UPDATE memory_spaces SET status='forgotten',name='[forgotten]' WHERE id=?", [space]);
    }
    return {
      id: space,
      seq: event(db, actor, space, input.all ? "space.forgotten" : "forget.completed", space),
    };
  });
}

export function exportMemorySpace(db: Database, actor: MemoryActor, space: string) {
  authorizeMemorySpace(db, actor, space, "memory:export");
  return db.transaction(() => {
    const records = memoryCandidates(db, actor, space, { include_stale: true });
    const sources = memorySources(db, actor, space, 0, 10001);
    if (records.length > 10000 || sources.length > 10000)
      throw new MemoryError(
        413,
        "export_capacity",
        "Bundle exceeds the 10,000 record/source export limit",
      );
    const checkpoints = (
      db
        .query(
          "SELECT name,version,source_cursor,data,updated_at FROM memory_checkpoints WHERE space_id=?",
        )
        .all(space) as (Omit<MemoryCheckpoint, "data"> & { data: string })[]
    ).map((c) => ({ ...c, data: JSON.parse(c.data) }));
    return {
      schema: "marina.memory.bundle.v1",
      space: authorizeMemorySpace(db, actor, space),
      records: records.map((r) => r.record),
      sources,
      checkpoints,
      vocabulary: memoryVocabulary(db, actor, space),
      exported_at: Date.now(),
    };
  })();
}

export function isServiceMemoryNote(db: Database, id: number): boolean {
  return !!db.query("SELECT 1 FROM memory_record_versions WHERE note_id=?").get(id);
}

/** Exact predicates over portable terms. No tokenizer, embedding or model calls. */
export function queryMemory(
  db: Database,
  actor: MemoryActor,
  space: string,
  input: MemoryQuery,
): MemoryQueryResult {
  return db.transaction(() => {
    const current = authorizeMemorySpace(db, actor, space);
    const fingerprint = hash({
      space,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      type: input.type,
      tier: input.tier,
      valid_at: input.valid_at,
      include_stale: input.include_stale,
    });
    let after = "";
    if (input.cursor) {
      let cursor: {
        generation: number;
        retrieval_generation?: number;
        fingerprint: string;
        after: string;
      };
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      } catch {
        throw new MemoryError(400, "invalid_cursor", "Malformed query cursor");
      }
      if (!cursor || cursor.fingerprint !== fingerprint || typeof cursor.after !== "string")
        throw new MemoryError(400, "invalid_cursor", "Cursor belongs to another query");
      if (
        cursor.retrieval_generation !== undefined
          ? cursor.retrieval_generation !== current.retrieval_generation
          : cursor.generation !== current.generation
      )
        throw new MemoryError(
          409,
          "query_changed",
          "Space changed; restart the query without a cursor",
        );
      after = cursor.after;
    }
    const limit = input.limit ?? 20;
    const filters = memoryFilters(input);
    const values: (string | number)[] = [space, after, ...filters.values];
    let temporalFilter = "";
    if (input.valid_at !== undefined) {
      temporalFilter =
        " AND (r.valid_from IS NULL OR r.valid_from<=?) AND (r.valid_until IS NULL OR r.valid_until>?)";
      values.push(input.valid_at, input.valid_at);
    }
    let claimFilter = "";
    if (input.predicate !== undefined || input.object !== undefined) {
      const conditions = ["c.space_id= ?"];
      values.push(space);
      if (input.subject !== undefined) {
        conditions.push("c.subject=?");
        values.push(input.subject);
      }
      if (input.predicate !== undefined) {
        conditions.push("c.predicate=?");
        values.push(input.predicate);
      }
      if (input.object !== undefined) {
        conditions.push("c.object_json=?");
        values.push(canonical(input.object));
      }
      claimFilter = ` AND r.id IN (SELECT c.record_id FROM memory_claims c WHERE ${conditions.join(" AND ")})`;
    }
    const rows = db
      .query(`SELECT ${currentColumns} FROM ${currentTables}
      WHERE r.space_id=? AND r.status='active' AND n.verification_status!='superseded' AND r.id>?
      ${filters.sql}${temporalFilter}${claimFilter} ORDER BY r.id LIMIT ?`)
      .all(...values, limit + 1) as CurrentRecordRow[];
    const page = rows.slice(0, limit);
    return {
      space_id: space,
      generation: current.generation,
      mode: "symbolic" as const,
      results: page.map(hydrateCurrent),
      next_cursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                generation: current.generation,
                retrieval_generation: current.retrieval_generation,
                fingerprint,
                after: page.at(-1)!.id,
              }),
            ).toString("base64url")
          : null,
    };
  })();
}

/** Bounded traversal of asserted relations. Paths cite records, not inferred truth. */
export function graphMemory(
  db: Database,
  actor: MemoryActor,
  space: string,
  input: MemoryGraphQuery,
): MemoryGraphResult {
  return db.transaction(() => {
    const current = authorizeMemorySpace(db, actor, space);
    const maxDepth = input.max_depth ?? 2,
      limit = input.limit ?? 50;
    const direction = input.direction ?? "out";
    const queue = [{ subject: input.subject, path: [] as string[] }];
    const seenSubjects = new Set<string>([input.subject]),
      seenRecords = new Set<string>();
    const edges: MemoryGraphResult["edges"] = [];
    let truncated = false;
    const predicates = input.predicates ?? [];
    const predicateFilter =
      input.predicates === undefined
        ? ""
        : ` AND predicate IN (${predicates.map(() => "?").join(",")})`;
    const directions =
      direction === "both"
        ? ["subject", "object_entity"]
        : [direction === "in" ? "object_entity" : "subject"];
    // Each branch can seek the corresponding subject/object index. UNION also
    // deduplicates self-loops for bidirectional traversal.
    const lookup = directions
      .map(
        (column) => `SELECT record_id FROM memory_claims
      WHERE space_id=? AND ${column}=?${predicateFilter}`,
      )
      .join(" UNION ");
    const statement = db.query(`SELECT ${currentColumns} FROM ${currentTables}
      WHERE r.space_id=? AND r.status='active' AND n.verification_status!='superseded'
      ${input.include_stale === true ? "" : "AND r.stale=0"}
      AND (? IS NULL OR ((r.valid_from IS NULL OR r.valid_from<=?) AND (r.valid_until IS NULL OR r.valid_until>?)))
      AND r.id IN (${lookup}) AND r.id NOT IN (SELECT value FROM json_each(?))
      ORDER BY r.id LIMIT ?`);
    for (const item of queue) {
      const remaining = limit - edges.length;
      const atBoundary = item.path.length >= maxDepth || remaining === 0;
      const records = statement.all(
        space,
        input.valid_at ?? null,
        input.valid_at ?? null,
        input.valid_at ?? null,
        ...directions.flatMap(() => [space, item.subject, ...predicates]),
        JSON.stringify([...seenRecords]),
        atBoundary ? 1 : remaining + 1,
      ) as CurrentRecordRow[];
      if (atBoundary) {
        if (records.length) {
          truncated = true;
          break;
        }
        continue;
      }
      for (const entry of records.slice(0, remaining)) {
        const record = hydrateCurrent(entry),
          claim = record.claim!;
        const path = [...item.path, record.id];
        edges.push({ record, path });
        seenRecords.add(record.id);
        const next =
          claim.subject === item.subject
            ? claim.object.kind === "entity"
              ? claim.object.id
              : undefined
            : claim.subject;
        if (next && !seenSubjects.has(next)) {
          seenSubjects.add(next);
          queue.push({ subject: next, path });
        }
      }
      if (records.length > remaining) {
        truncated = true;
        break;
      }
    }
    return {
      space_id: space,
      generation: current.generation,
      root: input.subject,
      edges,
      truncated,
    };
  })();
}

/** SQL stays in this module. MarinaDB delegates a typed repository, which both
 * the standalone HTTP server and the full-world adapter consume. */
export function memoryRepository(db: Database) {
  return {
    assistance: memoryAssistanceRepository(db),
    healthy: () => memoryDatabaseHealth(db),
    knowledgeGraph: (actor: MemoryActor, space: string, input: unknown, key: string) =>
      memoryKnowledgeGraph(db, actor, space, input, key),
    exportBundle: (actor: MemoryActor, space: string) => exportMemoryBundle(db, actor, space),
    importBundle: (actor: MemoryActor, space: string, input: unknown, key: string) =>
      importMemoryBundle(db, actor, space, input, key),
    exportPage: (actor: MemoryActor, space: string, cursor?: string) =>
      exportMemoryTransferPage(db, actor, space, cursor),
    beginTransfer: (actor: MemoryActor, space: string, header: unknown, key: string) =>
      beginMemoryTransfer(db, actor, space, header, key),
    transferStatus: (actor: MemoryActor, space: string, id: string) =>
      memoryTransferStatus(db, actor, space, id),
    transfers: (
      actor: MemoryActor,
      space: string,
      input?: import("../sdk/memory-transfer").MemoryTransferFilter,
    ) => listMemoryTransfers(db, actor, space, input),
    appendTransfer: (actor: MemoryActor, space: string, id: string, page: unknown, key: string) =>
      appendMemoryTransfer(db, actor, space, id, page, key),
    commitTransfer: (actor: MemoryActor, space: string, id: string, digest: string, key: string) =>
      commitMemoryTransfer(db, actor, space, id, digest, key),
    abortTransfer: (actor: MemoryActor, space: string, id: string, key: string) =>
      abortMemoryTransfer(db, actor, space, id, key),
    acknowledge: (actor: MemoryActor, space: string, keys: unknown) =>
      acknowledgeMemoryRequests(db, actor, space, keys),
    review: (actor: MemoryActor, space: string, input?: unknown) =>
      reviewMemory(db, actor, space, input),
    reaffirm: (
      actor: MemoryActor,
      space: string,
      id: string,
      input: unknown,
      key: string,
      model?: string,
    ) => reaffirmMemory(db, actor, space, id, input, key, model),
    cacheDelete: (actor: MemoryActor, space: string, raw: unknown, key: string) =>
      deleteMemoryCache(db, actor, space, raw, key),
    cacheGet: (actor: MemoryActor, space: string, input: unknown) =>
      getMemoryCache(db, actor, space, input),
    cachePut: (actor: MemoryActor, space: string, input: unknown, key: string) =>
      putMemoryCache(db, actor, space, input, key),
    cacheReceipt: (actor: MemoryActor, space: string, input: unknown, key: string) =>
      memoryMutationReceipt(db, actor, space, key, "cache.put", input),
    cacheCandidate: (actor: MemoryActor, space: string, input: unknown) =>
      getMemoryCache(db, actor, space, input, true),
    cachePutValidated: (
      actor: MemoryActor,
      space: string,
      input: unknown,
      key: string,
      seals: import("../memory/federation").MemoryFederatedSeal[],
    ) => putMemoryCache(db, actor, space, input, key, seals),
    usage: (actor: MemoryActor) => {
      requireActor(db, actor, "memory:read");
      return memoryStorageUsage(db, actor.principalId);
    },
    captureBatch: (actor: MemoryActor, space: string, items: unknown, key: string) =>
      captureMemoryBatch(db, actor, space, items, key),
    vocabulary: (actor: MemoryActor, space: string, version?: number) =>
      memoryVocabulary(db, actor, space, version),
    saveVocabulary: (
      actor: MemoryActor,
      space: string,
      expected: number,
      value: unknown,
      key: string,
    ) => saveMemoryVocabulary(db, actor, space, expected, value, key),
    sourceSearch: (
      actor: MemoryActor,
      space: string,
      input: MemorySourceSearch,
      excludeAssistanceRequests = false,
    ) => searchMemorySources(db, actor, space, input, excludeAssistanceRequests),
    sourceRange: (
      actor: MemoryActor,
      space: string,
      id: string,
      start?: number,
      end?: number,
      hash?: string,
    ) => readMemorySourceRange(db, actor, space, id, start, end, hash),
    // Synchronous reads only: keep heads, ranks and hydration on one WAL snapshot.
    readSnapshot: <T>(read: () => T): T => db.transaction(read)(),
    authorize: (actor: MemoryActor, space: string, scope?: MemoryScope) =>
      authorizeMemorySpace(db, actor, space, scope),
    createSpace: (actor: MemoryActor, name: string, key: string) =>
      createMemorySpace(db, actor, name, key),
    spaces: (actor: MemoryActor) => listMemorySpaces(db, actor),
    grant: (
      actor: MemoryActor,
      space: string,
      principal: string,
      role: "reader" | "writer" | null,
      key: string,
    ) => grantMemorySpace(db, actor, space, principal, role, key),
    remember: (
      actor: MemoryActor,
      space: string,
      input: MemoryRecordInput,
      key: string,
      model?: string,
    ) => rememberRecord(db, actor, space, input, key, model),
    revise: (
      actor: MemoryActor,
      space: string,
      id: string,
      expected: number,
      input: MemoryRecordInput,
      key: string,
      model?: string,
    ) => reviseRecord(db, actor, space, id, expected, input, key, model),
    read: (actor: MemoryActor, space: string, id: string, version?: number) =>
      readMemoryRecord(db, actor, space, id, version),
    capture: (
      actor: MemoryActor,
      space: string,
      body: unknown,
      session: string | undefined,
      key: string,
    ) => captureSource(db, actor, space, body, session, key),
    sources: (actor: MemoryActor, space: string, after?: number, limit?: number) =>
      memorySources(db, actor, space, after, limit),
    checkpoint: (
      actor: MemoryActor,
      space: string,
      name: string,
      expected: number,
      data: Record<string, unknown>,
      cursor: number,
      key: string,
      sourceIds?: string[],
    ) => saveMemoryCheckpoint(db, actor, space, name, expected, data, cursor, key, sourceIds),
    getCheckpoint: (actor: MemoryActor, space: string, name: string) =>
      readMemoryCheckpoint(db, actor, space, name),
    heads: (actor: MemoryActor, space: string, filter?: MemoryFilter) =>
      memoryHeads(db, actor, space, filter),
    readCurrent: (actor: MemoryActor, space: string, ids: string[]) =>
      readCurrentMemoryRecords(db, actor, space, ids),
    candidates: (actor: MemoryActor, space: string, filter?: MemoryFilter) =>
      memoryCandidates(db, actor, space, filter),
    lexical: (actor: MemoryActor, space: string, query: string, filter?: MemoryFilter) =>
      lexicalMemoryCandidates(db, actor, space, query, filter),
    rankVectors: (
      actor: MemoryActor,
      space: string,
      model: string,
      vector: number[],
      filter?: MemoryFilter,
    ) => rankMemoryVectors(db, actor, space, model, vector, filter),
    vectors: (actor: MemoryActor, space: string, model: string) =>
      memoryVectors(db, actor, space, model),
    reindex: (
      actor: MemoryActor,
      space: string,
      expected: number,
      model: string,
      key: string,
      page?: { cursor?: string; limit?: number },
    ) => reindexMemorySpace(db, actor, space, expected, model, key, page),
    claimJob: (model: string) => claimMemoryIndexJob(db, model),
    finishJob: (
      job: MemoryIndexJob,
      vector?: number[],
      failure?: "embedding_failed" | "quota_exceeded",
    ) => finishMemoryIndexJob(db, job, vector, failure),
    job: (actor: MemoryActor, space: string, id: string) =>
      readMemoryIndexJob(db, actor, space, id),
    forget: (actor: MemoryActor, space: string, input: ForgetMemoryInput, key: string) =>
      forgetMemory(db, actor, space, input, key),
    export: (actor: MemoryActor, space: string) => exportMemorySpace(db, actor, space),
    sourceHeaders: (actor: MemoryActor, space: string, after: number, limit: number) =>
      memorySourceHeaders(db, actor, space, after, limit),
    jsonStore: (actor: MemoryActor, space: string, input: unknown, key: string) =>
      memoryJsonStore(db, actor, space, input, key),
    join: (actor: MemoryActor, space: string, input: unknown) =>
      joinMemory(db, actor, space, input),
    saveRule: (actor: MemoryActor, space: string, input: unknown, key: string) =>
      saveMemoryRule(db, actor, space, input, key),
    runRule: (actor: MemoryActor, space: string, input: unknown) =>
      runMemoryRule(db, actor, space, input),
    materializeRule: (actor: MemoryActor, space: string, input: unknown, key: string) =>
      materializeMemoryRule(db, actor, space, input, key),
    query: (actor: MemoryActor, space: string, input: MemoryQuery) =>
      queryMemory(db, actor, space, input),
    graph: (actor: MemoryActor, space: string, input: MemoryGraphQuery) =>
      graphMemory(db, actor, space, input),
  };
}
export type MemoryRepository = ReturnType<typeof memoryRepository>;
