// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  ForecastAnswerRow,
  MarketPositionRow,
  MarketRow,
  saveForecastAnswer,
} from "../db-markets";
import type { ExactKeys } from "./exact-keys";

/** Markets, positions and calibration scores (`db-markets.ts`). */
export interface MarketsStore {
  createMarket(market: { id: string; roomId: string; question: string; category?: string }): void;
  getMarket(id: string): MarketRow | undefined;
  getMarketByRoom(roomId: string): MarketRow | undefined;
  listMarkets(opts?: { status?: string; category?: string; limit?: number }): MarketRow[];
  searchMarkets(query: string): MarketRow[];
  upsertPosition(
    marketId: string,
    entityName: string,
    direction: string,
    confidence: number,
    reasoning: string,
  ): void;
  getMarketPositions(marketId: string): MarketPositionRow[];
  resolveMarket(marketId: string, outcome: string, resolvedBy: string): void;
  recordMarketScore(
    marketId: string,
    entityName: string,
    brierScore: number,
    correct: boolean,
  ): void;
  getCalibrationLeaderboard(
    limit?: number,
  ): { entity_name: string; avg_brier: number; markets_scored: number; correct_count: number }[];
  getEntityMarketScore(
    entityName: string,
  ): { avg_brier: number; markets_scored: number; correct_count: number } | undefined;
  /** Forecast answers (migration 144): the audit trail of `forecast <question>`. */
  saveForecastAnswer(input: Parameters<typeof saveForecastAnswer>[1]): number;
  linkForecastToSample(id: number, entityName: string, sampleId: string): boolean;
  listForecastAnswers(entityName: string, limit?: number): ForecastAnswerRow[];
  openForecastsForSample(sampleId: string): ForecastAnswerRow[];
  resolveForecastAnswer(
    id: number,
    outcomeJson: string,
    score: number | null,
    now?: number,
  ): boolean;
}

/** Runtime mirror of `MarketsStore`'s method names — the drift test compares it to the facade. */
export const MARKETS_STORE_METHODS = [
  "createMarket",
  "getMarket",
  "getMarketByRoom",
  "listMarkets",
  "searchMarkets",
  "upsertPosition",
  "getMarketPositions",
  "resolveMarket",
  "recordMarketScore",
  "getCalibrationLeaderboard",
  "getEntityMarketScore",
  "saveForecastAnswer",
  "linkForecastToSample",
  "listForecastAnswers",
  "openForecastsForSample",
  "resolveForecastAnswer",
] as const satisfies readonly (keyof MarketsStore)[];

export const MARKETS_STORE_COMPLETE: ExactKeys<MarketsStore, typeof MARKETS_STORE_METHODS> = true;
