// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { all, create } from "mathjs";
import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, Entity, RoomContext } from "../../types";

/**
 * `calc` — rank-0 TypeScript math engine for every agent in the world.
 *
 * Backed by mathjs — a pure JS/TS library that parses math expressions
 * safely (no eval, no access to JS globals). Supports:
 *   - Arithmetic with arbitrary precision (BigNumber)
 *   - Algebra: solve, simplify, derivative, integrate
 *   - Sequential statements: `x = 5; y = x^2; y` returns 25
 *   - Fractions, complex numbers, units, matrices
 *   - Statistics: mean, median, std, sum, prod
 *
 * Rank 0 by design: every agent can do exact arithmetic from birth.
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
 *   calc solve(x^2 - 5*x + 6, x)
 *   calc simplify(x*2 + 3*x)
 *   calc mean([1,2,3,4,5])
 */

// Build a scoped mathjs instance with high precision.
// mathjs expressions have no access to JS globals. Two layers keep an
// expression from mutating or re-entering the engine:
//   1. Instance level: `import`, `createUnit` and `config` are replaced with
//      throwers, so no path (including node methods such as
//      `simplify(...).evaluate()`) can change the shared instance.
//   2. Expression level: every parser scope pre-binds the meta functions
//      (`evaluate`, `parse`, `compile`, `parser`, plus the three above) to
//      throwers. Symbols resolve from the scope before the math namespace,
//      so naming one inside an expression is refused.
// `evaluate` and `parse` stay intact on the instance itself: the parser,
// `simplify` and `derivative` call them internally, and overriding them on
// the instance breaks every expression.
const math = create(all as never, {
  number: "BigNumber",
  precision: 64,
});
const disabled = (name: string) => () => {
  throw new Error(`${name} disabled`);
};
math.import(
  {
    import: disabled("import"),
    createUnit: disabled("createUnit"),
    config: disabled("config"),
  },
  { override: true },
);

/** Names an expression may not call; bound to throwers in every parser scope. */
export const CALC_BLOCKED_FUNCTIONS = [
  "evaluate",
  "parse",
  "compile",
  "parser",
  "import",
  "createUnit",
  "config",
] as const;

function sandboxedParser(): ReturnType<typeof math.parser> {
  const parser = math.parser();
  for (const name of CALC_BLOCKED_FUNCTIONS) parser.set(name, disabled(name));
  return parser;
}

const MAX_EXPR_BYTES = 4_000;
const MAX_STATEMENTS = 50;

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  // mathjs returns its own types (BigNumber, Fraction, Matrix, etc.) — each
  // has a meaningful toString(). Wrap in math.format for consistent output.
  try {
    return math.format(v as never, { precision: 14 });
  } catch {
    return String(v);
  }
}

export interface EvalResult {
  outputs: string[];
  error?: string;
  durationMs: number;
}

export function evalExpression(source: string): EvalResult {
  const t0 = performance.now();
  const trimmed = source.trim();
  if (!trimmed) {
    return { outputs: [], durationMs: 0 };
  }
  if (trimmed.length > MAX_EXPR_BYTES) {
    return {
      outputs: [],
      error: `expression too long (${trimmed.length} > ${MAX_EXPR_BYTES})`,
      durationMs: 0,
    };
  }
  // Split on ; or newline; run sequentially sharing a scope.
  const statements = trimmed
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_STATEMENTS);

  const parser = sandboxedParser();
  const outputs: string[] = [];
  let error: string | undefined;
  try {
    for (const stmt of statements) {
      const out = parser.evaluate(stmt);
      const formatted = formatValue(out);
      if (formatted) outputs.push(formatted);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return { outputs, error, durationMs: Math.round(performance.now() - t0) };
}

/**
 * Wall-clock bound for one `calc` evaluation. mathjs is synchronous: run on the
 * server's event loop, one expensive call (`rationalize`, `simplify` or `solve`
 * of a large expression) freezes every agent, room and HTTP request. Each
 * evaluation therefore runs in a worker, which is terminated at this deadline.
 */
export const CALC_TIMEOUT_MS = 10_000;
const CALC_POOL_SIZE = 2;

interface CalcSlot {
  worker: Worker;
  busy: boolean;
}

const slots: CalcSlot[] = [];
const waiting: Array<() => void> = [];
let nextRequestId = 0;

function newCalcWorker(): Worker {
  const worker = new Worker(new URL("./calc-worker.ts", import.meta.url).href);
  // An idle worker never keeps the process alive.
  (worker as Worker & { unref?: () => void }).unref?.();
  return worker;
}

async function acquireSlot(): Promise<CalcSlot> {
  for (;;) {
    const free = slots.find((slot) => !slot.busy);
    if (free) {
      free.busy = true;
      return free;
    }
    if (slots.length < CALC_POOL_SIZE) {
      const slot = { worker: newCalcWorker(), busy: true };
      slots.push(slot);
      return slot;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
}

function releaseSlot(slot: CalcSlot, replace: boolean): void {
  if (replace) {
    slot.worker.terminate();
    slot.worker = newCalcWorker();
  }
  slot.busy = false;
  waiting.shift()?.();
}

/**
 * `evalExpression` bounded by `timeoutMs`, off the main thread. A timeout
 * terminates the worker (the pool replaces it) and returns an error result;
 * it never throws. Without worker support it falls back to the inline call.
 */
export async function evalExpressionBounded(
  source: string,
  timeoutMs = CALC_TIMEOUT_MS,
): Promise<EvalResult> {
  if (typeof Worker === "undefined") return evalExpression(source);
  let slot: CalcSlot;
  try {
    slot = await acquireSlot();
  } catch {
    // No worker runtime in this process: evaluate inline, unbounded, as before.
    return evalExpression(source);
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
    usage: ["calc <expression-or-statements>", "calc <expression>"],
    name: "calc",
    aliases: [],
    minRank: 0,
    help: `TypeScript math engine (mathjs). Safe expression evaluator — no eval, no globals.
Usage: calc <expression-or-statements>

Examples:
  calc 42 * 1729
  calc gcd(360, 420)
  calc x = 5; y = x^2 + 3*x; y
  calc solve(x^2 - 5*x + 6, x)
  calc simplify(x*2 + 3*x)
  calc mean([1,2,3,4,5])
  calc derivative('sin(x)', 'x')

Statements run in order, sharing a scope. Separate with ; or newline.
Each evaluation is bounded to ${CALC_TIMEOUT_MS / 1000} s; an expression that takes longer returns an error.`,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const expr = input.args?.trim();
      if (!expr) {
        ctx.send(input.entity, "Usage: calc <expression>. End with the value you want returned.");
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
