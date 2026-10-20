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
  /**
   * Residents or agents (account names) that produced the answer besides the
   * owner. Kept on the stored answer (`producers`); when it resolves each is
   * credited `forecast_resolved` under the same caps and independence rule
   * as the owner (`src/outcomes/forecast.ts`).
   */
  producers?: readonly string[];
}

/** The stored answer JSON with its producers attached (none: unchanged). */
function withProducers(answer: unknown, producers: readonly string[] | undefined): string {
  const names = cleanProducers(producers);
  if (!names.length || typeof answer !== "object" || answer === null || Array.isArray(answer))
    return JSON.stringify(answer);
  return JSON.stringify({ ...(answer as Record<string, unknown>), producers: names });
}

/** At most 8 distinct, non-empty account names. */
export function cleanProducers(producers: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const p of producers ?? []) {
    if (typeof p !== "string") continue;
    const name = p.trim();
    if (name && !out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= 8) break;
  }
  return out;
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
      answerJson: withProducers(answer, filing.producers),
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
      answerJson: withProducers(input.answer, filing.producers),
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

/** A resident's own probability, filed in-world (a market room's `predict`, `conduct track`). */
export interface ResidentForecast {
  /** The resident (or person) whose call it is: the answer's owner and producer. */
  owner: string;
  /** `market` (a market room's `predict`) or `conduct` (`conduct track`). */
  source: "market" | "conduct";
  /**
   * What makes a later call replace this one: the same owner, source and key
   * (`inworld:<marketId>`, `conduct:<score>:<sampleId>`).
   */
  key: string;
  /** The resolver Sample id it resolves on (`inworld/<marketId>`, `<venue>/<ticker>`). */
  sampleId: string;
  question: string;
  /** P(yes), 0–1. */
  probability: number;
  /** The surface's own record of the call (kept as the audit trail; never on the outcome). */
  answer: Record<string, unknown>;
}

/**
 * File a resident's in-world forecast on the one outcome path, so it resolves
 * through `resolveForecast` when its Sample resolves (Brier, one outcome,
 * lessons, `forecast_resolved` standing under the usual caps and independence
 * rule). A newer call with the same key replaces the open one: the earlier
 * row is settled `superseded`, unscored, and records no outcome — only the
 * latest call counts, as on the market's own board. Best-effort: undefined
 * when the write failed (the surface's own record never depends on it).
 */
export function fileResidentForecast(
  db: MarinaDB,
  input: ResidentForecast,
  now = Date.now(),
): number | undefined {
  const p = Math.max(0, Math.min(1, input.probability));
  if (!input.owner || !input.sampleId || !Number.isFinite(p)) return undefined;
  try {
    for (const open of db.openForecastsForSample(input.sampleId)) {
      if (open.entity_name !== input.owner || open.source !== input.source) continue;
      if (!open.external_id?.startsWith(`${input.key}#`)) continue;
      db.resolveForecastAnswer(open.id, JSON.stringify({ superseded: true }), null, now);
    }
    let externalId = `${input.key}#${now}`;
    for (let n = 1; db.getForecastAnswerByExternalId(input.owner, externalId); n++)
      externalId = `${input.key}#${now}.${n}`;
    return db.saveForecastAnswer({
      entityName: input.owner,
      question: input.question,
      kind: "probability",
      probability: p,
      answerJson: JSON.stringify({ ...input.answer, producers: [input.owner] }),
      sampleId: input.sampleId,
      source: input.source,
      externalId,
      // No eval mode: a resident's live call (any eval mode, `live` included,
      // never earns standing in `resolveForecast`).
      now,
    });
  } catch (err) {
    logger.warn("main", "resident forecast not filed", {
      key: input.key,
      error: getErrorMessage(err),
    });
    return undefined;
  }
}
