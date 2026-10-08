// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Calibration loop — pairs resolved Samples with whatever forecast / position
// notes referenced the same (kind, id), and writes outcome notes that close
// the generational learning loop. Successor agents `recall` the chain and
// learn whether the predictor was reliable for this class of question.
//
// This module replaces the hardcoded `calibrateForecasts` in feed-publisher
// (which only knew about TabH2O forecast notes). Now any module can register
// a finder; new prediction methods (scenario reports, position theses,
// agent debates) close their own loops by registering their own finder.
//
// Filter at source: finders run only on status="resolved" Samples — that's
// the closure-relevant signal. Open markets and no-change polls skip this
// path entirely (writeSample's status check upstream).

import { crpsNormal } from "../arena/score";
import { recordScoreOutcome } from "../coordination/score-outcome";
import { loadScore } from "../coordination/score-store";
import { positionSettlementFinder } from "../engine/commands/position";
import { Logger } from "../engine/logger";
import { noteResolvedForecast, truthFromResolution } from "../forecast/adjust";
import { historyFromEnv } from "../forecast/history";
import type { TypedForecastAnswer } from "../forecast/typed";
import { scoreTypedAnswer } from "../forecast/typed-score";
import { noteOutcome } from "../learning/service";
import type { MarinaDB } from "../persistence/database";
import type { EngineEvent, EntityId, RoomId } from "../types";
import type { Sample } from "./types";

/** Module logger. */
const logger = new Logger();

export interface CalibrationFinder {
  /** Short name for diagnostics + idempotency-on-register. */
  name: string;
  /**
   * For a resolved sample, find related forecast / position notes and write
   * outcome notes that close the loop. Best-effort — failures are logged
   * (not thrown). Receives the engine-event sink so outcome-note creation
   * can broadcast through the same dashboard / feed pipeline as the rest.
   */
  calibrate(db: MarinaDB, sample: Sample, emitEvent?: (event: EngineEvent) => void): void;
}

const FINDERS = new Map<string, CalibrationFinder>();

export function registerCalibrationFinder(finder: CalibrationFinder): void {
  FINDERS.set(finder.name, finder);
}

export function listCalibrationFinders(): CalibrationFinder[] {
  return [...FINDERS.values()];
}

/** Test helper. */
export function clearCalibrationFinders(): void {
  FINDERS.clear();
}

/** Run every registered finder against a resolved sample. No-op for any
 *  other sample status. Errors in one finder do not abort the others —
 *  calibration is best-effort. */
export function runCalibration(
  db: MarinaDB,
  sample: Sample,
  emitEvent?: (event: EngineEvent) => void,
): void {
  if (sample.status !== "resolved") return;
  for (const finder of FINDERS.values()) {
    try {
      finder.calibrate(db, sample, emitEvent);
    } catch (err) {
      logger.warn("calibration", `finder ${finder.name} failed`, { error: (err as Error).message });
    }
  }
}

// ─── Sample id parsing ──────────────────────────────────────────────────────

/** Extract the venue + ticker components of a Sample.id. The convention is
 *  `<venue>/<ticker>` for resolving samples (kalshi/KXFED-26MAR,
 *  polymarket/btc-100k-friday, inworld/<uuid>). */
export function parseSampleId(id: string): { venue: string; ticker: string } | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  const venue = id.slice(0, slash);
  const ticker = id.slice(slash + 1);
  if (!venue || !ticker) return undefined;
  return { venue, ticker };
}

/** Extract the YES/NO outcome from a resolved Sample's value, tolerantly.
 *  Different resolvers shape value differently; this is the common path. */
export function extractOutcome(sample: Sample): "yes" | "no" | undefined {
  const v = sample.value as Record<string, unknown> | undefined;
  const outcome = v?.outcome;
  if (outcome === "yes" || outcome === "no") return outcome;
  return undefined;
}

// ─── Built-in finders ───────────────────────────────────────────────────────

/**
 * TabH2O forecast finder — pairs `[TabH2O forecast <marketId>]` notes with
 * `[TabH2O outcome <marketId>]` outcomes. Inherited from the legacy
 * calibrateForecasts code; now generalized to read from a Sample instead
 * of a bespoke market_resolution event.
 *
 * Convention: TabH2O forecast notes were filed against the in-world DB
 * marketId, so this finder fires for samples whose venue is "inworld".
 */
