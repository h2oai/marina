// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import * as tasksDb from "./db-tasks";

const average = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

// ─── Productivity sessions and primitive usage ─────────────────────────────

export function startProductivitySession(
  db: Database,
  entityId: string,
  entityName: string,
  taskId: number,
  startedAt: number,
  toolCalls = 0,
  promptVersion?: string,
  inputTokens = 0,
  outputTokens = 0,
  costUsd = 0,
): void {
  db.run(
    `INSERT OR IGNORE INTO productivity_sessions
       (entity_id,entity_name,task_id,started_at,start_tool_calls,prompt_version,
        start_input_tokens,start_output_tokens,start_cost_usd) VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      entityId,
      entityName,
      taskId,
      startedAt,
      toolCalls,
      promptVersion ?? null,
      inputTokens,
      outputTokens,
      costUsd,
    ],
  );
}

export function finishProductivitySession(
  db: Database,
  entityId: string,
  entityName: string,
  taskId: number,
  outcome: "approved" | "rejected" | "expired",
  completedAt: number,
  endToolCalls = 0,
  endInputTokens = 0,
  endOutputTokens = 0,
  endCostUsd = 0,
): boolean {
  let session = db
    .query(
      "SELECT * FROM productivity_sessions WHERE entity_id=? AND task_id=? AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(entityId, taskId) as { id: number; started_at: number; start_tool_calls: number } | null;
  if (!session) {
    const claim = tasksDb.getTaskClaim(db, taskId, entityId);
    startProductivitySession(db, entityId, entityName, taskId, claim?.claimed_at ?? completedAt, 0);
    session = db
      .query(
        "SELECT * FROM productivity_sessions WHERE entity_id=? AND task_id=? AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(entityId, taskId) as typeof session;
  }
  if (!session) return false;
  const handoffs = (
    db
      .query(
        `SELECT COUNT(*) c FROM direct_messages WHERE created_at BETWEEN ? AND ?
       AND (sender_name=? OR target_name=?)`,
      )
      .get(session.started_at, completedAt, entityName, entityName) as { c: number }
  ).c;
  return (
    db.run(
      `UPDATE productivity_sessions SET completed_at=?,outcome=?,quality=?,end_tool_calls=?,handoffs=?,
         end_input_tokens=?,end_output_tokens=?,end_cost_usd=? WHERE id=?`,
      [
        completedAt,
        outcome,
        outcome === "approved" ? 1 : 0,
        endToolCalls,
        handoffs,
        endInputTokens,
        endOutputTokens,
        endCostUsd,
        session.id,
      ],
    ).changes > 0
  );
}

/** The columns the productivity read models need — never `metadata`. */
const PRODUCTIVITY_COLUMNS =
  "outcome, started_at, completed_at, start_tool_calls, end_tool_calls, handoffs";

interface ProductivityRow {
  outcome: string;
  started_at: number;
  completed_at: number;
  start_tool_calls: number;
  end_tool_calls: number | null;
  handoffs: number;
}

function computeProductivitySummary(
  rows: ProductivityRow[],
  entityName?: string,
): ProductivitySummary {
  const durations = rows
    .map((r) => Math.max(0, r.completed_at - r.started_at))
    .sort((a, b) => a - b);
  const successes = rows.filter((r) => r.outcome === "approved").length;
  return {
    entityName: entityName ?? null,
    outcomes: rows.length,
    successes,
    failures: rows.length - successes,
    successRate: rows.length ? successes / rows.length : 0,
    averageDurationMs: average(durations),
    medianDurationMs: durations.length
      ? durations.length % 2
        ? durations[Math.floor(durations.length / 2)]!
        : (durations[durations.length / 2 - 1]! + durations[durations.length / 2]!) / 2
      : 0,
    averageToolCalls: average(
      rows.map((r) => Math.max(0, (r.end_tool_calls ?? r.start_tool_calls) - r.start_tool_calls)),
    ),
    averageHandoffs: average(rows.map((r) => r.handoffs)),
    outcomesLast7d: rows.filter((r) => r.completed_at >= Date.now() - 7 * 86_400_000).length,
  };
}

export function getProductivitySummary(db: Database, entityName?: string): ProductivitySummary {
  const rows = (
    entityName
      ? db
          .query(
            `SELECT ${PRODUCTIVITY_COLUMNS} FROM productivity_sessions WHERE completed_at IS NOT NULL AND entity_name=? ORDER BY completed_at`,
          )
          .all(entityName)
      : db
          .query(
            `SELECT ${PRODUCTIVITY_COLUMNS} FROM productivity_sessions WHERE completed_at IS NOT NULL ORDER BY completed_at`,
          )
          .all()
  ) as ProductivityRow[];
  return computeProductivitySummary(rows, entityName);
}

export function getProductivityLeaderboard(db: Database, limit = 20): ProductivitySummary[] {
  const rows = db
    .query(
      `SELECT entity_name, ${PRODUCTIVITY_COLUMNS} FROM productivity_sessions WHERE completed_at IS NOT NULL ORDER BY entity_name, completed_at`,
    )
    .all() as Array<ProductivityRow & { entity_name: string }>;
  const byEntity = new Map<string, ProductivityRow[]>();
  for (const row of rows) {
    const { entity_name: name, ...rest } = row;
    const list = byEntity.get(name) ?? [];
    list.push(rest);
    byEntity.set(name, list);
  }
  const summaries: ProductivitySummary[] = [];
  for (const [name, group] of byEntity) {
    summaries.push(computeProductivitySummary(group, name));
  }
  return summaries
    .sort((a, b) => b.successes - a.successes || a.averageDurationMs - b.averageDurationMs)
    .slice(0, limit);
}

export function getProductivityTrend(
  db: Database,
  entityName?: string,
  days = 14,
): ProductivityTrendPoint[] {
  const since = Date.now() - Math.max(1, days) * 86_400_000;
  const rows = (
    entityName
      ? db
          .query(
            `SELECT ${PRODUCTIVITY_COLUMNS} FROM productivity_sessions WHERE completed_at>=? AND entity_name=? ORDER BY completed_at`,
          )
          .all(since, entityName)
      : db
          .query(
            `SELECT ${PRODUCTIVITY_COLUMNS} FROM productivity_sessions WHERE completed_at>=? ORDER BY completed_at`,
          )
          .all(since)
  ) as ProductivityRow[];
  const groups = new Map<string, ProductivityRow[]>();
  for (const row of rows) {
    const date = new Date(row.completed_at).toISOString().slice(0, 10);
    const day = groups.get(date);
    if (day) day.push(row);
    else groups.set(date, [row]);
  }
  return [...groups.entries()].map(([date, entries]) => ({
    date,
    outcomes: entries.length,
    successes: entries.filter((row) => row.outcome === "approved").length,
    averageDurationMs: average(entries.map((row) => row.completed_at - row.started_at)),
    averageToolCalls: average(
      entries.map((row) =>
        Math.max(0, (row.end_tool_calls ?? row.start_tool_calls) - row.start_tool_calls),
      ),
    ),
    averageHandoffs: average(entries.map((row) => row.handoffs)),
  }));
}

export function recordPrimitiveUsage(
  db: Database,
  input: {
    actorId?: string;
    actorName: string;
    actorKind: string;
    source: "command" | "agent_tool";
    primitive: string;
    action: string;
    safeLabel: string;
    toolName?: string;
    success?: boolean;
    meaningful?: boolean;
    worldAction?: boolean;
    communication?: boolean;
    latencyMs?: number;
    promptVersion?: string;
    riskClass?: "read" | "communicate" | "mutate" | "consequential";
    trustSources?: string[];
    createdAt?: number;
  },
): number {
  const result = db.run(
    `INSERT INTO primitive_usage
       (actor_id,actor_name,actor_kind,source,primitive,action,safe_label,tool_name,success,
        meaningful,world_action,communication,latency_ms,created_at,prompt_version,risk_class,trust_sources)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.actorId ?? null,
      input.actorName,
      input.actorKind,
      input.source,
      input.primitive,
      input.action,
      input.safeLabel,
      input.toolName ?? null,
      input.success === undefined ? null : input.success ? 1 : 0,
      input.meaningful ? 1 : 0,
      input.worldAction ? 1 : 0,
      input.communication ? 1 : 0,
      input.latencyMs ?? null,
      input.createdAt ?? Date.now(),
      input.promptVersion ?? null,
      input.riskClass ?? null,
      input.trustSources?.length ? JSON.stringify([...new Set(input.trustSources)].sort()) : null,
    ],
  );
  return Number(result.lastInsertRowid);
}

