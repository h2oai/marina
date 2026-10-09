// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as outcomesDb from "../db-outcomes";
import type { ExactKeys } from "./exact-keys";

/** The outcome path: resolved subjects and per-consumer delivery state (`db-outcomes.ts`). */
export interface OutcomesStore {
  recordOutcomeRow(
    input: outcomesDb.OutcomeInput,
    consumers: readonly string[],
  ): { id: number; created: boolean };
  getOutcome(id: number): outcomesDb.OutcomeRow | undefined;
  getOutcomeBySubject(subject: string): outcomesDb.OutcomeRow | undefined;
  listOutcomes(opts?: { kind?: outcomesDb.OutcomeKind; limit?: number }): outcomesDb.OutcomeRow[];
  pendingOutcomes(consumer: string, limit: number): outcomesDb.OutcomeRow[];
  setOutcomeDelivery(
    outcomeId: number,
    consumer: string,
    state: outcomesDb.DeliveryState,
    reason?: string,
    now?: number,
  ): void;
  outcomeDeliveries(outcomeId: number): outcomesDb.DeliveryRow[];
  outcomeDeliveryCounts(): Array<{ consumer: string; state: outcomesDb.DeliveryState; n: number }>;
}

/** Runtime mirror of `OutcomesStore`'s method names — the drift test compares it to the facade. */
export const OUTCOMES_STORE_METHODS = [
  "recordOutcomeRow",
  "getOutcome",
  "getOutcomeBySubject",
  "listOutcomes",
  "pendingOutcomes",
  "setOutcomeDelivery",
  "outcomeDeliveries",
  "outcomeDeliveryCounts",
] as const satisfies readonly (keyof OutcomesStore)[];

export const OUTCOMES_STORE_COMPLETE: ExactKeys<OutcomesStore, typeof OUTCOMES_STORE_METHODS> =
  true;
