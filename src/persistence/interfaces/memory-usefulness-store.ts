// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as usefulnessDb from "../db-memory-usefulness";
import type { ExactKeys } from "./exact-keys";

/** Retrieval telemetry and usefulness evidence (`db-memory-usefulness.ts`). */
export interface MemoryUsefulnessStore {
  recordMemoryServed(rows: readonly usefulnessDb.MemoryServedInput[]): number;
  applyUsefulness(rating: usefulnessDb.UsefulnessRatingInput): number;
  memoryUsefulnessSummary(
    entityName: string,
    sinceMs: number,
    opts?: { topItems?: number },
  ): usefulnessDb.MemoryUsefulnessSummary;
  usefulnessRatingsFor(
    itemId: string,
    limit?: number,
  ): ReturnType<typeof usefulnessDb.usefulnessRatingsFor>;
}

/** Runtime mirror of `MemoryUsefulnessStore`'s method names — the drift test compares it to the facade. */
export const MEMORY_USEFULNESS_STORE_METHODS = [
  "recordMemoryServed",
  "applyUsefulness",
  "memoryUsefulnessSummary",
  "usefulnessRatingsFor",
] as const satisfies readonly (keyof MemoryUsefulnessStore)[];

export const MEMORY_USEFULNESS_STORE_COMPLETE: ExactKeys<
  MemoryUsefulnessStore,
  typeof MEMORY_USEFULNESS_STORE_METHODS
> = true;
