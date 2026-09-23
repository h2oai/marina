// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type * as standingDb from "../db-standing";
import type { ExactKeys } from "./exact-keys";

/** Standing ledger and cache (`db-standing.ts`); entity ids resolve to durable keys at the facade. */
export interface StandingStore {
  appendStandingEvent(row: Parameters<typeof standingDb.appendStandingEvent>[1]): void;
  computeStanding(entityId: string, halfLifeMs: number, horizonMs: number, now: number): number;
  countStandingEvents(entityId: string, kind: string, since: number): number;
  getStandingCache(entityId: string): ReturnType<typeof standingDb.getStandingCache>;
  setStandingCache(entityId: string, standing: number, now: number): void;
  listStandingEntities(): string[];
  staleStandingEntities(cutoff: number): string[];
  standingLeaderboard(limit: number): ReturnType<typeof standingDb.standingLeaderboard>;
  ledgerForEntity(entityId: string, limit: number): ReturnType<typeof standingDb.ledgerForEntity>;
}

/** Runtime mirror of `StandingStore`'s method names — the drift test compares it to the facade. */
export const STANDING_STORE_METHODS = [
  "appendStandingEvent",
  "computeStanding",
  "countStandingEvents",
  "getStandingCache",
  "setStandingCache",
  "listStandingEntities",
  "staleStandingEntities",
  "standingLeaderboard",
  "ledgerForEntity",
] as const satisfies readonly (keyof StandingStore)[];

export const STANDING_STORE_COMPLETE: ExactKeys<StandingStore, typeof STANDING_STORE_METHODS> =
  true;
