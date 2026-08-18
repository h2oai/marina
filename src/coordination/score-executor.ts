// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Score executor — walks a Score DAG and runs it.
 *
 * Transport-free by design: the worker-dispatch function is injected. In
 * production an organizer agent wires `dispatch` to `tellAndAwait` (and
 * `conduct` to a recursive synthesize-and-run); in tests both are mocks. The
 * executor only knows how to schedule: topological layers, concurrent
 * independent steps, access-output threading, and depth-capped recursion.
 *
 * See docs/conductor-design.md, Phase 4.
 */

import {
  type ParsedAssignee,
  parseAssignee,
  type Score,
  ScoreError,
  type ScoreStep,
  terminalStepId,
  topoLayers,
  validateScore,
} from "./score";

/** One prior step's output, threaded into a step that accesses it. */
export interface StepInput {
  fromStepId: string;
  output: string;
}

export interface DispatchContext {
  step: ScoreStep;
  assignee: ParsedAssignee;
  inputs: StepInput[];
  /** Recursion depth of the Score this step belongs to (0 = top level). */
  depth: number;
}

/** Performs a single non-recursive step; returns the worker's output. */
export type DispatchFn = (ctx: DispatchContext) => Promise<string>;

export interface ScoreStepEvent {
  phase: "start" | "done" | "error";
  stepId: string;
  assignee: string;
  output?: string;
  error?: string;
}

export interface ExecuteOptions {
  /** Recursion cap for "conduct" steps. Default 3. */
  maxDepth?: number;
  /** Current recursion depth — set by the conduct handler, not callers. */
  depth?: number;
  /**
   * Handles a "conduct" step (recursion into a sub-Score). Receives a context
   * whose `depth` is already incremented. If absent, conduct steps error.
   */
  conduct?: (ctx: DispatchContext) => Promise<string>;
  /** Observe step lifecycle — for feed/dashboard propagation. */
  onStep?: (ev: ScoreStepEvent) => void;
  signal?: AbortSignal;
}

export interface ScoreRun {
  /** stepId → output. */
  outputs: Record<string, string>;
  /** The terminal (last authored) step's output — the Score's result. */
  result: string;
  /** Execution order (layer by layer). */
  order: string[];
}

const DEFAULT_MAX_DEPTH = 3;

export async function executeScore(
  score: Score,
  dispatch: DispatchFn,
  opts: ExecuteOptions = {},
): Promise<ScoreRun> {
  const invalid = validateScore(score);
  if (invalid) throw new ScoreError(invalid, "invalid");

  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const layers = topoLayers(score);
  const outputs: Record<string, string> = {};
  const order: string[] = [];

  for (const layer of layers) {
    // Steps within a layer have no inter-dependencies, so run them concurrently.
    await Promise.all(
      layer.map(async (step) => {
        if (opts.signal?.aborted) throw new ScoreError("Score execution aborted", "aborted");
        const assignee = parseAssignee(step.assignee);
        const inputs: StepInput[] = step.access.map((id) => ({
          fromStepId: id,
          output: outputs[id] ?? "",
        }));
        const ctx: DispatchContext = { step, assignee, inputs, depth };
        opts.onStep?.({ phase: "start", stepId: step.id, assignee: step.assignee });
        try {
          let out: string;
          if (assignee.kind === "conduct") {
            if (depth + 1 > maxDepth) {
              throw new ScoreError(`conduct recursion exceeds max depth ${maxDepth}`, "max_depth");
            }
            if (!opts.conduct) {
              throw new ScoreError(
                `step "${step.id}" is a conduct step but no conduct handler was provided`,
                "no_conduct",
              );
            }
            out = await opts.conduct({ ...ctx, depth: depth + 1 });
          } else {
            out = await dispatch(ctx);
          }
          outputs[step.id] = out;
          opts.onStep?.({ phase: "done", stepId: step.id, assignee: step.assignee, output: out });
        } catch (e) {
          opts.onStep?.({
            phase: "error",
            stepId: step.id,
            assignee: step.assignee,
            error: e instanceof Error ? e.message : String(e),
          });
          throw e;
        }
      }),
    );
    for (const step of layer) order.push(step.id);
  }

  const termId = terminalStepId(score);
  return { outputs, result: termId ? (outputs[termId] ?? "") : "", order };
}
