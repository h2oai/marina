// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  AutonomyPulseInput,
  AutonomyPulseRow,
  DailySpendRow,
  PrimitiveUsageSummary,
  ProductivitySummary,
  ProductivityTrendPoint,
  PromptOutcomeSummary,
} from "../db-telemetry";
import type { ExactKeys } from "./exact-keys";

/** Productivity sessions, primitive usage and prompt outcomes (`db-telemetry.ts`). */
export interface TelemetryStore {
  startProductivitySession(
    entityId: string,
    entityName: string,
    taskId: number,
    startedAt: number,
    toolCalls?: number,
    promptVersion?: string,
    inputTokens?: number,
    outputTokens?: number,
    costUsd?: number,
  ): void;
  finishProductivitySession(
    entityId: string,
    entityName: string,
    taskId: number,
    outcome: "approved" | "rejected" | "expired",
    completedAt: number,
    endToolCalls?: number,
    endInputTokens?: number,
    endOutputTokens?: number,
    endCostUsd?: number,
  ): boolean;
  getProductivitySummary(entityName?: string): ProductivitySummary;
  getProductivityLeaderboard(limit?: number): ProductivitySummary[];
  getProductivityTrend(entityName?: string, days?: number): ProductivityTrendPoint[];
  recordPrimitiveUsage(input: {
    actorId?: string;
    actorName: string;
    actorKind: string;
    source: "command" | "agent_tool";
    primitive: string;
    action: string;
    safeLabel: string;
    toolName?: string;
    success?: boolean;
    meaningful?: boolean;
    worldAction?: boolean;
    communication?: boolean;
    latencyMs?: number;
    promptVersion?: string;
    riskClass?: "read" | "communicate" | "mutate" | "consequential";
    trustSources?: string[];
    createdAt?: number;
  }): number;
  finishAgentToolUsage(actorName: string, toolName: string, success: boolean, at?: number): void;
  getPrimitiveUsageSummary(entityName?: string, days?: number): PrimitiveUsageSummary;
  getPromptOutcomeSummaries(days?: number): PromptOutcomeSummary[];
  getPrimitiveUsageLeaderboard(limit?: number): PrimitiveUsageSummary[];
  recordAutonomyPulse(pulse: AutonomyPulseInput): void;
  listAutonomyPulse(sinceMs: number): AutonomyPulseRow[];
  addDailySpend(day: string, source: string, usd: number): void;
  getDailySpend(day: string): DailySpendRow[];
}

/** Runtime mirror of `TelemetryStore`'s method names — the drift test compares it to the facade. */
export const TELEMETRY_STORE_METHODS = [
  "startProductivitySession",
  "finishProductivitySession",
  "getProductivitySummary",
  "getProductivityLeaderboard",
  "getProductivityTrend",
  "recordPrimitiveUsage",
  "finishAgentToolUsage",
  "getPrimitiveUsageSummary",
  "getPromptOutcomeSummaries",
  "getPrimitiveUsageLeaderboard",
  "recordAutonomyPulse",
  "listAutonomyPulse",
  "addDailySpend",
  "getDailySpend",
] as const satisfies readonly (keyof TelemetryStore)[];

export const TELEMETRY_STORE_COMPLETE: ExactKeys<TelemetryStore, typeof TELEMETRY_STORE_METHODS> =
  true;
