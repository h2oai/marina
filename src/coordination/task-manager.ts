// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  namedLeaderboard,
  recordVerified,
  standingOf,
  standingVerifierRefusal,
  TASK_STANDING_DEFAULT,
  taskStandingValue,
  type VerifiedCredit,
} from "../agent/standing";
import type { MarinaDB, TaskClaimRow, TaskRow } from "../persistence/database";

export interface Task {
  id: number;
  boardId: string | null;
  groupId: string | null;
  title: string;
  description: string;
  prerequisites: string[];
  deliverables: string;
  status: string;
  validationMode: string;
  creatorId: string;
  creatorName: string;
  standing: number;
  parentTaskId: number | null;
  priority: number;
  progress: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskClaim {
  taskId: number;
  entityId: string;
  entityName: string;
  status: string;
  submissionText: string | null;
  claimedAt: number;
  submittedAt: number | null;
  resolvedAt: number | null;
  heartbeatAt: number | null;
  leaseExpiresAt: number | null;
  releaseReason: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    boardId: row.board_id,
    groupId: row.group_id,
    title: row.title,
    description: row.description,
    prerequisites: JSON.parse(row.prerequisites) as string[],
    deliverables: row.deliverables,
    status: row.status,
    validationMode: row.validation_mode,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    standing: row.standing,
    parentTaskId: row.parent_task_id,
    priority: row.priority,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToClaim(row: TaskClaimRow): TaskClaim {
  return {
    taskId: row.task_id,
    entityId: row.entity_id,
    entityName: row.entity_name,
    status: row.status,
    submissionText: row.submission_text,
    claimedAt: row.claimed_at,
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    releaseReason: row.release_reason,
  };
}

/** The creator name world seeds file tasks under; it never logs in. */
export const SYSTEM_TASK_CREATOR = "system";

export class TaskManager {
  private readonly leaseMs: number;

  constructor(
    private db: MarinaDB,
    opts?: { leaseMs?: number },
  ) {
    const configured = opts?.leaseMs ?? Number(process.env.MARINA_TASK_LEASE_MS ?? 15 * 60_000);
    this.leaseMs = Number.isFinite(configured) && configured > 0 ? configured : 15 * 60_000;
  }

  create(opts: {
    title: string;
    description?: string;
    creatorId: string;
    creatorName: string;
    groupId?: string;
    validationMode?: string;
    standing?: number;
    parentTaskId?: number;
    priority?: number;
  }): Task {
    const id = this.db.createTask({
      title: opts.title,
      description: opts.description,
      creatorId: opts.creatorId,
      creatorName: opts.creatorName,
      groupId: opts.groupId,
      validationMode: opts.validationMode,
      // Unset = the default value; the cap is enforced where creators name one.
      standing: opts.standing ?? TASK_STANDING_DEFAULT,
      parentTaskId: opts.parentTaskId,
      priority: opts.priority,
    });
    return this.get(id)!;
  }

  updateProgress(id: number, progress: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    this.db.updateTaskProgress(id, progress);
    return true;
  }

  updatePriority(id: number, priority: number): boolean {
    const task = this.get(id);
    if (!task) return false;
    this.db.updateTaskPriority(id, priority);
    return true;
  }

  get(id: number): Task | undefined {
    const row = this.db.getTask(id);
    return row ? rowToTask(row) : undefined;
  }

  list(opts?: {
    status?: string;
    groupId?: string;
    limit?: number;
    orderByStanding?: boolean;
  }): Task[] {
    return this.db.listTasks(opts).map(rowToTask);
  }

  /** How many tasks match, without the page `list` caps at. */
  count(opts?: { status?: string; groupId?: string }): number {
    return this.db.countTasks(opts);
  }

  cancel(id: number, entityId: string): boolean {
    const task = this.get(id);
    if (!task) return false;
    if (task.creatorId !== entityId) return false;
    if (task.status !== "open") return false;
    this.db.updateTaskStatus(id, "cancelled");
    return true;
  }

  claim(taskId: number, entityId: string, entityName: string): TaskClaim | null {
    const task = this.get(taskId);
    if (task?.status !== "open") return null;

    // Check if already actively claimed by this entity. Released/expired claims
    // may be reacquired without losing their audit row.
    const existing = this.db.getTaskClaim(taskId, entityId);
    if (existing?.status === "claimed" || existing?.status === "submitted") return null;

    this.db.createTaskClaim(taskId, entityId, entityName, Date.now() + this.leaseMs);
    if (task.validationMode !== "bounty") {
      this.db.updateTaskStatus(taskId, "claimed");
    }
    return this.getClaim(taskId, entityId);
  }

  getClaim(taskId: number, entityId: string): TaskClaim | null {
    const row = this.db.getTaskClaim(taskId, entityId);
    return row ? rowToClaim(row) : null;
  }

  getClaims(taskId: number): TaskClaim[] {
    return this.db.getTaskClaims(taskId).map(rowToClaim);
  }

  heartbeat(taskId: number, entityId: string): TaskClaim | null {
    if (!this.db.renewTaskClaim(taskId, entityId, Date.now() + this.leaseMs)) return null;
    return this.getClaim(taskId, entityId);
  }

  recoverExpired(now = Date.now()): TaskClaim[] {
    return this.db.recoverExpiredTaskClaims(now).map(rowToClaim);
  }

  submit(taskId: number, entityId: string, submissionText: string): boolean {
    const claim = this.getClaim(taskId, entityId);
    if (claim?.status !== "claimed") return false;
    if (claim.leaseExpiresAt !== null && claim.leaseExpiresAt <= Date.now()) {
      this.recoverExpired();
      return false;
    }
    this.db.updateTaskClaimStatus(taskId, entityId, "submitted", submissionText);
    return true;
  }

  approveSubmission(taskId: number, claimantId: string, approverId: string): boolean {
    return this.approve(taskId, claimantId, approverId).ok;
  }

  /** The civic leaderboard (decayed, by account) with each row's credited task count. */
  standingBoard(limit = 10): { name: string; standing: number; tasks: number }[] {
    return namedLeaderboard(this.db, limit).map((row) => ({
      name: row.name,
      standing: row.standing,
      tasks: this.db.countStandingEvents(row.entityId, "task_complete", 0),
    }));
  }

  /** One participant's decayed standing by account (the `standing` command's number). */
  standingOf(name: string, entityId?: string): number {
    return standingOf(this.db, name, entityId);
  }

  /**
   * What approving `claimantName`'s submission would pay: the task's value
   * (capped at TASK_STANDING_MAX) when the creator — the approver — may
   * credit the claimant (`standingVerifierRefusal`: another account, and not
   * an agent inside the claimant's lineage), 0 otherwise. `task info` shows this.
   */
  standingFor(task: Task, claimantName?: string, claimantId?: string): VerifiedCredit {
    const amount = taskStandingValue(task.standing);
    if (amount <= 0) return { credited: false, amount: 0, reason: "the task carries no standing" };
    const refusal = claimantName
      ? standingVerifierRefusal(
          this.db,
          { name: claimantName, ...(claimantId ? { entityId: claimantId } : {}) },
          task.creatorName,
        )
      : undefined;
    if (refusal) return { credited: false, amount: 0, reason: refusal };
    return { credited: true, amount };
  }

  /**
   * Approve a submission (creator only) in any validation mode. Standing is
   * paid for work another party verified: the task's capped value unless the
   * approver is the claimant's own account, or an agent inside the claimant's
   * spawn lineage (no grounding signal for a task verdict) — the task still
   * completes either way.
   */
  approve(
    taskId: number,
    claimantId: string,
    approverId: string,
  ): { ok: false } | { ok: true; credit: VerifiedCredit } {
    const task = this.get(taskId);
    if (!task) return { ok: false };
    if (task.creatorId !== approverId) return { ok: false };

    const claim = this.getClaim(taskId, claimantId);
    if (claim?.status !== "submitted") return { ok: false };

    // Atomic: approval, completion, the bounty rejections and the standing
    // credit are one logical change — a failure on the last write must not
    // leave the task completed with the claim still `submitted`.
    return this.db.transaction(() => {
      this.db.updateTaskClaimStatus(taskId, claimantId, "approved");
      this.db.updateTaskStatus(taskId, "completed");
      if (task.validationMode === "bounty") this.db.rejectAllOtherClaims(taskId, claimantId);
      const credit = recordVerified(this.db, {
        kind: "task_complete",
        ref: String(taskId),
        worker: { name: claim.entityName, entityId: claimantId },
        verifier: task.creatorName,
        amount: taskStandingValue(task.standing),
        taskId,
      });
      return { ok: true as const, credit };
    });
  }

  /**
   * Hand a task the world seeded as `system` to `reviewer` before an operator
   * reviews it. `system` never logs in, so without a seeded reviewer of record
   * (`assignSeededTaskReviewer`) its submissions could never be approved; the
   * caller has checked that `reviewer` is an operator (a person at rank 9).
   * The handover is durable: the operator is the reviewer of record from then
   * on. Returns false for any task not created by `system`.
   */
  adoptSystemTask(taskId: number, reviewer: { id: string; name: string }): boolean {
    const task = this.get(taskId);
    if (task?.creatorName !== SYSTEM_TASK_CREATOR) return false;
    this.db.setTaskCreator(taskId, reviewer.id, reviewer.name);
    return true;
  }

  rejectSubmission(taskId: number, claimantId: string, approverId: string): boolean {
    const task = this.get(taskId);
    if (!task) return false;
    if (task.creatorId !== approverId) return false;

    const claim = this.getClaim(taskId, claimantId);
    if (claim?.status !== "submitted") return false;

    this.db.updateTaskClaimStatus(taskId, claimantId, "rejected");
    if (task.validationMode !== "bounty") {
      this.db.updateTaskStatus(taskId, "open");
    }
    return true;
  }

  listChildren(parentId: number): Task[] {
    return this.db.listTasks({ parentId }).map(rowToTask);
  }

  getBundleStatus(parentId: number): { total: number; completed: number; open: number } {
    const counts = this.db.getChildTaskCount(parentId);
    return {
      total: counts.total,
      completed: counts.completed,
      open: counts.total - counts.completed,
    };
  }

  assignToBundle(taskId: number, bundleId: number, entityId: string): boolean {
    const task = this.get(taskId);
    if (!task) return false;
    if (task.creatorId !== entityId) return false;
    const bundle = this.get(bundleId);
    if (!bundle) return false;
    this.db.setTaskParent(taskId, bundleId);
    return true;
  }

  listClaimedBy(entityId: string): Task[] {
    return this.db.listTasksClaimedBy(entityId).map(rowToTask);
  }

  searchTasks(
    query: string,
    opts?: { status?: string; limit?: number },
  ): (Task & { score: number })[] {
    return this.db.searchTasks(query, opts).map((row) => ({
      ...rowToTask(row),
      score: row.score,
    }));
  }
}
