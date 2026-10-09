// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recording a resolved result: one durable `outcomes` row per subject, with a
 * pending delivery for each consumer that learns from its kind. Delivery runs
 * in the background (`deliverSoon`) and on the `outcome-delivery` tick job, so
 * a producer never waits on a judge and nothing is lost to a restart.
 */

import type { MarinaDB } from "../persistence/database";
import type { OutcomeInput, OutcomeKind } from "../persistence/db-outcomes";

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
      await deliverOutcomes(db).catch(() => undefined);
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
  input: OutcomeInput,
  /** Deliver a judged outcome (its judge has earned agreement; see agreement.ts). */
  opts: { deliverJudged?: boolean } = {},
): { id: number; created: boolean } {
  const recorded = db.recordOutcomeRow(input, consumersFor(input.kind, input.basis, opts));
  if (recorded.created) deliverSoon(db);
  return recorded;
}
