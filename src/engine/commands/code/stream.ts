// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentEvent, AgentHandle } from "../../../agent/agent-types";
import { dim } from "../../../net/ansi";
import type { Entity, EntityId } from "../../../types";
import { sanitizeEntityName } from "../../entity-name";
import { ACTIVE_TASK_KEY, type CodeDeps, getAgentHandle } from "./shared";

// Live streams from a bound coding agent → the human in Code Mode for that
// session. Keyed `${sessionId}:${dispatcherId}` so we subscribe at most once.
const codeStreams = new Map<string, () => void>();

/** Subscribe the dispatcher to a bound agent's activity and forward the
 *  high-signal events (tool actions, prose, errors) to their connection, so
 *  Code Mode shows the agent working instead of going quiet. */
export function streamSessionAgent(
  deps: CodeDeps,
  dispatcherId: EntityId,
  handle: AgentHandle,
  sessionId: string,
): void {
  const notify = deps.notify;
  if (!notify) return;
  const key = `${sessionId}:${dispatcherId}`;
  if (codeStreams.has(key)) return; // already streaming this session to this watcher
  let buffer = "";
  let currentPhase = "received";
  let closed = false;
  // Tear down this stream (dead handle / dispatcher exit) so a later re-bind of
  // the same session to a fresh agent isn't blocked by a stale key entry.
  const closeStream = () => {
    if (closed) return;
    closed = true;
    try {
      unsub();
    } catch {
      /* best-effort */
    }
    codeStreams.delete(key);
  };
  const emitLifecycle = (phase: string, detail: string, extra: Record<string, unknown> = {}) => {
    if (phase === currentPhase && phase !== "failed") return;
    const previous = currentPhase;
    currentPhase = phase;
    // Submission is emitted by the command handler after storing its summary.
    // `terminal: true` marks end-of-task lifecycle events (completed, agent
    // death, stop-interrupt) so machine consumers (one-shot `marina -p`) can
    // distinguish them from recoverable mid-run "failed" tool errors.
    const payload = {
      agent: handle.name,
      detail,
      phase,
      previous,
      ...(phase === "completed" ? { terminal: true } : {}),
      ...extra,
    };
    deps.db?.createCodingEvent({
      sessionId,
      actor: handle.name,
      kind: "code_lifecycle",
      payload,
    });
    notify(dispatcherId, detail, {
      code: {
        event: "code_lifecycle",
        metadata: payload,
        phase,
        sessionId,
        status: phase === "failed" ? "failed" : phase === "completed" ? "complete" : "active",
        title: `${handle.name}: ${phase.replace(/_/g, " ")}`,
        type: "lifecycle",
      },
    });
  };
  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    if (text) notify(dispatcherId, `${handle.name}: ${text}`);
  };
  const unsub = handle.subscribe((ev: AgentEvent) => {
    switch (ev.type) {
      case "tool_call":
        {
          const lifecycle = lifecycleForToolCall(ev.toolName, ev.args);
          if (lifecycle) {
            const extra: Record<string, unknown> = { tool: ev.toolName };
            emitLifecycle(lifecycle.phase, lifecycle.detail, extra);
          }
        }
        notify(dispatcherId, dim(`  ▸ ${formatAgentToolCall(ev.toolName, ev.args)}`));
        break;
      case "tool_result":
        if (ev.isError) {
          emitLifecycle("failed", `${handle.name} hit a tool error`, { tool: ev.toolName });
          notify(dispatcherId, `  ✗ ${ev.toolName}: ${clipLine(stringifyResult(ev.result))}`);
        }
        break;
      case "text_delta":
        buffer += ev.delta;
        break;
      case "turn_end":
        flush();
        break;
      case "error":
        notify(dispatcherId, `  ⚠ ${clipLine(ev.error)}`);
        break;
      case "status_change":
        // The bound agent's handle died (stopped or errored out). If it was
        // still mid-task, surface a *terminal* failure so machine consumers
        // don't wait forever, then stop forwarding the dead handle.
        if (ev.status.state === "stopped" || ev.status.state === "error") {
          flush();
          if (
            currentPhase !== "completed" &&
            agentHasActiveCodingTask(deps, handle.name) &&
            !deps.db?.listCodingRuns({ sessionId, limit: 1 }).length
          ) {
            emitLifecycle("failed", `${handle.name} stopped before completing the task`, {
              reason: "agent_died",
              terminal: true,
            });
            clearCodingTask(deps, handle.name);
          }
          closeStream();
        }
        break;
    }
  });
  codeStreams.set(key, unsub);
}

