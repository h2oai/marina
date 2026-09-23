// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ShellLogRow } from "../db-shell";
import type { ExactKeys } from "./exact-keys";

/** Shell allowlist and audit log (`db-shell.ts`). */
export interface ShellStore {
  getShellAllowlist(): string[];
  isShellAllowed(binary: string): boolean;
  addToShellAllowlist(binary: string, addedBy: string): void;
  removeFromShellAllowlist(binary: string): boolean;
  logShellExec(
    entityId: string,
    binary: string,
    args: string,
    exitCode: number | null,
    outputLength: number,
  ): void;
  getShellHistory(entityId: string, limit?: number): ShellLogRow[];
  getShellLog(entityId: string | null, limit?: number): ShellLogRow[];
  trimShellLog(keepMs: number): number;
}

/** Runtime mirror of `ShellStore`'s method names — the drift test compares it to the facade. */
export const SHELL_STORE_METHODS = [
  "getShellAllowlist",
  "isShellAllowed",
  "addToShellAllowlist",
  "removeFromShellAllowlist",
  "logShellExec",
  "getShellHistory",
  "getShellLog",
  "trimShellLog",
] as const satisfies readonly (keyof ShellStore)[];

export const SHELL_STORE_COMPLETE: ExactKeys<ShellStore, typeof SHELL_STORE_METHODS> = true;
