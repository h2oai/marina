// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { canonicalFederationJson } from "../net/federation-crypto";
export type SimulationMode = "live" | "recorded" | "synthetic" | "hybrid" | "long-duration";
export type ReproducibilityLevel =
  | "exact-engine"
  | "recorded-response"
  | "behavioral"
  | "statistical"
  | "conceptual";
export interface SimulationManifestRow {
  hash: string;
  schema: "marina.simulation.v1";
  manifest_json: string;
  created_by: string;
  created_at: number;
}
export interface SimulationRunRow {
  id: string;
  manifest_hash: string;
  mode: SimulationMode;
  reproducibility: ReproducibilityLevel;
  seed: string | null;
  parent_run_id: string | null;
  fork_point_ref: string | null;
  treatments_json: string;
  created_by: string;
  created_at: number;
}
export interface SimulationEventRow {
  id: string;
  run_id: string;
  kind: "started" | "intervention" | "observation" | "measure" | "completed" | "failed" | "gap";
  source_ref: string | null;
  data_json: string;
  created_by: string;
  created_at: number;
  /** Monotonic insertion order (migration 94). */
  seq: number;
}
export interface SimulationComparisonRow {
  id: string;
  run_ids_json: string;
  questions_json: string;
  measures_json: string;
  interpretation: string;
  dataset_json: string;
  created_by: string;
  created_at: number;
}
export function createSimulationManifest(
  db: Database,
  input: { manifest: Record<string, unknown>; createdBy: string },
): SimulationManifestRow {
  const manifest = { ...input.manifest, schema: "marina.simulation.v1" };
  const json = canonicalFederationJson(manifest);
  const hash = `sha256:${createHash("sha256").update(json).digest("hex")}`;
  db.run(
    "INSERT OR IGNORE INTO simulation_manifests (hash,schema,manifest_json,created_by,created_at) VALUES (?,?,?,?,?)",
    [hash, "marina.simulation.v1", json, input.createdBy, Date.now()],
  );
  return db
    .query("SELECT * FROM simulation_manifests WHERE hash=?")
    .get(hash) as SimulationManifestRow;
}
export function getSimulationManifest(
  db: Database,
  hash: string,
): SimulationManifestRow | undefined {
  return (
    (db
      .query("SELECT * FROM simulation_manifests WHERE hash=?")
      .get(hash) as SimulationManifestRow | null) ?? undefined
  );
}
export function listSimulationManifests(db: Database, limit = 200): SimulationManifestRow[] {
  return db
    .query("SELECT * FROM simulation_manifests ORDER BY created_at DESC,hash LIMIT ?")
    .all(Math.max(1, Math.min(limit, 1000))) as SimulationManifestRow[];
}
export function createSimulationRun(
  db: Database,
  input: {
    manifestHash: string;
    mode: SimulationMode;
    reproducibility: ReproducibilityLevel;
    seed?: string;
    parentRunId?: string;
    forkPointRef?: string;
    treatments?: Record<string, unknown>;
    createdBy: string;
    id?: string;
  },
): SimulationRunRow {
  const manifest = getSimulationManifest(db, input.manifestHash);
  if (!manifest) throw new Error(`Simulation manifest does not exist: ${input.manifestHash}`);
  if (input.parentRunId) {
    const parent = getSimulationRun(db, input.parentRunId);
    if (!parent) throw new Error(`Parent simulation run does not exist: ${input.parentRunId}`);
    if (parent.manifest_hash !== input.manifestHash) {
      throw new Error("A simulation fork must retain its parent's manifest");
    }
    if (!input.forkPointRef?.trim()) {
      throw new Error("A simulation fork requires a causal fork-point reference");
    }
  } else if (input.forkPointRef) {
    throw new Error("A fork-point reference requires a parent simulation run");
  }
  const row = {
    id: input.id ?? `simulation_${randomUUID().slice(0, 16)}`,
    manifest_hash: input.manifestHash,
    mode: input.mode,
    reproducibility: input.reproducibility,
    seed: input.seed ?? null,
    parent_run_id: input.parentRunId ?? null,
    fork_point_ref: input.forkPointRef ?? null,
    treatments_json: JSON.stringify(input.treatments ?? {}),
    created_by: input.createdBy,
    created_at: Date.now(),
  };
  db.run(
    "INSERT INTO simulation_runs (id,manifest_hash,mode,reproducibility,seed,parent_run_id,fork_point_ref,treatments_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      row.id,
      row.manifest_hash,
      row.mode,
      row.reproducibility,
      row.seed,
      row.parent_run_id,
      row.fork_point_ref,
      row.treatments_json,
      row.created_by,
      row.created_at,
    ],
  );
  return row;
}
export function getSimulationRun(db: Database, id: string): SimulationRunRow | undefined {
  return (
    (db.query("SELECT * FROM simulation_runs WHERE id=?").get(id) as SimulationRunRow | null) ??
    undefined
  );
}
export function listSimulationRuns(
  db: Database,
  manifestHash?: string,
  limit = 200,
): SimulationRunRow[] {
  const bounded = Math.max(1, Math.min(limit, 1000));
  return (
    manifestHash
      ? db
          .query(
            "SELECT * FROM simulation_runs WHERE manifest_hash=? ORDER BY created_at,id LIMIT ?",
          )
          .all(manifestHash, bounded)
      : db.query("SELECT * FROM simulation_runs ORDER BY created_at DESC,id LIMIT ?").all(bounded)
  ) as SimulationRunRow[];
}
export function appendSimulationEvent(
  db: Database,
  input: {
    runId: string;
    kind: SimulationEventRow["kind"];
    sourceRef?: string;
    data: Record<string, unknown>;
    createdBy: string;
    id?: string;
  },
): SimulationEventRow {
  const row = {
    id: input.id ?? `simulation_event_${randomUUID().slice(0, 16)}`,
    run_id: input.runId,
    kind: input.kind,
    source_ref: input.sourceRef ?? null,
    data_json: JSON.stringify(input.data),
    created_by: input.createdBy,
    created_at: Date.now(),
  };
  db.run(
    "INSERT INTO simulation_events (id,run_id,kind,source_ref,data_json,created_by,created_at,seq) VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM simulation_events))",
    [row.id, row.run_id, row.kind, row.source_ref, row.data_json, row.created_by, row.created_at],
  );
  return db.query("SELECT * FROM simulation_events WHERE id=?").get(row.id) as SimulationEventRow;
}
export function listSimulationEvents(db: Database, runId: string): SimulationEventRow[] {
  return db
    .query("SELECT * FROM simulation_events WHERE run_id=? ORDER BY seq")
    .all(runId) as SimulationEventRow[];
}
export function createSimulationComparison(
  db: Database,
  input: {
    runIds: string[];
    questions: string[];
    measures: Record<string, unknown>;
    interpretation: string;
    dataset: Record<string, unknown>;
    createdBy: string;
    id?: string;
  },
): SimulationComparisonRow {
  const runIds = [...new Set(input.runIds)];
  if (runIds.length < 2) throw new Error("A simulation comparison requires two distinct runs");
  for (const runId of runIds) {
    if (!getSimulationRun(db, runId)) {
      throw new Error(`Simulation comparison run does not exist: ${runId}`);
    }
  }
  const row = {
    id: input.id ?? `comparison_${randomUUID().slice(0, 16)}`,
    run_ids_json: JSON.stringify(runIds),
    questions_json: JSON.stringify(input.questions),
    measures_json: JSON.stringify(input.measures),
    interpretation: input.interpretation,
    dataset_json: JSON.stringify(input.dataset),
    created_by: input.createdBy,
    created_at: Date.now(),
  };
  db.run(
    "INSERT INTO simulation_comparisons (id,run_ids_json,questions_json,measures_json,interpretation,dataset_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [
      row.id,
      row.run_ids_json,
      row.questions_json,
      row.measures_json,
      row.interpretation,
      row.dataset_json,
      row.created_by,
      row.created_at,
    ],
  );
  return row;
}
export function listSimulationComparisons(db: Database, limit = 200): SimulationComparisonRow[] {
  return db
    .query("SELECT * FROM simulation_comparisons ORDER BY created_at DESC,id LIMIT ?")
    .all(Math.max(1, Math.min(limit, 1000))) as SimulationComparisonRow[];
}
