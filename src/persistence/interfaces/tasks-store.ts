// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ProjectRow, TaskClaimRow, TaskRow } from "../db-tasks";
import type { ExactKeys } from "./exact-keys";

/** Tasks, claims, projects and legacy task-standing reads (`db-tasks.ts`). */
export interface TasksStore {
  createTask(task: {
    groupId?: string;
    title: string;
    description?: string;
    creatorId: string;
    creatorName: string;
    validationMode?: string;
    standing?: number;
    parentTaskId?: number;
    priority?: number;
  }): number;
  updateTaskProgress(id: number, progress: number): void;
  updateTaskPriority(id: number, priority: number): void;
  getTask(id: number): TaskRow | undefined;
  listTasks(opts?: {
    status?: string;
    groupId?: string;
    parentId?: number;
    limit?: number;
    orderByStanding?: boolean;
  }): TaskRow[];
  countTasks(opts?: { status?: string; groupId?: string; parentId?: number }): number;
  updateTaskStatus(id: number, status: string): void;
  createTaskClaim(
    taskId: number,
    entityId: string,
    entityName: string,
    leaseExpiresAt?: number,
  ): void;
  getTaskClaim(taskId: number, entityId: string): TaskClaimRow | undefined;
  listTasksClaimedBy(entityId: string): TaskRow[];
  getTaskClaims(taskId: number): TaskClaimRow[];
  updateTaskClaimStatus(
    taskId: number,
    entityId: string,
    status: string,
    submissionText?: string,
  ): void;
  renewTaskClaim(taskId: number, entityId: string, leaseExpiresAt: number): boolean;
  recoverExpiredTaskClaims(now?: number): TaskClaimRow[];
  /** Count completed tasks created by an entity. */
  countCompletedTasks(entityName: string): number;
  countApprovedTaskClaims(entityId: string): number;
  createProject(project: {
    id: string;
    name: string;
    description?: string;
    bundleId?: number;
    poolId?: string;
    groupId?: string;
    orchestration?: string;
    memoryArch?: string;
    createdBy: string;
  }): void;
  getProject(id: string): ProjectRow | undefined;
  getProjectByName(name: string): ProjectRow | undefined;
  listProjects(status?: string): ProjectRow[];
  updateProjectStatus(id: string, status: string): void;
  updateProjectOrchestration(id: string, orchestration: string): void;
  updateProjectMemoryArch(id: string, memoryArch: string): void;
  updateProjectBudget(
    id: string,
    budget: { tokens?: number | null; cost?: number | null; durationMs?: number | null },
  ): void;
  addProjectUsage(id: string, tokens: number, cost: number): void;
  resetProjectTasks(bundleId: number): number;
}

/** Runtime mirror of `TasksStore`'s method names — the drift test compares it to the facade. */
export const TASKS_STORE_METHODS = [
  "createTask",
  "updateTaskProgress",
  "updateTaskPriority",
  "getTask",
  "listTasks",
  "countTasks",
  "updateTaskStatus",
  "createTaskClaim",
  "getTaskClaim",
  "listTasksClaimedBy",
  "getTaskClaims",
  "updateTaskClaimStatus",
  "renewTaskClaim",
  "recoverExpiredTaskClaims",
  "countCompletedTasks",
  "countApprovedTaskClaims",
  "createProject",
  "getProject",
  "getProjectByName",
  "listProjects",
  "updateProjectStatus",
  "updateProjectOrchestration",
  "updateProjectMemoryArch",
  "updateProjectBudget",
  "addProjectUsage",
  "resetProjectTasks",
] as const satisfies readonly (keyof TasksStore)[];

export const TASKS_STORE_COMPLETE: ExactKeys<TasksStore, typeof TASKS_STORE_METHODS> = true;