export function finishAgentToolUsage(
  db: Database,
  actorName: string,
  toolName: string,
  success: boolean,
  at = Date.now(),
): void {
  const row = db
    .query(
      `SELECT id,created_at FROM primitive_usage
         WHERE actor_name=? AND source='agent_tool' AND tool_name=? AND success IS NULL
         ORDER BY id DESC LIMIT 1`,
    )
    .get(actorName, toolName) as { id: number; created_at: number } | null;
  if (!row) return;
  db.run("UPDATE primitive_usage SET success=?,latency_ms=? WHERE id=?", [
    success ? 1 : 0,
    Math.max(0, at - row.created_at),
    row.id,
  ]);
}

export function getPrimitiveUsageSummary(
  db: Database,
  entityName?: string,
  days = 7,
): PrimitiveUsageSummary {
  const since = Date.now() - Math.max(1 / 1440, days) * 86_400_000;
  const where = entityName ? "AND actor_name=?" : "";
  const args = entityName ? [since, entityName] : [since];
  const row = db
    .query(
      `SELECT
          SUM(CASE WHEN source='command' THEN 1 ELSE 0 END) commands,
          SUM(CASE WHEN source='command' AND meaningful=1 THEN 1 ELSE 0 END) meaningful_actions,
          SUM(CASE WHEN source='command' AND world_action=1 THEN 1 ELSE 0 END) world_actions,
          SUM(CASE WHEN source='command' AND communication=1 THEN 1 ELSE 0 END) communications,
          COUNT(DISTINCT CASE WHEN source='command' AND meaningful=1 THEN primitive END) diversity,
          COUNT(DISTINCT CASE WHEN source='command' AND meaningful=1 THEN actor_name END) participants,
          COUNT(DISTINCT CASE WHEN source='command' AND meaningful=1 AND actor_kind='agent' THEN actor_name END) agents,
          SUM(CASE WHEN source='agent_tool' THEN 1 ELSE 0 END) tool_calls,
          SUM(CASE WHEN source='agent_tool' AND tool_name LIKE 'marina_%' THEN 1 ELSE 0 END) marina_tools,
          SUM(CASE WHEN source='agent_tool' AND tool_name='think' THEN 1 ELSE 0 END) reasoning_only,
          SUM(CASE WHEN source='agent_tool' AND risk_class='consequential' THEN 1 ELSE 0 END) consequential_tools,
          SUM(CASE WHEN source='agent_tool' AND trust_sources IS NOT NULL THEN 1 ELSE 0 END) untrusted_tools,
          MAX(CASE WHEN source='command' AND meaningful=1 THEN created_at END) last_action
         FROM primitive_usage WHERE created_at>=? ${where}`,
    )
    .get(...args) as {
    commands: number | null;
    meaningful_actions: number | null;
    world_actions: number | null;
    communications: number | null;
    diversity: number | null;
    participants: number | null;
    agents: number | null;
    tool_calls: number | null;
    marina_tools: number | null;
    reasoning_only: number | null;
    consequential_tools: number | null;
    untrusted_tools: number | null;
    last_action: number | null;
  };
  const commands = row.commands ?? 0;
  const meaningfulActions = row.meaningful_actions ?? 0;
  const topPrimitives = db
    .query(
      `SELECT primitive,COUNT(*) count FROM primitive_usage
         WHERE created_at>=? AND source='command' AND meaningful=1 ${where}
         GROUP BY primitive ORDER BY count DESC,primitive LIMIT 8`,
    )
    .all(...args) as Array<{ primitive: string; count: number }>;
  const promptVersions = db
    .query(
      `SELECT DISTINCT prompt_version FROM primitive_usage
         WHERE created_at>=? AND prompt_version IS NOT NULL ${where} ORDER BY prompt_version`,
    )
    .all(...args) as Array<{ prompt_version: string }>;
  const sessions = db
    .query(
      `SELECT ps.outcome,COUNT(pu.id) meaningful
         FROM productivity_sessions ps LEFT JOIN primitive_usage pu
           ON pu.actor_name=ps.entity_name AND pu.source='command' AND pu.meaningful=1
           AND pu.created_at BETWEEN ps.started_at AND ps.completed_at
         WHERE ps.completed_at IS NOT NULL AND ps.completed_at>=? ${
           entityName ? "AND ps.entity_name=?" : ""
}
         GROUP BY ps.id`,
    )
    .all(...args) as Array<{ outcome: string; meaningful: number }>;
  return {
    entityName: entityName ?? null,
    commands,
    meaningfulActions,
    meaningfulRate: commands ? meaningfulActions / commands : 0,
    worldActions: row.world_actions ?? 0,
    communications: row.communications ?? 0,
    primitiveDiversity: row.diversity ?? 0,
    activeParticipants: row.participants ?? 0,
    activeAgents: row.agents ?? 0,
    toolCalls: row.tool_calls ?? 0,
    marinaToolCalls: row.marina_tools ?? 0,
    reasoningOnlyCalls: row.reasoning_only ?? 0,
    consequentialToolCalls: row.consequential_tools ?? 0,
    untrustedToolCalls: row.untrusted_tools ?? 0,
    lastActionAt: row.last_action,
    outcomeSessions: sessions.length,
    approvedMeaningfulAverage: average(
      sessions
        .filter((session) => session.outcome === "approved")
        .map((session) => session.meaningful),
    ),
    failedMeaningfulAverage: average(
      sessions
        .filter((session) => session.outcome !== "approved")
        .map((session) => session.meaningful),
    ),
    topPrimitives,
    promptVersions: promptVersions.map((entry) => entry.prompt_version),
  };
}

