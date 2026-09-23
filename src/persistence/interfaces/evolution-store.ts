// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  EvolutionActivitySummary,
  EvolutionRunRow,
  EvolutionSessionRow,
  EvolutionSessionStatus,
} from "../db-evolution";
import type { ExactKeys } from "./exact-keys";

/** Native evolution protocols (`db-evolution.ts`). */
export interface EvolutionStore {
  createEvolutionSession(opts: {
    experimentId: number;
    objective: string;
    protocol?: object;
    createdBy: string;
  }): number;
  getEvolutionSession(id: number): EvolutionSessionRow | undefined;
  getEvolutionSessionByExperiment(experimentId: number): EvolutionSessionRow | undefined;
  listEvolutionSessions(status?: EvolutionSessionStatus): EvolutionSessionRow[];
  listActiveEvolutionSessionsForParticipant(entityName: string): EvolutionSessionRow[];
  getEvolutionActivity(
    experimentId: number,
    startedAt: number,
    endedAt?: number,
  ): EvolutionActivitySummary;
  updateEvolutionSessionStatus(id: number, status: EvolutionSessionStatus): void;
  createEvolutionRun(opts: {
    sessionId: number;
    hypothesis: string;
    candidateRef: string;
    proposedBy: string;
    parentRunId?: number;
  }): number;
  getEvolutionRun(id: number): EvolutionRunRow | undefined;
  listEvolutionRuns(sessionId: number): EvolutionRunRow[];
  evaluateEvolutionRun(id: number, evaluatorName: string, evidence: string): void;
  decideEvolutionRun(
    id: number,
    reviewerName: string,
    decision: "accept" | "reject" | "inconclusive",
  ): void;
}

/** Runtime mirror of `EvolutionStore`'s method names — the drift test compares it to the facade. */
export const EVOLUTION_STORE_METHODS = [
  "createEvolutionSession",
  "getEvolutionSession",
  "getEvolutionSessionByExperiment",
  "listEvolutionSessions",
  "listActiveEvolutionSessionsForParticipant",
  "getEvolutionActivity",
  "updateEvolutionSessionStatus",
  "createEvolutionRun",
  "getEvolutionRun",
  "listEvolutionRuns",
  "evaluateEvolutionRun",
  "decideEvolutionRun",
] as const satisfies readonly (keyof EvolutionStore)[];

export const EVOLUTION_STORE_COMPLETE: ExactKeys<EvolutionStore, typeof EVOLUTION_STORE_METHODS> =
  true;
