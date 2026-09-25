// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { TaskManager } from "../coordination/task-manager";
import { sanitizeEntityName } from "../engine/entity-name";
import { codingRunContext } from "../persistence/coding-run-context";
import type { CodingArtifactRow, CodingSessionRow, MarinaDB } from "../persistence/database";
import type { Entity, EntityId } from "../types";

export interface CodingRunMetadata {
  version: 1;
  taskId: number;
  ownerKey: string;
  ownerName: string;
  workerKey: string;
  workerName: string;
  runtimeName?: string;
  profile: string;
  modelTarget?: string;
  workspace: string;
  executionTarget: string;
  workspaceEventId?: string;
  summaryId?: string;
  verificationId?: string;
  verification?: "passed" | "failed" | "missing" | "stale";
  reason?: string;
}

export function codingRunMetadata(run: CodingArtifactRow): CodingRunMetadata {
  return JSON.parse(run.metadata_json) as CodingRunMetadata;
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
  },
): CodingArtifactRow {
  return db.transaction(() => {
    if (
      sanitizeEntityName(input.owner.name).toLowerCase() !==
      sanitizeEntityName(input.session.created_by).toLowerCase()
    ) {
      throw new Error("Only the coding session creator may dispatch its task.");
    }
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
    if (!tasks.claim(task.id, input.worker.id, input.worker.name)) {
      throw new Error("Could not claim the coding task.");
    }
    const metadata: CodingRunMetadata = {
      version: 1,
      taskId: task.id,
      ownerKey,
      ownerName: input.owner.name,
      workerKey,
      workerName: input.worker.name,
      runtimeName: input.runtimeName,
      profile: input.profile,
      modelTarget: input.modelTarget,
      workspace: input.session.workspace_root,
      executionTarget: input.session.execution_target,
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

/** A stored summary is a submission; only the ordinary task review approves it. */
export function submitCodingRun(
  db: MarinaDB,
  sessionId: string,
  worker: Entity,
  summary: CodingArtifactRow,
): CodingArtifactRow | undefined {
  return db.transaction(() => {
    const run = db.listCodingRuns({ sessionId, status: "active", limit: 1 })[0];
    if (!run) return undefined;
    const meta = codingRunMetadata(run);
    const origin = JSON.parse(summary.metadata_json) as { runId?: string };
    if (summary.session_id !== sessionId || origin.runId !== run.id) return undefined;
    if (meta.workerKey !== db.durableEntityKey(worker.id)) return undefined;
    const tasks = new TaskManager(db);
    const artifacts = db.listCodingRunArtifacts(run.id);
    const verificationIndex = artifacts.findIndex((artifact) => artifact.kind === "verification");
    const verification = artifacts[verificationIndex];
    const changedSince =
      verification &&
      (JSON.parse(verification.metadata_json) as { workspaceEventId?: string }).workspaceEventId !==
        meta.workspaceEventId;
    meta.summaryId = summary.id;
    meta.verificationId = verification?.id;
    meta.verification = !verification
      ? "missing"
      : verification.status !== "complete"
        ? "failed"
        : changedSince
          ? "stale"
          : "passed";
    const evidence = `${summary.content_text}\n\nCoding attempt: artifact:${run.id}\nSummary: artifact:${summary.id}\nRecorded verification: ${meta.verification}${verification ? ` (artifact:${verification.id})` : ""}`;
    if (!tasks.submit(meta.taskId, worker.id, evidence)) {
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
    const claim = db.getTaskClaim(meta.taskId, meta.workerKey);
    if (claim?.status === "claimed") {
      db.updateTaskClaimStatus(meta.taskId, meta.workerKey, "released");
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
      const meta = codingRunMetadata(run);
      const claim = db.getTaskClaim(meta.taskId, meta.workerKey);
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
  const claim = tasks.getClaim(meta.taskId, meta.workerKey);
  if (
    claim?.status !== "claimed" ||
    (claim.leaseExpiresAt !== null && claim.leaseExpiresAt <= Date.now())
  )
    return false;
  return !!tasks.heartbeat(meta.taskId, meta.workerKey);
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
