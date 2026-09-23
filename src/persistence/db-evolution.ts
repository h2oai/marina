// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { getParticipants } from "./db-experiments";

// ─── Native evolution protocols ────────────────────────────────────────────

export function createEvolutionSession(
  db: Database,
  opts: { experimentId: number; objective: string; protocol?: object; createdBy: string },
): number {
  const result = db.run(
    `INSERT INTO evolution_sessions
       (experiment_id, objective, protocol, status, created_by, created_at)
       VALUES (?, ?, ?, 'draft', ?, ?)`,
    [
      opts.experimentId,
      opts.objective,
      JSON.stringify(opts.protocol ?? {}),
      opts.createdBy,
      Date.now(),
    ],
  );
  return Number(result.lastInsertRowid);
}

export function getEvolutionSession(db: Database, id: number): EvolutionSessionRow | undefined {
  return (
    (db
      .query("SELECT * FROM evolution_sessions WHERE id = ?")
      .get(id) as EvolutionSessionRow | null) ?? undefined
  );
}

export function getEvolutionSessionByExperiment(
  db: Database,
  experimentId: number,
): EvolutionSessionRow | undefined {
  return (
    (db
      .query("SELECT * FROM evolution_sessions WHERE experiment_id = ?")
      .get(experimentId) as EvolutionSessionRow | null) ?? undefined
  );
}

export function listEvolutionSessions(
  db: Database,
  status?: EvolutionSessionStatus,
): EvolutionSessionRow[] {
  if (status) {
    return db
      .query("SELECT * FROM evolution_sessions WHERE status = ? ORDER BY id DESC")
      .all(status) as EvolutionSessionRow[];
  }
  return db
    .query("SELECT * FROM evolution_sessions ORDER BY id DESC")
    .all() as EvolutionSessionRow[];
}

export function listActiveEvolutionSessionsForParticipant(
  db: Database,
  entityName: string,
): EvolutionSessionRow[] {
  return db
    .query(
      `SELECT es.* FROM evolution_sessions es
         JOIN experiment_participants ep ON ep.experiment_id = es.experiment_id
         WHERE es.status = 'active' AND lower(ep.entity_name) = lower(?)
         ORDER BY es.id`,
    )
    .all(entityName) as EvolutionSessionRow[];
}

