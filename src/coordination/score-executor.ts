// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Score executor — walks a Score DAG and runs it.
 *
 * Transport-free by design: the worker-dispatch function is injected. In
 * production an organizer agent wires `dispatch` to `tellAndAwait` (and
 * `conduct` to a recursive synthesize-and-run); in tests both are mocks. The
 * executor only knows how to schedule: bounded ready steps, concurrent
 * independent steps, access-output threading, and depth-capped recursion.
 *
 * See the conductor design (private archive: marina-internal design/conductor-design.md), Phase 4.
 */

import { getErrorMessage } from "../engine/errors";
import {
  type ParsedAssignee,
  parseAssignee,
  type Score,
  ScoreError,
  type ScoreStep,
  terminalStepId,
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
  /** Shared cancellation: dispatchers must propagate this to their transport. */
  signal: AbortSignal;
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
  /** Maximum active steps, default 4. Independent requests remain queued. */
  concurrency?: number;
  /** Overall deadline, including time spent waiting for predecessors. */
  timeoutMs?: number;
}

export interface ScoreRun {
  /** stepId → output. */
  outputs: Record<string, string>;
  /** The terminal (last authored) step's output — the Score's result. */
  result: string;
  /** Dispatch order (ready dependencies first, authored order breaks ties). */
  order: string[];
}

const DEFAULT_MAX_DEPTH = 3;

export async function executeScore(
  score: Score,
  dispatch: DispatchFn,
  opts: ExecuteOptions = {},
): Promise<ScoreRun> {
  // Snapshot before dispatch: a caller editing the saved definition cannot
  // mutate the graph or instructions of an already-running attempt.
  score = structuredClone(score);
  const invalid = validateScore(score);
  if (invalid) throw new ScoreError(invalid, "invalid");
  const concurrency = opts.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new ScoreError("concurrency must be a positive integer", "invalid");
  }
  if (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
    throw new ScoreError("timeoutMs must be positive", "invalid");
  }
  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const controller = new AbortController();
  const abort = () => controller.abort(new ScoreError("Score execution aborted", "aborted"));
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) abort();
  const timer =
    opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new ScoreError("Score execution deadline exceeded", "timeout"));
        }, opts.timeoutMs);
  const outputs: Record<string, string> = Object.create(null);
  const order: string[] = [];
  const pending = [...score.steps];
  const running = new Map<string, Promise<void>>();
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // Attach a handler even for an empty graph or a pre-aborted request.
  void aborted.catch(() => undefined);
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();

  const runStep = async (step: ScoreStep): Promise<void> => {
    const assignee = parseAssignee(step.assignee);
    const inputs = step.access.map((id) => ({ fromStepId: id, output: outputs[id]! }));
    const ctx: DispatchContext = { step, assignee, inputs, depth, signal: controller.signal };
    try {
      opts.onStep?.({ phase: "start", stepId: step.id, assignee: step.assignee });
      controller.signal.throwIfAborted();
      let work: Promise<string>;
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
        work = opts.conduct({ ...ctx, depth: depth + 1 });
      } else {
        work = dispatch(ctx);
      }
      const out = await Promise.race([work, aborted]);
      controller.signal.throwIfAborted();
      outputs[step.id] = out;
      opts.onStep?.({ phase: "done", stepId: step.id, assignee: step.assignee, output: out });
    } catch (error) {
      // Stop admitting siblings immediately, before the scheduler wakes up.
      controller.abort(error);
      opts.onStep?.({
        phase: "error",
        stepId: step.id,
        assignee: step.assignee,
        error: getErrorMessage(error),
      });
      throw error;
    }
  };

  try {
    controller.signal.throwIfAborted();
    while (pending.length || running.size) {
      controller.signal.throwIfAborted();
      while (running.size < concurrency) {
        const index = pending.findIndex((step) =>
          step.access.every((id) => Object.hasOwn(outputs, id)),
        );
        if (index < 0) break;
        const step = pending.splice(index, 1)[0]!;
        order.push(step.id);
        const promise = runStep(step).finally(() => {
          running.delete(step.id);
        });
        // Every launched step is observed even if a different sibling fails first.
        void promise.catch(() => undefined);
        running.set(step.id, promise);
        if (controller.signal.aborted) break;
      }
      if (running.size) await Promise.race([...running.values(), aborted]);
    }
    controller.signal.throwIfAborted();
    const termId = terminalStepId(score);
    return { outputs, result: termId ? (outputs[termId] ?? "") : "", order };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
