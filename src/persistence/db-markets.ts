// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Markets ───────────────────────────────────────────────────────────────

export function createMarket(
  db: Database,
  market: { id: string; roomId: string; question: string; category?: string },
): void {
  db.run(
    "INSERT OR IGNORE INTO markets (id, room_id, question, category, created_at) VALUES (?, ?, ?, ?, ?)",
    [market.id, market.roomId, market.question, market.category ?? "", Date.now()],
  );
}

export function getMarket(db: Database, id: string): MarketRow | undefined {
  return (db.query("SELECT * FROM markets WHERE id = ?").get(id) as MarketRow | null) ?? undefined;
}

export function getMarketByRoom(db: Database, roomId: string): MarketRow | undefined {
  return (
    (db.query("SELECT * FROM markets WHERE room_id = ?").get(roomId) as MarketRow | null) ??
    undefined
  );
}

export function listMarkets(
  db: Database,
  opts?: { status?: string; category?: string; limit?: number },
): MarketRow[] {
  const limit = opts?.limit ?? 50;
  if (opts?.status) {
    return db
      .query("SELECT * FROM markets WHERE status = ? ORDER BY created_at DESC LIMIT ?")
      .all(opts.status, limit) as MarketRow[];
  }
  if (opts?.category) {
    return db
      .query("SELECT * FROM markets WHERE category = ? ORDER BY created_at DESC LIMIT ?")
      .all(opts.category, limit) as MarketRow[];
  }
  return db
    .query("SELECT * FROM markets ORDER BY created_at DESC LIMIT ?")
    .all(limit) as MarketRow[];
}

export function searchMarkets(db: Database, query: string): MarketRow[] {
  return db
    .query(
      `SELECT m.* FROM markets m
         JOIN markets_fts f ON m.seq = f.rowid
         WHERE markets_fts MATCH ?
         ORDER BY rank LIMIT 20`,
    )
    .all(query) as MarketRow[];
}

