// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Durable execution checkpoint for one agent's in-flight work (`run_state`
// table, migration 149). Written before the agent's loop advances past a
// model/tool step whose outcome is not yet committed; read back at boot so a
// crash resumes the step instead of restarting the turn from a coarse summary.
//
// This is the native Marina analogue of Pi Durable's "everything is a task
// that stores a checkpoint before it moves on". It is intentionally narrow:
// the lean-agent loop already yields after every message batch (`finishTurn`),
// so the only state that must survive a crash is the *single pending effect*
// (a tool call) and whether a resume may safely re-run it.

import type { Database } from "bun:sqlite";

/** Recovery policy for an effect whose durable intent exists but whose outcome is unknown. */
export type ToolReplay = "safe" | "never";

export type RunStatePhase = "tool_call" | "model_request";

/** One row in `run_state`: the effect currently in flight for an agent. */
export interface RunState {
  agentName: string;
  phase: RunStatePhase;
  /** pi-agent-core tool-call id, when `phase === "tool_call"`. */
  toolCallId: string;
  toolName: string;
  /** JSON-encoded tool arguments (must be present to re-drive a `safe` tool). */
  argsJson: string;
  /** Mirror of `AgentTool.replay` — may a resume re-run this effect? */
  replay: ToolReplay;
  /** Streamed/partial output observed before the crash, JSON-encoded. */
  partialOutputJson: string;
  /** Wall-clock millis of the last write; used for stale-run diagnostics. */
  updatedAt: number;
}

/**
 * Upsert the in-flight state for an agent. One row per agent: a new step
 * replaces the previous one, so the row always describes the *oldest
 * unacknowledged* effect (the one a resume must decide about).
 */
export function putRunState(db: Database, state: RunState): void {
  db.run(
    `INSERT INTO run_state
       (agent_name, phase, tool_call_id, tool_name, args_json, replay, partial_output_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_name) DO UPDATE SET
       phase = excluded.phase,
       tool_call_id = excluded.tool_call_id,
       tool_name = excluded.tool_name,
       args_json = excluded.args_json,
       replay = excluded.replay,
       partial_output_json = excluded.partial_output_json,
       updated_at = excluded.updated_at`,
    [
      state.agentName,
      state.phase,
      state.toolCallId,
      state.toolName,
      state.argsJson,
      state.replay,
      state.partialOutputJson,
      state.updatedAt,
    ],
  );
}

/** Read the in-flight state for an agent, or `undefined` when the agent is clean. */
export function getRunState(db: Database, agentName: string): RunState | undefined {
  const row = db
    .query(
      `SELECT agent_name, phase, tool_call_id, tool_name, args_json, replay, partial_output_json, updated_at
       FROM run_state WHERE agent_name = ?`,
    )
    .get(agentName) as {
    agent_name: string;
    phase: RunStatePhase;
    tool_call_id: string;
    tool_name: string;
    args_json: string;
    replay: ToolReplay;
    partial_output_json: string;
    updated_at: number;
  } | null;
  if (!row) return undefined;
  return {
    agentName: row.agent_name,
    phase: row.phase,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    argsJson: row.args_json,
    replay: row.replay,
    partialOutputJson: row.partial_output_json,
    updatedAt: row.updated_at,
  };
}

/** Clear an agent's in-flight state once its effect has been committed. */
export function clearRunState(db: Database, agentName: string): void {
  db.run("DELETE FROM run_state WHERE agent_name = ?", [agentName]);
}
