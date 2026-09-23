// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ExactKeys } from "./exact-keys";

/** Facade-owned primitives: durable identity key, transactions, checkpoint and close. */
export interface CoreStore {
  durableEntityKey(entityId: string): string;
  /** Durable key for a world account by name, or undefined when no account exists. */
  durableKeyForName(name: string): string | undefined;
  transaction<T>(fn: () => T): T;
  /** Checkpoint WAL file to reduce its size */
  checkpoint(): void;
  close(): void;
}

/** Runtime mirror of `CoreStore`'s method names — the drift test compares it to the facade. */
export const CORE_STORE_METHODS = [
  "durableEntityKey",
  "durableKeyForName",
  "transaction",
  "checkpoint",
  "close",
] as const satisfies readonly (keyof CoreStore)[];

export const CORE_STORE_COMPLETE: ExactKeys<CoreStore, typeof CORE_STORE_METHODS> = true;