export function getPromptOutcomeSummaries(db: Database, days = 30): PromptOutcomeSummary[] {
  const since = Date.now() - Math.max(1, days) * 86_400_000;
  const outcomes = db
    .query(
      `SELECT prompt_version,COUNT(DISTINCT entity_name) agents,COUNT(*) outcomes,
          SUM(CASE WHEN outcome='approved' THEN 1 ELSE 0 END) successes,
          AVG(completed_at-started_at) average_duration,
          AVG(MAX(0,COALESCE(end_tool_calls,start_tool_calls)-start_tool_calls)) average_tools,
          AVG(MAX(0,COALESCE(end_input_tokens,start_input_tokens)-start_input_tokens)) average_input,
          AVG(MAX(0,COALESCE(end_output_tokens,start_output_tokens)-start_output_tokens)) average_output,
          AVG(MAX(0,COALESCE(end_cost_usd,start_cost_usd)-start_cost_usd)) average_cost
         FROM productivity_sessions
         WHERE completed_at>=? AND prompt_version IS NOT NULL
         GROUP BY prompt_version ORDER BY outcomes DESC`,
    )
    .all(since) as Array<{
    prompt_version: string;
    agents: number;
    outcomes: number;
    successes: number;
    average_duration: number;
    average_tools: number;
    average_input: number;
    average_output: number;
    average_cost: number;
  }>;
  const actions = db
    .query(
      `SELECT prompt_version,COUNT(*) meaningful FROM primitive_usage
         WHERE created_at>=? AND source='command' AND meaningful=1 AND prompt_version IS NOT NULL
         GROUP BY prompt_version`,
    )
    .all(since) as Array<{ prompt_version: string; meaningful: number }>;
  const actionMap = new Map(actions.map((row) => [row.prompt_version, row.meaningful]));
  return outcomes.map((row) => ({
    promptVersion: row.prompt_version,
    agents: row.agents,
    outcomes: row.outcomes,
    successes: row.successes,
    failures: row.outcomes - row.successes,
    successRate: row.outcomes ? row.successes / row.outcomes : 0,
    averageDurationMs: row.average_duration ?? 0,
    averageToolCalls: row.average_tools ?? 0,
    averageInputTokens: row.average_input ?? 0,
    averageOutputTokens: row.average_output ?? 0,
    averageCostUsd: row.average_cost ?? 0,
    meaningfulActions: actionMap.get(row.prompt_version) ?? 0,
  }));
}

