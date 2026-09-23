// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  ExperimentParticipantRow,
  ExperimentResultRow,
  ExperimentRow,
} from "../db-experiments";
import type { ExactKeys } from "./exact-keys";

/** Experiments (`db-experiments.ts`). */
export interface ExperimentsStore {
  createExperiment(opts: {
    name: string;
    description?: string;
    config?: Record<string, unknown>;
    creatorName: string;
    requiredAgents?: number;
    timeLimit?: number;
  }): number;
  getExperiment(id: number): ExperimentRow | undefined;
  getExperimentByName(name: string): ExperimentRow | undefined;
  listExperiments(status?: string): ExperimentRow[];
  updateExperimentStatus(id: number, status: string): void;
  startExperiment(id: number): void;
  completeExperiment(id: number): void;
  addParticipant(experimentId: number, entityName: string): void;
  getParticipants(experimentId: number): ExperimentParticipantRow[];
  isParticipant(experimentId: number, entityName: string): boolean;
  recordResult(
    experimentId: number,
    entityName: string,
    metricName: string,
    metricValue: number,
    arm?: string,
  ): void;
  getResults(experimentId: number): ExperimentResultRow[];
}

/** Runtime mirror of `ExperimentsStore`'s method names — the drift test compares it to the facade. */
export const EXPERIMENTS_STORE_METHODS = [
  "createExperiment",
  "getExperiment",
  "getExperimentByName",
  "listExperiments",
  "updateExperimentStatus",
  "startExperiment",
  "completeExperiment",
  "addParticipant",
  "getParticipants",
  "isParticipant",
  "recordResult",
  "getResults",
] as const satisfies readonly (keyof ExperimentsStore)[];

export const EXPERIMENTS_STORE_COMPLETE: ExactKeys<
  ExperimentsStore,
  typeof EXPERIMENTS_STORE_METHODS
> = true;
