// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { realpath } from "node:fs/promises";
import { TaskManager } from "../coordination/task-manager";
import { sanitizeEntityName } from "../engine/entity-name";
import { getErrorMessage } from "../engine/errors";
import { codingRunContext } from "../persistence/coding-run-context";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../persistence/database";
import type { Entity, EntityId } from "../types";
import { CANDIDATE_POLICY, type CandidateIdentity, observeCandidate } from "./candidate";
import { candidateVerificationRetry } from "./verification-plan";

export interface CodingRunMetadata {
  version: 1;
  taskId: number;
  ownerKey: string;
  ownerName: string;
  workerKey: string;
  /** Exact canonical task-claim row; unlike workerKey, this may be a transient entity id. */
  claimantId?: string;
  workerName: string;
  runtimeName?: string;
  profile: string;
  modelTarget?: string;
  workspace: string;
  executionTarget: string;
  workspaceEventId?: string;
  summaryId?: string;
  /** Frozen owner intent for this attempt; omission preserves ordinary task behavior. */
  verificationRequirement?: "candidate" | "checks";
  /** Owner preauthorizes only its active worker to reclaim an owner-held lock. */
  ownerMode?: "unattended";
  unverifiedAcceptance?: { ownerKey: string; reason: string; acceptedAt: number };
  verificationId?: string;
  verification?:
    | "passed"
    | "failed"
    | "not_run"
    | "error"
    | "missing"
    | "stale"
    | "unbound"
    | "unavailable";
  candidateId?: string;
  verificationObservedAt?: number;
  verificationReason?: string;
  reason?: string;
}

export function codingRunMetadata(run: CodingArtifactRow): CodingRunMetadata {
  return JSON.parse(run.metadata_json) as CodingRunMetadata;
}

/** Resolve the canonical claim without confusing its row key with account authority.
 * Older attempts lack the row reference; accept only an exact or durable identity match. */
export function codingRunClaim(db: MarinaDB, run: CodingArtifactRow) {
  const meta = codingRunMetadata(run);
  if (meta.claimantId) return db.getTaskClaim(meta.taskId, meta.claimantId);
  return (
    db.getTaskClaim(meta.taskId, meta.workerKey) ??
    db
      .getTaskClaims(meta.taskId)
      .find((claim) => db.durableEntityKey(claim.entity_id) === meta.workerKey)
  );
}

