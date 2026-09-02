// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalFederationJson,
  signDocumentJson as sign,
  verifyFederationDocument,
} from "../net/federation-crypto";
import { escapeLike } from "./fts";

export interface MeshRow {
  id: string;
  name: string;
  charter_ref: string;
  protocol: string;
  created_by: string;
  created_at: number;
}
export interface MeshMembershipEventRow {
  id: string;
  mesh_id: string;
  world_id: string;
  kind: "joined" | "left" | "rejoined" | "observed_silent";
  visibility_from: number;
  disclosure_json: string;
  actor_id: string;
  signature_json: string | null;
  created_at: number;
  /** Monotonic insertion order (migration 94) — `.at(-1)` latest-membership reads depend on it. */
  seq: number;
}
export interface MeshEventRow {
  id: string;
  mesh_id: string;
  origin_world_id: string;
  sequence: number;
  kind: string;
  payload_json: string;
  parent_ids_json: string;
  content_hash: string;
  signature_json: string | null;
  created_at: number;
}
export interface MeshWitnessRow {
  id: string;
  mesh_id: string;
  event_id: string;
  witness_world_id: string;
  observation: "witnessed" | "replicated" | "disputed" | "unavailable";
  signature_json: string | null;
  created_at: number;
}
export interface MeshTranslationRow {
  id: string;
  source_mesh_id: string;
  target_mesh_id: string;
  translator_ref: string;
  protocol_map_json: string;
  actor_id: string;
  signature_json: string | null;
  created_at: number;
}

export function createMesh(
  db: Database,
  input: { name: string; charterRef: string; protocol: string; createdBy: string; id?: string },
): MeshRow {
  const row = {
    id: input.id ?? `mesh_${randomUUID().slice(0, 16)}`,
    name: input.name,
    charter_ref: input.charterRef,
    protocol: input.protocol,
    created_by: input.createdBy,
    created_at: Date.now(),
  };
  db.run(
    "INSERT INTO meshes (id,name,charter_ref,protocol,created_by,created_at) VALUES (?,?,?,?,?,?)",
    [row.id, row.name, row.charter_ref, row.protocol, row.created_by, row.created_at],
  );
  return row;
}
export function getMesh(db: Database, id: string): MeshRow | undefined {
  return (db.query("SELECT * FROM meshes WHERE id=?").get(id) as MeshRow | null) ?? undefined;
}
export function listMeshes(db: Database, limit = 200): MeshRow[] {
  return db
    .query("SELECT * FROM meshes ORDER BY created_at DESC,id LIMIT ?")
    .all(Math.max(1, Math.min(limit, 1000))) as MeshRow[];
}

/**
 * Bounded selector resolution over the WHOLE table (a capped list scan would
 * silently miss older rows). Returns up to 2 rows: 1 = unambiguous.
 */
export function findMeshesBySelector(db: Database, selector: string): MeshRow[] {
  const prefix = `${escapeLike(selector)}%`;
  return db
    .query("SELECT * FROM meshes WHERE id LIKE ? ESCAPE '\\' OR name = ? COLLATE NOCASE LIMIT 2")
    .all(prefix, selector) as MeshRow[];
}

export function appendMeshMembershipEvent(
  db: Database,
  input: {
    meshId: string;
    worldId: string;
    kind: MeshMembershipEventRow["kind"];
    visibilityFrom?: number;
    disclosure?: Record<string, unknown>;
    actorId: string;
    id?: string;
    createdAt?: number;
  },
): MeshMembershipEventRow {
  const row = {
    id: input.id ?? `membership_${randomUUID().slice(0, 16)}`,
    meshId: input.meshId,
    worldId: input.worldId,
    kind: input.kind,
    visibilityFrom: input.visibilityFrom ?? Date.now(),
    disclosure: input.disclosure ?? {},
    actorId: input.actorId,
    createdAt: input.createdAt ?? Date.now(),
  };
  const signature = sign({ schema: "marina.mesh.membership.v1", ...row });
  db.run(
    "INSERT INTO mesh_membership_events (id,mesh_id,world_id,kind,visibility_from,disclosure_json,actor_id,signature_json,created_at,seq) VALUES (?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM mesh_membership_events))",
    [
      row.id,
      row.meshId,
      row.worldId,
      row.kind,
      row.visibilityFrom,
      JSON.stringify(row.disclosure),
      row.actorId,
      signature,
      row.createdAt,
    ],
  );
  return db
    .query("SELECT * FROM mesh_membership_events WHERE id=?")
    .get(row.id) as MeshMembershipEventRow;
}
export function listMeshMembershipEvents(db: Database, meshId: string): MeshMembershipEventRow[] {
  return db
    .query("SELECT * FROM mesh_membership_events WHERE mesh_id=? ORDER BY seq")
    .all(meshId) as MeshMembershipEventRow[];
}

