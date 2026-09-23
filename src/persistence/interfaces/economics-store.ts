// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as economicsDb from "../db-economics";
import type { ExactKeys } from "./exact-keys";

/** Asset-neutral economics (`db-economics.ts`). */
export interface EconomicsStore {
  createEconomicContract(
    input: Parameters<typeof economicsDb.createEconomicContract>[1],
  ): ReturnType<typeof economicsDb.createEconomicContract>;
  getEconomicContract(id: string): ReturnType<typeof economicsDb.getEconomicContract>;
  listEconomicContracts(): ReturnType<typeof economicsDb.listEconomicContracts>;
  appendEconomicEvent(
    input: Parameters<typeof economicsDb.appendEconomicEvent>[1],
  ): ReturnType<typeof economicsDb.appendEconomicEvent>;
  listEconomicEvents(id: string, limit?: number): ReturnType<typeof economicsDb.listEconomicEvents>;
  verifyEconomicEvent(
    row: economicsDb.EconomicEventRow,
  ): ReturnType<typeof economicsDb.verifyEconomicEvent>;
  createEconomicAdapter(
    input: Parameters<typeof economicsDb.createEconomicAdapter>[1],
  ): ReturnType<typeof economicsDb.createEconomicAdapter>;
  listEconomicAdapters(): ReturnType<typeof economicsDb.listEconomicAdapters>;
}

/** Runtime mirror of `EconomicsStore`'s method names — the drift test compares it to the facade. */
export const ECONOMICS_STORE_METHODS = [
  "createEconomicContract",
  "getEconomicContract",
  "listEconomicContracts",
  "appendEconomicEvent",
  "listEconomicEvents",
  "verifyEconomicEvent",
  "createEconomicAdapter",
  "listEconomicAdapters",
] as const satisfies readonly (keyof EconomicsStore)[];

export const ECONOMICS_STORE_COMPLETE: ExactKeys<EconomicsStore, typeof ECONOMICS_STORE_METHODS> =
  true;
