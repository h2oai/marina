// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { integer, MemoryError, object, recordInput, textValue } from "../memory/service-types";
import { canonicalPortableMemory } from "../sdk/memory-portable";
import type { MemoryBundle, MemoryRecord, MemorySource } from "../sdk/memory-types";
import { definitionInput, validateMemoryContract } from "./db-memory-contracts";
import {
  authorizeMemorySpace,
  canonical,
  event,
  mutation,
  readMemoryRecord,
} from "./db-memory-service";
import { createNote } from "./db-notes";
import type { MemoryActor } from "./db-principals";

const digest = (value: unknown) =>
  createHash("sha256").update(canonicalPortableMemory(value)).digest("hex");
const bodyDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MAX_BYTES = 1536 * 1024;
const ATTRIBUTE_KEYS = new Set([
  "subject",
  "metadata",
  "source_ids",
  "depends_on",
  "dependency_versions",
  "claim",
  "valid_time",
  "vocabulary_version",
]);
interface Version {
  record: MemoryRecord;
  attributes: Record<string, unknown> | null;
}
interface BundleRecord {
  id: string;
  version: number;
  created_at: number;
  stale: number;
  stale_reason: string | null;
  versions: Version[];
}
interface BundlePayload {
  origin_space: string;
  sources: (MemorySource & { body_sha256: string })[];
  records: BundleRecord[];
  vocabularies: { version: number; definition: string; created_at: number }[];
  checkpoints: {
    name: string;
    version: number;
    source_cursor: number;
    data: string;
    updated_at: number;
  }[];
}
export function exportMemoryBundle(db: Database, actor: MemoryActor, space: string): MemoryBundle {
  return db.transaction(() => {
    authorizeMemorySpace(db, actor, space, "memory:export");
    // Bound raw payload bytes before loading bodies, histories or checkpoints.
    const size = db
      .query(`SELECT
      coalesce((SELECT sum(length(CAST(body AS BLOB))) FROM memory_sources WHERE space_id=?),0) +
      coalesce((SELECT sum(length(CAST(n.content AS BLOB))+coalesce(length(CAST(v.attributes AS BLOB)),0))
        FROM memory_records r JOIN memory_record_versions v ON v.record_id=r.id JOIN notes n ON n.id=v.note_id
        WHERE r.space_id=? AND r.status='active'),0) +
      coalesce((SELECT sum(length(CAST(definition AS BLOB))) FROM memory_vocabularies WHERE space_id=?),0) +
      coalesce((SELECT sum(length(CAST(data AS BLOB))) FROM memory_checkpoints WHERE space_id=?),0) AS bytes`)
      .get(space, space, space, space) as { bytes: number };
    if (size.bytes > MAX_BYTES)
      throw new MemoryError(
        413,
        "bundle_capacity",
        "Bundle exceeds 1.5 MiB; use operator snapshots for larger exact transfers",
      );
    const rows = db
      .query(
        "SELECT id,version,created_at,stale,stale_reason FROM memory_records WHERE space_id=? AND status='active' ORDER BY id LIMIT 2001",
      )
      .all(space) as Omit<BundleRecord, "versions">[];
    const sources = db
      .query("SELECT * FROM memory_sources WHERE space_id=? ORDER BY seq LIMIT 2001")
      .all(space) as (Omit<MemorySource, "body"> & { body: string })[];
    if (rows.length > 2000 || sources.length > 2000)
      throw new MemoryError(
        413,
        "bundle_capacity",
        "Native bundle supports up to 2000 records/sources; use scoped query/source pagination or operator snapshots for larger transfers",
      );
    let bytes = 0;
    const charge = (value: unknown) => {
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > MAX_BYTES)
        throw new MemoryError(
          413,
          "bundle_capacity",
          "Bundle exceeds 1.5 MiB; use operator snapshots for larger exact transfers",
        );
    };
    const records = rows.map((row) => {
      const versions = db
        .query(
          "SELECT version,attributes FROM memory_record_versions WHERE record_id=? ORDER BY version LIMIT 2001",
        )
        .all(row.id) as { version: number; attributes: string | null }[];
      if (versions.length > 2000)
        throw new MemoryError(413, "bundle_capacity", "Too many revisions in bundle");
      const result = {
        ...row,
        versions: versions.map((v) => {
          const version = {
            record: readMemoryRecord(db, actor, space, row.id, v.version),
            attributes: v.attributes ? JSON.parse(v.attributes) : null,
          };
          charge(version);
          return version;
        }),
      };
      charge(row);
      return result;
    });
    const payload: BundlePayload = {
      origin_space: space,
      sources: sources.map((s) => ({
        ...s,
        body: JSON.parse(s.body),
        body_sha256: bodyDigest(JSON.parse(s.body)),
      })),
      records,
      vocabularies: db
        .query(
          "SELECT version,definition,created_at FROM memory_vocabularies WHERE space_id=? ORDER BY version",
        )
        .all(space) as BundlePayload["vocabularies"],
      checkpoints: db
        .query(
          "SELECT name,version,source_cursor,data,updated_at FROM memory_checkpoints WHERE space_id=? ORDER BY name",
        )
        .all(space) as BundlePayload["checkpoints"],
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES)
      throw new MemoryError(
        413,
        "bundle_capacity",
        "Bundle exceeds 1.5 MiB; use operator snapshots for larger exact transfers",
      );
    return {
      schema: "marina.memory.bundle.v2" as const,
      sha256: digest(payload),
      payload,
      excluded: ["credentials", "grants", "receipts", "indexes", "cached_results"],
    };
  })();
}

