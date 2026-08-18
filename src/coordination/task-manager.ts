// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

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
      standing: opts.standing,
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
    const task = this.get(taskId);
    if (!task) return false;
    if (task.creatorId !== approverId) return false;

    const claim = this.getClaim(taskId, claimantId);
    if (claim?.status !== "submitted") return false;

    this.db.updateTaskClaimStatus(taskId, claimantId, "approved");
    this.db.updateTaskStatus(taskId, "completed");

    // Bounty mode: reject all other claims and record standing
    if (task.validationMode === "bounty") {
      this.db.rejectAllOtherClaims(taskId, claimantId);
      if (task.standing > 0) {
        this.db.recordStandingEarned(claimantId, claim.entityName, taskId, task.standing);
      }
    }

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

  getEntityStanding(entityId: string): number {
    return this.db.getEntityStanding(entityId);
  }

  getStandingLeaderboard(
    limit?: number,
  ): { entityName: string; total: number; taskCount: number }[] {
    return this.db.getStandingLeaderboard(limit);
  }
}
