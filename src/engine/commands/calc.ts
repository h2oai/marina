// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, Entity, RoomContext } from "../../types";
import { refuseCommand } from "../command-response";
import type { EvalResult } from "./calc-eval";

export type { EvalResult } from "./calc-eval";

/** The inline evaluator, loaded on demand: mathjs stays out of this module's
 * import graph (see calc-eval.ts), so only a process that evaluates pays for it. */
async function evalInline(source: string): Promise<EvalResult> {
  const { evalExpression } = await import("./calc-eval");
  return evalExpression(source);
}

/**
 * `calc` — rank-0 TypeScript math engine for every agent in the world.
 *
 * Backed by mathjs — a pure JS/TS library that parses math expressions
 * safely (no eval, no access to JS globals). Supports:
 *   - Arithmetic with arbitrary precision (BigNumber)
 *   - Algebra: polynomialRoot, lusolve, simplify, derivative (symbolic forms
 *     take the expression as a string: simplify('x*2 + 3*x'))
 *   - Sequential statements: `x = 5; y = x^2; y` returns 25
 *   - Fractions, complex numbers, units, matrices
 *   - Statistics: mean, median, std, sum, prod
 *
 * Rank 0 by design: every agent can do exact arithmetic from its first turn.
 * This is the primitive that lets multi-agent orchestrations beat bare
 * LLMs on math benchmarks (GSM8K, MATH-500, AIME) — no Python, no
 * subprocess, all TypeScript.
 *
 * Usage:
 *   calc <expression-or-statements>
 *
 * Examples:
 *   calc 42 * 1729
 *   calc gcd(360, 420)
 *   calc x = 5; y = x^2 + 3*x; y
 *   calc sqrt(2024)
 *   calc polynomialRoot(6, -5, 1)
 *   calc simplify('x*2 + 3*x')
 *   calc mean([1,2,3,4,5])
 */

/**
 * Wall-clock bound for one `calc` evaluation. mathjs is synchronous: run on the
 * server's event loop, one expensive call (`rationalize`, `simplify` or `solve`
 * of a large expression) freezes every agent, room and HTTP request. Each
 * evaluation therefore runs in a worker, which is terminated at this deadline.
 * The clock starts once the worker has loaded mathjs and said so: loading takes
 * about a second idle and several on a loaded machine, and must not eat into
 * the time an expression is given.
 */
export const CALC_TIMEOUT_MS = 10_000;
/** Separate, generous bound for a new worker to load mathjs and report ready. */
export const CALC_LOAD_TIMEOUT_MS = 60_000;
const CALC_POOL_SIZE = 2;
const DEFAULT_CALC_WORKER_URL = new URL("./calc-worker.ts", import.meta.url).href;

interface CalcSlot {
  worker: Worker;
  /** Resolves `null` once the worker reported ready, or an error message if it failed first. */
  ready: Promise<string | null>;
  busy: boolean;
}

const slots: CalcSlot[] = [];
const waiting: Array<() => void> = [];
let nextRequestId = 0;
let calcWorkerUrl = DEFAULT_CALC_WORKER_URL;

