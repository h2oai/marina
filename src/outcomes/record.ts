// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recording a resolved result: one durable `outcomes` row per subject, with a
 * pending delivery for each consumer that learns from its kind. Delivery runs
 * in the background (`deliverSoon`) and on the `outcome-delivery` tick job, so
 * a producer never waits on a judge and nothing is lost to a restart.
 */

import { logRejection, tryLog } from "../engine/errors";
import { Logger } from "../engine/logger";
import type { MarinaDB } from "../persistence/database";
import type { OutcomeInput, OutcomeKind } from "../persistence/db-outcomes";

const logger = new Logger();

/**
 * Sources of forecasts residents file in-world (`predict` in a market room,
 * `conduct track`). They resolve, earn standing and teach lessons like any
 * forecast, but never feed the forecast history: that history tunes the
 * forecast PIPELINE's own outputs (recalibration, prior shrink, routing), and a
 * resident's call is not one of them.
 */
export const RESIDENT_FORECAST_SOURCES: readonly string[] = ["market", "conduct"];

const residentForecast = (source: string | undefined) =>
  !!source && RESIDENT_FORECAST_SOURCES.some((s) => source === s || source.startsWith(`${s}:`));

/**
 * The consumers that learn from an outcome. A judged outcome has none: it is
 * an opinion, recorded for agreement and evidence, until its judge has
 * earned the right to settle results (see `src/outcomes/agreement.ts`).
 */
export function consumersFor(
  kind: OutcomeKind,
  basis: OutcomeInput["basis"] = "mechanical",
  opts: { deliverJudged?: boolean; source?: string } = {},
): string[] {
  if (basis === "judged" && !opts.deliverJudged) return [];
  // A reported request carries no text to judge a lesson from: evidence only.
  // A benchmark run's lesson goes through the benchmark learner
  // (`noteBenchmarkRun`), which owns its leak guard: its row is evidence only.
  if (kind === "request" || kind === "benchmark") return [];
  if (kind === "forecast" && residentForecast(opts.source)) return ["lessons"];
  return kind === "forecast" ? ["lessons", "history"] : ["lessons"];
}

const scheduled = new WeakMap<object, { again: boolean; running: Promise<void> }>();

/**
 * Deliver pending outcomes for `db` in the background, single-flight: a call
 * while a pass runs schedules exactly one more pass after it.
 */
export function deliverSoon(db: MarinaDB): void {
  const s = scheduled.get(db);
  if (s) {
    s.again = true;
    return;
  }
  const state = { again: false, running: Promise.resolve() };
  state.running = (async () => {
    const { deliverOutcomes } = await import("./deliver");
    do {
      state.again = false;
      await deliverOutcomes(db).catch(
        logRejection(logger, "outcomes", "outcome delivery pass failed"),
      );
    } while (state.again);
  })().finally(() => scheduled.delete(db));
  scheduled.set(db, state);
}

export function hasPendingDelivery(db: MarinaDB): boolean {
  return scheduled.has(db);
}

/** Wait for background delivery for `db` (tests, scripts before exit). */
export async function settleDelivery(db: MarinaDB, timeoutMs?: number): Promise<void> {
  const { settleDeliveryPasses, abortDelivery } = await import("./deliver");
  const drain = async () => {
    do {
      for (let s = scheduled.get(db); s; s = scheduled.get(db)) await s.running;
      await settleDeliveryPasses(db);
    } while (scheduled.has(db));
  };
  if (timeoutMs === undefined) return drain();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      drain(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          abortDelivery(db);
          logger.warn(
            "outcomes",
            "outcome delivery drain timed out; unfinished deliveries remain pending",
          );
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Record one resolved subject (settle once: a subject already recorded keeps
 * its first outcome) and schedule its delivery.
 */
export function recordResolved(
  db: MarinaDB,
  input: OutcomeInput & { decisionIds?: readonly string[] },
  /** Deliver a judged outcome (its judge has earned agreement; see agreement.ts). */
  opts: { deliverJudged?: boolean } = {},
): { id: number; created: boolean } {
  const recorded = db.recordOutcomeRow(
    input,
    consumersFor(input.kind, input.basis, { ...opts, source: input.source }),
  );
  if (input.owner && input.decisionIds?.length) {
    tryLog(logger, "decisions", "Could not attribute outcome to decisions", () => {
      for (const id of new Set(input.decisionIds!.slice(0, 100)))
        db.linkDecisionOutcome(input.owner!, id, recorded.id);
    });
  }
  if (recorded.created) deliverSoon(db);
  return recorded;
}
