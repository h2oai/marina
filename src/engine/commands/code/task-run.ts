// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentHandle } from "../../../agent/agent-types";
import {
  codingRunMetadata,
  endCodingRun,
  heartbeatCodingRun,
  submitCodingRun,
} from "../../../coding/task-run";
import { TaskManager } from "../../../coordination/task-manager";
import type { CodingArtifactRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { getErrorMessage } from "../../errors";
import { Logger } from "../../logger";
import {
  type CodeDeps,
  resolveSession,
  sameEntityName,
  sendCode,
  updateCodeContext,
} from "./shared";
import { clearCodingTask } from "./stream";

const logger = new Logger();
const observers = new WeakMap<MarinaDB, Map<string, () => void>>();

function unobserve(db: MarinaDB, id: string): void {
  observers.get(db)?.get(id)?.();
  observers.get(db)?.delete(id);
}

/** Observes the attempt independently of the operator's terminal connection. */
export function observeCodingRun(
  deps: CodeDeps & { db: MarinaDB },
  run: CodingArtifactRow,
  handle: AgentHandle,
): void {
  let entries = observers.get(deps.db);
  if (!entries) {
    entries = new Map();
    observers.set(deps.db, entries);
  }
  if (entries.has(run.id)) return;
  const meta = codingRunMetadata(run);
  const workerId = handle.getStatus().entityId;
  if (workerId)
    deps.logEvent?.({
      type: "task_claimed",
      entity: workerId as EntityId,
      taskId: meta.taskId,
      timestamp: Date.now(),
    });
  let closed = false;
  const unsubscribe = handle.subscribe((event) => {
    if (closed) return;
    if (deps.db.getCodingArtifact(run.id)?.status !== "active") {
      unobserve(deps.db, run.id);
      return;
    }
    if (event.type === "status_change" && ["stopped", "error"].includes(event.status.state)) {
      const ended = endCodingRun(deps.db, run.id, "failed", "agent_died");
      if (ended) publishCodingRun(deps, ended);
      return;
    }
    if (event.type === "tool_call" || event.type === "tool_result" || event.type === "turn_end") {
      const claim = heartbeatCodingRun(deps.db, run);
      if (!claim) {
        const ended = endCodingRun(
          deps.db,
          run.id,
          "interrupted",
          "Task claim was released or expired; execution was not automatically replayed.",
        );
        if (ended) {
          publishCodingRun(deps, ended);
          void handle.reconfigure({}).catch((error) => {
            logger.warn("code", "Could not interrupt a worker after its task claim ended", {
              runId: run.id,
              error: getErrorMessage(error),
            });
          });
        }
        return;
      }
      deps.db.createCodingEvent({
        sessionId: run.session_id,
        actor: handle.name,
        kind: "task_run_progress",
        payload: {
          runId: run.id,
          taskId: meta.taskId,
          event: event.type,
          ...(event.type !== "turn_end" ? { tool: event.toolName } : {}),
          ...(event.type === "tool_result" ? { isError: event.isError } : {}),
        },
      });
    }
  });
  entries.set(run.id, () => {
    closed = true;
    unsubscribe();
  });
}

export function publishCodingRun(deps: CodeDeps & { db: MarinaDB }, run: CodingArtifactRow): void {
  unobserve(deps.db, run.id);
  const meta = codingRunMetadata(run);
  clearCodingTask(deps, meta.runtimeName ?? meta.workerName);
  const submitted = run.status === "submitted";
  const summary = meta.summaryId
    ? deps.db.getCodingArtifact(meta.summaryId)?.content_text
    : undefined;
  const detail = submitted
    ? `Task #${meta.taskId} submitted for review. Recorded verification: ${meta.verification}.`
    : `Task #${meta.taskId} ${run.status}: ${meta.reason === "agent_died" ? "Worker stopped before submitting." : meta.reason}`;
  const payload = {
    runId: run.id,
    taskId: meta.taskId,
    agent: meta.workerName,
    phase: submitted ? "completed" : "failed",
    terminal: true,
    outcome: run.status,
    reason: meta.reason,
    summary,
    verification: meta.verification,
    verificationId: meta.verificationId,
    summaryId: meta.summaryId,
  };
  deps.db.createCodingEvent({
    sessionId: run.session_id,
    actor: meta.workerName,
    kind: "code_lifecycle",
    payload,
  });
  const owner = deps.findEntityExact?.(meta.ownerName) ?? deps.getEntity(meta.ownerKey);
  if (owner && sameEntityName(owner.name, meta.ownerName)) {
    updateCodeContext(owner, deps.db, deps.db.getCodingSession(run.session_id) ?? undefined);
    deps.notify?.(owner.id, detail, {
      code: {
        event: "code_lifecycle",
        type: "lifecycle",
        artifactId: run.id,
        artifactKind: "task_run",
        sessionId: run.session_id,
        status: run.status,
        phase: payload.phase,
        title: detail,
        metadata: payload,
        commands: [`code review ${run.id}`, `code show ${run.id}`],
      },
    });
  }
}

export function submitSessionRun(
  deps: CodeDeps & { db: MarinaDB },
  sessionId: string,
  worker: Entity,
  summary: CodingArtifactRow,
): void {
  const run = submitCodingRun(deps.db, sessionId, worker, summary);
  if (run) {
    deps.logEvent?.({
      type: "task_submitted",
      entity: worker.id,
      taskId: codingRunMetadata(run).taskId,
      timestamp: Date.now(),
    });
    publishCodingRun(deps, run);
  }
}

/** Review remains the canonical task approval path, exposed within Code Mode. */
export function reviewCodingRun(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const action = args[0] === "approve" || args[0] === "reject" ? args[0] : "show";
  const ref = action === "show" ? args[0] : args[1];
  const run = ref
    ? deps.db.getCodingArtifact(ref)
    : deps.db.listCodingRuns({ sessionId: session.id, limit: 1 })[0];
  if (run?.kind !== "task_run" || run.session_id !== session.id) {
    ctx.send(eid, "No task attempt found in this session. Use code do <task> first.");
    return;
  }
  const meta = codingRunMetadata(run);
  if (action !== "show") {
    const tasks = new TaskManager(deps.db);
    const allowed =
      action === "approve"
        ? tasks.approveSubmission(meta.taskId, meta.workerKey, eid)
        : tasks.rejectSubmission(meta.taskId, meta.workerKey, eid);
    if (!allowed) {
      ctx.send(eid, "Only the task creator can review a submitted task.");
      return;
    }
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: action === "approve" ? "task_run_approved" : "task_run_rejected",
      payload: { runId: run.id, taskId: meta.taskId },
    });
    deps.logEvent?.({
      type: action === "approve" ? "task_approved" : "task_rejected",
      entity: eid,
      taskId: meta.taskId,
      timestamp: Date.now(),
    });
  }
  const task = deps.db.getTask(meta.taskId);
  const claim = deps.db.getTaskClaim(meta.taskId, meta.workerKey);
  const summary = meta.summaryId ? deps.db.getCodingArtifact(meta.summaryId) : undefined;
  const commands = [
    `code show ${run.id}`,
    ...(meta.summaryId ? [`code show ${meta.summaryId}`] : []),
    ...(meta.verificationId ? [`code show ${meta.verificationId}`] : []),
    ...(claim?.status === "submitted" && meta.ownerKey === deps.db.durableEntityKey(eid)
      ? [`code review approve ${run.id}`, `code review reject ${run.id}`]
      : []),
  ];
  sendCode(
    ctx,
    eid,
    [
      `Task #${meta.taskId}: ${task?.title ?? run.title}`,
      `Attempt: ${run.id} (${run.status})`,
      `Review: ${claim?.status ?? "unknown"}`,
      `Recorded verification: ${meta.verification ?? "not yet submitted"}`,
      summary?.content_text ?? run.content_text,
    ].join("\n"),
    {
      type: "artifact",
      event: "task_run_review",
      artifactId: run.id,
      artifactKind: "task_run",
      sessionId: session.id,
      title: run.title,
      status: claim?.status ?? run.status,
      metadata: { ...meta, runId: run.id, taskStatus: task?.status },
      commands,
      content: summary?.content_text ?? run.content_text,
    },
  );
}
