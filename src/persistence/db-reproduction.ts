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

export type ComponentDisposition = "inherited" | "mutated" | "introduced" | "excluded";

export interface CognitiveReproductionRow {
  id: string;
  descendant_intellect_id: string;
  mode: string;
  parent_ids_json: string;
  contributors_json: string;
  hypothesis: string;
  evidence_refs_json: string;
  created_by: string;
  signature_json: string | null;
  created_at: number;
}

export interface CognitiveReproductionComponentRow {
  id: string;
  reproduction_id: string;
  kind: string;
  ref: string;
  disposition: ComponentDisposition;
  source_ref: string | null;
  metadata_json: string;
  created_at: number;
}

export interface MarinaGenomeRow {
  hash: string;
  schema: "marina.genome.v1";
  manifest_json: string;
  created_by: string;
  signature_json: string | null;
  created_at: number;
}

export interface MarinaDescendantRow {
  id: string;
  name: string;
  genome_hash: string;
  parent_world_ids_json: string;
  mode: string;
  hypothesis: string;
  inherited_state_refs_json: string;
  excluded_components_json: string;
  mutations_json: string;
  initial_habitat: string | null;
  world_variant_id: string | null;
  created_by: string;
  signature_json: string | null;
  created_at: number;
}

export function recordCognitiveReproduction(
  db: Database,
  input: {
    descendantIntellectId: string;
    mode: string;
    parentIds: string[];
    contributors: string[];
    hypothesis?: string;
    evidenceRefs?: string[];
    components: Array<{
      kind: string;
      ref: string;
      disposition: ComponentDisposition;
      sourceRef?: string;
      metadata?: Record<string, unknown>;
    }>;
    createdBy: string;
    id?: string;
    createdAt?: number;
  },
): CognitiveReproductionRow {
  const createdAt = input.createdAt ?? Date.now();
  const id = input.id ?? `reproduction_${randomUUID().slice(0, 16)}`;
  const document = {
    schema: "marina.cognitive-reproduction.v1",
    id,
    descendantIntellectId: input.descendantIntellectId,
    mode: input.mode,
    parentIds: input.parentIds,
    contributors: input.contributors,
    hypothesis: input.hypothesis ?? "",
    evidenceRefs: input.evidenceRefs ?? [],
    components: input.components,
    createdBy: input.createdBy,
    createdAt,
  };
  const signature = sign(document);
  db.transaction(() => {
    db.run(
      `INSERT INTO cognitive_reproductions
       (id,descendant_intellect_id,mode,parent_ids_json,contributors_json,hypothesis,
        evidence_refs_json,created_by,signature_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.descendantIntellectId,
        input.mode,
        JSON.stringify(input.parentIds),
        JSON.stringify(input.contributors),
        input.hypothesis ?? "",
        JSON.stringify(input.evidenceRefs ?? []),
        input.createdBy,
        signature,
        createdAt,
      ],
    );
    for (const component of input.components) {
      db.run(
        `INSERT INTO cognitive_reproduction_components
         (id,reproduction_id,kind,ref,disposition,source_ref,metadata_json,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          `component_${randomUUID().slice(0, 16)}`,
          id,
          component.kind,
          component.ref,
          component.disposition,
          component.sourceRef ?? null,
          JSON.stringify(component.metadata ?? {}),
          createdAt,
        ],
      );
    }
  })();
  return getCognitiveReproduction(db, id)!;
}

export function getCognitiveReproduction(
  db: Database,
  id: string,
): CognitiveReproductionRow | undefined {
  return (
    (db
      .query("SELECT * FROM cognitive_reproductions WHERE id=?")
      .get(id) as CognitiveReproductionRow | null) ?? undefined
  );
}

export function listCognitiveReproductions(db: Database): CognitiveReproductionRow[] {
  return db
    .query("SELECT * FROM cognitive_reproductions ORDER BY created_at DESC,id")
    .all() as CognitiveReproductionRow[];
}