/** Explicit import into an empty owned space. Preserve portable IDs, historical
 * attributes and original bytes; refuse collisions instead of silently merging. */
export function importMemoryBundle(
  db: Database,
  actor: MemoryActor,
  space: string,
  raw: unknown,
  key: string,
) {
  const envelope = object(raw),
    payload = object(envelope.payload) as unknown as BundlePayload;
  if (envelope.schema !== "marina.memory.bundle.v2" || envelope.sha256 !== digest(payload))
    throw new MemoryError(400, "invalid_bundle", "Bundle schema or SHA-256 does not match");
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES)
    throw new MemoryError(413, "bundle_capacity", "Bundle exceeds 1.5 MiB");
  textValue(payload.origin_space, "origin_space", 256);
  for (const name of ["sources", "records", "vocabularies", "checkpoints"] as const)
    if (!Array.isArray(payload[name]) || payload[name].length > 2000)
      throw new MemoryError(400, "invalid_bundle", `Invalid ${name} section`);
  for (const record of payload.records)
    if (!Array.isArray(record.versions) || !record.versions.length || record.versions.length > 2000)
      throw new MemoryError(400, "invalid_bundle", "Invalid record history");
  return mutation(db, actor, space, key, "bundle.import", envelope, () => {
    const result = applyMemoryImport(db, actor, space, payload);
    return {
      id: space,
      seq: event(db, actor, space, "bundle.imported", String(envelope.sha256)),
      ...result,
    };
  });
}

/** Re-iterable rows let a staged transfer publish without materializing an entire
 * history. Only call inside an enclosing mutation transaction. */