export function appendMeshEvent(
  db: Database,
  input: {
    meshId: string;
    originWorldId: string;
    kind: string;
    payload: Record<string, unknown>;
    parentIds?: string[];
    id?: string;
    createdAt?: number;
    signature?: unknown;
  },
): MeshEventRow {
  const sequence =
    ((
      db
        .query("SELECT MAX(sequence) AS n FROM mesh_events WHERE mesh_id=? AND origin_world_id=?")
        .get(input.meshId, input.originWorldId) as { n: number | null }
    ).n ?? 0) + 1;
  const createdAt = input.createdAt ?? Date.now();
  const content = {
    schema: "marina.mesh.event.v1",
    id: input.id ?? `mesh_event_${randomUUID().slice(0, 16)}`,
    meshId: input.meshId,
    originWorldId: input.originWorldId,
    sequence,
    kind: input.kind,
    payload: input.payload,
    parentIds: input.parentIds ?? [],
    createdAt,
  };
  const contentHash = `sha256:${createHash("sha256").update(canonicalFederationJson(content)).digest("hex")}`;
  const signature = input.signature
    ? JSON.stringify(input.signature)
    : sign({ ...content, contentHash });
  db.run(
    "INSERT INTO mesh_events (id,mesh_id,origin_world_id,sequence,kind,payload_json,parent_ids_json,content_hash,signature_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      content.id,
      input.meshId,
      input.originWorldId,
      sequence,
      input.kind,
      JSON.stringify(input.payload),
      JSON.stringify(input.parentIds ?? []),
      contentHash,
      signature,
      createdAt,
    ],
  );
  return db.query("SELECT * FROM mesh_events WHERE id=?").get(content.id) as MeshEventRow;
}
export function listMeshEvents(db: Database, meshId: string, limit = 500): MeshEventRow[] {
  return db
    .query("SELECT * FROM mesh_events WHERE mesh_id=? ORDER BY created_at DESC,id DESC LIMIT ?")
    .all(meshId, Math.max(1, Math.min(limit, 2000)))
    .reverse() as MeshEventRow[];
}
export function getMeshEvent(db: Database, id: string): MeshEventRow | undefined {
  return (
    (db.query("SELECT * FROM mesh_events WHERE id=?").get(id) as MeshEventRow | null) ?? undefined
  );
}
export function countMeshEvents(db: Database, meshId: string): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM mesh_events WHERE mesh_id=?").get(meshId) as { n: number }
  ).n;
}

export function exportMeshEvent(row: MeshEventRow): string {
  let payload: unknown;
  let parentIds: unknown;
  let signature: unknown;
  try {
    payload = JSON.parse(row.payload_json);
    parentIds = JSON.parse(row.parent_ids_json);
    signature = row.signature_json ? JSON.parse(row.signature_json) : null;
  } catch {
    // A corrupt row cannot be exported faithfully — its content hash would no
    // longer verify on the receiving side anyway.
    throw new Error(`Mesh event ${row.id} has malformed stored JSON and cannot be exported.`);
  }
  return Buffer.from(
    JSON.stringify({
      schema: "marina.mesh.event.v1",
      id: row.id,
      meshId: row.mesh_id,
      originWorldId: row.origin_world_id,
      sequence: row.sequence,
      kind: row.kind,
      payload,
      parentIds,
      createdAt: row.created_at,
      contentHash: row.content_hash,
      signature,
    }),
  ).toString("base64url");
}

export function importMeshEvent(
  db: Database,
  token: string,
  opts?: { expectedMeshId?: string },
): MeshEventRow {
  if (!token || token.length > 100_000)
    throw new Error("Mesh event token is invalid or too large.");
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new Error("Mesh event token is not valid base64url JSON.");
  }
  if (
    document.schema !== "marina.mesh.event.v1" ||
    typeof document.id !== "string" ||
    typeof document.meshId !== "string" ||
    typeof document.originWorldId !== "string" ||
    typeof document.sequence !== "number" ||
    typeof document.kind !== "string" ||
    !document.payload ||
    typeof document.payload !== "object" ||
    !Array.isArray(document.parentIds) ||
    typeof document.createdAt !== "number" ||
    typeof document.contentHash !== "string"
  )
    throw new Error("Mesh event document is invalid.");
  // Every rejection below happens BEFORE the insert — a refused replication
  // must leave no row behind.
  if (opts?.expectedMeshId && document.meshId !== opts.expectedMeshId)
    throw new Error("Event belongs to another mesh.");
  const { contentHash, signature, ...content } = document;
  const expected = `sha256:${createHash("sha256").update(canonicalFederationJson(content)).digest("hex")}`;
  if (contentHash !== expected) throw new Error("Mesh event content hash does not verify.");
  // Trust anchor: originWorldId is attacker-supplied. A blocked peer is always
  // refused; a peer with a pinned public key must sign with exactly that key.
  const peer = db
    .query("SELECT public_key, trust_status FROM federation_peers WHERE world_id=?")
    .get(document.originWorldId) as { public_key: string | null; trust_status: string } | null;
  if (peer?.trust_status === "blocked")
    throw new Error("Origin world is blocked by operator trust policy.");
  if (!signature) {
    // Unsigned cross-world evidence is refused by default — otherwise any
    // logged-in entity can fabricate events attributed to any origin world.
    if (process.env.MARINA_FEDERATION_ALLOW_UNSIGNED !== "true")
      throw new Error(
        "Mesh event is unsigned. Signed replication is required (MARINA_FEDERATION_ALLOW_UNSIGNED=true accepts unsigned events on trusted networks).",
      );
  } else {
    const verification = verifyFederationDocument(document, {
      pinnedPublicKey: peer?.public_key,
    });
    if (!verification.valid)
      throw new Error(`Mesh event signature does not verify: ${verification.error ?? "invalid"}`);
  }
  const existing = db
    .query("SELECT * FROM mesh_events WHERE id=?")
    .get(document.id) as MeshEventRow | null;
  if (existing) {
    if (existing.content_hash !== contentHash)
      throw new Error("Mesh event id collides with different content.");
    return existing;
  }
  const inserted = db.run(
    "INSERT INTO mesh_events (id,mesh_id,origin_world_id,sequence,kind,payload_json,parent_ids_json,content_hash,signature_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      document.id,
      document.meshId,
      document.originWorldId,
      document.sequence,
      document.kind,
      JSON.stringify(document.payload),
      JSON.stringify(document.parentIds),
      contentHash,
      signature ? JSON.stringify(signature) : null,
      document.createdAt,
    ],
  );
  if (inserted.changes !== 1) throw new Error("Mesh event was not replicated.");
  return db.query("SELECT * FROM mesh_events WHERE id=?").get(document.id) as MeshEventRow;
}

