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

export const INTELLECT_EVENT_KINDS = [
  "created",
  "instance_created",
  "component_changed",
  "continuity_claimed",
  "descended",
  "migrated",
  "dormant",
  "revived",
  "terminated",
  "last_observed",
] as const;
export type IntellectEventKind = (typeof INTELLECT_EVENT_KINDS)[number];

export interface IntellectRow {
  id: string;
  display_name: string;
  purpose: string;
  origin_marina: string;
  created_by: string;
  created_at: number;
}

export interface IntellectInstanceRow {
  id: string;
  intellect_id: string;
  local_principal_id: string | null;
  model_ref: string | null;
  harness_ref: string | null;
  environment_ref: string | null;
  created_by: string;
  created_at: number;
}

export interface IntellectEventRow {
  id: number;
  intellect_id: string;
  kind: IntellectEventKind;
  actor_id: string;
  instance_id: string | null;
  related_intellect_id: string | null;
  data_json: string;
  signature_json: string | null;
  created_at: number;
}

export function createIntellect(
  db: Database,
  input: {
    displayName: string;
    purpose?: string;
    originMarina: string;
    createdBy: string;
    contributors?: string[];
    id?: string;
  },
): IntellectRow {
  const row: IntellectRow = {
    id: input.id ?? `intellect_${randomUUID().slice(0, 16)}`,
    display_name: input.displayName,
    purpose: input.purpose ?? "",
    origin_marina: input.originMarina,
    created_by: input.createdBy,
    created_at: Date.now(),
  };
  const create = db.transaction(() => {
    db.run(
      `INSERT INTO intellects
       (id, display_name, purpose, origin_marina, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.display_name, row.purpose, row.origin_marina, row.created_by, row.created_at],
    );
    appendIntellectEvent(db, {
      intellectId: row.id,
      kind: "created",
      actorId: input.createdBy,
      data: {
        displayName: row.display_name,
        purpose: row.purpose,
        originMarina: row.origin_marina,
        contributors: input.contributors ?? [input.createdBy],
      },
      createdAt: row.created_at,
    });
  });
  create();
  return row;
}

export function getIntellect(db: Database, id: string): IntellectRow | undefined {
  return (
    (db.query("SELECT * FROM intellects WHERE id = ?").get(id) as IntellectRow | null) ?? undefined
  );
}

export function listIntellects(db: Database, limit = 100): IntellectRow[] {
  return db
    .query("SELECT * FROM intellects ORDER BY created_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(limit, 500))) as IntellectRow[];
}

/**
 * Bounded id-prefix resolution over the WHOLE table (a capped list scan would
 * silently miss older rows). Returns up to 2 rows: 1 = unambiguous.
 */
export function findIntellectsByIdPrefix(db: Database, selector: string): IntellectRow[] {
  const prefix = `${selector.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return db
    .query("SELECT * FROM intellects WHERE id LIKE ? ESCAPE '\\' LIMIT 2")
    .all(prefix) as IntellectRow[];
}

export function createIntellectInstance(
  db: Database,
  input: {
    intellectId: string;
    localPrincipalId?: string;
    modelRef?: string;
    harnessRef?: string;
    environmentRef?: string;
    createdBy: string;
    id?: string;
  },
): IntellectInstanceRow {
  const row: IntellectInstanceRow = {
    id: input.id ?? `instance_${randomUUID().slice(0, 16)}`,
    intellect_id: input.intellectId,
    local_principal_id: input.localPrincipalId ?? null,
    model_ref: input.modelRef ?? null,
    harness_ref: input.harnessRef ?? null,
    environment_ref: input.environmentRef ?? null,
    created_by: input.createdBy,
    created_at: Date.now(),
  };
  const create = db.transaction(() => {
    db.run(
      `INSERT INTO intellect_instances
       (id, intellect_id, local_principal_id, model_ref, harness_ref, environment_ref,
        created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.intellect_id,
        row.local_principal_id,
        row.model_ref,
        row.harness_ref,
        row.environment_ref,
        row.created_by,
        row.created_at,
      ],
    );
    appendIntellectEvent(db, {
      intellectId: row.intellect_id,
      kind: "instance_created",
      actorId: input.createdBy,
      instanceId: row.id,
      data: {
        localPrincipalId: row.local_principal_id,
        modelRef: row.model_ref,
        harnessRef: row.harness_ref,
        environmentRef: row.environment_ref,
      },
      createdAt: row.created_at,
    });
  });
  create();
  return row;
}

export function listIntellectInstances(db: Database, intellectId: string): IntellectInstanceRow[] {
  return db
    .query("SELECT * FROM intellect_instances WHERE intellect_id = ? ORDER BY created_at, id")
    .all(intellectId) as IntellectInstanceRow[];
}

export function appendIntellectEvent(
  db: Database,
  input: {
    intellectId: string;
    kind: IntellectEventKind;
    actorId: string;
    instanceId?: string;
    relatedIntellectId?: string;
    data?: Record<string, unknown>;
    createdAt?: number;
  },
): IntellectEventRow {
  const createdAt = input.createdAt ?? Date.now();
  // The signature binds the row's own id (assigned by the insert) so a valid
  // signature can't be replayed onto a different event row. Insert-then-sign
  // runs inside one transaction, mirroring db-economics.
  const append = db.transaction(() => {
    const result = db.run(
      `INSERT INTO intellect_events
       (intellect_id, kind, actor_id, instance_id, related_intellect_id, data_json,
        signature_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.intellectId,
        input.kind,
        input.actorId,
        input.instanceId ?? null,
        input.relatedIntellectId ?? null,
        JSON.stringify(input.data ?? {}),
        null,
        createdAt,
      ],
    );
    const id = Number(result.lastInsertRowid);
    if (federationSigningAvailable()) {
      const signature = signFederationDocument({
        schema: "marina.intellect.event.v1",
        id,
        intellectId: input.intellectId,
        kind: input.kind,
        actorId: input.actorId,
        instanceId: input.instanceId ?? null,
        relatedIntellectId: input.relatedIntellectId ?? null,
        data: input.data ?? {},
        createdAt,
      }).signature;
      db.run("UPDATE intellect_events SET signature_json = ? WHERE id = ?", [
        JSON.stringify(signature),
        id,
      ]);
    }
    return db.query("SELECT * FROM intellect_events WHERE id = ?").get(id) as IntellectEventRow;
  });
  return append();
}

export function listIntellectEvents(db: Database, intellectId: string): IntellectEventRow[] {
  return db
    .query("SELECT * FROM intellect_events WHERE intellect_id = ? ORDER BY created_at, id")
    .all(intellectId) as IntellectEventRow[];
}

export function verifyIntellectEvent(row: IntellectEventRow): {
  valid: boolean;
  keyId: string | null;
  error?: string;
} {
  if (!row.signature_json) return { valid: false, keyId: null, error: "Event is unsigned" };
  try {
    const document = {
      schema: "marina.intellect.event.v1",
      id: row.id,
      intellectId: row.intellect_id,
      kind: row.kind,
      actorId: row.actor_id,
      instanceId: row.instance_id,
      relatedIntellectId: row.related_intellect_id,
      data: JSON.parse(row.data_json),
      createdAt: row.created_at,
      signature: JSON.parse(row.signature_json) as FederationSignature,
    };
    return verifyFederationDocument(document);
  } catch {
    return { valid: false, keyId: null, error: "Malformed intellect event" };
  }
}
