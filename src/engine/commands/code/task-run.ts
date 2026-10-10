// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentHandle } from "../../../agent/agent-types";
import {
  assessCodingVerification,
  codingRunClaim,
  codingRunMetadata,
  codingVerificationReadiness,
  codingVerificationUnchanged,
  endCodingRun,
  heartbeatCodingRun,
  submitCodingRun,
} from "../../../coding/task-run";
import { codingWorkerState } from "../../../coding/worker-state";
import { TaskManager } from "../../../coordination/task-manager";
import { recordTaskVerdict } from "../../../outcomes/live";
import type { CodingArtifactRow, MarinaDB } from "../../../persistence/database";
import type { Entity, EntityId, RoomContext } from "../../../types";
import { getErrorMessage } from "../../errors";
import { Logger } from "../../logger";
import {
  type CodeDeps,
  canAdoptCodingSession,
  getAgentHandle,
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
  const initialWorker = codingWorkerState(handle);
  const received = {
    runId: run.id,
    runStatus: run.status,
    phase: "received",
    verificationRequirement: meta.verificationRequirement,
    verificationReadiness: codingVerificationReadiness(deps.db, run),
    ...initialWorker,
  };
  deps.db.createCodingEvent({
    sessionId: run.session_id,
    actor: meta.ownerName,
    kind: "code_lifecycle",
    payload: received,
  });
  const owner = deps.findEntityExact?.(meta.ownerName) ?? deps.getEntity(meta.ownerKey);
  if (owner && sameEntityName(owner.name, meta.ownerName))
    deps.notify?.(owner.id, "Task received and queued for the coding agent.", {
      code: {
        event: "code_lifecycle",
        type: "lifecycle",
        sessionId: run.session_id,
        status: "active",
        phase: "received",
        title: "Task received",
        metadata: received,
      },
    });
  if (workerId)
    deps.logEvent?.({
      type: "task_claimed",
      entity: workerId as EntityId,
      taskId: meta.taskId,
      timestamp: Date.now(),
    });
  let closed = false;
  const stateKey = (worker: ReturnType<typeof codingWorkerState>) =>
    JSON.stringify([worker.workerState, worker.workerReason, worker.workerPauseKind]);
  let previousWorker = stateKey(initialWorker);
  const publishWorker = () => {
    const worker = codingWorkerState(handle);
    const key = stateKey(worker);
    if (key === previousWorker) return;
    previousWorker = key;
    const payload = { runId: run.id, runStatus: "active", ...worker };
    deps.db.createCodingEvent({
      sessionId: run.session_id,
      actor: meta.workerName,
      kind: "worker_state_changed",
      payload,
    });
    const currentOwner = deps.findEntityExact?.(meta.ownerName) ?? deps.getEntity(meta.ownerKey);
    const currentSession = deps.db.getCodingSession(run.session_id);
    if (
      currentOwner &&
      sameEntityName(currentOwner.name, meta.ownerName) &&
      currentSession &&
      canAdoptCodingSession(currentSession, currentOwner)
    )
      deps.notify?.(
        currentOwner.id,
        `Worker ${worker.workerState}${worker.workerReason ? `: ${worker.workerReason}` : "."}`,
        {
          code: {
            event: "worker_state_changed",
            type: "lifecycle",
            sessionId: run.session_id,
            status: "active",
            metadata: payload,
            commands: [`agent status ${handle.name}`, "code status", "code stop"],
          },
        },
      );
  };
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
    if (
      [
        "operator_status_change",
        "status_change",
        "error",
        "turn_start",
        "turn_end",
        "tool_call",
        "tool_result",
      ].includes(event.type)
    )
      publishWorker();
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
    ? meta.unverifiedAcceptance
      ? `Task #${meta.taskId} accepted by its owner without verified evidence: ${meta.unverifiedAcceptance.reason}. Recorded verification: ${meta.verification}.`
      : `Task #${meta.taskId} submitted for review. Recorded verification: ${meta.verification}.`
    : `Task #${meta.taskId} ${run.status}: ${meta.reason === "agent_died" ? "Worker stopped before submitting." : meta.reason}`;
  const payload = {
    runId: run.id,
    taskId: meta.taskId,
    agent: meta.workerName,
    phase: submitted ? "completed" : "failed",
    terminal: true,
    outcome: run.status,
    reason: meta.reason?.startsWith("Blocked:") ? "blocked" : meta.reason,
    summary,
    verification: meta.verification,
    verificationReason: meta.verificationReason,
    verificationId: meta.verificationId,
    candidateId: meta.candidateId,
    verificationObservedAt: meta.verificationObservedAt,
    summaryId: meta.summaryId,
    unverifiedAcceptance: meta.unverifiedAcceptance,
    verificationRequirement: meta.verificationRequirement,
    verificationReadiness: codingVerificationReadiness(deps.db, run),
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

export async function submitSessionRun(
  deps: CodeDeps & { db: MarinaDB },
  sessionId: string,
  worker: Entity,
  summary: CodingArtifactRow,
): Promise<CodingArtifactRow | undefined> {
  const run = await submitCodingRun(
    deps.db,
    sessionId,
    worker,
    summary,
    deps.getConnectionProtocol?.(worker.id) !== "telnet",
  );
  if (run?.status === "submitted") {
    deps.logEvent?.({
      type: "task_submitted",
      entity: worker.id,
      taskId: codingRunMetadata(run).taskId,
      timestamp: Date.now(),
    });
    publishCodingRun(deps, run);
  }
  return run;
}

/** Review remains the canonical task approval path, exposed within Code Mode. */
export async function reviewCodingRun(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): Promise<void> {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  if (!canAdoptCodingSession(session, entity)) {
    throw new Error("Coding session review is unavailable for this participant.");
  }
  const action =
    args[0] === "approve" || args[0] === "reject" || args[0] === "accept-unverified"
      ? args[0]
      : "show";
  const ref = action === "show" ? args[0] : args[1];
  const run = ref
    ? deps.db.getCodingArtifact(ref)
    : deps.db.listCodingRuns({ sessionId: session.id, limit: 1 })[0];
  if (run?.kind !== "task_run" || run.session_id !== session.id) {
    ctx.send(eid, "No task attempt found in this session. Use code do <task> first.");
    return;
  }
  const meta = codingRunMetadata(run);
  const assessment = await assessCodingVerification(
    deps.db,
    run,
    deps.getConnectionProtocol?.(eid) !== "telnet",
  );
  if (!codingVerificationUnchanged(deps.db, run, assessment.verificationId)) {
    throw new Error("The task or its evidence changed during review. Review it again.");
  }
  const current = deps.db.getCodingSession(session.id);
  const actor = deps.getEntity(eid);
  if (!current || !actor || !canAdoptCodingSession(current, actor)) return;
  Object.assign(meta, assessment);
  deps.db.updateCodingArtifact(run.id, { metadata: meta });
  const claim = codingRunClaim(deps.db, run);
  if (
    action === "approve" &&
    (meta.candidateId || meta.verificationRequirement) &&
    meta.verification !== "passed"
  ) {
    throw new Error(
      `Candidate approval withheld: verification is ${meta.verification}. ${meta.verificationReason ?? "Inspect the check output."} Reverify the intended source in a new attempt before approval.`,
    );
  }
  if (action === "accept-unverified") {
    const reason = args.slice(2).join(" ").trim();
    if (!reason || meta.ownerKey !== deps.db.durableEntityKey(eid))
      throw new Error(
        "Only the task owner may accept unverified work, with an explicit reason: code review accept-unverified <attempt> <reason>",
      );
    const summary = meta.summaryId ? deps.db.getCodingArtifact(meta.summaryId) : undefined;
    if (!summary || !claim || !["active", "submitted"].includes(run.status))
      throw new Error(
        "Unverified acceptance requires a saved worker summary on an active or submitted attempt.",
      );
    deps.db.transaction(() => {
      const tasks = new TaskManager(deps.db);
      if (
        run.status === "active" &&
        !tasks.submit(
          meta.taskId,
          claim.entity_id,
          `${summary.content_text}\n\nOwner accepted unverified work: ${reason}\nAttempt: artifact:${run.id}\nRecorded verification: ${meta.verification}`,
        )
      )
        throw new Error("The claim changed or expired; unverified work was not accepted.");
      if (!tasks.approveSubmission(meta.taskId, claim.entity_id, eid))
        throw new Error("Only the task creator can accept this submission.");
      meta.unverifiedAcceptance = { ownerKey: meta.ownerKey, reason, acceptedAt: Date.now() };
      deps.db.updateCodingArtifact(run.id, { status: "submitted", metadata: meta });
      deps.db.createCodingEvent({
        sessionId: session.id,
        actor: entity.name,
        kind: "task_run_accepted_unverified",
        payload: { ...meta, runId: run.id },
      });
    });
    // The owner's acceptance is a verdict like an approval (no event is emitted here).
    recordTaskVerdict(deps.db, {
      taskId: meta.taskId,
      claimant: deps.getEntity(claim.entity_id)?.name ?? meta.workerName ?? claim.entity_id,
      approved: true,
      at: meta.unverifiedAcceptance?.acceptedAt ?? Date.now(),
      detail: "accepted by the task's owner without verification",
    });
    if (run.status === "active") {
      publishCodingRun(deps, deps.db.getCodingArtifact(run.id)!);
      const handle = getAgentHandle(deps, meta.runtimeName ?? meta.workerName);
      if (handle && meta.workerKey !== deps.db.durableEntityKey(eid))
        await handle.reconfigure({}).catch((error) =>
          logger.warn("code", "Could not interrupt the accepted task's worker", {
            runId: run.id,
            error: getErrorMessage(error),
          }),
        );
    }
  } else if (action !== "show") {
    const tasks = new TaskManager(deps.db);
    const allowed =
      claim &&
      (action === "approve"
        ? tasks.approveSubmission(meta.taskId, claim.entity_id, eid)
        : tasks.rejectSubmission(meta.taskId, claim.entity_id, eid));
    if (!allowed) {
      ctx.send(eid, "Only the task creator can review a submitted task.");
      return;
    }
    deps.db.createCodingEvent({
      sessionId: session.id,
      actor: entity.name,
      kind: action === "approve" ? "task_run_approved" : "task_run_rejected",
      payload: {
        runId: run.id,
        taskId: meta.taskId,
        candidateId: meta.candidateId,
        verificationId: meta.verificationId,
        verification: meta.verification,
        observedAt: meta.verificationObservedAt,
        reviewerKey: deps.db.durableEntityKey(eid),
      },
    });
    deps.logEvent?.({
      type: action === "approve" ? "task_approved" : "task_rejected",
      entity: eid,
      taskId: meta.taskId,
      ...(claim.entity_name ? { claimantName: claim.entity_name } : {}),
      timestamp: Date.now(),
    });
  }
  const task = deps.db.getTask(meta.taskId);
  const currentRun = deps.db.getCodingArtifact(run.id)!;
  const currentClaim = codingRunClaim(deps.db, currentRun);
  const summary = meta.summaryId ? deps.db.getCodingArtifact(meta.summaryId) : undefined;
  const commands = [
    `code show ${run.id}`,
    ...(meta.summaryId ? [`code show ${meta.summaryId}`] : []),
    ...(meta.verificationId ? [`code show ${meta.verificationId}`] : []),
    ...(currentClaim?.status === "submitted" && meta.ownerKey === deps.db.durableEntityKey(eid)
      ? [`code review approve ${run.id}`, `code review reject ${run.id}`]
      : []),
  ];
  sendCode(
    ctx,
    eid,
    [
      `Task #${meta.taskId}: ${task?.title ?? run.title}`,
      `Attempt: ${run.id} (${currentRun.status})`,
      `Review: ${currentClaim?.status ?? "unknown"}`,
      `Recorded verification: ${meta.verification ?? "not yet submitted"}`,
      ...(meta.verificationObservedAt
        ? [`Observed: ${new Date(meta.verificationObservedAt).toISOString()}`]
        : []),
      ...(meta.candidateId ? [`Candidate: artifact:${meta.candidateId}`] : []),
      ...(meta.verificationReason ? [meta.verificationReason] : []),
      ...(meta.unverifiedAcceptance
        ? [`Accepted unverified by owner: ${meta.unverifiedAcceptance.reason}`]
        : []),
      summary?.content_text ?? run.content_text,
    ].join("\n"),
    {
      type: "artifact",
      event: "task_run_review",
      artifactId: run.id,
      artifactKind: "task_run",
      sessionId: session.id,
      title: run.title,
      status: currentClaim?.status ?? run.status,
      metadata: {
        ...meta,
        runId: run.id,
        taskStatus: task?.status,
        verificationReadiness: codingVerificationReadiness(deps.db, run, meta),
      },
      commands,
      content: summary?.content_text ?? run.content_text,
    },
  );
}

/** A blocked attempt releases its claim without declaring success or changing other agents. */
export function blockCodingRun(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const run = deps.db.listCodingRuns({ sessionId: session.id, status: "active", limit: 1 })[0];
  const reason = args.join(" ").trim();
  if (!run || !reason) throw new Error("Use code blocked <reason> on an active task.");
  const meta = codingRunMetadata(run);
  if (![meta.ownerKey, meta.workerKey].includes(deps.db.durableEntityKey(eid)))
    throw new Error("Only this task's owner or worker may report it blocked.");
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "handoff",
    title: "Task blocked",
    status: "complete",
    contentText: reason,
    createdBy: entity.name,
    metadata: { runId: run.id, reason: "blocked" },
  });
  const ended = endCodingRun(deps.db, run.id, "interrupted", `Blocked: ${reason}`);
  if (ended) publishCodingRun(deps, ended);
  sendCode(ctx, eid, `Task blocked; progress saved in ${artifact.id}. The claim is released.`, {
    event: "task_run_interrupted",
    type: "artifact",
    sessionId: session.id,
    status: "interrupted",
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    metadata: { runId: run.id, reason: "blocked", terminal: true, outcome: "interrupted" },
    commands: [`code review ${run.id}`],
  });
}
