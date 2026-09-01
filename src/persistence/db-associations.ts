// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  type FederationSignature,
  federationSigningAvailable,
  signFederationDocument,
  verifyFederationDocument,
} from "../net/federation-crypto";

export const ASSOCIATION_EVENT_KINDS = [
  "created",
  "joined",
  "left",
  "terms_changed",
  "observed",
  "branched",
  "dissolved",
  "continued",
  "descendant_created",
] as const;
export type AssociationEventKind = (typeof ASSOCIATION_EVENT_KINDS)[number];

export const ASSOCIATION_DIRECTIONS = ["directed", "reciprocal"] as const;
export type AssociationDirection = (typeof ASSOCIATION_DIRECTIONS)[number];

export interface AssociationRow {
  id: string;
  name: string;
  purpose: string;
  created_by: string;
  created_at: number;
}

export interface AssociationEventRow {
  id: string;
  association_id: string;
  kind: AssociationEventKind;
  actor_id: string;
  subject_kind: string | null;
  subject_ref: string | null;
  data_json: string;
  signature_json: string | null;
  created_at: number;
}

export interface AssociationRelationRow {
  id: string;
  association_id: string;
  source_kind: string;
  source_ref: string;
  target_kind: string;
  target_ref: string;
  semantics: string;
  direction: AssociationDirection;
  terms_json: string;
  supersedes_id: string | null;
  actor_id: string;
  signature_json: string | null;
  created_at: number;
}

export interface AssociationLinkRow {
  id: string;
  association_id: string;
  kind: string;
  ref: string;
  relationship: string;
  actor_id: string;
  metadata_json: string;
  signature_json: string | null;
  created_at: number;
}

export interface AssociationParticipant {
  kind: string;
  ref: string;
  active: boolean;
  role: string | null;
  lastEventId: string;
  lastChangedAt: number;
}

export interface AssociationProjection {
  active: boolean;
  participants: AssociationParticipant[];
  relations: AssociationRelationRow[];
}

