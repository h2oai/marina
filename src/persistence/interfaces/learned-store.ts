// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as learnedDb from "../db-learned";
import type { ExactKeys } from "./exact-keys";

/** Imported `marina.learned.v1` bundles and the export allow-list readers (`db-learned.ts`). */
export interface LearnedStore {
  recordLearnedArtifact(
    row: Omit<learnedDb.LearnedArtifactRow, "imported_at"> & { imported_at?: number },
  ): void;
  latestLearnedArtifact(artifactId: string): learnedDb.LearnedArtifactRow | undefined;
  listLearnedArtifacts(): learnedDb.LearnedArtifactRow[];
  upsertLearnedItem(
    row: Omit<learnedDb.LearnedItemRow, "updated_at" | "confirmed_by"> & { updated_at?: number },
  ): void;
  setLearnedItemStatus(
    artifactId: string,
    itemKey: string,
    status: learnedDb.LearnedItemStatus,
  ): void;
  confirmLearnedItem(artifactId: string, itemKey: string, confirmedBy: string): boolean;
  getLearnedItem(artifactId: string, itemKey: string): learnedDb.LearnedItemRow | undefined;
  listLearnedItems(opts?: {
    artifactId?: string;
    status?: learnedDb.LearnedItemStatus;
    limit?: number;
  }): learnedDb.LearnedItemRow[];
  recordUpstreamDefaultSeed(
    row: Omit<learnedDb.UpstreamDefaultSeedRow, "id" | "created_at"> & { created_at?: number },
  ): number;
  latestUpstreamDefaultSeed(slot: string): learnedDb.UpstreamDefaultSeedRow | undefined;
  listUpstreamDefaultSeeds(): learnedDb.UpstreamDefaultSeedRow[];
  recordEvidencePrior(
    row: Omit<learnedDb.EvidencePriorRow, "id" | "created_at"> & { created_at?: number },
  ): number;
  listEvidencePriors(opts?: { family?: string; limit?: number }): learnedDb.EvidencePriorRow[];
  recordUpstreamEvent(event: learnedDb.UpstreamEventInput): number;
  listUpstreamEvents(opts?: { artifactId?: string; limit?: number }): learnedDb.UpstreamEventRow[];
  listOwnedSpaceRecords(
    ownerName: string,
    prefix: string,
    now?: number,
  ): learnedDb.LearnedSourceRecord[];
  listRatifiedInstitutionalRecords(now?: number): learnedDb.LearnedSourceRecord[];
  listLedgerCells(): learnedDb.LedgerCellRow[];
}

/** Runtime mirror of `LearnedStore`'s method names — the drift test compares it to the facade. */
export const LEARNED_STORE_METHODS = [
  "recordLearnedArtifact",
  "latestLearnedArtifact",
  "listLearnedArtifacts",
  "upsertLearnedItem",
  "setLearnedItemStatus",
  "confirmLearnedItem",
  "getLearnedItem",
  "listLearnedItems",
  "recordUpstreamDefaultSeed",
  "latestUpstreamDefaultSeed",
  "listUpstreamDefaultSeeds",
  "recordEvidencePrior",
  "listEvidencePriors",
  "recordUpstreamEvent",
  "listUpstreamEvents",
  "listOwnedSpaceRecords",
  "listRatifiedInstitutionalRecords",
  "listLedgerCells",
] as const satisfies readonly (keyof LearnedStore)[];

export const LEARNED_STORE_COMPLETE: ExactKeys<LearnedStore, typeof LEARNED_STORE_METHODS> = true;