export const tabh2oForecastFinder: CalibrationFinder = {
  name: "tabh2o-forecast",
  calibrate(db, sample, emitEvent) {
    const parts = parseSampleId(sample.id);
    if (parts?.venue !== "inworld") return;
    const outcome = extractOutcome(sample);
    if (!outcome) return;
    const marketId = parts.ticker;

    const matches = db.searchAllNotes(`TabH2O forecast ${marketId}`, 20);
    for (const note of matches) {
      if (!note.content.includes(`[TabH2O forecast ${marketId}]`)) continue;
      const m = note.content.match(/YES (\d+)%/);
      if (!m) continue;
      const predictedYesPct = Number(m[1]);
      const predictedYesProb = predictedYesPct / 100;
      const actualYesProb = outcome === "yes" ? 1 : 0;
      const brier = (predictedYesProb - actualYesProb) ** 2;
      const correct =
        (outcome === "yes" && predictedYesPct >= 50) || (outcome === "no" && predictedYesPct < 50);

      const outcomeContent =
        `[TabH2O outcome ${marketId}] Predicted YES ${predictedYesPct}% → actual ${outcome.toUpperCase()}. ` +
        `Brier ${brier.toFixed(3)}, ${correct ? "CORRECT" : "MISS"}. Forecast: note #${note.id}.`;

      let outcomeId: number;
      try {
        outcomeId = db.createNote(note.entity_name, outcomeContent, note.room_id ?? undefined, {
          importance: 8,
          noteType: "inference",
        });
      } catch (err) {
        logger.warn("calibration", "tabh2o: outcome note write failed", {
          error: (err as Error).message,
        });
        continue;
      }

      emitEvent?.({
        type: "note_created",
        entity: note.entity_name as EntityId,
        noteId: outcomeId,
        authorName: note.entity_name,
        content: outcomeContent,
        importance: 8,
        noteType: "inference",
        roomId: (note.room_id ?? undefined) as RoomId | undefined,
        timestamp: Date.now(),
      });

      try {
        db.createNoteLink(note.id, outcomeId, "related_to");
        emitEvent?.({
          type: "note_link_created",
          entity: note.entity_name as EntityId,
          sourceId: note.id,
          targetId: outcomeId,
          relationship: "related_to",
          timestamp: Date.now(),
        });
      } catch {
        // Duplicate link / FK mismatch — non-fatal.
      }
    }
  },
};

/**
 * Position-thesis finder — pairs paper-orders board posts with outcome
 * notes once the underlying market resolves. For v1, writes a calibration
 * note recording: which side we took, what the market resolved to, and
 * whether we won. Realized P&L is booked separately by the
 * `position-settlement` finder (settle orders on the same ledger); this one
 * closes the qualitative loop so positions accumulate a track record.
 *
 * Looks for orders where the body's `ticker` field matches the sample's
 * ticker. Venue-aware: kalshi positions only get calibrated by kalshi
 * resolutions, etc.
 */
export const positionThesisFinder: CalibrationFinder = {
  name: "position-thesis",
  calibrate(db, sample, emitEvent) {
    const parts = parseSampleId(sample.id);
    if (!parts) return;
    if (parts.venue !== "kalshi" && parts.venue !== "polymarket") return;
    const outcome = extractOutcome(sample);
    if (!outcome) return;

    // Find the paper-orders board (may not exist if bettor world isn't loaded)
    let boardId: string;
    try {
      const board = db.getBoardByName("paper-orders");
      if (!board) return;
      boardId = board.id;
    } catch {
      return;
    }

    const posts = db.listBoardPosts(boardId, { limit: 200 });
    for (const post of posts) {
      // Body is JSON-encoded OrderRecord. Parse tolerantly.
      let order: { venue?: string; ticker?: string; side?: string; action?: string };
      try {
        order = JSON.parse(post.body) as typeof order;
      } catch {
        continue;
      }
      if (order.venue !== parts.venue) continue;
      if (order.ticker !== parts.ticker) continue;
      if (order.action !== "open") continue; // skip closes — they'll have their own settlement

      const side = order.side === "yes" ? "yes" : "no";
      const correct = side === outcome;
      const outcomeContent =
        `[position outcome ${parts.venue}/${parts.ticker}] Took ${side.toUpperCase()} → actual ${outcome.toUpperCase()}. ` +
        `${correct ? "WIN" : "LOSS"}. Order: post #${post.id}.`;

      let outcomeNoteId: number;
      try {
        outcomeNoteId = db.createNote(post.author_name, outcomeContent, undefined, {
          importance: 8,
          noteType: "inference",
        });
      } catch (err) {
        logger.warn("calibration", "position: outcome note write failed", {
          error: (err as Error).message,
        });
        continue;
      }
      emitEvent?.({
        type: "note_created",
        entity: post.author_name as EntityId,
        noteId: outcomeNoteId,
        authorName: post.author_name,
        content: outcomeContent,
        importance: 8,
        noteType: "inference",
        timestamp: Date.now(),
      });
    }
  },
};

/**
 * Inworld-market-resolver finder — handles DB persistence for in-world
 * prediction markets (worlds/markets.ts). The room's resolve handler writes
 * a Sample with id="inworld/<marketId>" and value carrying the outcome +
 * per-position Brier scores; this finder propagates that to the markets +
 * market_scores tables. Was previously inlined in
 * FeedPublisher.publishMarketResolution; now lives as a finder so the
 * Sample-driven path is the single source of truth.
 */
