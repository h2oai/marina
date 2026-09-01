// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CognitiveEventKind, MarinaDB } from "../persistence/database";
import type { EngineEvent } from "../types";

interface ProjectedCognitiveEvent {
  kind: CognitiveEventKind;
  actorId: string;
  traceId?: string;
  payload: Record<string, unknown>;
}

export function cognitiveProvenanceEnabled(): boolean {
  return process.env.MARINA_COGNITIVE_PROVENANCE === "true";
}

/** Capture the canonical execution stream without changing or replacing it. */
export function recordEngineCognition(db: MarinaDB, event: EngineEvent): void {
  if (!cognitiveProvenanceEnabled()) return;
  for (const projected of projectEngineEvent(event)) {
    db.appendCognitiveEvent({ ...projected, createdAt: event.timestamp });
  }
}

export function projectEngineEvent(event: EngineEvent): ProjectedCognitiveEvent[] {
  switch (event.type) {
    case "command": {
      const verb = event.input.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
      // Desire capture writes journey-correlated input/output events directly.
      if (verb === "desire" || verb === "pursue") return [];
      const input: ProjectedCognitiveEvent = {
        kind: "input",
        actorId: String(event.entity),
        payload: { channel: "command", content: event.input },
      };
      const kind: CognitiveEventKind = ["recall", "ask", "dig", "recap"].includes(verb)
        ? "memory_influence"
        : verb === "reflect"
          ? "reflection"
          : ["note", "share", "create", "build"].includes(verb)
            ? "creation"
            : "action";
      return [
        input,
        { kind, actorId: String(event.entity), payload: { command: event.input, verb } },
      ];
    }
    case "agent_turn_start":
      return [
        {
          kind: "input",
          actorId: event.name,
          traceId: event.traceId,
          payload: compact({
            source: "agent_turn",
            model: event.model,
            origin: event.origin,
            runId: event.runId,
          }),
        },
      ];
    case "agent_turn_end":
      return [
        {
          kind: "output",
          actorId: event.name,
          traceId: event.traceId,
          payload: compact({
            source: "agent_turn",
            model: event.model,
            hadToolCalls: event.hadToolCalls,
            toolCount: event.toolCount,
            durationMs: event.durationMs,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            costUsd: event.costUsd,
          }),
        },
      ];
    // agent_text_delta / agent_thinking_delta are deliberately NOT projected:
    // one hash-chained (and, when signing is configured, Ed25519-signed)
    // transactional INSERT per streamed token chunk makes the ledger unusable
    // under load and adds no provenance the agent_turn_end output row doesn't
    // already carry.
    case "agent_tool_call":
      return [
        {
          kind: "tool_intention",
          actorId: event.name,
          traceId: event.traceId,
          payload: compact({
            tool: event.toolName,
            risk: event.risk,
            trustSources: event.trustSources,
            runId: event.runId,
            spanId: event.spanId,
            parentSpanId: event.parentSpanId,
          }),
        },
      ];
    case "agent_tool_result":
      return [
        {
          kind: "action",
          actorId: event.name,
          traceId: event.traceId,
          payload: compact({ tool: event.toolName, runId: event.runId, spanId: event.spanId }),
        },
        {
          kind: "consequence",
          actorId: event.name,
          traceId: event.traceId,
          payload: compact({
            tool: event.toolName,
            isError: event.isError,
            runId: event.runId,
            spanId: event.spanId,
            parentSpanId: event.parentSpanId,
          }),
        },
      ];
    case "recall_trace":
      return [
        {
          kind: "memory_influence",
          actorId: String(event.entity),
          payload: {
            query: event.query,
            seedNoteIds: event.seedNoteIds,
            activatedNoteIds: event.activatedNoteIds,
          },
        },
      ];
    case "note_created":
      return [
        {
          kind: event.noteType === "reflection" ? "reflection" : "creation",
          actorId: String(event.entity),
          payload: compact({
            created: "note",
            noteId: event.noteId,
            noteType: event.noteType,
            importance: event.importance,
            poolId: event.poolId,
            content: event.content,
          }),
        },
      ];
    case "model_request_lifecycle":
      if (!new Set(["received", "completed", "failed"]).has(event.phase)) return [];
      return [
        {
          kind:
            event.phase === "received"
              ? "input"
              : event.phase === "completed"
                ? "output"
                : "consequence",
          actorId: event.entityId ?? event.target ?? event.model,
          traceId: event.traceId ?? event.requestId,
          payload: compact({
            source: "model_request",
            phase: event.phase,
            requestId: event.requestId,
            model: event.model,
            target: event.target,
            routeKind: event.routeKind,
            durationMs: event.durationMs,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            costUsd: event.costUsd,
            errorKind: event.errorKind,
          }),
        },
      ];
    case "task_claimed":
    case "task_submitted":
    case "task_approved":
    case "task_rejected":
    case "task_released":
      return [
        {
          kind: "consequence",
          actorId: String(event.entity),
          payload: { event: event.type, taskId: event.taskId },
        },
      ];
    case "agent_spawn":
      return [
        {
          kind: "creation",
          actorId: String(event.entity),
          payload: { created: "agent", name: event.name, model: event.model, role: event.role },
        },
      ];
    case "canvas_publish":
      return [
        {
          kind: "creation",
          actorId: String(event.entity),
          payload: { created: "canvas_node", canvasId: event.canvasId, nodeId: event.nodeId },
        },
      ];
    case "board_post":
      return [
        {
          kind: "creation",
          actorId: String(event.entity),
          payload: {
            created: "board_post",
            postId: event.postId,
            boardId: event.boardId,
            title: event.title,
          },
        },
      ];
    case "pool_note":
      return [
        {
          kind: "creation",
          actorId: String(event.entity),
          payload: {
            created: "pool_note",
            noteId: event.noteId,
            poolName: event.poolName,
            importance: event.importance,
          },
        },
      ];
    default:
      return [];
  }
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
