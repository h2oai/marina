// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as judgeLedgerDb from "../db-judge-ledger";
import type { ExactKeys } from "./exact-keys";

/** The judge ledger — every judge opinion and its ground truth (`db-judge-ledger.ts`). */
export interface JudgeLedgerStore {
  recordJudgeOpinion(row: judgeLedgerDb.JudgeOpinionInput): void;
  settleJudgeTruth(truth: {
    subject: string;
    succeeded: boolean;
    truthJson?: string | null;
    resolvedAt: number;
  }): number;
  findJudgeTruth(
    key: string,
    opinedAt: number,
  ): { subject: string; succeeded: number; truth_json: string | null; resolved_at: number } | null;
  listJudgeLedger(opts?: {
    surface?: string;
    judge?: string;
    limit?: number;
  }): judgeLedgerDb.JudgeLedgerRow[];
  judgeLedgerTallies(opts?: {
    surface?: string;
    judge?: string;
    question?: string;
    byQuestion?: boolean;
  }): judgeLedgerDb.JudgeLedgerTally[];
  backfillJudgeLedger(): void;
}

/** Runtime mirror of `JudgeLedgerStore`'s method names — the drift test compares it to the facade. */
export const JUDGE_LEDGER_STORE_METHODS = [
  "recordJudgeOpinion",
  "settleJudgeTruth",
  "findJudgeTruth",
  "listJudgeLedger",
  "judgeLedgerTallies",
  "backfillJudgeLedger",
] as const satisfies readonly (keyof JudgeLedgerStore)[];

export const JUDGE_LEDGER_STORE_COMPLETE: ExactKeys<
  JudgeLedgerStore,
  typeof JUDGE_LEDGER_STORE_METHODS
> = true;
