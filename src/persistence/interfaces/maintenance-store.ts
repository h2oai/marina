// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CompactionOpts, CompactionStats } from "../db-maintenance";
import type { ExactKeys } from "./exact-keys";

/** Retention primitives and snapshots (`db-maintenance.ts`). */
export interface MaintenanceStore {
  tableExists(table: string): boolean;
  tableColumns(table: string): string[];
  deleteBatch(table: string, whereSql: string, params: (string | number)[], limit: number): number;
  snapshot(targetPath: string): {
    notes: number;
    pools: number;
    benchmarkRuns: number;
    entities: number;
    bytes: number;
  };
  snapshotCompacted(targetPath: string, opts?: CompactionOpts): CompactionStats;
}

/** Runtime mirror of `MaintenanceStore`'s method names — the drift test compares it to the facade. */
export const MAINTENANCE_STORE_METHODS = [
  "tableExists",
  "tableColumns",
  "deleteBatch",
  "snapshot",
  "snapshotCompacted",
] as const satisfies readonly (keyof MaintenanceStore)[];

export const MAINTENANCE_STORE_COMPLETE: ExactKeys<
  MaintenanceStore,
  typeof MAINTENANCE_STORE_METHODS
> = true;
