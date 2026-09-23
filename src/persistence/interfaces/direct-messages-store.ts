// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { DirectMessageRow } from "../db-direct-messages";
import type { TaskRow } from "../db-tasks";
import type { ExactKeys } from "./exact-keys";

/** Durable direct-message receipts (`db-direct-messages.ts`). */
export interface DirectMessagesStore {
  createDirectMessage(message: {
    correlationId: string;
    dedupeKey: string;
    senderId: string;
    senderName: string;
    targetId: string;
    targetName: string;
    content: string;
    deadlineAt?: number;
  }): DirectMessageRow;
  getDirectMessage(id: number): DirectMessageRow | undefined;
  listDirectMessageInbox(targetId: string, limit?: number): DirectMessageRow[];
  acknowledgeDirectMessage(id: number, targetId: string, replyMessageId?: number): boolean;
  expireDirectMessages(now?: number): number;
  getChildTaskCount(parentId: number): { total: number; completed: number };
  setTaskParent(taskId: number, parentTaskId: number): void;
  searchTasks(
    query: string,
    opts?: { status?: string; limit?: number },
  ): (TaskRow & { score: number })[];
  recordStandingEarned(entityId: string, entityName: string, taskId: number, amount: number): void;
  getEntityStanding(entityId: string): number;
  getStandingLeaderboard(
    limit?: number,
  ): { entityName: string; total: number; taskCount: number }[];
  rejectAllOtherClaims(taskId: number, winnerEntityId: string): void;
}

/** Runtime mirror of `DirectMessagesStore`'s method names — the drift test compares it to the facade. */
export const DIRECT_MESSAGES_STORE_METHODS = [
  "createDirectMessage",
  "getDirectMessage",
  "listDirectMessageInbox",
  "acknowledgeDirectMessage",
  "expireDirectMessages",
  "getChildTaskCount",
  "setTaskParent",
  "searchTasks",
  "recordStandingEarned",
  "getEntityStanding",
  "getStandingLeaderboard",
  "rejectAllOtherClaims",
] as const satisfies readonly (keyof DirectMessagesStore)[];

export const DIRECT_MESSAGES_STORE_COMPLETE: ExactKeys<
  DirectMessagesStore,
  typeof DIRECT_MESSAGES_STORE_METHODS
> = true;
