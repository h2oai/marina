// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CompactionOpts, CompactionStats } from "../db-maintenance";
import type { DatabasePages, JournalPruneOptions, JournalPruneResult } from "../db-storage";
import type { ExactKeys } from "./exact-keys";

/** Retention primitives and snapshots (`db-maintenance.ts`), and the storage budget (`db-storage.ts`). */
export interface MaintenanceStore {
  tableExists(table: string): boolean;
  walCheckpoint(): { busy: boolean; log: number; checkpointed: number };
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
  databasePages(): DatabasePages;
  pruneJournalSources(before: number, opts?: JournalPruneOptions): JournalPruneResult;
  reclaimFreePages(opts: { allowVacuum: boolean }): { reclaimed: number; vacuumed: boolean };
}

/** Runtime mirror of `MaintenanceStore`'s method names — the drift test compares it to the facade. */
export const MAINTENANCE_STORE_METHODS = [
  "tableExists",
  "walCheckpoint",
  "tableColumns",
  "deleteBatch",
  "snapshot",
  "snapshotCompacted",
  "databasePages",
  "pruneJournalSources",
  "reclaimFreePages",
] as const satisfies readonly (keyof MaintenanceStore)[];

export const MAINTENANCE_STORE_COMPLETE: ExactKeys<
  MaintenanceStore,
  typeof MAINTENANCE_STORE_METHODS
> = true;
