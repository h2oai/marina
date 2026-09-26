// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as decisionsDb from "../db-decisions";
import type { ExactKeys } from "./exact-keys";

/** Judge observations for measuring a decision backend against human verdicts (`db-decisions.ts`). */
export interface DecisionsStore {
  recordJudgeObservation(row: decisionsDb.JudgeObservationInput): number;
  listJudgeObservations(opts?: {
    evaluator?: string;
    limit?: number;
  }): decisionsDb.JudgeObservationRow[];
}

/** Runtime mirror of `DecisionsStore`'s method names — the drift test compares it to the facade. */
export const DECISIONS_STORE_METHODS = [
  "recordJudgeObservation",
  "listJudgeObservations",
] as const satisfies readonly (keyof DecisionsStore)[];

export const DECISIONS_STORE_COMPLETE: ExactKeys<DecisionsStore, typeof DECISIONS_STORE_METHODS> =
  true;