export function createAssociation(
  db: Database,
  input: { name: string; purpose?: string; createdBy: string; id?: string; createdAt?: number },
): AssociationRow {
  const row: AssociationRow = {
    id: input.id ?? `association_${randomUUID().slice(0, 16)}`,
    name: input.name,
    purpose: input.purpose ?? "",
    created_by: input.createdBy,
    created_at: input.createdAt ?? Date.now(),
  };
  const create = db.transaction(() => {
    db.run(
      `INSERT INTO associations (id, name, purpose, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [row.id, row.name, row.purpose, row.created_by, row.created_at],
    );
    appendAssociationEvent(db, {
      associationId: row.id,
      kind: "created",
      actorId: row.created_by,
      data: { name: row.name, purpose: row.purpose },
      createdAt: row.created_at,
    });
  });
  create();
  return row;
}

export function getAssociation(db: Database, id: string): AssociationRow | undefined {
  return (
    (db.query("SELECT * FROM associations WHERE id = ?").get(id) as AssociationRow | null) ??
    undefined
  );
}

export function listAssociations(db: Database, limit = 100): AssociationRow[] {
  return db
    .query("SELECT * FROM associations ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(Math.max(1, Math.min(limit, 500))) as AssociationRow[];
}

export function appendAssociationEvent(
  db: Database,
  input: {
    associationId: string;
    kind: AssociationEventKind;
    actorId: string;
    subjectKind?: string;
    subjectRef?: string;
    data?: Record<string, unknown>;
    id?: string;
    createdAt?: number;
  },
): AssociationEventRow {
  const row = {
    id: input.id ?? `association_event_${randomUUID().slice(0, 16)}`,
    associationId: input.associationId,
    kind: input.kind,
    actorId: input.actorId,
    subjectKind: input.subjectKind ?? null,
    subjectRef: input.subjectRef ?? null,
    data: input.data ?? {},
    createdAt: input.createdAt ?? Date.now(),
  };
  const signature = signRecord("marina.association.event.v1", row);
  db.run(
    `INSERT INTO association_events
     (id, association_id, kind, actor_id, subject_kind, subject_ref, data_json,
      signature_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.associationId,
      row.kind,
      row.actorId,
      row.subjectKind,
      row.subjectRef,
      JSON.stringify(row.data),
      signature,
      row.createdAt,
    ],
  );
  return db
    .query("SELECT * FROM association_events WHERE id = ?")
    .get(row.id) as AssociationEventRow;
}

export function listAssociationEvents(db: Database, associationId: string): AssociationEventRow[] {
  return db
    .query("SELECT * FROM association_events WHERE association_id = ? ORDER BY created_at, rowid")
    .all(associationId) as AssociationEventRow[];
}

export function declareAssociationRelation(
  db: Database,
  input: {
    associationId: string;
    sourceKind: string;
    sourceRef: string;
    targetKind: string;
    targetRef: string;
    semantics: string;
    direction: AssociationDirection;
    terms?: Record<string, unknown>;
    supersedesId?: string;
    actorId: string;
    id?: string;
    createdAt?: number;
  },
): AssociationRelationRow {
  if (input.supersedesId) {
    const prior = db
      .query("SELECT association_id FROM association_relations WHERE id = ?")
      .get(input.supersedesId) as { association_id: string } | null;
    if (!prior || prior.association_id !== input.associationId) {
      throw new Error("A relation may supersede only a relation in the same association");
    }
  }
  const row = {
    id: input.id ?? `association_relation_${randomUUID().slice(0, 16)}`,
    associationId: input.associationId,
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    targetKind: input.targetKind,
    targetRef: input.targetRef,
    semantics: input.semantics,
    direction: input.direction,
    terms: input.terms ?? {},
    supersedesId: input.supersedesId ?? null,
    actorId: input.actorId,
    createdAt: input.createdAt ?? Date.now(),
  };
  const signature = signRecord("marina.association.relation.v1", row);
  db.run(
    `INSERT INTO association_relations
     (id, association_id, source_kind, source_ref, target_kind, target_ref, semantics,
      direction, terms_json, supersedes_id, actor_id, signature_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.associationId,
      row.sourceKind,
      row.sourceRef,
      row.targetKind,
      row.targetRef,
      row.semantics,
      row.direction,
      JSON.stringify(row.terms),
      row.supersedesId,
      row.actorId,
      signature,
      row.createdAt,
    ],
  );
  return db
    .query("SELECT * FROM association_relations WHERE id = ?")
    .get(row.id) as AssociationRelationRow;
}

export function listAssociationRelations(
  db: Database,
  associationId: string,
): AssociationRelationRow[] {
  return db
    .query(
      "SELECT * FROM association_relations WHERE association_id = ? ORDER BY created_at, rowid",
    )
    .all(associationId) as AssociationRelationRow[];
}

export function linkAssociation(
  db: Database,
  input: {
    associationId: string;
    kind: string;
    ref: string;
    relationship: string;
    actorId: string;
    metadata?: Record<string, unknown>;
    id?: string;
    createdAt?: number;
  },
): AssociationLinkRow {
  const row = {
    id: input.id ?? `association_link_${randomUUID().slice(0, 16)}`,
    associationId: input.associationId,
    kind: input.kind,
    ref: input.ref,
    relationship: input.relationship,
    actorId: input.actorId,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? Date.now(),
  };
  const signature = signRecord("marina.association.link.v1", row);
  db.run(
    `INSERT INTO association_links
     (id, association_id, kind, ref, relationship, actor_id, metadata_json,
      signature_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.associationId,
      row.kind,
      row.ref,
      row.relationship,
      row.actorId,
      JSON.stringify(row.metadata),
      signature,
      row.createdAt,
    ],
  );
  return db.query("SELECT * FROM association_links WHERE id = ?").get(row.id) as AssociationLinkRow;
}

export function listAssociationLinks(db: Database, associationId: string): AssociationLinkRow[] {
  return db
    .query("SELECT * FROM association_links WHERE association_id = ? ORDER BY created_at, rowid")
    .all(associationId) as AssociationLinkRow[];
}

export function projectAssociation(
  events: AssociationEventRow[],
  relations: AssociationRelationRow[],
): AssociationProjection {
  const participants = new Map<string, AssociationParticipant>();
  let active = true;
  for (const event of events) {
    if (event.kind === "dissolved") active = false;
    if (event.kind === "continued") active = true;
    if (
      (event.kind !== "joined" && event.kind !== "left") ||
      !event.subject_kind ||
      !event.subject_ref
    )
      continue;
    let role: string | null = null;
    if (event.kind === "joined") {
      try {
        const data = JSON.parse(event.data_json) as { role?: unknown };
        if (typeof data.role === "string" && data.role.trim()) role = data.role;
      } catch {}
    }
    const key = `${event.subject_kind}\u0000${event.subject_ref}`;
    participants.set(key, {
      kind: event.subject_kind,
      ref: event.subject_ref,
      active: event.kind === "joined",
      role: event.kind === "joined" ? role : (participants.get(key)?.role ?? null),
      lastEventId: event.id,
      lastChangedAt: event.created_at,
    });
  }
  const superseded = new Set(
    relations.map((relation) => relation.supersedes_id).filter((id): id is string => Boolean(id)),
  );
  return {
    active,
    participants: [...participants.values()],
    relations: relations.filter((relation) => !superseded.has(relation.id)),
  };
}

export function verifyAssociationEvent(row: AssociationEventRow) {
  try {
    return verifyRecord(
      "marina.association.event.v1",
      {
        id: row.id,
        associationId: row.association_id,
        kind: row.kind,
        actorId: row.actor_id,
        subjectKind: row.subject_kind,
        subjectRef: row.subject_ref,
        data: JSON.parse(row.data_json),
        createdAt: row.created_at,
      },
      row.signature_json,
    );
  } catch {
    return { valid: false, keyId: null, error: "Malformed association event" };
  }
}

export function verifyAssociationRelation(row: AssociationRelationRow) {
  try {
    return verifyRecord(
      "marina.association.relation.v1",
      {
        id: row.id,
        associationId: row.association_id,
        sourceKind: row.source_kind,
        sourceRef: row.source_ref,
        targetKind: row.target_kind,
        targetRef: row.target_ref,
        semantics: row.semantics,
        direction: row.direction,
        terms: JSON.parse(row.terms_json),
        supersedesId: row.supersedes_id,
        actorId: row.actor_id,
        createdAt: row.created_at,
      },
      row.signature_json,
    );
  } catch {
    return { valid: false, keyId: null, error: "Malformed association relation" };
  }
}

export function verifyAssociationLink(row: AssociationLinkRow) {
  try {
    return verifyRecord(
      "marina.association.link.v1",
      {
        id: row.id,
        associationId: row.association_id,
        kind: row.kind,
        ref: row.ref,
        relationship: row.relationship,
        actorId: row.actor_id,
        metadata: JSON.parse(row.metadata_json),
        createdAt: row.created_at,
      },
      row.signature_json,
    );
  } catch {
    return { valid: false, keyId: null, error: "Malformed association link" };
  }
}

function signRecord(schema: string, record: Record<string, unknown>): string | null {
  if (!federationSigningAvailable()) return null;
  return JSON.stringify(signFederationDocument({ schema, ...record }).signature);
}

function verifyRecord(
  schema: string,
  record: Record<string, unknown>,
  signatureJson: string | null,
): { valid: boolean; keyId: string | null; error?: string } {
  if (!signatureJson) return { valid: false, keyId: null, error: "Record is unsigned" };
  try {
    return verifyFederationDocument({
      schema,
      ...record,
      signature: JSON.parse(signatureJson) as FederationSignature,
    });
  } catch {
    return { valid: false, keyId: null, error: "Malformed association record" };
  }
}