export const inworldMarketResolverFinder: CalibrationFinder = {
  name: "inworld-market-resolver",
  calibrate(db, sample) {
    const parts = parseSampleId(sample.id);
    if (parts?.venue !== "inworld") return;
    const value = sample.value as
      | {
          outcome?: "yes" | "no";
          scores?: { entity: string; brier: number; correct: boolean }[];
          marketId?: string;
          resolvedBy?: string;
        }
      | undefined;
    if (!value || (value.outcome !== "yes" && value.outcome !== "no")) return;
    const marketId = value.marketId ?? parts.ticker;
    const resolvedBy = value.resolvedBy ?? "system";

    try {
      db.resolveMarket(marketId, value.outcome, resolvedBy);
    } catch (err) {
      logger.warn("calibration", "inworld: resolveMarket failed", {
        error: (err as Error).message,
      });
    }
    if (value.scores) {
      for (const s of value.scores) {
        try {
          db.recordMarketScore(marketId, s.entity, s.brier, s.correct);
        } catch (err) {
          logger.warn("calibration", "inworld: recordMarketScore failed", {
            error: (err as Error).message,
          });
        }
      }
    }
  },
};

/**
 * Conductor learning loop (Phase 5 automatic closure). When a question a Score
 * was tracking against resolves, score the Score's prediction (Brier) and write
 * its shape→outcome prior so successor conductors recall what worked — no
 * gradients, just generational memory. Producer: `conduct track <name>
 * <sampleId> predict=<p>` writes the `[score-run:<sampleId>]` note this pairs
 * with. See the conductor design (private archive: marina-internal design/conductor-design.md), Phase 5.
 */
export const conductorScoreFinder: CalibrationFinder = {
  name: "conductor-score",
  calibrate(db, sample) {
    const outcome = extractOutcome(sample);
    if (!outcome) return;
    const actual = outcome === "yes" ? 1 : 0;
    const tag = `[score-run:${sample.id}]`;
    const matches = db
      .searchAllNotes(`score-run ${sample.id}`, 20)
      .filter((n) => n.content.includes(tag));
    for (const note of matches) {
      const predM = note.content.match(/predict=([0-9.]+)/);
      const nameM = note.content.match(/score:(\S+)/);
      if (!predM || !nameM) continue;
      const predict = Number(predM[1]);
      const scoreName = nameM[1]!;
      const score = loadScore(db, scoreName);
      if (!score) continue;
      const brier = (predict - actual) ** 2;
      const category = note.content.match(/category:(\S+)/)?.[1];
      recordScoreOutcome(db, score, {
        scoreName,
        score: 1 - brier, // quality: 1 = perfectly calibrated, 0 = maximally wrong
        category,
        label: `auto: ${sample.id} → ${outcome.toUpperCase()}, predicted ${predict.toFixed(2)}, Brier ${brier.toFixed(3)}`,
        recordedBy: note.entity_name,
      });
    }
  },
};

