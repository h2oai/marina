// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Experiments ───────────────────────────────────────────────────────────

export function createExperiment(
  db: Database,
  opts: {
    name: string;
    description?: string;
    config?: Record<string, unknown>;
    creatorName: string;
    requiredAgents?: number;
    timeLimit?: number;
  },
): number {
  const result = db.run(
    `INSERT INTO experiments (name, description, config, creator_name, required_agents, time_limit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.name,
      opts.description ?? "",
      JSON.stringify(opts.config ?? {}),
      opts.creatorName,
      opts.requiredAgents ?? 2,
      opts.timeLimit ?? null,
      Date.now(),
    ],
  );
  return Number(result.lastInsertRowid);
}

export function getExperiment(db: Database, id: number): ExperimentRow | undefined {
  return (
    (db.query("SELECT * FROM experiments WHERE id = ?").get(id) as ExperimentRow | null) ??
    undefined
  );
}

export function getExperimentByName(db: Database, name: string): ExperimentRow | undefined {
  return (
    (db.query("SELECT * FROM experiments WHERE name = ?").get(name) as ExperimentRow | null) ??
    undefined
  );
}

export function listExperiments(db: Database, status?: string): ExperimentRow[] {
  if (status) {
    return db
      .query("SELECT * FROM experiments WHERE status = ? ORDER BY id DESC")
      .all(status) as ExperimentRow[];
  }
  return db.query("SELECT * FROM experiments ORDER BY id DESC").all() as ExperimentRow[];
}

export function updateExperimentStatus(db: Database, id: number, status: string): void {
  db.run("UPDATE experiments SET status = ? WHERE id = ?", [status, id]);
}

export function startExperiment(db: Database, id: number): void {
  db.run("UPDATE experiments SET status = 'active', started_at = ? WHERE id = ?", [Date.now(), id]);
}

export function completeExperiment(db: Database, id: number): void {
  db.run("UPDATE experiments SET status = 'completed', completed_at = ? WHERE id = ?", [
    Date.now(),
    id,
  ]);
}

export function addParticipant(db: Database, experimentId: number, entityName: string): void {
  db.run(
    "INSERT OR IGNORE INTO experiment_participants (experiment_id, entity_name, joined_at) VALUES (?, ?, ?)",
    [experimentId, entityName, Date.now()],
  );
}

export function getParticipants(db: Database, experimentId: number): ExperimentParticipantRow[] {
  return db
    .query("SELECT * FROM experiment_participants WHERE experiment_id = ?")
    .all(experimentId) as ExperimentParticipantRow[];
}

export function isParticipant(db: Database, experimentId: number, entityName: string): boolean {
  const row = db
    .query("SELECT 1 FROM experiment_participants WHERE experiment_id = ? AND entity_name = ?")
    .get(experimentId, entityName);
  return row !== null;
}

export function recordResult(
  db: Database,
  experimentId: number,
  entityName: string,
  metricName: string,
  metricValue: number,
  arm = "",
): void {
  db.run(
    `INSERT INTO experiment_results (experiment_id, entity_name, metric_name, metric_value, arm, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [experimentId, entityName, metricName, metricValue, arm, Date.now()],
  );
}

export function getResults(db: Database, experimentId: number): ExperimentResultRow[] {
  return db
    .query("SELECT * FROM experiment_results WHERE experiment_id = ? ORDER BY id")
    .all(experimentId) as ExperimentResultRow[];
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface ExperimentRow {
  id: number;
  name: string;
  description: string;
  config: string;
  status: string;
  creator_name: string;
  required_agents: number;
  time_limit: number | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface ExperimentParticipantRow {
  experiment_id: number;
  entity_name: string;
  joined_at: number;
}

export interface ExperimentResultRow {
  id: number;
  experiment_id: number;
  entity_name: string;
  metric_name: string;
  metric_value: number;
  arm: string;
  recorded_at: number;
}