export function witnessMeshEvent(
  db: Database,
  input: {
    meshId: string;
    eventId: string;
    witnessWorldId: string;
    observation: MeshWitnessRow["observation"];
    id?: string;
  },
): MeshWitnessRow {
  const createdAt = Date.now();
  const id = input.id ?? `witness_${randomUUID().slice(0, 16)}`;
  const signature = sign({ schema: "marina.mesh.witness.v1", id, ...input, createdAt });
  db.run(
    "INSERT INTO mesh_witnesses (id,mesh_id,event_id,witness_world_id,observation,signature_json,created_at) VALUES (?,?,?,?,?,?,?)",
    [
      id,
      input.meshId,
      input.eventId,
      input.witnessWorldId,
      input.observation,
      signature,
      createdAt,
    ],
  );
  return db.query("SELECT * FROM mesh_witnesses WHERE id=?").get(id) as MeshWitnessRow;
}
export function listMeshWitnesses(db: Database, meshId: string, limit = 500): MeshWitnessRow[] {
  return db
    .query("SELECT * FROM mesh_witnesses WHERE mesh_id=? ORDER BY created_at DESC,id DESC LIMIT ?")
    .all(meshId, Math.max(1, Math.min(limit, 2000)))
    .reverse() as MeshWitnessRow[];
}
export function countMeshWitnesses(db: Database, meshId: string): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM mesh_witnesses WHERE mesh_id=?").get(meshId) as {
      n: number;
    }
  ).n;
}

export function createMeshTranslation(
  db: Database,
  input: {
    sourceMeshId: string;
    targetMeshId: string;
    translatorRef: string;
    protocolMap: Record<string, unknown>;
    actorId: string;
    id?: string;
  },
): MeshTranslationRow {
  const createdAt = Date.now();
  const id = input.id ?? `translation_${randomUUID().slice(0, 16)}`;
  const signature = sign({ schema: "marina.mesh.translation.v1", id, ...input, createdAt });
  db.run(
    "INSERT INTO mesh_translations (id,source_mesh_id,target_mesh_id,translator_ref,protocol_map_json,actor_id,signature_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      id,
      input.sourceMeshId,
      input.targetMeshId,
      input.translatorRef,
      JSON.stringify(input.protocolMap),
      input.actorId,
      signature,
      createdAt,
    ],
  );
  return db.query("SELECT * FROM mesh_translations WHERE id=?").get(id) as MeshTranslationRow;
}
export function listMeshTranslations(db: Database, meshId: string): MeshTranslationRow[] {
  return db
    .query(
      "SELECT * FROM mesh_translations WHERE source_mesh_id=? OR target_mesh_id=? ORDER BY created_at,id",
    )
    .all(meshId, meshId) as MeshTranslationRow[];
}

export function verifyMeshEvent(row: MeshEventRow) {
  if (!row.signature_json) return { valid: false, keyId: null, error: "Event is unsigned" };
  try {
    return verifyFederationDocument({
      schema: "marina.mesh.event.v1",
      id: row.id,
      meshId: row.mesh_id,
      originWorldId: row.origin_world_id,
      sequence: row.sequence,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      parentIds: JSON.parse(row.parent_ids_json),
      createdAt: row.created_at,
      contentHash: row.content_hash,
      signature: JSON.parse(row.signature_json),
    });
  } catch {
    return { valid: false, keyId: null, error: "Malformed mesh event" };
  }
}