export function upsertPosition(
  db: Database,
  marketId: string,
  entityName: string,
  direction: string,
  confidence: number,
  reasoning: string,
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO market_positions (market_id, entity_name, direction, confidence, reasoning, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(market_id, entity_name)
       DO UPDATE SET direction = excluded.direction, confidence = excluded.confidence,
                     reasoning = excluded.reasoning, updated_at = excluded.updated_at`,
    [marketId, entityName, direction, confidence, reasoning, now, now],
  );
}

export function getMarketPositions(db: Database, marketId: string): MarketPositionRow[] {
  return db
    .query("SELECT * FROM market_positions WHERE market_id = ? ORDER BY updated_at DESC")
    .all(marketId) as MarketPositionRow[];
}

export function resolveMarket(
  db: Database,
  marketId: string,
  outcome: string,
  resolvedBy: string,
): void {
  db.run(
    "UPDATE markets SET status = 'resolved', outcome = ?, resolved_at = ?, resolved_by = ? WHERE id = ?",
    [outcome, Date.now(), resolvedBy, marketId],
  );
}

export function recordMarketScore(
  db: Database,
  marketId: string,
  entityName: string,
  brierScore: number,
  correct: boolean,
): void {
  db.run(
    "INSERT INTO market_scores (market_id, entity_name, brier_score, correct, scored_at) VALUES (?, ?, ?, ?, ?)",
    [marketId, entityName, brierScore, correct ? 1 : 0, Date.now()],
  );
}

export function getCalibrationLeaderboard(
  db: Database,
  limit = 20,
): { entity_name: string; avg_brier: number; markets_scored: number; correct_count: number }[] {
  return db
    .query(
      `SELECT entity_name, AVG(brier_score) as avg_brier,
                COUNT(*) as markets_scored, SUM(correct) as correct_count
         FROM market_scores
         GROUP BY entity_name
         HAVING markets_scored >= 1
         ORDER BY avg_brier ASC
         LIMIT ?`,
    )
    .all(limit) as {
    entity_name: string;
    avg_brier: number;
    markets_scored: number;
    correct_count: number;
  }[];
}

export function getEntityMarketScore(
  db: Database,
  entityName: string,
): { avg_brier: number; markets_scored: number; correct_count: number } | undefined {
  return (
    (db
      .query(
        `SELECT AVG(brier_score) as avg_brier, COUNT(*) as markets_scored,
                  SUM(correct) as correct_count
           FROM market_scores WHERE entity_name = ?`,
      )
      .get(entityName) as {
      avg_brier: number;
      markets_scored: number;
      correct_count: number;
    } | null) ?? undefined
  );
}

// ─── Forecast answers (migration 145; typed kinds, migration 151) ─────────

export type ForecastAnswerKind = "probability" | "number" | "choice" | "multi" | "ranking" | "text";

export interface ForecastAnswerRow {
  id: number;
  entity_name: string;
  question: string;
  kind: ForecastAnswerKind;
  probability: number | null;
  mean: number | null;
  sd: number | null;
  /** A typed answer (choice, set, ranking, text, or a number's point) as one string (migration 151). */
  prediction: string | null;
  /** The full answer object (analysts, judge, sources, verification, cost). */
  answer_json: string;
  /** Resolver Sample id (`<venue>/<ticker>`) this forecast resolves on. */
  sample_id: string | null;
  created_at: number;
  resolved_at: number | null;
  outcome_json: string | null;
  /** Brier score (probability) or CRPS (number); lower is better. */
  score: number | null;
}

export function saveForecastAnswer(
  db: Database,
  input: {
    entityName: string;
    question: string;
    kind: ForecastAnswerKind;
    probability?: number;
    mean?: number;
    sd?: number;
    prediction?: string;
    answerJson: string;
    sampleId?: string;
    now?: number;
  },
): number {
  const result = db.run(
    `INSERT INTO forecast_answers
       (entity_name, question, kind, probability, mean, sd, prediction, answer_json, sample_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.entityName,
      input.question,
      input.kind,
      input.probability ?? null,
      input.mean ?? null,
      input.sd ?? null,
      input.prediction ?? null,
      input.answerJson,
      input.sampleId ?? null,
      input.now ?? Date.now(),
    ],
  );
  return Number(result.lastInsertRowid);
}

/** Link the caller's own unresolved forecast to a Sample id. False when not theirs or settled. */
export function linkForecastToSample(
  db: Database,
  id: number,
  entityName: string,
  sampleId: string,
): boolean {
  return (
    db.run(
      `UPDATE forecast_answers SET sample_id = ?
       WHERE id = ? AND entity_name = ? AND resolved_at IS NULL`,
      [sampleId, id, entityName],
    ).changes > 0
  );
}

export function listForecastAnswers(
  db: Database,
  entityName: string,
  limit = 20,
): ForecastAnswerRow[] {
  return db
    .query(
      "SELECT * FROM forecast_answers WHERE entity_name = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(entityName, limit) as ForecastAnswerRow[];
}

export function openForecastsForSample(db: Database, sampleId: string): ForecastAnswerRow[] {
  return db
    .query("SELECT * FROM forecast_answers WHERE sample_id = ? AND resolved_at IS NULL")
    .all(sampleId) as ForecastAnswerRow[];
}

/** Settle once: a forecast already resolved is never re-scored. */
export function resolveForecastAnswer(
  db: Database,
  id: number,
  outcomeJson: string,
  score: number | null,
  now = Date.now(),
): boolean {
  return (
    db.run(
      `UPDATE forecast_answers SET resolved_at = ?, outcome_json = ?, score = ?
       WHERE id = ? AND resolved_at IS NULL`,
      [now, outcomeJson, score, id],
    ).changes > 0
  );
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface MarketRow {
  id: string;
  room_id: string;
  question: string;
  category: string;
  status: string;
  outcome: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
  created_at: number;
}

export interface MarketPositionRow {
  id: number;
  market_id: string;
  entity_name: string;
  direction: string;
  confidence: number;
  reasoning: string;
  created_at: number;
  updated_at: number;
}
