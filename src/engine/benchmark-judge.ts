// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Who grades a benchmark run. A run never grades itself by default: the judge
 * is `--judge-model` / `judge:` when given, else the configured default judge
 * (`MARINA_BENCHMARK_JUDGE_MODEL`, default `marina/default`), and a judge that
 * names the target model is refused unless the caller opts in to self-judging
 * (`--self-judge` / `self-judge:on`). The opt-in is recorded with the run.
 *
 * Shared by the harness (`benchmarks/harness.ts`) and the in-world runner
 * (`src/engine/benchmark-runner.ts`) so both apply one rule.
 */

/** The judge when nothing else is configured: this Marina's default model. */
export const BUILTIN_BENCHMARK_JUDGE = "marina/default";

/** The configured default judge model. */
export function defaultBenchmarkJudge(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.MARINA_BENCHMARK_JUDGE_MODEL?.trim() || BUILTIN_BENCHMARK_JUDGE;
}

/** Ids that name this Marina's default model. */
const DEFAULT_ALIASES = new Set(["marina", "marina/default", "default"]);

/**
 * The forms a model id is known by: the id itself (lowercased, without an
 * `openrouter/` routing prefix) and, for an alias of the default model, the
 * concrete default model when it is known.
 */
function modelForms(id: string, defaultModel?: string): Set<string> {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^openrouter\//, "");
  const out = new Set([norm(id)]);
  if (DEFAULT_ALIASES.has(norm(id))) {
    out.add("marina/default");
    if (defaultModel) out.add(norm(defaultModel));
  }
  return out;
}

/** True when `judge` and `target` name the same model (aliases of the default model included). */
export function sameJudgeModel(target: string, judge: string, defaultModel?: string): boolean {
  const a = modelForms(target, defaultModel);
  for (const f of modelForms(judge, defaultModel)) if (a.has(f)) return true;
  return false;
}

export interface JudgeChoice {
  model: string;
  /** Where the model came from: an explicit flag, the configured default, or the built-in. */
  source: "explicit" | "configured" | "builtin";
  /** The run grades itself, by explicit opt-in. */
  selfJudge?: true;
}

/**
 * Resolve the run's judge, or explain why it is refused. `defaultModel` is
 * the concrete model `marina/default` routes to, when known, so a target that
 * names it directly is still recognised as the judge.
 */
export function resolveBenchmarkJudge(opts: {
  target: string;
  judge?: string;
  selfJudge?: boolean;
  env?: Record<string, string | undefined>;
  defaultModel?: string;
}): JudgeChoice | { error: string } {
  const env = opts.env ?? process.env;
  const explicit = opts.judge?.trim();
  const configured = env.MARINA_BENCHMARK_JUDGE_MODEL?.trim();
  const model = explicit || configured || BUILTIN_BENCHMARK_JUDGE;
  const source: JudgeChoice["source"] = explicit
    ? "explicit"
    : configured
      ? "configured"
      : "builtin";
  const same = sameJudgeModel(opts.target, model, opts.defaultModel);
  if (same && !opts.selfJudge) {
    return {
      error:
        `the judge (${model}${source === "explicit" ? "" : `, the ${source === "configured" ? "configured" : "built-in"} default`}) ` +
        `is the target model ${opts.target}: a run must not grade itself. Pass a different judge ` +
        `(judge:<model> / --judge-model), set MARINA_BENCHMARK_JUDGE_MODEL, or opt in with ` +
        `self-judge:on / --self-judge (recorded with the run).`,
    };
  }
  return { model, source, ...(same ? { selfJudge: true as const } : {}) };
}

/**
 * The judge as the ledger records it: `<model> @ <endpoint>`, marked
 * `[self-judge]` when the run graded itself by opt-in, so a self-graded run
 * never pairs or pools with an independently graded one.
 */
export function judgeLabel(judge: {
  model?: string;
  endpoint?: string;
  self_judge?: boolean;
}): string | null {
  if (!judge.model) return null;
  return `${judge.model}${judge.endpoint ? ` @ ${judge.endpoint}` : ""}${judge.self_judge ? " [self-judge]" : ""}`;
}
