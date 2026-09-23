// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { admitMemoryImport } from "../db-memory-admission";
import type { compactMemoryReceipts } from "../db-memory-retention";
import type * as memoryServiceDb from "../db-memory-service";
import type * as principalsDb from "../db-principals";
import type { ExactKeys } from "./exact-keys";

/** Durable memory service repository, admission, credentials and receipt compaction (`db-memory-*.ts`). */
export interface MemoryServiceStore {
  compactMemoryReceipts(
    options: Parameters<typeof compactMemoryReceipts>[1],
  ): ReturnType<typeof compactMemoryReceipts>;
  memoryRepository(): memoryServiceDb.MemoryRepository;
  admitMemoryImport(): ReturnType<typeof admitMemoryImport>;
  isServiceMemoryNote(id: number): boolean;
  issueMemoryCredential(
    ...args: Parameters<typeof principalsDb.issueMemoryCredential> extends [unknown, ...infer R]
      ? R
      : never
  ): ReturnType<typeof principalsDb.issueMemoryCredential>;
  verifyMemoryCredential(token: string): ReturnType<typeof principalsDb.verifyMemoryCredential>;
}

/** Runtime mirror of `MemoryServiceStore`'s method names — the drift test compares it to the facade. */
export const MEMORY_SERVICE_STORE_METHODS = [
  "compactMemoryReceipts",
  "memoryRepository",
  "admitMemoryImport",
  "isServiceMemoryNote",
  "issueMemoryCredential",
  "verifyMemoryCredential",
] as const satisfies readonly (keyof MemoryServiceStore)[];

export const MEMORY_SERVICE_STORE_COMPLETE: ExactKeys<
  MemoryServiceStore,
  typeof MEMORY_SERVICE_STORE_METHODS
> = true;
