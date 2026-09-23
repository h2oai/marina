// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MacroRow } from "../db-macros";
import type { ExactKeys } from "./exact-keys";

/** Macros (`db-macros.ts`); author ids resolve to durable keys at the facade. */
export interface MacrosStore {
  createMacro(name: string, authorId: string, command: string): number;
  getMacro(id: number): MacroRow | undefined;
  getMacroByName(name: string, authorId: string): MacroRow | undefined;
  listMacros(authorId?: string): MacroRow[];
  updateMacro(id: number, command: string): void;
  deleteMacro(id: number): void;
}

/** Runtime mirror of `MacrosStore`'s method names — the drift test compares it to the facade. */
export const MACROS_STORE_METHODS = [
  "createMacro",
  "getMacro",
  "getMacroByName",
  "listMacros",
  "updateMacro",
  "deleteMacro",
] as const satisfies readonly (keyof MacrosStore)[];

export const MACROS_STORE_COMPLETE: ExactKeys<MacrosStore, typeof MACROS_STORE_METHODS> = true;
