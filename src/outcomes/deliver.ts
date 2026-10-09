// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Delivering recorded outcomes to the consumers that learn from them, from
 * durable per-consumer state (`outcome_deliveries`):
 *
 *   lessons  a judged lesson through the armed learner (`armedLearner`),
 *            within the shared hourly budget. Over budget, or no verdict
 *            reached, the outcome waits for a later pass — never dropped.
 *   history  one record in MARINA_FORECAST_HISTORY (recalibration, prior
 *            shrink, routing), from the answer's pre-adjustment forecast.
 *
 * One rule set for every producer: a measurement run (`eval_mode = measure`)
 * is recorded but never delivered (`skipped: measurement`); private context
 * (the question) is read back from the subject row, never stored on the
 * outcome. A delivery that keeps failing ends `failed`, with its reason.
 */

import { Logger } from "../engine/logger";
import { noteResolvedForecast, noteResolvedRecord } from "../forecast/adjust";
import { type ForecastHistory, historyFromEnv, resolvedRecord } from "../forecast/history";
import type { TypedForecastAnswer } from "../forecast/typed";
import { lessonsMode } from "../learning/modes";
import { type Outcome, type OutcomeDomain, recordOutcome } from "../learning/outcomes";
import { armedLearner } from "../learning/service";
import type { MarinaDB } from "../persistence/database";
import type { ForecastAnswerRow } from "../persistence/db-markets";
import type { OutcomeRow } from "../persistence/db-outcomes";

const logger = new Logger();

/** Attempts before a delivery that keeps failing (or never gets a verdict) ends `failed`. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export interface DeliveryReport {
  done: number;
  skipped: number;
  failed: number;
  /** Left pending for a later pass (budget, no verdict, not armed). */
  waiting: number;
}

const forecastId = (subject: string) =>
  subject.startsWith("forecast:") ? Number(subject.slice("forecast:".length)) : undefined;

function answerFor(db: MarinaDB, o: OutcomeRow): ForecastAnswerRow | undefined {
  const id = forecastId(o.subject);
  return id !== undefined && Number.isSafeInteger(id) ? db.getForecastAnswer(id) : undefined;
}

function typedOf(row: ForecastAnswerRow): TypedForecastAnswer | undefined {
  try {
    const a = JSON.parse(row.answer_json) as Partial<TypedForecastAnswer>;
    return a?.answer?.type === row.kind ? (a as TypedForecastAnswer) : undefined;
  } catch {
    return undefined;
  }
}

const parse = (s: string | null) => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
};

/** What a forecast lesson says it attempted, by the answer's kind. */
export function attemptedFor(kind: string): string {
  if (kind === "probability") return "probability forecast of a yes/no question";
  if (kind === "number") return "numeric forecast with an uncertainty band";
  return `${kind} forecast`;
}

function retryOrFail(
  db: MarinaDB,
  o: OutcomeRow,
  consumer: string,
  reason: string,
): "failed" | "waiting" {
  const attempts = db.outcomeDeliveries(o.id).find((d) => d.consumer === consumer)?.attempts ?? 0;
  const state = attempts + 1 >= MAX_DELIVERY_ATTEMPTS ? "failed" : "pending";
  db.setOutcomeDelivery(o.id, consumer, state, reason);
  return state === "failed" ? "failed" : "waiting";
}

/**
 * The history record for a resolved forecast: a typed answer through
 * `noteResolvedForecast` (its pre-adjustment forecast and prior); a plain
 * probability or number from its saved values (that path has no adjustment
 * stage). Undefined when there is nothing to record (a number with no sd).
 */