export function listReproductionComponents(
  db: Database,
  reproductionId: string,
): CognitiveReproductionComponentRow[] {
  return db
    .query(
      "SELECT * FROM cognitive_reproduction_components WHERE reproduction_id=? ORDER BY created_at,id",
    )
    .all(reproductionId) as CognitiveReproductionComponentRow[];
}

export function createMarinaGenome(
  db: Database,
  input: { manifest: Record<string, unknown>; createdBy: string; createdAt?: number },
): MarinaGenomeRow {
  const manifest = { ...input.manifest, schema: "marina.genome.v1" };
  const manifestJson = canonicalFederationJson(manifest);
  const hash = `sha256:${createHash("sha256").update(manifestJson).digest("hex")}`;
  const createdAt = input.createdAt ?? Date.now();
  const signature = sign({ ...manifest, hash });
  db.run(
    `INSERT OR IGNORE INTO marina_genomes
     (hash,schema,manifest_json,created_by,signature_json,created_at) VALUES (?,?,?,?,?,?)`,
    [hash, "marina.genome.v1", manifestJson, input.createdBy, signature, createdAt],
  );
  return db.query("SELECT * FROM marina_genomes WHERE hash=?").get(hash) as MarinaGenomeRow;
}

export function getMarinaGenome(db: Database, hash: string): MarinaGenomeRow | undefined {
  return (
    (db.query("SELECT * FROM marina_genomes WHERE hash=?").get(hash) as MarinaGenomeRow | null) ??
    undefined
  );
}

export function listMarinaGenomes(db: Database): MarinaGenomeRow[] {
  return db
    .query("SELECT * FROM marina_genomes ORDER BY created_at DESC,hash")
    .all() as MarinaGenomeRow[];
}

export function createMarinaDescendant(
  db: Database,
  input: {
    name: string;
    genomeHash: string;
    parentWorldIds: string[];
    mode: string;
    hypothesis?: string;
    inheritedStateRefs?: string[];
    excludedComponents?: string[];
    mutations?: string[];
    initialHabitat?: string;
    worldVariantId?: string;
    createdBy: string;
    id?: string;
    createdAt?: number;
  },
): MarinaDescendantRow {
  const id = input.id ?? `marina_${randomUUID().slice(0, 16)}`;
  const createdAt = input.createdAt ?? Date.now();
  const document = { schema: "marina.descendant.v1", id, ...input, createdAt };
  const signature = sign(document);
  db.run(
    `INSERT INTO marina_descendants
     (id,name,genome_hash,parent_world_ids_json,mode,hypothesis,inherited_state_refs_json,
      excluded_components_json,mutations_json,initial_habitat,world_variant_id,created_by,
      signature_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.name,
      input.genomeHash,
      JSON.stringify(input.parentWorldIds),
      input.mode,
      input.hypothesis ?? "",
      JSON.stringify(input.inheritedStateRefs ?? []),
      JSON.stringify(input.excludedComponents ?? []),
      JSON.stringify(input.mutations ?? []),
      input.initialHabitat ?? null,
      input.worldVariantId ?? null,
      input.createdBy,
      signature,
      createdAt,
    ],
  );
  return getMarinaDescendant(db, id)!;
}

export function getMarinaDescendant(db: Database, id: string): MarinaDescendantRow | undefined {
  return (
    (db
      .query("SELECT * FROM marina_descendants WHERE id=?")
      .get(id) as MarinaDescendantRow | null) ?? undefined
  );
}

export function listMarinaDescendants(db: Database): MarinaDescendantRow[] {
  return db
    .query("SELECT * FROM marina_descendants ORDER BY created_at DESC,id")
    .all() as MarinaDescendantRow[];
}

export function verifySignedJson(document: Record<string, unknown>, signatureJson: string | null) {
  if (!signatureJson) return { valid: false, keyId: null, error: "Record is unsigned" };
  try {
    return verifyFederationDocument({ ...document, signature: JSON.parse(signatureJson) });
  } catch {
    return { valid: false, keyId: null, error: "Malformed signed record" };
  }
}

function sign(document: Record<string, unknown>): string | null {
  return federationSigningAvailable()
    ? JSON.stringify(signFederationDocument(document).signature)
    : null;
}
