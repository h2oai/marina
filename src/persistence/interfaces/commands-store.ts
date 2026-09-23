// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CommandHistoryRow, CommandSourceRow } from "../db-commands";
import type { ExactKeys } from "./exact-keys";

/** Dynamic commands (`db-commands.ts`). */
export interface CommandsStore {
  saveCommandSource(opts: { id: string; name: string; source: string; createdBy: string }): void;
  getCommand(id: string): CommandSourceRow | undefined;
  getCommandByName(name: string): CommandSourceRow | undefined;
  listCommands(): CommandSourceRow[];
  markCommandValid(name: string): void;
  deleteCommand(name: string): void;
  getCommandHistory(name: string, limit?: number): CommandHistoryRow[];
  getAllValidCommandNames(): string[];
  clearDynamicCommands(): void;
}

/** Runtime mirror of `CommandsStore`'s method names — the drift test compares it to the facade. */
export const COMMANDS_STORE_METHODS = [
  "saveCommandSource",
  "getCommand",
  "getCommandByName",
  "listCommands",
  "markCommandValid",
  "deleteCommand",
  "getCommandHistory",
  "getAllValidCommandNames",
  "clearDynamicCommands",
] as const satisfies readonly (keyof CommandsStore)[];

export const COMMANDS_STORE_COMPLETE: ExactKeys<CommandsStore, typeof COMMANDS_STORE_METHODS> =
  true;