/** Called before delivering attention, so even an immediate reply has an attempt. */
export function beginCodingRun(
  db: MarinaDB,
  input: {
    session: CodingSessionRow;
    owner: Entity;
    worker: Entity;
    prompt: string;
    profile: string;
    modelTarget?: string;
    runtimeName?: string;
    verificationRequirement?: "candidate" | "checks";
    /** Owner preauthorizes only its active worker to reclaim an owner-held lock. */
    ownerMode?: "unattended";
  },
): CodingArtifactRow {
  return db.transaction(() => {
    if (
      sanitizeEntityName(input.owner.name).toLowerCase() !==
      sanitizeEntityName(input.session.created_by).toLowerCase()
    ) {
      throw new Error("Only the coding session creator may dispatch its task.");
    }
    if (input.verificationRequirement === "candidate" && input.session.execution_target !== "local")
      throw new Error("Candidate-required tasks need a local Git workspace.");
    const workerKey = db.durableEntityKey(input.worker.id);
    const ownerKey = db.durableEntityKey(input.owner.id);
    const active = db.listCodingRuns({
      sessionId: input.session.id,
      status: "active",
      limit: 1,
    })[0];
    if (active) {
      const meta = codingRunMetadata(active);
      if (meta.workerKey !== workerKey || meta.ownerKey !== ownerKey) {
        throw new Error(
          "This coding session already has an active task. Stop it before changing workers.",
        );
      }
      if (
        input.verificationRequirement &&
        meta.verificationRequirement !== input.verificationRequirement
      )
        throw new Error(
          "This attempt's verification contract is already set. Stop it before changing the verification requirement.",
        );
      if (input.ownerMode && meta.ownerMode !== input.ownerMode)
        throw new Error(
          "This attempt's owner contract is already set. Stop it before changing it.",
        );
      if (!heartbeatCodingRun(db, active)) {
        throw new Error(
          "The task claim is no longer active. Stop this attempt before starting another.",
        );
      }
      db.createCodingEvent({
        sessionId: input.session.id,
        actor: input.owner.name,
        kind: "task_run_steered",
        payload: { runId: active.id, taskId: meta.taskId, text: input.prompt },
      });
      bindRunContext(active);
      return active;
    }
    if (db.listCodingRuns({ workerKey, status: "active", limit: 1 }).length) {
      throw new Error("This worker already has an active coding task in another session.");
    }
    const tasks = new TaskManager(db);
    const task = tasks.create({
      title: input.prompt.slice(0, 160),
      description: input.prompt,
      creatorId: input.owner.id,
      creatorName: input.owner.name,
    });
    const claim = tasks.claim(task.id, input.worker.id, input.worker.name);
    if (!claim) {
      throw new Error("Could not claim the coding task.");
    }
    const metadata: CodingRunMetadata = {
      version: 1,
      taskId: task.id,
      ownerKey,
      ownerName: input.owner.name,
      workerKey,
      claimantId: claim.entityId,
      workerName: input.worker.name,
      runtimeName: input.runtimeName,
      profile: input.profile,
      modelTarget: input.modelTarget,
      workspace: input.session.workspace_root,
      executionTarget: input.session.execution_target,
      verificationRequirement: input.verificationRequirement,
      ownerMode: input.ownerMode,
    };
    const run = db.createCodingArtifact({
      sessionId: input.session.id,
      kind: "task_run",
      title: `Task #${task.id}: ${task.title}`,
      status: "active",
      contentText: input.prompt,
      metadata,
      createdBy: input.owner.name,
    });
    db.createCodingEvent({
      sessionId: input.session.id,
      actor: input.owner.name,
      kind: "task_run_started",
      payload: { runId: run.id, ...metadata },
    });
    bindRunContext(run);
    return run;
  });
}

/** Required checks gate submission. An early summary remains durable progress on the same attempt. */
export async function submitCodingRun(
  db: MarinaDB,
  sessionId: string,
  worker: Entity,
  summary: CodingArtifactRow,
  allowHostObservation = true,
): Promise<CodingArtifactRow | undefined> {
  const initial = db.listCodingRuns({ sessionId, status: "active", limit: 1 })[0];
  if (!initial || codingRunMetadata(initial).workerKey !== db.durableEntityKey(worker.id))
    return undefined;
  if (summary.session_id !== sessionId || JSON.parse(summary.metadata_json).runId !== initial.id)
    return undefined;
  const assessed = await assessCodingVerification(db, initial, allowHostObservation);
  return db.transaction(() => {
    const run = db.listCodingRuns({ sessionId, status: "active", limit: 1 })[0];
    if (!run || run.id !== initial.id) return undefined;
    const meta = codingRunMetadata(run);
    const origin = JSON.parse(summary.metadata_json) as { runId?: string };
    if (summary.session_id !== sessionId || origin.runId !== run.id) return undefined;
    if (meta.workerKey !== db.durableEntityKey(worker.id)) return undefined;
    const tasks = new TaskManager(db);
    const verification = latestVerification(db, run.id);
    if (!codingVerificationUnchanged(db, initial, assessed.verificationId))
      throw new Error(
        "Verification evidence changed during submission. Inspect it and submit again.",
      );
    meta.summaryId = summary.id;
    Object.assign(meta, assessed);
    if (meta.verificationRequirement && meta.verification !== "passed") {
      db.updateCodingArtifact(run.id, { metadata: meta });
      db.createCodingEvent({
        sessionId,
        actor: worker.name,
        kind: "verification_required",
        payload: { runId: run.id, summaryId: summary.id, ...meta },
      });
      return db.getCodingArtifact(run.id)!;
    }
    const evidence = `${summary.content_text}\n\nCoding attempt: artifact:${run.id}\nSummary: artifact:${summary.id}\nRecorded verification: ${meta.verification}${verification ? ` (artifact:${verification.id})` : ""}`;
    const claim = codingRunClaim(db, run);
    if (!claim || !tasks.submit(meta.taskId, claim.entity_id, evidence)) {
      throw new Error(
        "The coding task claim expired or changed; its summary was saved but could not be submitted.",
      );
    }
    db.updateCodingArtifact(run.id, { status: "submitted", metadata: meta });
    db.createCodingEvent({
      sessionId,
      actor: worker.name,
      kind: "task_run_submitted",
      payload: { runId: run.id, ...meta, taskStatus: "submitted" },
    });
    return db.getCodingArtifact(run.id)!;
  });
}

