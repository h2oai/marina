// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  canonicalFederationJson,
  federationSigningAvailable,
  signFederationDocument,
  verifyFederationDocument,
} from "../net/federation-crypto";

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
    Object.values(row),
  );
  return row;
}
export function getMesh(db: Database, id: string): MeshRow | undefined {
  return (db.query("SELECT * FROM meshes WHERE id=?").get(id) as MeshRow | null) ?? undefined;
}
export function listMeshes(db: Database): MeshRow[] {
  return db.query("SELECT * FROM meshes ORDER BY created_at DESC,id").all() as MeshRow[];
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
    "INSERT INTO mesh_membership_events (id,mesh_id,world_id,kind,visibility_from,disclosure_json,actor_id,signature_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
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
    .query("SELECT * FROM mesh_membership_events WHERE mesh_id=? ORDER BY created_at,id")
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
export function listMeshEvents(db: Database, meshId: string): MeshEventRow[] {
  return db
    .query("SELECT * FROM mesh_events WHERE mesh_id=? ORDER BY created_at,id")
    .all(meshId) as MeshEventRow[];
}

export function exportMeshEvent(row: MeshEventRow): string {
  return Buffer.from(
    JSON.stringify({
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
      signature: row.signature_json ? JSON.parse(row.signature_json) : null,
    }),
  ).toString("base64url");
}

export function importMeshEvent(db: Database, token: string): MeshEventRow {
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
  const { contentHash, signature, ...content } = document;
  const expected = `sha256:${createHash("sha256").update(canonicalFederationJson(content)).digest("hex")}`;
  if (contentHash !== expected) throw new Error("Mesh event content hash does not verify.");
  if (signature && !verifyFederationDocument(document).valid)
    throw new Error("Mesh event signature does not verify.");
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
export function listMeshWitnesses(db: Database, meshId: string): MeshWitnessRow[] {
  return db
    .query("SELECT * FROM mesh_witnesses WHERE mesh_id=? ORDER BY created_at,id")
    .all(meshId) as MeshWitnessRow[];
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

function sign(document: Record<string, unknown>): string | null {
  return federationSigningAvailable()
    ? JSON.stringify(signFederationDocument(document).signature)
    : null;
}
