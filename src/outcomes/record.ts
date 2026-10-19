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
 * The consumers that learn from an outcome. A judged outcome has none: it is
 * an opinion, recorded for agreement and evidence, until its judge has
 * earned the right to settle results (see `src/outcomes/agreement.ts`).
 */
export function consumersFor(
  kind: OutcomeKind,
  basis: OutcomeInput["basis"] = "mechanical",
  opts: { deliverJudged?: boolean } = {},
): string[] {
  if (basis === "judged" && !opts.deliverJudged) return [];
  // A reported request carries no text to judge a lesson from: evidence only.
  // A benchmark run's lesson goes through the benchmark learner
  // (`noteBenchmarkRun`), which owns its leak guard: its row is evidence only.
  if (kind === "request" || kind === "benchmark") return [];
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

/** Wait for background delivery for `db` (tests, scripts before exit). */
export async function settleDelivery(db: MarinaDB): Promise<void> {
  for (let s = scheduled.get(db); s; s = scheduled.get(db)) await s.running;
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
  const recorded = db.recordOutcomeRow(input, consumersFor(input.kind, input.basis, opts));
  if (input.owner && input.decisionIds?.length) {
    tryLog(logger, "decisions", "Could not attribute outcome to decisions", () => {
      for (const id of new Set(input.decisionIds!.slice(0, 100)))
        db.linkDecisionOutcome(input.owner!, id, recorded.id);
    });
  }
  if (recorded.created) deliverSoon(db);
  return recorded;
}
