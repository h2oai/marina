// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Filing and resolving a board's answers through the one outcome path. A board
 * adapter files each answer it submits under its owner and the board's own id,
 * then resolves by that id when the board publishes the outcome; scoring,
 * lessons and history follow from `resolveForecast`. Thin by design: an
 * adapter supplies only its id and its outcome as a resolution value.
 */

import { getErrorMessage } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { TypedForecastAnswer } from "../forecast/typed";
import type { MarinaDB } from "../persistence/database";
import { type ForecastResolution, resolveForecast } from "./forecast";

const logger = new Logger();

export interface BoardFiling {
  /** Whose answer it is (the board's entrant, e.g. `marina:metaculus`). */
  owner: string;
  /** The board, as the outcome's source prefix (`metaculus`, `futurex`, …). */
  source: string;
  /** The board's own id for the question, namespaced (`metaculus:q123`). */
  externalId: string;
  evalMode?: "live" | "measure";
}

/**
 * File a typed answer once per (owner, external id); an answer already filed
 * keeps its first row (returns its id). Best-effort: undefined when the write
 * failed (the submission itself never depends on it).
 */
export function fileTypedAnswer(
  db: MarinaDB,
  answer: TypedForecastAnswer,
  filing: BoardFiling,
  /** A number's sd when the board derived one the answer does not carry. */
  sd?: number,
): number | undefined {
  const existing = db.getForecastAnswerByExternalId(filing.owner, filing.externalId);
  if (existing) return existing.id;
  try {
    sd ??= answer.uncertainty?.sd;
    return db.saveForecastAnswer({
      entityName: filing.owner,
      question: answer.question,
      kind: answer.answer.type,
      ...(typeof answer.prediction === "number" ? { mean: answer.prediction } : {}),
      ...(typeof answer.prediction === "number" && sd ? { sd } : {}),
      ...(answer.formatted !== undefined ? { prediction: answer.formatted } : {}),
      answerJson: JSON.stringify(answer),
      source: filing.source,
      externalId: filing.externalId,
      ...(filing.evalMode ? { evalMode: filing.evalMode } : {}),
    });
  } catch (err) {
    logger.warn("main", "board answer not filed", {
      id: filing.externalId,
      error: getErrorMessage(err),
    });
    return undefined;
  }
}

/**
 * File a plain answer (a probability, or a number's mean and sd) once per
 * (owner, external id), for a board whose filing is not a typed answer.
 */
export function fileAnswer(
  db: MarinaDB,
  input: {
    question: string;
    kind: "probability" | "number";
    probability?: number;
    mean?: number;
    sd?: number;
    /** The board's own record of the answer (kept as the audit trail). */
    answer: unknown;
  },
  filing: BoardFiling,
): number | undefined {
  const existing = db.getForecastAnswerByExternalId(filing.owner, filing.externalId);
  if (existing) return existing.id;
  try {
    return db.saveForecastAnswer({
      entityName: filing.owner,
      question: input.question,
      kind: input.kind,
      ...(input.probability !== undefined ? { probability: input.probability } : {}),
      ...(input.mean !== undefined ? { mean: input.mean } : {}),
      ...(input.sd !== undefined ? { sd: input.sd } : {}),
      answerJson: JSON.stringify(input.answer),
      source: filing.source,
      externalId: filing.externalId,
      ...(filing.evalMode ? { evalMode: filing.evalMode } : {}),
    });
  } catch (err) {
    logger.warn("main", "board answer not filed", {
      id: filing.externalId,
      error: getErrorMessage(err),
    });
    return undefined;
  }
}

/**
 * Resolve a filed answer by its board id. `unfiled`: no answer was filed under
 * that id (an answer from before filing existed — the adapter keeps its old
 * path for it); `settled`: already resolved; undefined: the outcome could not
 * be scored against it (it stays open).
 */
export function resolveFiled(
  db: MarinaDB,
  owner: string,
  externalId: string,
  value: unknown,
  resolvedAt: number,
  refs: string[] = [],
): ForecastResolution | "unfiled" | "settled" | undefined {
  const row = db.getForecastAnswerByExternalId(owner, externalId);
  if (!row) return "unfiled";
  if (row.resolved_at !== null) return "settled";
  return resolveForecast(db, row.id, value, resolvedAt, { refs: [externalId, ...refs] });
}
