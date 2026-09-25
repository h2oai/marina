// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as arenaDb from "../db-arena";
import type { ExactKeys } from "./exact-keys";

/** Social Simulation Arena submissions (`db-arena.ts`). */
export interface ArenaStore {
  insertArenaSubmission(row: arenaDb.InsertArenaSubmission): number;
  updateArenaSubmission(
    id: number,
    update: { status: arenaDb.ArenaSubmissionStatus; httpStatus?: number; response?: string },
  ): void;
  latestArenaSubmission(entrant: string, roundId: string): arenaDb.ArenaSubmissionRow | undefined;
  listArenaSubmissions(opts?: { entrant?: string; limit?: number }): arenaDb.ArenaSubmissionRow[];
}

/** Runtime mirror of `ArenaStore`'s method names — the drift test compares it to the facade. */
export const ARENA_STORE_METHODS = [
  "insertArenaSubmission",
  "updateArenaSubmission",
  "latestArenaSubmission",
  "listArenaSubmissions",
] as const satisfies readonly (keyof ArenaStore)[];

export const ARENA_STORE_COMPLETE: ExactKeys<ArenaStore, typeof ARENA_STORE_METHODS> = true;