export function getPrimitiveUsageLeaderboard(db: Database, limit = 20): PrimitiveUsageSummary[] {
  const since = Date.now() - 7 * 86_400_000;
  const mainRows = db
    .query(
      `SELECT actor_name,
          SUM(CASE WHEN source='command' THEN 1 ELSE 0 END) commands,
          SUM(CASE WHEN source='command' AND meaningful=1 THEN 1 ELSE 0 END) meaningful_actions,
          SUM(CASE WHEN source='command' AND world_action=1 THEN 1 ELSE 0 END) world_actions,
          SUM(CASE WHEN source='command' AND communication=1 THEN 1 ELSE 0 END) communications,
          COUNT(DISTINCT CASE WHEN source='command' AND meaningful=1 THEN primitive END) diversity,
          SUM(CASE WHEN source='agent_tool' THEN 1 ELSE 0 END) tool_calls,
          SUM(CASE WHEN source='agent_tool' AND tool_name LIKE 'marina_%' THEN 1 ELSE 0 END) marina_tools,
          SUM(CASE WHEN source='agent_tool' AND tool_name='think' THEN 1 ELSE 0 END) reasoning_only,
          SUM(CASE WHEN source='agent_tool' AND risk_class='consequential' THEN 1 ELSE 0 END) consequential_tools,
          SUM(CASE WHEN source='agent_tool' AND trust_sources IS NOT NULL THEN 1 ELSE 0 END) untrusted_tools
         FROM primitive_usage WHERE actor_kind='agent' AND created_at>=?
         GROUP BY actor_name`,
    )
    .all(since) as Array<{
    actor_name: string;
    commands: number | null;
    meaningful_actions: number | null;
    world_actions: number | null;
    communications: number | null;
    diversity: number | null;
    tool_calls: number | null;
    marina_tools: number | null;
    reasoning_only: number | null;
    consequential_tools: number | null;
    untrusted_tools: number | null;
  }>;
  const topRows = db
    .query(
      `SELECT actor_name, primitive, COUNT(*) as count
         FROM primitive_usage
         WHERE actor_kind='agent' AND created_at>=? AND source='command' AND meaningful=1
         GROUP BY actor_name, primitive
         ORDER BY actor_name, count DESC, primitive`,
    )
    .all(since) as Array<{ actor_name: string; primitive: string; count: number }>;
  const versionRows = db
    .query(
      `SELECT DISTINCT actor_name, prompt_version
         FROM primitive_usage
         WHERE actor_kind='agent' AND created_at>=? AND prompt_version IS NOT NULL
         ORDER BY actor_name, prompt_version`,
    )
    .all(since) as Array<{ actor_name: string; prompt_version: string }>;
  const topMap = new Map<string, Array<{ primitive: string; count: number }>>();
  for (const row of topRows) {
    const list = topMap.get(row.actor_name) ?? [];
    if (list.length < 8) {
      list.push({ primitive: row.primitive, count: row.count });
      topMap.set(row.actor_name, list);
    }
  }
  const versionMap = new Map<string, string[]>();
  for (const row of versionRows) {
    const list = versionMap.get(row.actor_name) ?? [];
    list.push(row.prompt_version);
    versionMap.set(row.actor_name, list);
  }
  const summaries: PrimitiveUsageSummary[] = [];
  for (const row of mainRows) {
    const commands = row.commands ?? 0;
    const meaningfulActions = row.meaningful_actions ?? 0;
    summaries.push({
      entityName: row.actor_name,
      commands,
      meaningfulActions,
      meaningfulRate: commands ? meaningfulActions / commands : 0,
      worldActions: row.world_actions ?? 0,
      communications: row.communications ?? 0,
      primitiveDiversity: row.diversity ?? 0,
      activeParticipants: 0,
      activeAgents: 0,
      toolCalls: row.tool_calls ?? 0,
      marinaToolCalls: row.marina_tools ?? 0,
      reasoningOnlyCalls: row.reasoning_only ?? 0,
      consequentialToolCalls: row.consequential_tools ?? 0,
      untrustedToolCalls: row.untrusted_tools ?? 0,
      lastActionAt: null,
      outcomeSessions: 0,
      approvedMeaningfulAverage: 0,
      failedMeaningfulAverage: 0,
      topPrimitives: topMap.get(row.actor_name) ?? [],
      promptVersions: versionMap.get(row.actor_name) ?? [],
    });
  }
  return summaries
    .sort(
      (a, b) =>
        b.meaningfulActions - a.meaningfulActions ||
        b.primitiveDiversity - a.primitiveDiversity ||
        b.meaningfulRate - a.meaningfulRate,
    )
    .slice(0, limit);
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface ProductivitySummary {
  entityName: string | null;
  outcomes: number;
  successes: number;
  failures: number;
  successRate: number;
  averageDurationMs: number;
  medianDurationMs: number;
  averageToolCalls: number;
  averageHandoffs: number;
  outcomesLast7d: number;
}

export interface ProductivityTrendPoint {
  date: string;
  outcomes: number;
  successes: number;
  averageDurationMs: number;
  averageToolCalls: number;
  averageHandoffs: number;
}

export interface PrimitiveUsageSummary {
  entityName: string | null;
  commands: number;
  meaningfulActions: number;
  meaningfulRate: number;
  worldActions: number;
  communications: number;
  primitiveDiversity: number;
  activeParticipants: number;
  activeAgents: number;
  toolCalls: number;
  marinaToolCalls: number;
  reasoningOnlyCalls: number;
  consequentialToolCalls: number;
  untrustedToolCalls: number;
  lastActionAt: number | null;
  outcomeSessions: number;
  approvedMeaningfulAverage: number;
  failedMeaningfulAverage: number;
  topPrimitives: Array<{ primitive: string; count: number }>;
  promptVersions: string[];
}

export interface PromptOutcomeSummary {
  promptVersion: string;
  agents: number;
  outcomes: number;
  successes: number;
  failures: number;
  successRate: number;
  averageDurationMs: number;
  averageToolCalls: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  averageCostUsd: number;
  meaningfulActions: number;
}

// ─── Autonomy pulse history (migration 130) ─────────────────────────────────

export interface AutonomyPulseInput {
  at: number;
  activeAgents: number;
  primitiveActions: number;
  communications: number;
  toolCalls: number;
  medianResponseMs?: number;
  qualified: boolean;
}

export interface AutonomyPulseRow {
  at: number;
  active_agents: number;
  primitive_actions: number;
  communications: number;
  tool_calls: number;
  median_response_ms: number | null;
  qualified: number;
}

export function recordAutonomyPulse(db: Database, p: AutonomyPulseInput): void {
  db.query(
    `INSERT INTO autonomy_pulse
       (at, active_agents, primitive_actions, communications, tool_calls, median_response_ms, qualified)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.at,
    p.activeAgents,
    p.primitiveActions,
    p.communications,
    p.toolCalls,
    p.medianResponseMs ?? null,
    p.qualified ? 1 : 0,
  );
}

/** Pulses since `sinceMs`, oldest first. */
export function listAutonomyPulse(db: Database, sinceMs: number): AutonomyPulseRow[] {
  return db
    .query(
      `SELECT at, active_agents, primitive_actions, communications, tool_calls,
              median_response_ms, qualified
         FROM autonomy_pulse WHERE at >= ? ORDER BY at ASC LIMIT 10000`,
    )
    .all(sinceMs) as AutonomyPulseRow[];
}

// ─── Daily spend (migration 131) ────────────────────────────────────────────

export interface DailySpendRow {
  day: string;
  source: string;
  cost_usd: number;
  calls: number;
}

export function addDailySpend(db: Database, day: string, source: string, usd: number): void {
  db.query(
    `INSERT INTO spend_daily (day, source, cost_usd, calls, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(day, source) DO UPDATE SET
       cost_usd = cost_usd + excluded.cost_usd, calls = calls + 1, updated_at = excluded.updated_at`,
  ).run(day, source, usd, Date.now());
}

export function getDailySpend(db: Database, day: string): DailySpendRow[] {
  return db
    .query("SELECT day, source, cost_usd, calls FROM spend_daily WHERE day = ? ORDER BY source")
    .all(day) as DailySpendRow[];
}