function newCalcWorker(): Pick<CalcSlot, "worker" | "ready"> {
  const worker = new Worker(calcWorkerUrl);
  // An idle worker never keeps the process alive.
  (worker as Worker & { unref?: () => void }).unref?.();
  const ready = new Promise<string | null>((resolve) => {
    const done = (outcome: string | null): void => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      resolve(outcome);
    };
    const onMessage = (event: MessageEvent<{ ready?: boolean }>): void => {
      if (event.data?.ready === true) done(null);
    };
    const onError = (event: ErrorEvent): void => done(`calc worker failed: ${event.message}`);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
  return { worker, ready };
}

/** Wait for the slot's worker to be ready, bounded by `loadTimeoutMs`. */
async function awaitReady(slot: CalcSlot, loadTimeoutMs: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(`calc worker did not start within ${loadTimeoutMs} ms; try again.`),
      loadTimeoutMs,
    );
  });
  try {
    return await Promise.race([slot.ready, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Test hook: terminate the pool (call it only while no evaluation is in
 * flight) and spawn later workers from `workerUrl`, or the real calc worker
 * when omitted.
 */
export function resetCalcPoolForTests(workerUrl?: string): void {
  for (const slot of slots.splice(0)) slot.worker.terminate();
  calcWorkerUrl = workerUrl ?? DEFAULT_CALC_WORKER_URL;
}

async function acquireSlot(): Promise<CalcSlot> {
  for (;;) {
    const free = slots.find((slot) => !slot.busy);
    if (free) {
      free.busy = true;
      return free;
    }
    if (slots.length < CALC_POOL_SIZE) {
      const slot = { ...newCalcWorker(), busy: true };
      slots.push(slot);
      return slot;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
}

function releaseSlot(slot: CalcSlot, replace: boolean): void {
  if (replace) {
    slot.worker.terminate();
    Object.assign(slot, newCalcWorker());
  }
  slot.busy = false;
  waiting.shift()?.();
}

/**
 * `evalExpression` bounded by `timeoutMs` of evaluation, off the main thread.
 * A new worker first gets `loadTimeoutMs` to load mathjs; the evaluation
 * deadline starts only after it reports ready, and the expression is not sent
 * before then. A timeout terminates the worker (the pool replaces it) and
 * returns an error result; it never throws. Without worker support it falls
 * back to the inline call.
 */
export async function evalExpressionBounded(
  source: string,
  timeoutMs = CALC_TIMEOUT_MS,
  loadTimeoutMs = CALC_LOAD_TIMEOUT_MS,
): Promise<EvalResult> {
  if (typeof Worker === "undefined") return evalInline(source);
  let slot: CalcSlot;
  try {
    slot = await acquireSlot();
  } catch {
    // No worker runtime in this process: evaluate inline, unbounded, as before.
    return evalInline(source);
  }
  const loadError = await awaitReady(slot, loadTimeoutMs);
  if (loadError !== null) {
    releaseSlot(slot, true);
    return { outputs: [], error: loadError, durationMs: 0 };
  }
  const t0 = performance.now();
  const id = ++nextRequestId;
  return new Promise<EvalResult>((resolve) => {
    let settled = false;
    const finish = (result: EvalResult, replace: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      slot.worker.removeEventListener("message", onMessage);
      slot.worker.removeEventListener("error", onError);
      releaseSlot(slot, replace);
      resolve(result);
    };
    const elapsed = () => Math.round(performance.now() - t0);
    const onMessage = (event: MessageEvent<{ id: number; result: EvalResult }>): void => {
      if (event.data?.id === id) finish(event.data.result, false);
    };
    const onError = (event: ErrorEvent): void => {
      finish(
        { outputs: [], error: `calc worker failed: ${event.message}`, durationMs: elapsed() },
        true,
      );
    };
    const timer = setTimeout(() => {
      finish(
        {
          outputs: [],
          error: `timed out after ${timeoutMs} ms; the expression is too expensive. Simplify it or split it into smaller steps.`,
          durationMs: elapsed(),
        },
        true,
      );
    }, timeoutMs);
    slot.worker.addEventListener("message", onMessage);
    slot.worker.addEventListener("error", onError);
    slot.worker.postMessage({ id, source });
  });
}

export function calcCommand(deps: { getEntity: (id: string) => Entity | undefined }): CommandDef {
  return {
    category: "System",
    usage: [
      { syntax: "calc <expression-or-statements>", effect: "read" },
      { syntax: "calc <expression>", effect: "read" },
    ],
    name: "calc",
    aliases: [],
    minRank: 0,
    help: `TypeScript math engine (mathjs). Safe expression evaluator — no eval, no globals.
Usage: calc <expression-or-statements>

Examples:
  calc 42 * 1729
  calc gcd(360, 420)
  calc x = 5; y = x^2 + 3*x; y
  calc polynomialRoot(6, -5, 1)      (roots of x^2 - 5x + 6; constant term first)
  calc lusolve([[1,2],[3,4]], [5,6])
  calc simplify('x*2 + 3*x')
  calc mean([1,2,3,4,5])
  calc derivative('sin(x)', 'x')

Statements run in order, sharing a scope. Separate with ; or newline.
Each evaluation is bounded to ${CALC_TIMEOUT_MS / 1000} s; an expression that takes longer returns an error.
Forecast a series or price numeric ranges with \`quant fit\` / \`quant buckets\` (see \`help quant\`, \`skill builtin quantitative-estimates\`).`,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const expr = input.args?.trim();
      if (!expr) {
        refuseCommand(
          ctx,
          input.entity,
          "Usage: calc <expression>. End with the value you want returned.",
        );
        return;
      }

      const result = await evalExpressionBounded(expr);
      const lines: string[] = [
        header("calc"),
        separator(),
        `  ${dim("duration")}: ${result.durationMs}ms`,
      ];
      if (result.outputs.length > 0) {
        lines.push(`  ${bold("result")}:`);
        for (const out of result.outputs) {
          for (const line of out.split("\n")) {
            if (line.length > 0) lines.push(`    ${line.slice(0, 300)}`);
          }
        }
      }
      if (result.error) {
        lines.push(`  ${bold("error")}:`);
        for (const line of result.error.split("\n")) {
          if (line.length > 0) lines.push(`    ${line.slice(0, 300)}`);
        }
      }
      if (result.outputs.length === 0 && !result.error) {
        lines.push(`  ${dim("(no output — evaluated but nothing to display)")}`);
      }
      ctx.send(input.entity, lines.join("\n"));
    },
  };
}
