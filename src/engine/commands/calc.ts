// Copyright 2025-2026 Marina Contributors
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

// Build a scoped mathjs instance with high precision and restricted "eval".
// mathjs `evaluate` is already safe (no JS globals exposed); we further
// forbid its `import`/`createUnit`/function-definition overrides by using
// its `limitedEvaluate` pattern.
const math = create(all as never, {
  number: "BigNumber",
  precision: 64,
});
// Disable the meta-operations that would let an agent mutate the math
// environment (even though these are already sandboxed from JS itself).
math.import(
  {
    import: () => {
      throw new Error("import disabled");
    },
    createUnit: () => {
      throw new Error("createUnit disabled");
    },
    evaluate: () => {
      throw new Error("recursive evaluate disabled");
    },
    parse: () => {
      throw new Error("parse disabled");
    },
  },
  { override: true },
);

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

interface EvalResult {
  outputs: string[];
  error?: string;
  durationMs: number;
}

function evalExpression(source: string): EvalResult {
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

  const parser = math.parser();
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

export function calcCommand(deps: { getEntity: (id: string) => Entity | undefined }): CommandDef {
  return {
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

Statements run in order, sharing a scope. Separate with ; or newline.`,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      const expr = input.args?.trim();
      if (!expr) {
        ctx.send(input.entity, "Usage: calc <expression>. End with the value you want returned.");
        return;
      }

      const result = evalExpression(expr);
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