export function getEvolutionActivity(
  db: Database,
  experimentId: number,
  startedAt: number,
  endedAt = Date.now(),
): EvolutionActivitySummary {
  const participants = getParticipants(db, experimentId).map((row) => row.entity_name);
  if (participants.length === 0) return emptyEvolutionActivity();
  const placeholders = participants.map(() => "?").join(",");
  const row = db
    .query(
      `SELECT
           SUM(CASE WHEN source='command' AND meaningful=1 THEN 1 ELSE 0 END) meaningful_actions,
           SUM(CASE WHEN source='command' AND communication=1 THEN 1 ELSE 0 END) communications,
           SUM(CASE WHEN source='agent_tool' THEN 1 ELSE 0 END) tool_calls,
           SUM(CASE WHEN source='agent_tool' AND tool_name LIKE 'marina_%' THEN 1 ELSE 0 END) marina_tool_calls,
           AVG(CASE WHEN source='agent_tool' AND latency_ms IS NOT NULL THEN latency_ms END) average_tool_latency_ms,
           MAX(CASE WHEN source='agent_tool' THEN latency_ms END) maximum_tool_latency_ms,
           COUNT(DISTINCT CASE WHEN meaningful=1 THEN actor_name END) active_participants
         FROM primitive_usage
         WHERE created_at BETWEEN ? AND ? AND actor_name IN (${placeholders})`,
    )
    .get(startedAt, endedAt, ...participants) as {
    meaningful_actions: number | null;
    communications: number | null;
    tool_calls: number | null;
    marina_tool_calls: number | null;
    average_tool_latency_ms: number | null;
    maximum_tool_latency_ms: number | null;
    active_participants: number | null;
  };
  return {
    participants,
    activeParticipants: row.active_participants ?? 0,
    meaningfulActions: row.meaningful_actions ?? 0,
    communications: row.communications ?? 0,
    toolCalls: row.tool_calls ?? 0,
    marinaToolCalls: row.marina_tool_calls ?? 0,
    averageToolLatencyMs: row.average_tool_latency_ms,
    maximumToolLatencyMs: row.maximum_tool_latency_ms,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}

export function updateEvolutionSessionStatus(
  db: Database,
  id: number,
  status: EvolutionSessionStatus,
): void {
  const timestampColumn =
    status === "active"
      ? "started_at"
      : status === "paused"
        ? "paused_at"
        : status === "completed"
          ? "completed_at"
          : undefined;
  if (timestampColumn) {
    if (status === "active") {
      db.run(
        "UPDATE evolution_sessions SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
        [status, Date.now(), id],
      );
      return;
    }
    db.run(`UPDATE evolution_sessions SET status = ?, ${timestampColumn} = ? WHERE id = ?`, [
      status,
      Date.now(),
      id,
    ]);
    return;
  }
  db.run("UPDATE evolution_sessions SET status = ? WHERE id = ?", [status, id]);
}

export function createEvolutionRun(
  db: Database,
  opts: {
    sessionId: number;
    hypothesis: string;
    candidateRef: string;
    proposedBy: string;
    parentRunId?: number;
  },
): number {
  const next = db
    .query(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM evolution_runs WHERE session_id = ?",
    )
    .get(opts.sessionId) as { sequence: number };
  const result = db.run(
    `INSERT INTO evolution_runs
       (session_id, sequence, parent_run_id, hypothesis, candidate_ref, proposed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.sessionId,
      next.sequence,
      opts.parentRunId ?? null,
      opts.hypothesis,
      opts.candidateRef,
      opts.proposedBy,
      Date.now(),
    ],
  );
  return Number(result.lastInsertRowid);
}

export function getEvolutionRun(db: Database, id: number): EvolutionRunRow | undefined {
  return (
    (db.query("SELECT * FROM evolution_runs WHERE id = ?").get(id) as EvolutionRunRow | null) ??
    undefined
  );
}

export function listEvolutionRuns(db: Database, sessionId: number): EvolutionRunRow[] {
  return db
    .query("SELECT * FROM evolution_runs WHERE session_id = ? ORDER BY sequence")
    .all(sessionId) as EvolutionRunRow[];
}

export function evaluateEvolutionRun(
  db: Database,
  id: number,
  evaluatorName: string,
  evidence: string,
): void {
  db.run(
    `UPDATE evolution_runs
       SET status = 'evaluated', evaluator_name = ?, evidence = ?, evaluated_at = ?
       WHERE id = ?`,
    [evaluatorName, evidence, Date.now(), id],
  );
}

export function decideEvolutionRun(
  db: Database,
  id: number,
  reviewerName: string,
  decision: "accept" | "reject" | "inconclusive",
): void {
  const status =
    decision === "accept" ? "accepted" : decision === "reject" ? "rejected" : "evaluated";
  db.run(
    `UPDATE evolution_runs
       SET status = ?, reviewer_name = ?, decision = ?, decided_at = ?
       WHERE id = ?`,
    [status, reviewerName, decision, Date.now(), id],
  );
}

// ─── Row types ────────────────────────────────────────────────────────────

export type EvolutionSessionStatus = "draft" | "active" | "paused" | "completed";

export interface EvolutionSessionRow {
  id: number;
  experiment_id: number;
  objective: string;
  protocol: string;
  status: EvolutionSessionStatus;
  created_by: string;
  created_at: number;
  started_at: number | null;
  paused_at: number | null;
  completed_at: number | null;
}

export interface EvolutionRunRow {
  id: number;
  session_id: number;
  sequence: number;
  parent_run_id: number | null;
  hypothesis: string;
  candidate_ref: string;
  proposed_by: string;
  status: "proposed" | "evaluated" | "accepted" | "rejected";
  evaluator_name: string | null;
  reviewer_name: string | null;
  evidence: string;
  decision: "accept" | "reject" | "inconclusive" | null;
  created_at: number;
  evaluated_at: number | null;
  decided_at: number | null;
}

export interface EvolutionActivitySummary {
  participants: string[];
  activeParticipants: number;
  meaningfulActions: number;
  communications: number;
  toolCalls: number;
  marinaToolCalls: number;
  averageToolLatencyMs: number | null;
  maximumToolLatencyMs: number | null;
  /** Reserved until provider-neutral per-session token attribution is durable. */
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export function emptyEvolutionActivity(): EvolutionActivitySummary {
  return {
    participants: [],
    activeParticipants: 0,
    meaningfulActions: 0,
    communications: 0,
    toolCalls: 0,
    marinaToolCalls: 0,
    averageToolLatencyMs: null,
    maximumToolLatencyMs: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}
