// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as dreamsDb from "../db-memory-dreams";
import type { ExactKeys } from "./exact-keys";

/** Dream records (`db-memory-dreams.ts`). */
export interface MemoryDreamsStore {
  recordDream(input: dreamsDb.DreamInsert): number;
  getDream(id: number): dreamsDb.DreamRow | undefined;
  listDreams(entityName: string, limit?: number): dreamsDb.DreamRow[];
  listRecentDreams(limit?: number, entityName?: string): dreamsDb.DreamRow[];
  lastDreamAt(entityName: string): number | undefined;
  updateDream(id: number, patch: dreamsDb.DreamUpdate): boolean;
}

/** Runtime mirror of `MemoryDreamsStore`'s method names — the drift test compares it to the facade. */
export const MEMORY_DREAMS_STORE_METHODS = [
  "recordDream",
  "getDream",
  "listDreams",
  "listRecentDreams",
  "lastDreamAt",
  "updateDream",
] as const satisfies readonly (keyof MemoryDreamsStore)[];

export const MEMORY_DREAMS_STORE_COMPLETE: ExactKeys<
  MemoryDreamsStore,
  typeof MEMORY_DREAMS_STORE_METHODS
> = true;
