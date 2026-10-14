// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { DecisionReceipt } from "../../sdk/decision-receipt";
import type * as decisionsDb from "../db-decisions";
import type { ExactKeys } from "./exact-keys";

/** Judge observations, challenge outcomes and durable challenge holds — a decision backend measured against human verdicts (`db-decisions.ts`). */
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
  saveChallengeHold(row: decisionsDb.ChallengeHoldInput): void;
  updateChallengeHold(
    token: string,
    patch: {
      status?: decisionsDb.ChallengeHoldStatus;
      requesterNotice?: string | null;
      requesterId?: string;
    },
  ): boolean;
  listChallengeHolds(opts?: {
    pending?: boolean;
    withNotice?: boolean;
    limit?: number;
  }): decisionsDb.ChallengeHoldRow[];
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
  "saveChallengeHold",
  "updateChallengeHold",
  "listChallengeHolds",
] as const satisfies readonly (keyof DecisionsStore)[];

export const DECISIONS_STORE_COMPLETE: ExactKeys<DecisionsStore, typeof DECISIONS_STORE_METHODS> =
  true;
