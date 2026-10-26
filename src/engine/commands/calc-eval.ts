// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The mathjs half of `calc`: the sandboxed instance and the synchronous
 * evaluator. Only the calc worker (and the inline fallback where no Worker
 * exists) loads this module. Importing mathjs means about a thousand CommonJS
 * modules plus its typed-function setup — around a second on an idle machine
 * and several on a loaded one — so the command module (`calc.ts`), which every
 * server and engine import pulls in, must never import it statically.
 */

import { all, create } from "mathjs";

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
