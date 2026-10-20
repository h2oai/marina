// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Running an instantiated formation Score: the Score executor
 * (`src/sdk/score-executor.ts`) with every ready step admitted at once (a
 * formation's own schedule is its access graph, so the executor never queues a
 * step the formation would have started), plus the two helpers every surface
 * shares — seeded steps (work already done, e.g. the typed pipeline's round
 * one) and once-per-stage gates (a surface's budget check before a stage).
 */

import type { Score } from "../../sdk/score";
import {
  type DispatchContext,
  type DispatchFn,
  type ExecuteOptions,
  executeScore,
  type ScoreRun,
} from "../../sdk/score-executor";

/** Run a formation Score; every ready step starts at once. */
export function runFormationScore(
  score: Score,
  dispatch: DispatchFn,
  opts: Omit<ExecuteOptions, "concurrency"> = {},
): Promise<ScoreRun> {
  return executeScore(score, dispatch, { ...opts, concurrency: Math.max(1, score.steps.length) });
}

/** Dispatch the steps already done from `seeds` (their outputs), every other step to `next`. */
export function seeded(seeds: Readonly<Record<string, string>>, next: DispatchFn): DispatchFn {
  return (ctx: DispatchContext) =>
    Object.hasOwn(seeds, ctx.step.id) ? Promise.resolve(seeds[ctx.step.id]!) : next(ctx);
}

/**
 * A check made once per stage, by the first step of the stage to ask: every
 * step of a stage starts in the same tick, so they all see the one answer the
 * stage's protocol would have computed before starting them.
 */
export class StageGates<T> {
  private readonly made = new Map<string, T>();
  once(stage: string, check: () => T): T {
    if (!this.made.has(stage)) this.made.set(stage, check());
    return this.made.get(stage)!;
  }
}