function latestVerification(db: MarinaDB, runId: string) {
  return db
    .listCodingRunArtifacts(runId)
    .find(
      (artifact) => artifact.kind === "verification" || artifact.kind === "verification_request",
    );
}

/** UI projection of a fresh assessment, never a substitute for the submission check. */
export function codingVerificationReadiness(
  db: MarinaDB,
  run: CodingArtifactRow,
  meta = codingRunMetadata(run),
) {
  if (latestVerification(db, run.id)?.status === "running") return "running" as const;
  if (meta.verification === "passed") return "ready" as const;
  if (meta.verification === "not_run") return "not-run" as const;
  if (meta.verification && meta.verification !== "missing") return "needs-attention" as const;
  return meta.verificationRequirement ? ("required" as const) : undefined;
}

/** No async observation may overwrite a concurrent attempt/evidence transition. */
export function codingVerificationUnchanged(
  db: MarinaDB,
  run: CodingArtifactRow,
  verificationId?: string,
) {
  const current = db.getCodingArtifact(run.id);
  return (
    current?.metadata_json === run.metadata_json &&
    current.status === run.status &&
    latestVerification(db, run.id)?.id === verificationId
  );
}

/** Explicit observation, never a promise that a mutable working tree stays verified.
 * Live/legacy checks retain their output but cannot manufacture immutable evidence. */
