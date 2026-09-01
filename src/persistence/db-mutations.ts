// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  federationSigningAvailable,
  signFederationDocument,
  verifyFederationDocument,
} from "../net/federation-crypto";
export type MutationDisposition = "proposed" | "adopted" | "rejected" | "branched" | "observed";
export interface CivilizationMutationRow {
  id: string;
  domain: string;
  target_ref: string;
  summary: string;
  patch_json: string;
  parent_ids_json: string;
  evidence_refs_json: string;
  descendant_ref: string | null;
  disposition: MutationDisposition;
  created_by: string;
  signature_json: string | null;
  created_at: number;
}
export function appendCivilizationMutation(
  db: Database,
  input: {
    domain: string;
    targetRef: string;
    summary: string;
    patch: Record<string, unknown>;
    parentIds?: string[];
    evidenceRefs?: string[];
    descendantRef?: string;
    disposition: MutationDisposition;
    createdBy: string;
    id?: string;
    createdAt?: number;
  },
): CivilizationMutationRow {
  const id = input.id ?? `mutation_${randomUUID().slice(0, 16)}`;
  const parentIds = [...new Set(input.parentIds ?? [])];
  if (parentIds.length !== (input.parentIds ?? []).length) {
    throw new Error("Mutation parent ids must be unique");
  }
  if (parentIds.includes(id)) throw new Error("A mutation cannot be its own parent");
  for (const parentId of parentIds) {
    if (!getCivilizationMutation(db, parentId)) {
      throw new Error(`Parent mutation does not exist: ${parentId}`);
    }
  }
  const document = {
    schema: "marina.civilization.mutation.v1",
    id,
    domain: input.domain,
    targetRef: input.targetRef,
    summary: input.summary,
    patch: input.patch,
    parentIds,
    evidenceRefs: input.evidenceRefs ?? [],
    descendantRef: input.descendantRef ?? null,
    disposition: input.disposition,
    createdBy: input.createdBy,
    createdAt: input.createdAt ?? Date.now(),
  };
  const signature = federationSigningAvailable()
    ? JSON.stringify(signFederationDocument(document).signature)
    : null;
  db.run(
    "INSERT INTO civilization_mutations (id,domain,target_ref,summary,patch_json,parent_ids_json,evidence_refs_json,descendant_ref,disposition,created_by,signature_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      document.id,
      document.domain,
      document.targetRef,
      document.summary,
      JSON.stringify(document.patch),
      JSON.stringify(document.parentIds),
      JSON.stringify(document.evidenceRefs),
      document.descendantRef,
      document.disposition,
      document.createdBy,
      signature,
      document.createdAt,
    ],
  );
  return db
    .query("SELECT * FROM civilization_mutations WHERE id=?")
    .get(document.id) as CivilizationMutationRow;
}
export function getCivilizationMutation(
  db: Database,
  id: string,
): CivilizationMutationRow | undefined {
  return (
    (db
      .query("SELECT * FROM civilization_mutations WHERE id=?")
      .get(id) as CivilizationMutationRow | null) ?? undefined
  );
}
export function listCivilizationMutations(
  db: Database,
  domain?: string,
  targetRef?: string,
): CivilizationMutationRow[] {
  if (domain && targetRef)
    return db
      .query(
        "SELECT * FROM civilization_mutations WHERE domain=? AND target_ref=? ORDER BY created_at,rowid",
      )
      .all(domain, targetRef) as CivilizationMutationRow[];
  if (domain)
    return db
      .query("SELECT * FROM civilization_mutations WHERE domain=? ORDER BY created_at DESC,id")
      .all(domain) as CivilizationMutationRow[];
  return db
    .query("SELECT * FROM civilization_mutations ORDER BY created_at DESC,id")
    .all() as CivilizationMutationRow[];
}
export function verifyCivilizationMutation(row: CivilizationMutationRow) {
  if (!row.signature_json) return { valid: false, keyId: null, error: "Mutation is unsigned" };
  try {
    return verifyFederationDocument({
      schema: "marina.civilization.mutation.v1",
      id: row.id,
      domain: row.domain,
      targetRef: row.target_ref,
      summary: row.summary,
      patch: JSON.parse(row.patch_json),
      parentIds: JSON.parse(row.parent_ids_json),
      evidenceRefs: JSON.parse(row.evidence_refs_json),
      descendantRef: row.descendant_ref,
      disposition: row.disposition,
      createdBy: row.created_by,
      createdAt: row.created_at,
      signature: JSON.parse(row.signature_json),
    });
  } catch {
    return { valid: false, keyId: null, error: "Malformed mutation" };
  }
}