export interface MemoryImportRows {
  origin_space: string;
  sources: Iterable<BundlePayload["sources"][number]>;
  records: Iterable<Omit<BundleRecord, "versions"> & { versions: Iterable<Version> }>;
  vocabularies: Iterable<BundlePayload["vocabularies"][number]>;
  checkpoints: Iterable<BundlePayload["checkpoints"][number]>;
}
export function applyMemoryImport(
  db: Database,
  actor: MemoryActor,
  space: string,
  payload: MemoryImportRows,
) {
  const target = authorizeMemorySpace(db, actor, space, "memory:write");
  if (target.owner_id !== actor.principalId)
    throw new MemoryError(403, "owner_required", "Import requires the space owner");
  for (const table of [
    "memory_records",
    "memory_sources",
    "memory_vocabularies",
    "memory_checkpoints",
  ])
    if (db.query(`SELECT 1 FROM ${table} WHERE space_id=? LIMIT 1`).get(space))
      throw new MemoryError(409, "import_not_empty", "Import requires an empty destination");
  const sourceIds = new Set<string>(),
    recordIds = new Set<string>(),
    cursors = new Map<number, number>();
  for (const s of payload.sources) {
    textValue(s.id, "source id", 128);
    integer(s.seq, "source seq", 1, Number.MAX_SAFE_INTEGER);
    if (cursors.has(s.seq) || !Object.hasOwn(s, "body"))
      throw new MemoryError(400, "invalid_bundle", "Duplicate source sequence or missing body");
    integer(s.created_at, "created_at", 0, Number.MAX_SAFE_INTEGER);
    if (s.session_id !== null) textValue(s.session_id, "session_id", 256);
    if (sourceIds.has(s.id) || db.query("SELECT 1 FROM memory_sources WHERE id=?").get(s.id))
      throw new MemoryError(409, "identity_collision", "Source identity already exists");
    textValue(s.content_hash, "content_hash", 128);
    if (s.body_sha256 !== bodyDigest(s.body))
      throw new MemoryError(400, "invalid_bundle", "Source content hash mismatch");
    sourceIds.add(s.id);
    const row = db.run(
      "INSERT INTO memory_sources(id,space_id,session_id,body,content_hash,created_at) VALUES (?,?,?,?,?,?)",
      [s.id, space, s.session_id, JSON.stringify(s.body), s.content_hash, s.created_at],
    );
    cursors.set(s.seq, Number(row.lastInsertRowid));
  }
  const dependencies = new Map<string, string[]>();
  for (const r of payload.records) {
    textValue(r.id, "record id", 128);
    integer(r.version, "version", 1, Number.MAX_SAFE_INTEGER);
    integer(r.created_at, "created_at", 0, Number.MAX_SAFE_INTEGER);
    if (recordIds.has(r.id) || db.query("SELECT 1 FROM memory_records WHERE id=?").get(r.id))
      throw new MemoryError(409, "identity_collision", "Record identity already exists");
    if (![0, 1].includes(r.stale))
      throw new MemoryError(400, "invalid_bundle", "Invalid record history");
    recordIds.add(r.id);
    const seen = new Set<number>();
    let head: number | undefined;
    db.run(
      "INSERT INTO memory_records(id,space_id,version,created_at,stale,stale_reason) VALUES (?,?,?,?,?,?)",
      [
        r.id,
        space,
        r.version,
        r.created_at,
        r.stale,
        r.stale_reason === null ? null : JSON.stringify(object(JSON.parse(r.stale_reason))),
      ],
    );
    for (const version of r.versions) {
      const v = version.record;
      integer(v.version, "version", 1, r.version);
      integer(v.created_at, "created_at", 0, Number.MAX_SAFE_INTEGER);
      if (v.id !== r.id || seen.has(v.version))
        throw new MemoryError(400, "invalid_bundle", "Duplicate or mismatched record version");
      seen.add(v.version);
      // Unknown legacy attributes stay NULL, never reconstructed as known history.
      const attrs = version.attributes === null ? null : object(version.attributes);
      if (attrs && Object.keys(attrs).some((key) => !ATTRIBUTE_KEYS.has(key)))
        throw new MemoryError(400, "invalid_bundle", "Unknown revision attribute");
      if (attrs?.vocabulary_version !== undefined)
        integer(attrs.vocabulary_version, "vocabulary_version", 0, Number.MAX_SAFE_INTEGER);
      const input = recordInput({
        ...attrs,
        content: v.content,
        type: v.type,
        tier: v.tier,
        importance: v.importance,
        subject: attrs?.subject ?? (attrs === null ? (v.subject ?? undefined) : undefined),
        metadata: attrs?.metadata ?? (attrs === null ? v.metadata : undefined),
        dependency_versions: undefined,
      });
      if (attrs && (input.subject ?? null) !== (attrs.subject ?? null))
        throw new MemoryError(400, "invalid_bundle", "Claim and subject disagree");
      const note = createNote(db, `memory:${actor.principalId}`, v.content, undefined, {
        noteType: input.type,
        tier: input.tier,
        importance: input.importance,
        skipDedup: true,
      });
      db.run("UPDATE notes SET created_at=?,verification_status=? WHERE id=?", [
        v.created_at,
        v.version === r.version ? "unverified" : "superseded",
        note,
      ]);
      db.run(
        "INSERT INTO memory_record_versions(record_id,version,note_id,attributes) VALUES (?,?,?,?)",
        [r.id, v.version, note, attrs === null ? null : JSON.stringify(attrs)],
      );
      if (v.version === r.version) {
        dependencies.set(r.id, input.depends_on ?? []);
        head = note;
        db.run(
          "UPDATE memory_records SET current_note_id=?,subject=?,metadata=?,valid_from=?,valid_until=? WHERE id=?",
          [
            head,
            input.subject ?? null,
            JSON.stringify(input.metadata ?? {}),
            input.valid_time?.from ?? null,
            input.valid_time?.until ?? null,
            r.id,
          ],
        );
        if (input.claim)
          db.run("INSERT INTO memory_claims VALUES (?,?,?,?,?,?)", [
            r.id,
            space,
            input.claim.subject,
            input.claim.predicate,
            canonical(input.claim.object),
            input.claim.object.kind === "entity" ? input.claim.object.id : null,
          ]);
      }
    }
    if (!head) throw new MemoryError(400, "invalid_bundle", "Current revision is absent");
  }
  for (const r of payload.records)
    for (const version of r.versions) {
      const attrs = version.attributes;
      if (!attrs) continue;
      const sources = (attrs.source_ids ?? []) as string[],
        parents = (attrs.depends_on ?? []) as string[];
      const pins = attrs.dependency_versions === undefined ? {} : object(attrs.dependency_versions);
      if (Object.keys(pins).some((id) => !parents.includes(id)))
        throw new MemoryError(400, "invalid_bundle", "Unexpected dependency pin");
      for (const id of sources) {
        if (!sourceIds.has(id))
          throw new MemoryError(400, "invalid_bundle", "Missing source lineage");
        db.run("INSERT OR IGNORE INTO memory_derivations VALUES (?,?)", [r.id, id]);
      }
      for (const id of parents) {
        if (id === r.id || !recordIds.has(id))
          throw new MemoryError(400, "invalid_bundle", "Missing or self-referential dependency");
        const pin = pins[id] ?? null;
        if (
          pin !== null &&
          !db
            .query("SELECT 1 FROM memory_record_versions WHERE record_id=? AND version=?")
            .get(id, integer(pin, "dependency version", 1, Number.MAX_SAFE_INTEGER))
        )
          throw new MemoryError(400, "invalid_bundle", "Missing premise revision");
        db.run("INSERT OR IGNORE INTO memory_dependencies VALUES (?,?)", [r.id, id]);
        db.run("INSERT INTO memory_revision_dependencies VALUES (?,?,?,?)", [
          r.id,
          version.record.version,
          id,
          pin as number | null,
        ]);
      }
    }
  // Validate the current dependency DAG in linear space/time. Historical
  // dependencies may differ; they remain inspectable without governing the head.
  const visited = new Set<string>(),
    active = new Set<string>();
  for (const root of dependencies.keys()) {
    const stack: { id: string; exit: boolean }[] = [{ id: root, exit: false }];
    while (stack.length) {
      const next = stack.pop()!;
      if (next.exit) {
        active.delete(next.id);
        visited.add(next.id);
        continue;
      }
      if (active.has(next.id))
        throw new MemoryError(400, "invalid_bundle", "Cyclic current dependencies");
      if (visited.has(next.id)) continue;
      active.add(next.id);
      stack.push({ id: next.id, exit: true });
      for (const parent of dependencies.get(next.id) ?? []) stack.push({ id: parent, exit: false });
    }
  }
  // Never import an apparently current conclusion whose declared basis disagrees.
  db.run(
    `UPDATE memory_records SET stale=1,stale_reason='{"kind":"import_requires_review"}' WHERE space_id=? AND EXISTS (
      SELECT 1 FROM memory_revision_dependencies d JOIN memory_records p ON p.id=d.depends_on_id WHERE d.record_id=memory_records.id AND d.record_version=memory_records.version AND (d.depends_on_version IS NULL OR d.depends_on_version!=p.version OR p.stale=1))`,
    [space],
  );
  // DFS completion order places premises before conclusions. Propagate once,
  // avoiding a whole-space SQL scan for every level of a long dependency chain.
  const stale = new Set(
    (
      db.query("SELECT id FROM memory_records WHERE space_id=? AND stale=1").all(space) as {
        id: string;
      }[]
    ).map((row) => row.id),
  );
  const markStale = db.query(
    `UPDATE memory_records SET stale=1,stale_reason='{"kind":"import_requires_review"}' WHERE id=? AND space_id=?`,
  );
  for (const id of visited)
    if (!stale.has(id) && (dependencies.get(id) ?? []).some((parent) => stale.has(parent))) {
      markStale.run(id, space);
      stale.add(id);
    }
  const vocabularyVersions = new Set<number>([0]);
  for (const v of payload.vocabularies) {
    integer(v.version, "vocabulary version", 1, Number.MAX_SAFE_INTEGER);
    if (vocabularyVersions.has(v.version))
      throw new MemoryError(400, "invalid_bundle", "Duplicate vocabulary version");
    vocabularyVersions.add(v.version);
    definitionInput(JSON.parse(v.definition));
    db.run("INSERT INTO memory_vocabularies VALUES (?,?,?,?)", [
      space,
      v.version,
      v.definition,
      integer(v.created_at, "created_at", 0, Number.MAX_SAFE_INTEGER),
    ]);
  }
  for (const r of payload.records) {
    for (const version of r.versions) {
      const vocabulary = version.attributes?.vocabulary_version;
      if (vocabulary !== undefined && !vocabularyVersions.has(vocabulary as number))
        throw new MemoryError(400, "invalid_bundle", "Historical vocabulary version is absent");
    }
    const current = readMemoryRecord(db, actor, space, r.id);
    if (current.freshness !== "stale")
      validateMemoryContract(
        db,
        actor,
        space,
        { content: current.content, claim: current.claim, valid_time: current.valid_time },
        r.id,
      );
  }
  for (const c of payload.checkpoints) {
    textValue(c.name, "checkpoint name", 128);
    object(JSON.parse(c.data));
    const cursor = c.source_cursor === 0 ? 0 : cursors.get(c.source_cursor);
    if (cursor === undefined)
      throw new MemoryError(400, "invalid_bundle", "Checkpoint cursor has no source");
    db.run("INSERT INTO memory_checkpoints VALUES (?,?,?,?,?,?)", [
      space,
      c.name,
      integer(c.version, "checkpoint version", 1, Number.MAX_SAFE_INTEGER),
      cursor,
      c.data,
      integer(c.updated_at, "updated_at", 0, Number.MAX_SAFE_INTEGER),
    ]);
  }
  return {
    origin_space: payload.origin_space,
    sources: sourceIds.size,
    records: recordIds.size,
    portable_ids_preserved: true,
    excluded: ["credentials", "grants", "receipts", "indexes", "cached_results"],
  };
}