/** A numeric resolution: `value` itself, or its `value` / `actual` field. */
export function extractNumericOutcome(sample: Sample): number | undefined {
  const v = sample.value;
  const n =
    typeof v === "number"
      ? v
      : typeof v === "object" && v !== null
        ? ((v as Record<string, unknown>).value ?? (v as Record<string, unknown>).actual)
        : undefined;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Forecast-question finder — closes the loop for `forecast <question>`
 * (`src/forecast/`). Answers are persisted in `forecast_answers` (migration
 * 144) with the Sample id they resolve on (`resolves:<venue>/<ticker>` or
 * `forecast track <id> <sampleId>`). When that Sample resolves, each open
 * answer is settled once: a probability gets its Brier score against the
 * yes/no outcome, a number its CRPS against the numeric outcome. An answer
 * that produced no value is settled with the outcome and no score. A typed
 * answer (choice / multi / ranking / text) is scored by `scoreTypedAnswer`
 * (`src/forecast/typed-score.ts`) against the outcome matched to its own
 * options; an outcome it cannot match leaves the row open. A typed number is a
 * number (CRPS from its uncertainty). Every scored answer is handed to the
 * lesson loop. The row is the record — `forecast list` shows the track record.
 */
export const forecastQuestionFinder: CalibrationFinder = {
  name: "forecast-question",
  calibrate(db, sample) {
    const open = db.openForecastsForSample(sample.id);
    if (open.length === 0) return;
    const outcome = extractOutcome(sample);
    const actual = extractNumericOutcome(sample);
    for (const f of open) {
      if (f.kind === "probability") {
        if (!outcome) continue;
        const y = outcome === "yes" ? 1 : 0;
        const brier = f.probability === null ? null : (f.probability - y) ** 2;
        db.resolveForecastAnswer(
          f.id,
          JSON.stringify({
            sampleId: sample.id,
            outcome,
            ...(brier === null
              ? {}
              : { brier, correct: (f.probability ?? 0) >= 0.5 === (outcome === "yes") }),
          }),
          brier,
          sample.ts,
        );
        if (brier !== null)
          noteOutcome(db, {
            domain: "forecast",
            source: "forecast:probability",
            succeeded: (f.probability ?? 0) >= 0.5 === (outcome === "yes"),
            score: 1 - brier,
            resolvedAt: new Date(sample.ts).toISOString(),
            attempted: "probability forecast of a yes/no question",
            detail: `brier ${brier.toFixed(3)} (said ${Math.round((f.probability ?? 0) * 100)}%)`,
            refs: [`forecast:${f.id}`, `sample:${sample.id}`],
            privateContext: f.question,
          });
      } else if (f.kind === "number") {
        if (actual === undefined) continue;
        const crps = f.mean === null || f.sd === null ? null : crpsNormal(f.mean, f.sd, actual);
        const within80 =
          f.mean === null || f.sd === null ? undefined : Math.abs(actual - f.mean) <= 1.2816 * f.sd;
        db.resolveForecastAnswer(
          f.id,
          JSON.stringify({
            sampleId: sample.id,
            actual,
            ...(crps === null
              ? {}
              : { crps, absError: Math.abs(actual - (f.mean ?? 0)), within80 }),
          }),
          crps,
          sample.ts,
        );
        if (crps !== null && f.mean !== null)
          noteOutcome(db, {
            domain: "forecast",
            source: "forecast:number",
            succeeded: within80 === true,
            resolvedAt: new Date(sample.ts).toISOString(),
            attempted: "numeric forecast with an uncertainty band",
            detail: `${within80 ? "inside" : "outside"} the 80% band; error ${actual === 0 ? "n/a" : `${(((f.mean - actual) / Math.abs(actual)) * 100).toFixed(1)}%`}`,
            refs: [`forecast:${f.id}`, `sample:${sample.id}`],
            privateContext: f.question,
          });
      } else {
        let answer: TypedForecastAnswer;
        try {
          answer = JSON.parse(f.answer_json) as TypedForecastAnswer;
        } catch {
          continue;
        }
        if (!answer?.answer || answer.answer.type !== f.kind) continue;
        const r = scoreTypedAnswer(answer, sample.value);
        if (!r) continue;
        db.resolveForecastAnswer(
          f.id,
          JSON.stringify({
            sampleId: sample.id,
            outcome: r.outcome,
            metric: r.metric,
            quality: r.quality,
            correct: r.succeeded,
          }),
          r.loss,
          sample.ts,
        );
        void recordResolvedHistory(f.id, answer, r.outcome, sample.ts);
        noteOutcome(db, {
          domain: "forecast",
          source: `forecast:${f.kind}`,
          succeeded: r.succeeded,
          score: r.quality,
          resolvedAt: new Date(sample.ts).toISOString(),
          attempted: `${f.kind} forecast`,
          detail: `${r.metric} loss ${r.loss.toFixed(3)}`,
          refs: [`forecast:${f.id}`, `sample:${sample.id}`],
          privateContext: `${f.question}\n${JSON.stringify(r.outcome)}\n${f.prediction ?? ""}`,
        });
      }
    }
  },
};

/**
 * A resolved typed answer into the forecast history (`MARINA_FORECAST_HISTORY`),
 * so recalibration and prior shrink learn from live outcomes. Saved answers are
 * live work (a measurement run is never saved), known at the Sample's time.
 */
async function recordResolvedHistory(
  id: number,
  answer: TypedForecastAnswer,
  outcome: string[] | string,
  ts: number,
): Promise<void> {
  try {
    const history = historyFromEnv();
    if (!history) return;
    const truth = truthFromResolution(answer.answer, outcome);
    if (!truth) return;
    await noteResolvedForecast(history, {
      id: `forecast:${id}`,
      req: { question: answer.question, answer: answer.answer },
      answer,
      truth,
      resolvedAt: new Date(ts).toISOString(),
    });
  } catch (err) {
    logger.warn("calibration", "Forecast history not written", { id, error: String(err) });
  }
}

/** Register the built-in finders. Idempotent. */
export function registerBuiltinCalibrationFinders(): void {
  registerCalibrationFinder(tabh2oForecastFinder);
  registerCalibrationFinder(positionThesisFinder);
  registerCalibrationFinder(inworldMarketResolverFinder);
  registerCalibrationFinder(conductorScoreFinder);
  registerCalibrationFinder(forecastQuestionFinder);
  registerCalibrationFinder(positionSettlementFinder);
}