export async function assessCodingVerification(
  db: MarinaDB,
  run: CodingArtifactRow,
  allowHostObservation = true,
) {
  const meta = codingRunMetadata(run);
  const verification = latestVerification(db, run.id);
  const result: Pick<
    CodingRunMetadata,
    | "verification"
    | "verificationId"
    | "candidateId"
    | "verificationObservedAt"
    | "verificationReason"
  > = {
    verification: "missing",
    verificationId: verification?.id,
    candidateId: undefined,
    verificationObservedAt: Date.now(),
    verificationReason: undefined,
  };
  if (!verification)
    return {
      ...result,
      verificationReason: `No required checks recorded. Run ${meta.verificationRequirement === "checks" ? "code verify" : "code verify candidate"}, inspect its result, then submit a summary.`,
    };
  if (verification.kind === "verification_request" && verification.status === "running")
    return {
      ...result,
      verificationReason: `Checks are still running. Inspect code show ${verification.id}; wait for the result before resubmitting.`,
    };
  const evidence = JSON.parse(verification.metadata_json) as Record<string, unknown>;
  const candidateRetry = candidateVerificationRetry(evidence.verificationOptions);
  const retry =
    meta.verificationRequirement === "checks" && !evidence.candidateId
      ? candidateRetry.replace("code verify candidate", "code verify")
      : candidateRetry;
  result.candidateId = typeof evidence.candidateId === "string" ? evidence.candidateId : undefined;
  // Checks that never ran (or whose runner broke) are neither a pass nor a failure.
  if (verification.status === "not_run" || verification.status === "error")
    return {
      ...result,
      verification: verification.status as "not_run" | "error",
      verificationReason:
        typeof evidence.outcomeReason === "string"
          ? evidence.outcomeReason
          : verification.status === "not_run"
            ? "Checks were not run."
            : "Verification infrastructure failed.",
    };
  if (verification.status !== "complete")
    return {
      ...result,
      verification: "failed" as const,
      verificationReason: `Inspect code show ${verification.id}, fix the failed checks, then run ${retry}.`,
    };
  if (!evidence.candidateId && evidence.workspaceEventId !== meta.workspaceEventId)
    return {
      ...result,
      verification: "stale" as const,
      verificationReason: `Source changed after verification. Finish edits and run ${retry}; inspect the completed receipt before resubmitting.`,
    };
  if (meta.verificationRequirement === "checks" && !evidence.candidateId) {
    const session = db.getCodingSession(run.session_id);
    const steps = Array.isArray(evidence.steps) ? evidence.steps : [];
    // A whitespace-only fallback is useful evidence, but cannot certify a deliverable.
    const meaningful = steps.some((step) => {
      if (!step || typeof step !== "object" || step.outcome !== "passed") return false;
      const command = (
        typeof step.command === "string"
          ? step.command
          : Array.isArray(step.command)
            ? step.command.join(" ")
            : ""
      ).trim();
      return command.length > 0 && command !== "git diff --check";
    });
    if (
      !meaningful ||
      evidence.executionTarget !== session?.execution_target ||
      evidence.workspace !== (session?.worktree_path ?? session?.workspace_root)
    )
      return {
        ...result,
        verification: "unbound" as const,
        verificationReason:
          "No current task checks bound to this workspace. Use code recipe save default <validation command> then code verify; inspect what the checks actually validate.",
      };
    return { ...result, verification: "passed" as const };
  }
  const row =
    typeof evidence.candidateId === "string"
      ? db.getCodingArtifact(evidence.candidateId)
      : undefined;
  if (row?.kind !== "candidate" || row.session_id !== run.session_id)
    return {
      ...result,
      verification: "unbound" as const,
      verificationReason:
        "Checks ran without an immutable source candidate. Use code verify candidate.",
    };
  result.candidateId = row.id;
  const candidate = JSON.parse(row.metadata_json) as CandidateIdentity & { runId?: string };
  const session = db.getCodingSession(run.session_id);
  if (
    candidate.version !== 1 ||
    candidate.policy !== CANDIDATE_POLICY ||
    candidate.runId !== run.id ||
    session?.execution_target !== "local" ||
    evidence.executionTarget !== "local" ||
    evidence.executionLocation !== "candidate-materialization" ||
    evidence.tree !== candidate.tree ||
    evidence.candidateFingerprint !== candidate.fingerprint
  )
    return {
      ...result,
      verification: "unavailable" as const,
      verificationReason: "Candidate identity or workspace binding changed.",
    };
  if (evidence.materializedFingerprint !== candidate.fingerprint)
    return {
      ...result,
      verification: "stale" as const,
      verificationReason:
        "Checks changed the materialized source or its final state could not be observed.",
    };
  if (!allowHostObservation)
    return {
      ...result,
      verification: "unavailable" as const,
      verificationReason: "Host source observation is unavailable over this transport.",
    };
  try {
    if ((await realpath(session.worktree_path ?? session.workspace_root)) !== candidate.repository)
      throw new Error("Candidate workspace binding changed.");
    const current = await observeCandidate(candidate);
    const latestSession = db.getCodingSession(run.session_id);
    if (
      latestSession?.workspace_root !== session.workspace_root ||
      latestSession?.worktree_path !== session.worktree_path ||
      latestSession?.execution_target !== "local"
    )
      throw new Error("Candidate workspace binding changed during observation.");
    result.verification = current === candidate.fingerprint ? "passed" : "stale";
    if (result.verification === "stale")
      result.verificationReason = `Included source changed since snapshot verification. Run ${retry} and inspect the completed receipt before resubmitting.`;
  } catch (error) {
    result.verification = "unavailable";
    result.verificationReason = getErrorMessage(error);
  }
  result.verificationObservedAt = Date.now();
  return result;
}