function lifecycleForToolCall(
  toolName: string,
  args: Record<string, unknown>,
): { detail: string; phase: string } | undefined {
  const typed = toolName.replace(/^marina_code_/, "");
  const action =
    toolName === "marina_code" && typeof args.action === "string" ? args.action : typed;
  if (/^(session_status|list_files|read_file|search|diff|status|files|read)$/.test(action)) {
    return { phase: "inspecting", detail: "Inspecting the workspace and current changes" };
  }
  if (action === "plan") return { phase: "planning", detail: "Recording an implementation plan" };
  if (/^(patch|apply_patch|reject_patch|apply|reject)$/.test(action)) {
    return {
      phase: action.includes("apply") ? "applying" : "patching",
      detail: action.includes("apply")
        ? "Applying the reviewed patch"
        : "Preparing a reviewable patch",
    };
  }
  if (action === "approval") {
    return { phase: "awaiting_approval", detail: "Waiting for a recorded approval decision" };
  }
  if (/^(verify|run)$/.test(action)) {
    return { phase: "verifying", detail: "Running workspace verification" };
  }
  if (action === "summary") {
    return { phase: "submitting", detail: "Recording a summary for task review" };
  }
  return undefined;
}

/**
 * End the bound coder's task mode: clear the persisted `coding_task` entity
 * property and the adapter's in-memory task (which un-suppresses the normal
 * cognitive sections). Called on `code stop` and when the summary-artifact
 * submission succeeds. Best-effort — a missing handle/entity is fine.
 */
export function clearCodingTask(deps: CodeDeps, agentName: string): void {
  const handle = getAgentHandle(deps, agentName);
  handle?.setActiveCodingTask?.(null);
  const entity = findCodingAgentEntity(deps, agentName);
  if (entity && entity.properties[ACTIVE_TASK_KEY] !== undefined) {
    delete entity.properties[ACTIVE_TASK_KEY];
    deps.db?.saveEntity(entity);
  }
}

/** Resolve the bound coder's entity (handle-status id first, then name lookup
 *  tolerant of config-name vs sanitized-entity-name drift). */
function findCodingAgentEntity(deps: CodeDeps, agentName: string): Entity | undefined {
  const handle = getAgentHandle(deps, agentName);
  const entityId = handle?.getStatus().entityId;
  return (
    (entityId ? deps.getEntity(entityId) : undefined) ??
    deps.findAgentByName?.(agentName) ??
    deps.findAgentByName?.(sanitizeEntityName(agentName))
  );
}

/** True while the bound coder still carries a persisted `coding_task` — i.e.
 *  an assigned run is in flight (set on assign, cleared on stop/completion). */
export function agentHasActiveCodingTask(deps: CodeDeps, agentName: string): boolean {
  return findCodingAgentEntity(deps, agentName)?.properties[ACTIVE_TASK_KEY] !== undefined;
}

/** Tear down all live streams a dispatcher is watching (on exit / disconnect). */
export function stopCodeStreamsFor(entityId: EntityId): void {
  const suffix = `:${entityId}`;
  for (const [key, unsub] of codeStreams) {
    if (!key.endsWith(suffix)) continue;
    try {
      unsub();
    } catch {
      /* best-effort */
    }
    codeStreams.delete(key);
  }
}

function formatAgentToolCall(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "marina_code") {
    const action = typeof args.action === "string" ? args.action : "";
    const detail = (args.path ?? args.query ?? args.command ?? "") as unknown;
    const detailStr = typeof detail === "string" && detail ? ` ${clipLine(detail, 60)}` : "";
    return `code ${action}${detailStr}`.trim();
  }
  return toolName;
}

function clipLine(value: unknown, max = 120): string {
  const flat = String(value).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
