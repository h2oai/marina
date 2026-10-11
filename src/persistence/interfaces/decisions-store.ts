// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { DecisionReceipt } from "../../sdk/decision-receipt";
import type * as decisionsDb from "../db-decisions";
import type { ExactKeys } from "./exact-keys";

/** Judge observations and challenge outcomes — a decision backend measured against human verdicts (`db-decisions.ts`). */
export interface DecisionsStore {
  recordDecisionReceipt(owner: string, subject: string, receipt: DecisionReceipt): void;
  listDecisionReceipts(owner: string, limit?: number): decisionsDb.DecisionReceiptRow[];
  linkDecisionOutcome(owner: string, decisionId: string, outcomeId: number): boolean;
  decisionOutcomeIds(owner: string, decisionId: string): number[];
  recordJudgeObservation(row: decisionsDb.JudgeObservationInput): number;
  listJudgeObservations(opts?: {
    evaluator?: string;
    limit?: number;
  }): decisionsDb.JudgeObservationRow[];
  recordChallengeOutcome(row: decisionsDb.ChallengeOutcomeInput): number;
  listChallengeOutcomes(opts?: {
    class?: string;
    limit?: number;
  }): decisionsDb.ChallengeOutcomeRow[];
}

/** Runtime mirror of `DecisionsStore`'s method names — the drift test compares it to the facade. */
export const DECISIONS_STORE_METHODS = [
  "recordDecisionReceipt",
  "listDecisionReceipts",
  "linkDecisionOutcome",
  "decisionOutcomeIds",
  "recordJudgeObservation",
  "listJudgeObservations",
  "recordChallengeOutcome",
  "listChallengeOutcomes",
] as const satisfies readonly (keyof DecisionsStore)[];

export const DECISIONS_STORE_COMPLETE: ExactKeys<DecisionsStore, typeof DECISIONS_STORE_METHODS> =
  true;