async function deliverHistory(
  db: MarinaDB,
  o: OutcomeRow,
  history: ForecastHistory,
): Promise<"done" | "skipped"> {
  const row = answerFor(db, o);
  if (!row) return "skipped";
  const truth = parse(o.truth_json) as { options?: string[]; value?: number } | undefined;
  if (!truth) return "skipped";
  const resolvedAt = new Date(o.resolved_at).toISOString();
  const typed = typedOf(row);
  if (typed) {
    const wrote = await noteResolvedForecast(history, {
      id: o.subject,
      req: { question: typed.question, answer: typed.answer },
      answer: typed,
      truth,
      resolvedAt,
    });
    return wrote || (await history.all()).some((r) => r.id === o.subject) ? "done" : "skipped";
  }
  if (row.kind === "number" && row.mean !== null && row.sd !== null && row.sd > 0) {
    if (truth.value === undefined) return "skipped";
    await noteResolvedRecord(
      history,
      resolvedRecord({
        id: o.subject,
        spec: { type: "number" },
        resolvedAt,
        numbers: { value: row.mean, sd: row.sd },
        truth,
      }),
    );
    return "done";
  }
  if (row.kind === "probability" && row.probability !== null && truth.options?.length) {
    await noteResolvedRecord(
      history,
      resolvedRecord({
        id: o.subject,
        spec: {
          type: "choice",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
        resolvedAt,
        numbers: { distribution: { yes: row.probability, no: 1 - row.probability } },
        truth,
      }),
    );
    return "done";
  }
  return "skipped";
}

/** The lesson loop's view of an outcome, with private context read back from its subject. */
function lessonOutcome(db: MarinaDB, o: OutcomeRow): Outcome {
  const row = o.kind === "forecast" ? answerFor(db, o) : undefined;
  const refs = (parse(o.refs_json) as string[] | undefined) ?? [];
  return {
    domain: o.domain as OutcomeDomain,
    source: o.source,
    succeeded: o.succeeded === 1,
    ...(o.quality !== null ? { score: o.quality } : {}),
    resolvedAt: new Date(o.resolved_at).toISOString(),
    attempted: row ? attemptedFor(row.kind) : `${o.kind} ${o.source}`,
    ...(o.detail ? { detail: o.detail } : {}),
    ...(refs.length ? { refs } : {}),
    ...(o.basis === "judged"
      ? { provenance: { basis: "judged", judge: o.judge ?? "unknown" } }
      : {}),
    ...(row
      ? { privateContext: `${row.question}\n${o.truth_json ?? ""}\n${row.prediction ?? ""}` }
      : {}),
  };
}

/**
 * One delivery pass over pending outcomes (at most `max` per consumer).
 * Safe to run concurrently with producers; each delivery settles once.
 */
export async function deliverOutcomes(
  db: MarinaDB,
  opts: { env?: NodeJS.ProcessEnv; max?: number } = {},
): Promise<Record<string, DeliveryReport>> {
  const env = opts.env ?? process.env;
  const max = Math.max(1, opts.max ?? 50);
  const report: Record<string, DeliveryReport> = {};
  const tally = (consumer: string) =>
    (report[consumer] ??= { done: 0, skipped: 0, failed: 0, waiting: 0 });

  // History: no history configured ⇒ nothing to write (skipped, with the reason).
  const history = historyFromEnv(env);
  for (const o of db.pendingOutcomes("history", max)) {
    const t = tally("history");
    if (o.eval_mode === "measure") {
      db.setOutcomeDelivery(o.id, "history", "skipped", "measurement");
      t.skipped++;
      continue;
    }
    if (!history) {
      db.setOutcomeDelivery(o.id, "history", "skipped", "no history configured");
      t.skipped++;
      continue;
    }
    try {
      const state = await deliverHistory(db, o, history);
      db.setOutcomeDelivery(
        o.id,
        "history",
        state,
        state === "skipped" ? "no raw forecast to record" : undefined,
      );
      t[state]++;
    } catch (err) {
      t[retryOrFail(db, o, "history", String(err))]++;
    }
  }

  // Lessons: off ⇒ skipped; not armed (a script that never armed it) ⇒ wait.
  const lessonsOff = lessonsMode(env) === "off";
  const learner = lessonsOff ? undefined : armedLearner(db, env);
  const pending = db.pendingOutcomes("lessons", max);
  const room = learner ? learner.take(pending.filter((o) => o.eval_mode !== "measure").length) : 0;
  let used = 0;
  for (const o of pending) {
    const t = tally("lessons");
    if (o.eval_mode === "measure" || lessonsOff) {
      db.setOutcomeDelivery(o.id, "lessons", "skipped", lessonsOff ? "lessons off" : "measurement");
      t.skipped++;
      continue;
    }
    if (!learner || used >= room) {
      t.waiting++;
      continue;
    }
    used++;
    try {
      const r = await recordOutcome({ ...learner.deps, deferUnjudged: true }, lessonOutcome(db, o));
      if (r.deferred) t[retryOrFail(db, o, "lessons", `no verdict: ${r.reason}`)]++;
      else {
        db.setOutcomeDelivery(o.id, "lessons", "done", r.trust);
        t.done++;
      }
    } catch (err) {
      t[retryOrFail(db, o, "lessons", String(err))]++;
    }
  }
  if (report.lessons?.failed || report.history?.failed)
    logger.warn("main", "some outcome deliveries failed", { report });
  return report;
}
