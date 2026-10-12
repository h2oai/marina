// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentHandle } from "../../../agent/agent-types";
import { type BudgetForced, SPEND_STOP_EVENT_CONTEXT } from "../../../agent/budget-terminal";
import {
  assessCodingVerification,
  codingRunClaim,
  codingRunCrewMember,
  codingRunMetadata,
  codingVerificationReadiness,
  codingVerificationUnchanged,
  endCodingRun,
  heartbeatCodingRun,
  recordCodingAssumption,
  submitCodingRun,
  UNATTENDED_BLOCK_ANSWERS,
} from "../../../coding/task-run";
import { codingWorkerState } from "../../../coding/worker-state";
import { TaskManager } from "../../../coordination/task-manager";
import { harnessDecisionProvider } from "../../../decisions/engines";
import { judgeOpinion } from "../../../decisions/policy";
import { DecisionError, type DecisionProvider } from "../../../decisions/types";
import { decisionVerifyMode, verifySubmission } from "../../../decisions/verify";
import { recordTaskOpinion, recordTaskVerdict } from "../../../outcomes/live";
import type { CodingArtifactRow, MarinaDB } from "../../../persistence/database";
import type { CrewId, Entity, EntityId, RoomContext } from "../../../types";
import { getErrorMessage } from "../../errors";
import { Logger } from "../../logger";
import { dailyBudget } from "../../spend-ledger";
import {
  type CodeDeps,
  canAdoptCodingSession,
  formatCodingNoteTitle,
  getAgentHandle,
  resolveSession,
  sameEntityName,
  sendCode,
  updateCodeContext,
} from "./shared";
import { clearCodingTask } from "./stream";
import { workspaceForSession } from "./workspace";

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
  let spendStopped = false;
  const unsubscribe = handle.subscribe((event) => {
    if (closed) return;
    if (deps.db.getCodingArtifact(run.id)?.status !== "active") {
      unobserve(deps.db, run.id);
      return;
    }
    // The worker's runtime ran out of model budget: end the attempt like every
    // other budget — mechanically, once, with no further model call.
    if (event.type === "error" && event.context === SPEND_STOP_EVENT_CONTEXT) {
      if (spendStopped) return;
      spendStopped = true;
      const stop = endCodingRunForSpend(deps, run.id, handle, event.error).then(
        () => undefined,
        (error) =>
          logger.warn("code", "Could not end a coding attempt after a spend stop", {
            runId: run.id,
            error: getErrorMessage(error),
          }),
      );
      deps.trackBackground?.(stop);
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
      : `Task #${meta.taskId} submitted for review${meta.budgetForced ? (meta.budgetForced.reason === "spend" ? " when the model budget ran out (budget-forced best effort, submitted without a model call)" : " at its deadline (budget-forced best effort)") : ""}. Recorded verification: ${meta.verification}.`
    : `Task #${meta.taskId} ${run.status}: ${meta.reason === "agent_died" ? "Worker stopped before submitting." : meta.reason}`;
  const assumptions = (meta.assumptions ?? []).map(({ text, source }) => ({ text, source }));
  const payload = {
    runId: run.id,
    taskId: meta.taskId,
    agent: meta.workerName,
    phase: submitted ? "completed" : "failed",
    terminal: true,
    outcome: run.status,
    reason: meta.reason?.startsWith("Blocked:") ? "blocked" : meta.reason,
    ...(meta.reason?.startsWith("Blocked:") ? { detail: meta.reason } : {}),
    ...(assumptions.length ? { assumptions } : {}),
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
    ...(meta.requirements ? { requirements: meta.requirements } : {}),
    ...(meta.budgetForced ? { budgetForced: meta.budgetForced } : {}),
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
        title: assumptions.length
          ? `${detail} Assumptions recorded: ${assumptions.length}.`
          : detail,
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
  forCrew?: string,
  stop?: BudgetForced,
): Promise<CodingArtifactRow | undefined> {
  const run = await submitCodingRun(
    deps.db,
    sessionId,
    worker,
    summary,
    deps.getConnectionProtocol?.(worker.id) !== "telnet",
    forCrew,
    stop,
  );
  if (run?.status === "submitted") {
    deps.logEvent?.({
      type: "task_submitted",
      entity: worker.id,
      taskId: codingRunMetadata(run).taskId,
      timestamp: Date.now(),
    });
    publishCodingRun(deps, run);
    observeCodingSubmission(deps, run, worker, summary.content_text ?? "");
  }
  if (
    run &&
    forCrew !== undefined &&
    codingRunMetadata(run).workerKey !== deps.db.durableEntityKey(worker.id)
  )
    notifyCrewLead(deps, run, worker);
  return run;
}

/**
 * May `member` submit the session's active attempt for its crew? Members only:
 * the attempt must record a crew (crew driver with a contract), the member must
 * be on that recorded roster by durable key, AND still be on the live crew's
 * roster (a dissolved crew or a removed member is refused). No crew manager in
 * this process ⇒ refused. The lead submits normally and never needs this.
 */
export function crewSubmitAuthority(
  deps: CodeDeps & { db: MarinaDB },
  sessionId: string,
  member: Entity,
): { forCrew?: string } | { refusal: string } {
  const run = deps.db.listCodingRuns({ sessionId, status: "active", limit: 1 })[0];
  if (!run) return { refusal: "No active task attempt in this session to submit." };
  const meta = codingRunMetadata(run);
  const key = deps.db.durableEntityKey(member.id);
  if (meta.workerKey === key) return {};
  if (!meta.crew) return { refusal: `Task #${meta.taskId} has no crew; only its coder submits.` };
  const live = deps.crewManager?.get(meta.crew.id as CrewId);
  if (
    !codingRunCrewMember(meta, key) ||
    !live ||
    live.state === "dissolved" ||
    !live.members.some((m) => sameEntityName(m.agentName, member.name))
  )
    return {
      refusal: `Only a member of crew ${meta.crew.name} may submit task #${meta.taskId} for the crew.`,
    };
  return { forCrew: meta.crew.id };
}

/** Tell the lead that a crew member submitted (or tried to submit) its attempt. */
function notifyCrewLead(
  deps: CodeDeps & { db: MarinaDB },
  run: CodingArtifactRow,
  member: Entity,
): void {
  const meta = codingRunMetadata(run);
  const lead = deps.findEntityExact?.(meta.workerName) ?? deps.getEntity(meta.workerKey);
  if (!lead || !sameEntityName(lead.name, meta.workerName) || lead.id === member.id) return;
  const text =
    run.status === "submitted"
      ? `${member.name} submitted task #${meta.taskId} for crew ${meta.crew?.name ?? "?"}${meta.budgetForced ? " at its deadline (budget-forced best effort)" : ""}. Recorded verification: ${meta.verification}. The attempt is closed; stop working on it.`
      : `${member.name} tried to submit task #${meta.taskId} for the crew; it remains active. Recorded verification: ${meta.verification}.`;
  deps.notify?.(lead.id, text, {
    code: {
      event: "crew_member_submitted",
      type: "lifecycle",
      artifactId: run.id,
      artifactKind: "task_run",
      sessionId: run.session_id,
      status: run.status,
      title: text,
      metadata: {
        runId: run.id,
        taskId: meta.taskId,
        submittedBy: member.name,
        crew: meta.crew?.name,
        verification: meta.verification,
        ...(meta.budgetForced ? { budgetForced: meta.budgetForced } : {}),
      },
      commands: ["code status", `code show ${run.id}`],
    },
  });
}

/**
 * The submission verifier on a Code Mode submit (`MARINA_DECISION_VERIFY`,
 * default observe): the same judge `task submit` uses scores the submitted
 * summary in the background and its opinion is recorded beside the
 * submission (`judge_observations` + the task's outcome opinion), so its
 * agreement with the owner's verdict is measured. A Code Mode submission has
 * already passed its required checks, so the judge never bounces it — under
 * `on` too its opinion is advice; approval still decides. Never throws.
 *
 * A submission forced by a spend stop asks no model: the budget is spent, so
 * the verifier is treated as an outage (opinion `none`, never a pass).
 */
export function observeCodingSubmission(
  deps: CodeDeps & { db: MarinaDB },
  run: CodingArtifactRow,
  worker: Entity,
  summaryText: string,
): void {
  const mode = decisionVerifyMode();
  const configured = mode === "off" ? undefined : harnessDecisionProvider();
  if (!configured) return;
  const meta = codingRunMetadata(run);
  const task = deps.db.getTask(meta.taskId);
  if (!task) return;
  const provider: DecisionProvider =
    meta.budgetForced?.reason === "spend"
      ? {
          kind: configured.kind,
          model: configured.model,
          ...(configured.calibrated === undefined ? {} : { calibrated: configured.calibrated }),
          ask: async () => {
            throw new DecisionError(
              "not asked: the model spend budget ran out (spend stop)",
              "spend_cap",
              429,
            );
          },
        }
      : configured;
  const observation = verifySubmission(provider, task, summaryText, 1)
    .then((verdict) => {
      const evaluator = `${verdict.provider ?? provider.kind}:${verdict.model ?? provider.model}`;
      const opinion = verdict.error ? "none" : judgeOpinion(verdict.signals, ["delivered"]);
      deps.logEvent?.({
        type: "agent_decision",
        name: worker.name,
        stage: "verify",
        verdict: "observed",
        subject: `task #${meta.taskId}`,
        reason: verdict.reason,
        signals: verdict.signals,
        ...(verdict.provider ? { provider: verdict.provider } : {}),
        ...(verdict.model ? { model: verdict.model } : {}),
        ...(verdict.latencyMs === undefined ? {} : { latencyMs: verdict.latencyMs }),
        ...(verdict.costUsd === undefined ? {} : { costUsd: verdict.costUsd }),
        ...(verdict.error ? { error: verdict.error } : {}),
        timestamp: Date.now(),
      });
      deps.db.recordJudgeObservation({
        taskId: meta.taskId,
        claimantName: worker.name,
        evaluator,
        calibrated: provider.calibrated !== false,
        mode: "observe",
        opinion,
        signals: verdict.signals,
        ...(verdict.error ? { error: verdict.error.slice(0, 300) } : {}),
      });
      recordTaskOpinion(deps.db, {
        taskId: meta.taskId,
        claimant: worker.name,
        judge: evaluator,
        opinion,
      });
    })
    .catch((error) =>
      logger.warn("code", "Submission verifier opinion not recorded", {
        runId: run.id,
        error: getErrorMessage(error),
      }),
    );
  deps.trackBackground?.(observation);
}

/** Events that change the workspace by themselves (each names its paths). */
const WRITE_EVENTS: ReadonlySet<string> = new Set(["file_written", "file_edited", "patch_applied"]);
/** Events that MAY change the workspace; a non-empty diff confirms it. */
const MAYBE_WRITE_EVENTS: ReadonlySet<string> = new Set(["command_ran", "checkpoint_reverted"]);
const SPEND_SUMMARY_PATHS = 20;
const SPEND_SUMMARY_PRIOR_CHARS = 1500;

/** The `BudgetForced` label of a spend stop: today's dollars when Marina's own cap is what ran out. */
export function spendBudgetForced(): BudgetForced {
  const today = dailyBudget();
  return today && today.capUsd > 0 && today.spentUsd >= today.capUsd
    ? { reason: "spend", used: today.spentUsd, cap: today.capUsd, source: "spend-stop" }
    : { reason: "spend", used: 0, cap: 0, source: "spend-stop" };
}

/**
 * What this attempt changed in the workspace, from its own record: the paths
 * of its writes, edits and applied patches; else, when it ran commands, the
 * paths changed against HEAD, untracked included (`.gitignore` respected;
 * `git diff` where the workspace cannot list them). Empty ⇒ nothing to submit. Never
 * asks a model.
 */
export async function codingAttemptChanges(
  deps: CodeDeps & { db: MarinaDB },
  run: CodingArtifactRow,
): Promise<string[]> {
  const paths = new Set<string>();
  let mayHaveWritten = false;
  for (const event of deps.db.listCodingEvents(run.session_id, 5000)) {
    if (event.created_at < run.created_at) continue;
    if (!WRITE_EVENTS.has(event.kind) && !MAYBE_WRITE_EVENTS.has(event.kind)) continue;
    let payload: { runId?: unknown; path?: unknown; paths?: unknown };
    try {
      payload = JSON.parse(event.payload_json);
    } catch {
      continue; // an unreadable payload is not this attempt's write
    }
    if (payload.runId !== run.id) continue;
    if (!WRITE_EVENTS.has(event.kind)) {
      mayHaveWritten = true;
      continue;
    }
    const named = [
      ...(typeof payload.path === "string" ? [payload.path] : []),
      ...(Array.isArray(payload.paths)
        ? payload.paths.filter((p): p is string => typeof p === "string")
        : []),
    ];
    for (const p of named.length ? named : ["(unnamed change)"]) paths.add(p);
  }
  if (paths.size || !mayHaveWritten) return [...paths];
  const session = deps.db.getCodingSession(run.session_id);
  if (!session) return [];
  try {
    const workspace = workspaceForSession(deps, session);
    // Changed against HEAD, untracked files included (`.gitignore` respected).
    if (workspace.changedPaths) return await workspace.changedPaths();
    const diff = await workspace.diff();
    if (diff.exitCode !== 0 || !diff.content.trim()) return [];
    const files = [...diff.content.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!);
    return files.length ? [...new Set(files)] : ["(workspace diff)"];
  } catch (error) {
    logger.warn("code", "Could not read the workspace diff after a spend stop", {
      runId: run.id,
      error: getErrorMessage(error),
    });
    return [];
  }
}

/** The submission text for a spend stop, assembled from the attempt's record (no model). */
function spendStopSummary(
  deps: CodeDeps & { db: MarinaDB },
  run: CodingArtifactRow,
  changed: string[],
  reason: string,
): string {
  const meta = codingRunMetadata(run);
  const prior = meta.summaryId
    ? deps.db.getCodingArtifact(meta.summaryId)?.content_text?.trim()
    : undefined;
  const shown = changed.slice(0, SPEND_SUMMARY_PATHS);
  const more = changed.length - shown.length;
  return [
    "Budget-forced (spend): the model spend budget ran out before the worker submitted. This summary was assembled mechanically from the attempt's record; no model call was made.",
    `Stop: ${reason.replace(/\s+/g, " ").slice(0, 200)}`,
    `Changed in this attempt: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`,
    ...(prior
      ? [`Worker's last saved summary: ${prior.slice(0, SPEND_SUMMARY_PRIOR_CHARS)}`]
      : ["The worker saved no summary of its own."]),
    "Not established: whether the task is complete. Review the diff and the recorded verification.",
  ].join("\n");
}

/**
 * A spend stop (`SPEND_STOP_EVENT_CONTEXT` from the worker's runtime) ends
 * the attempt the way every budget ends — in an answer. With changes in the
 * workspace, the work is submitted for review, labelled `budgetForced`
 * (`reason: "spend"`), with a summary assembled without a model and whatever
 * verification is recorded (never reported as verified unless its checks
 * passed). With nothing to submit, the attempt ends blocked (`kind:impossible`,
 * same label). Returns what happened, or undefined when the attempt was no
 * longer active. Makes no model call.
 */
export async function endCodingRunForSpend(
  deps: CodeDeps & { db: MarinaDB },
  runId: string,
  handle: Pick<AgentHandle, "getStatus">,
  reason: string,
): Promise<"submitted" | "blocked" | undefined> {
  const run = deps.db.getCodingArtifact(runId);
  if (run?.kind !== "task_run" || run.status !== "active") return undefined;
  const meta = codingRunMetadata(run);
  const stop = spendBudgetForced();
  const workerId = handle.getStatus().entityId;
  const worker = workerId ? deps.getEntity(workerId) : undefined;
  const changed = await codingAttemptChanges(deps, run);
  if (changed.length && worker) {
    const summary = deps.db.createCodingArtifact({
      sessionId: run.session_id,
      kind: "summary",
      title: formatCodingNoteTitle("summary", "Budget-forced (spend): work in the workspace"),
      status: "complete",
      contentText: spendStopSummary(deps, run, changed, reason),
      metadata: {
        profile: meta.profile,
        runId: run.id,
        taskId: meta.taskId,
        workspaceEventId: meta.workspaceEventId,
        budgetForced: stop,
      },
      createdBy: worker.name,
    });
    deps.db.createCodingEvent({
      sessionId: run.session_id,
      actor: worker.name,
      kind: "summary_recorded",
      payload: { id: summary.id, runId: run.id, budgetForced: stop },
    });
    try {
      const submitted = await submitSessionRun(
        deps,
        run.session_id,
        worker,
        summary,
        undefined,
        stop,
      );
      if (submitted?.status === "submitted") return "submitted";
    } catch (error) {
      logger.warn("code", "Spend-stop submission failed; ending the attempt blocked", {
        runId: run.id,
        error: getErrorMessage(error),
      });
    }
  }
  const note = `BudgetForced: the model budget is exhausted (${reason.slice(0, 120).replace(/\s+/g, " ")}); ${changed.length ? "the work could not be submitted and stays in the workspace" : "nothing in the workspace to submit"}`;
  deps.db.createCodingArtifact({
    sessionId: run.session_id,
    kind: "handoff",
    title: "Task blocked",
    status: "complete",
    contentText: note,
    createdBy: worker?.name ?? meta.workerName,
    metadata: { runId: run.id, reason: "blocked", blockKind: "impossible", budgetForced: stop },
  });
  const ended = endCodingRun(deps.db, run.id, "interrupted", `Blocked: ${note}`, stop);
  if (!ended) return undefined;
  publishCodingRun(deps, ended);
  return "blocked";
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
      `${meta.verificationRequirement === "checks" ? "Approval" : "Candidate approval"} withheld: verification is ${meta.verification}. ${meta.verificationReason ?? "Inspect the check output."} Reverify the intended source in a new attempt before approval.`,
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

/** A leading `kind:<decision|impossible>` (also `kind=`, `--kind <v>`) on `code blocked`. */
function blockKind(args: string[]): { kind: "decision" | "impossible"; rest: string[] } {
  const [first = "", second] = args;
  const inline = /^(?:--)?kind[:=](\w+)$/i.exec(first)?.[1];
  const value = inline ?? (first.toLowerCase() === "--kind" ? second : undefined);
  if (value === undefined) return { kind: "decision", rest: args };
  const kind = value.toLowerCase();
  if (kind !== "decision" && kind !== "impossible")
    throw new Error("Use code blocked [kind:decision|impossible] <reason>.");
  return { kind, rest: args.slice(inline !== undefined ? 1 : 2) };
}

/**
 * A blocked attempt releases its claim without declaring success or changing other agents.
 *
 * On an owner-unattended attempt (`code do owner:unattended`, the headless `-p` path) nobody can
 * answer, so a worker's block about a decision a person would make (ambiguity, conflicting
 * requirements, an in-scope choice) is answered at once: proceed on the most defensible
 * interpretation, recorded as an assumption. The answer carries no authority: no gate,
 * permission, install or command policy changes. `kind:impossible`, or a block past
 * {@link UNATTENDED_BLOCK_ANSWERS} answers, ends the attempt; work already produced stays.
 */
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
  const { kind, rest } = blockKind(args);
  const reason = rest.join(" ").trim();
  if (!run || !reason) throw new Error("Use code blocked <reason> on an active task.");
  const meta = codingRunMetadata(run);
  const callerKey = deps.db.durableEntityKey(eid);
  if (![meta.ownerKey, meta.workerKey].includes(callerKey))
    throw new Error("Only this task's owner or worker may report it blocked.");
  const answered = meta.blocksAnswered ?? 0;
  const unattendedDecision =
    meta.ownerMode === "unattended" && callerKey === meta.workerKey && kind === "decision";
  if (unattendedDecision && answered < UNATTENDED_BLOCK_ANSWERS) {
    answerUnattendedBlock(ctx, eid, entity, deps, session.id, run, reason, answered + 1);
    return;
  }
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "handoff",
    title: "Task blocked",
    status: "complete",
    contentText: reason,
    createdBy: entity.name,
    metadata: { runId: run.id, reason: "blocked", blockKind: kind },
  });
  const suffix = unattendedDecision ? ` (after ${answered} automatic answers)` : "";
  const ended = endCodingRun(deps.db, run.id, "interrupted", `Blocked: ${reason}${suffix}`);
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

function answerUnattendedBlock(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  sessionId: string,
  run: CodingArtifactRow,
  reason: string,
  answer: number,
): void {
  const left = UNATTENDED_BLOCK_ANSWERS - answer;
  const assumption = `Unanswered (no person attends this task): ${reason} — proceeding on the most defensible interpretation of the request.`;
  const directive = [
    "No person can answer during this unattended task, so this block is answered now.",
    "Choose the most defensible interpretation of the request (what its stated goals most plausibly require), record it with code assume <interpretation>, and continue to delivery.",
    "This answer grants no authority: gates, permissions, installs and the command policy are unchanged. Work without what is not allowed where possible, and record what you skipped with code assume.",
    `Use code blocked kind:impossible <reason> only when required data, credentials or a working environment are missing. ${left > 0 ? `${left} more block${left === 1 ? "" : "s"} will be answered this way; the one after that` : "The next block"} ends the task. Work already produced stays in the workspace.`,
  ].join(" ");
  const artifact = deps.db.createCodingArtifact({
    sessionId,
    kind: "assumption",
    title: "Block answered: proceeding on an assumption",
    status: "complete",
    contentText: `${assumption}\n\n${directive}`,
    createdBy: entity.name,
    metadata: { runId: run.id, source: "block", blockReason: reason, answer },
  });
  const meta = recordCodingAssumption(
    deps.db,
    run.id,
    { text: assumption, source: "block", artifactId: artifact.id },
    (next) => {
      next.blocksAnswered = answer;
    },
  );
  if (!meta) throw new Error("Use code blocked <reason> on an active task.");
  const payload = {
    runId: run.id,
    taskId: meta.taskId,
    answer,
    answersLeft: left,
    reason,
    artifactId: artifact.id,
  };
  deps.db.createCodingEvent({
    sessionId,
    actor: entity.name,
    kind: "task_run_block_answered",
    payload,
  });
  const message = {
    type: "lifecycle" as const,
    event: "task_run_block_answered",
    sessionId,
    status: "active",
    artifactId: artifact.id,
    artifactKind: artifact.kind,
    title: "Block answered automatically",
    content: directive,
    metadata: payload,
    commands: ["code assume <interpretation>", "code status"],
  };
  sendCode(ctx, eid, directive, message);
  const owner = deps.findEntityExact?.(meta.ownerName) ?? deps.getEntity(meta.ownerKey);
  if (owner && owner.id !== eid && sameEntityName(owner.name, meta.ownerName))
    deps.notify?.(owner.id, `Worker block answered automatically (unattended): ${reason}`, {
      code: message,
    });
}

/** `code assume <interpretation>` — record an assumption on the active attempt. */
export function assumeCodingRun(
  ctx: RoomContext,
  eid: EntityId,
  entity: Entity,
  deps: CodeDeps & { db: MarinaDB },
  args: string[],
): void {
  const session = resolveSession(ctx, eid, entity, deps.db);
  if (!session) return;
  const run = deps.db.listCodingRuns({ sessionId: session.id, status: "active", limit: 1 })[0];
  const text = args.join(" ").trim();
  if (!run || !text) throw new Error("Use code assume <interpretation> on an active task.");
  const meta = codingRunMetadata(run);
  if (![meta.ownerKey, meta.workerKey].includes(deps.db.durableEntityKey(eid)))
    throw new Error("Only this task's owner or worker may record its assumptions.");
  const artifact = deps.db.createCodingArtifact({
    sessionId: session.id,
    kind: "assumption",
    title: `Assumption: ${text.length > 64 ? `${text.slice(0, 61)}...` : text}`,
    status: "complete",
    contentText: text,
    createdBy: entity.name,
    metadata: { runId: run.id, source: "worker" },
  });
  const updated = recordCodingAssumption(deps.db, run.id, {
    text,
    source: "worker",
    artifactId: artifact.id,
  });
  if (!updated) throw new Error("Use code assume <interpretation> on an active task.");
  deps.db.createCodingEvent({
    sessionId: session.id,
    actor: entity.name,
    kind: "assumption_recorded",
    payload: { runId: run.id, artifactId: artifact.id, text },
  });
  sendCode(
    ctx,
    eid,
    `Assumption recorded (${updated.assumptions?.length ?? 1}); it appears in the completion receipt.`,
    {
      type: "note",
      event: "assumption_recorded",
      sessionId: session.id,
      status: "complete",
      artifactId: artifact.id,
      artifactKind: artifact.kind,
      content: text,
      metadata: { runId: run.id },
      commands: [`code show ${artifact.id}`],
    },
  );
}
