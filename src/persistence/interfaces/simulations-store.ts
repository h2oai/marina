// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as simulationsDb from "../db-simulations";
import type { ExactKeys } from "./exact-keys";

/** Unified simulation laboratory (`db-simulations.ts`). */
export interface SimulationsStore {
  createSimulationManifest(
    input: Parameters<typeof simulationsDb.createSimulationManifest>[1],
  ): ReturnType<typeof simulationsDb.createSimulationManifest>;
  getSimulationManifest(hash: string): ReturnType<typeof simulationsDb.getSimulationManifest>;
  listSimulationManifests(): ReturnType<typeof simulationsDb.listSimulationManifests>;
  createSimulationRun(
    input: Parameters<typeof simulationsDb.createSimulationRun>[1],
  ): ReturnType<typeof simulationsDb.createSimulationRun>;
  getSimulationRun(id: string): ReturnType<typeof simulationsDb.getSimulationRun>;
  listSimulationRuns(hash?: string): ReturnType<typeof simulationsDb.listSimulationRuns>;
  appendSimulationEvent(
    input: Parameters<typeof simulationsDb.appendSimulationEvent>[1],
  ): ReturnType<typeof simulationsDb.appendSimulationEvent>;
  listSimulationEvents(id: string): ReturnType<typeof simulationsDb.listSimulationEvents>;
  createSimulationComparison(
    input: Parameters<typeof simulationsDb.createSimulationComparison>[1],
  ): ReturnType<typeof simulationsDb.createSimulationComparison>;
  listSimulationComparisons(): ReturnType<typeof simulationsDb.listSimulationComparisons>;
}

/** Runtime mirror of `SimulationsStore`'s method names — the drift test compares it to the facade. */
export const SIMULATIONS_STORE_METHODS = [
  "createSimulationManifest",
  "getSimulationManifest",
  "listSimulationManifests",
  "createSimulationRun",
  "getSimulationRun",
  "listSimulationRuns",
  "appendSimulationEvent",
  "listSimulationEvents",
  "createSimulationComparison",
  "listSimulationComparisons",
] as const satisfies readonly (keyof SimulationsStore)[];

export const SIMULATIONS_STORE_COMPLETE: ExactKeys<
  SimulationsStore,
  typeof SIMULATIONS_STORE_METHODS
> = true;
