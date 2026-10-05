// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Leakage rule 2 — self-exclusion for measurement.
 *
 * A request carrying `x-marina-eval: benchmark=<name>; slice=<hash>; mode=measure`
 * is a measurement run of board <name>. Every lesson whose provenance includes
 * that board is excluded from what it recalls, so the board's score means
 * "Marina's general knowledge applied to this board", never memorisation of
 * the board. Lessons from every other board still flow.
 *
 * A lesson comes from a board when any of these names it:
 *   - its `source` (`benchmark:<name>`, `<name>`, or `<producer>:…` where the
 *     board is `<producer>` or `<producer>-…`, e.g. `futurex:…` for `futurex-past-clean`);
 *   - a `bench:<run id>` in its refs whose ledger run is of that benchmark.
 *
 * `mode=live` (an actual competition entry or daily answer) lifts the rule:
 * live outcomes are genuinely in the future, so every lesson may be used.
 * The time rule (`visibleAt`) applies in every mode.
 */

import type { Lesson } from "./outcomes";

export type EvalMode = "measure" | "live";

export interface EvalContext {
  benchmark: string;
  slice?: string;
  mode: EvalMode;
}

export const EVAL_HEADER = "x-marina-eval";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/**
 * Parse an `x-marina-eval` value. Without a valid `benchmark` it is no eval
 * context (undefined); `mode` defaults to `measure` (the safe direction).
 */
export function parseEvalHeader(value: string | null | undefined): EvalContext | undefined {
  if (!value) return undefined;
  const fields = new Map<string, string>();
  for (const part of value.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    fields.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  const benchmark = fields.get("benchmark");
  if (!benchmark || !NAME.test(benchmark)) return undefined;
  const slice = fields.get("slice");
  return {
    benchmark,
    ...(slice && /^[A-Za-z0-9_-]{1,64}$/.test(slice) ? { slice } : {}),
    mode: fields.get("mode")?.toLowerCase() === "live" ? "live" : "measure",
  };
}

/** A request's eval context as a spreadable recall option (`{}` when it carries none). */
export function evalOption(req: { headers: Headers }): { eval?: EvalContext } {
  const ctx = parseEvalHeader(req.headers.get(EVAL_HEADER));
  return ctx ? { eval: ctx } : {};
}

/** The header value for an eval context (harnesses). */
export function formatEvalHeader(ctx: EvalContext): string {
  return [
    `benchmark=${ctx.benchmark}`,
    ...(ctx.slice ? [`slice=${ctx.slice}`] : []),
    `mode=${ctx.mode}`,
  ].join("; ");
}

/** The response header that lists the lesson ids a request was served. */
export const LESSONS_HEADER = "x-marina-lessons";

/**
 * Parse an `x-marina-lessons` response header: `0`, or served ids, then
 * `observe:`-prefixed ids recalled but not injected, `;`-separated.
 */
export function parseLessonsHeader(value: string | null | undefined): {
  served: string[];
  observed: string[];
} {
  const out = { served: [] as string[], observed: [] as string[] };
  if (!value || value === "0") return out;
  for (const part of value.split(";")) {
    const observed = part.startsWith("observe:");
    const ids = (observed ? part.slice("observe:".length) : part)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s));
    (observed ? out.observed : out.served).push(...ids);
  }
  return out;
}

/** Source prefixes that name a kind of producer, not a board. */
const GENERIC_PREFIXES = new Set([
  "benchmark",
  "forecast",
  "code",
  "tools",
  "arena",
  "meta",
  "supersede",
  "legacy",
]);

/** Does the board named by `origin` (a source label or benchmark name) cover `benchmark`? */
function sameBoard(origin: string, benchmark: string): boolean {
  if (!origin) return false;
  const a = origin.toLowerCase();
  const b = benchmark.toLowerCase();
  return a === b || b.startsWith(`${a}-`);
}

/**
 * The self-exclusion predicate for `ctx` (undefined when nothing is excluded:
 * no context, or `mode=live`). `benchmarkOf` resolves a ledger run id to its
 * benchmark name (memoised here); without it only sources are checked.
 */
export function evalExclusion(
  ctx: EvalContext | undefined,
  benchmarkOf?: (runId: string) => string | undefined,
): ((lesson: Lesson) => boolean) | undefined {
  if (!ctx || ctx.mode !== "measure") return undefined;
  const cache = new Map<string, string | undefined>();
  const runBenchmark = (id: string) => {
    if (!cache.has(id)) cache.set(id, benchmarkOf?.(id));
    return cache.get(id);
  };
  return (lesson) => {
    const source = lesson.source ?? "";
    const prefix = source.split(":")[0] ?? "";
    const origins = [
      source,
      source.startsWith("benchmark:") ? source.slice("benchmark:".length) : "",
      // A producer label names a board (`futurex:…`); a generic domain prefix does not.
      GENERIC_PREFIXES.has(prefix) ? "" : prefix,
    ];
    if (origins.some((o) => sameBoard(o, ctx.benchmark))) return true;
    for (const ref of lesson.refs ?? []) {
      if (!ref.startsWith("bench:")) continue;
      const name = runBenchmark(ref.slice("bench:".length));
      if (name && sameBoard(name, ctx.benchmark)) return true;
    }
    return false;
  };
}