export function endCodingRun(
  db: MarinaDB,
  runId: string,
  status: "cancelled" | "failed" | "interrupted",
  reason: string,
): CodingArtifactRow | undefined {
  return db.transaction(() => {
    const run = db.getCodingArtifact(runId);
    if (run?.kind !== "task_run" || run.status !== "active") return undefined;
    const meta = codingRunMetadata(run);
    meta.reason = reason;
    // Release only this attempt's live claim. A submitted/approved claim cannot
    // be undone by a delayed stop or a late event from an old worker.
    const claim = codingRunClaim(db, run);
    if (claim?.status === "claimed") {
      db.updateTaskClaimStatus(meta.taskId, claim.entity_id, "released");
      const task = db.getTask(meta.taskId);
      if (task?.status === "claimed") db.updateTaskStatus(meta.taskId, "open");
    }
    db.updateCodingArtifact(run.id, { status, metadata: meta });
    db.createCodingEvent({
      sessionId: run.session_id,
      actor: meta.workerName,
      kind: `task_run_${status}`,
      payload: { runId, ...meta },
    });
    return db.getCodingArtifact(run.id)!;
  });
}

/** Boot recovery records uncertainty; it never replays host-affecting work. */
export function recoverCodingRuns(db: MarinaDB): void {
  for (;;) {
    const runs = db.listCodingRuns({ status: "active", limit: 100 });
    if (!runs.length) return;
    for (const run of runs) {
      const claim = codingRunClaim(db, run);
      const worker = claim ? db.loadEntity(claim.entity_id as EntityId) : undefined;
      if (worker?.properties.coding_session_id === run.session_id) {
        delete worker.properties.coding_task;
        db.saveEntity(worker);
      }
      endCodingRun(
        db,
        run.id,
        "interrupted",
        "Marina restarted; execution outcome is unknown. Inspect artifacts before retrying.",
      );
    }
  }
}

export function heartbeatCodingRun(db: MarinaDB, run: CodingArtifactRow): boolean {
  const meta = codingRunMetadata(run);
  const tasks = new TaskManager(db);
  const claim = codingRunClaim(db, run);
  if (
    claim?.status !== "claimed" ||
    (claim.lease_expires_at !== null && claim.lease_expires_at <= Date.now())
  )
    return false;
  return !!tasks.heartbeat(meta.taskId, claim.entity_id);
}

function bindRunContext(run: CodingArtifactRow): void {
  const context = codingRunContext.getStore();
  if (context)
    Object.assign(context, {
      sessionId: run.session_id,
      runId: run.id,
      taskId: codingRunMetadata(run).taskId,
    });
}

/** The owner opts in at dispatch; a worker cannot grant itself this authority. */
export function canReclaimCodingWriter(
  db: MarinaDB,
  session: CodingSessionRow,
  actor: Entity,
  target: string,
): boolean {
  const same = (a: string | null | undefined, b: string) =>
    !!a && sanitizeEntityName(a).toLowerCase() === sanitizeEntityName(b).toLowerCase();
  if (
    session.status !== "active" ||
    !same(target, actor.name) ||
    !same(session.writer, session.created_by)
  )
    return false;
  const run = db.listCodingRuns({ sessionId: session.id, status: "active", limit: 1 })[0];
  if (!run) return false;
  const meta = codingRunMetadata(run);
  const claim = codingRunClaim(db, run);
  return (
    meta.ownerMode === "unattended" &&
    same(meta.ownerName, session.created_by) &&
    meta.workerKey === db.durableEntityKey(actor.id) &&
    same(meta.workerName, actor.name) &&
    db.getTask(meta.taskId)?.status === "claimed" &&
    claim?.status === "claimed" &&
    (claim.lease_expires_at === null || claim.lease_expires_at > Date.now())
  );
}
