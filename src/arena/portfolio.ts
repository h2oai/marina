// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type { WorkBudget } from "../coordination/work-budget";
import { getErrorMessage } from "../engine/errors";
import { type Score, validateScore } from "../sdk/score";
import { type DispatchContext, executeScore } from "../sdk/score-executor";
import type { RoundForecast } from "./forecast";
import {
  dossierBlock,
  type FormationPattern,
  formationForecastRound,
  formationPattern,
  type ResearchDossier,
} from "./formations";
import { auditForecastInputs } from "./input-audit";
import type { Usage } from "./model-backend";
import { validateForecastBody } from "./submit";
import type { ArenaLock, ArenaRound, Distribution } from "./types";

type Operation =
  | { kind: "formation"; pattern: FormationPattern; models: string[] }
  | { kind: "aggregate" }
  | { kind: "conduct"; plan: ArenaPlan };

/** A Score plus typed forecasting operations. No arbitrary code, dynamic imports
 * or new scheduler: parallelism and recursion use the existing Score executor. */
export interface ArenaPlan {
  version: 1;
  score: Score;
  operations: Record<string, Operation>;
}

export const portfolioHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validateArenaPlan(plan: ArenaPlan): void {
  let count = 0;
  const visit = (p: ArenaPlan, depth: number) => {
    if (
      depth > 3 ||
      !p ||
      p.version !== 1 ||
      !p.score ||
      !Array.isArray(p.score.steps) ||
      !p.operations ||
      typeof p.operations !== "object"
    )
      throw new Error("invalid arena plan (max depth 3)");
    if ((count += p.score.steps.length) > 32) throw new Error("arena plan exceeds 32 total steps");
    const bad = validateScore(p.score);
    if (bad) throw new Error(bad);
    if (Object.keys(p.operations).length !== p.score.steps.length)
      throw new Error("every step needs exactly one operation");
    for (const s of p.score.steps) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(s.id)) throw new Error("invalid portfolio step id");
      const op = Object.hasOwn(p.operations, s.id) ? p.operations[s.id] : undefined;
      if (!op || s.assignee !== (op.kind === "conduct" ? "conduct" : "role:forecaster"))
        throw new Error("operation/assignee mismatch");
      if (op.kind === "formation") {
        if (
          !formationPattern(op.pattern) ||
          !Array.isArray(op.models) ||
          op.models.length < 1 ||
          op.models.length > 8 ||
          op.models.some((m) => typeof m !== "string" || !/^[\w.-]+\/[\w./:@-]+$/.test(m))
        )
          throw new Error("invalid formation operation");
      } else if (op.kind === "aggregate") {
        if (s.access.length < 2) throw new Error("aggregate needs at least two inputs");
      } else if (op.kind === "conduct") visit(op.plan, depth + 1);
      else throw new Error("unknown portfolio operation");
    }
  };
  visit(plan, 0);
}

/** All presets include the same Delphi control. Only the additional work differs. */
export function arenaPortfolioPlan(
  kind: "control" | "parallel" | "layered",
  models: string[],
): ArenaPlan {
  const steps: Score["steps"] = [
    {
      id: "control",
      instruction: "Independent Delphi control",
      assignee: "role:forecaster",
      access: [],
    },
  ];
  const operations: ArenaPlan["operations"] = {
    control: { kind: "formation", pattern: "delphi", models: [...models] },
  };
  if (kind !== "control") {
    steps.push(
      {
        id: "complement",
        instruction: "Complementary quantitative and contextual analysis",
        assignee: "role:forecaster",
        access: [],
      },
      {
        id: "aggregate",
        instruction: "Equal mixture retaining disagreement uncertainty",
        assignee: "role:forecaster",
        access: ["control", "complement"],
      },
    );
    operations.complement = { kind: "formation", pattern: "symbiosis", models: [...models] };
    operations.aggregate = { kind: "aggregate" };
  }
  if (kind === "layered") {
    steps.push({
      id: "verify",
      instruction: "Verify the combined candidate against original evidence",
      assignee: "role:forecaster",
      access: ["aggregate"],
    });
    operations.verify = { kind: "formation", pattern: "verification", models: [...models] };
  }
  return {
    version: 1,
    score: { id: `arena-${kind}-v1`, goal: "Bounded shadow comparison", author: "marina", steps },
    operations,
  };
}

/** Equal-weight mixture moments, NOT standard error of independent votes.
 * Correlated models agreeing is not evidence that outcome uncertainty vanished. */
export function mixtureDistribution(values: Distribution[], anchor: Distribution): Distribution {
  const mean = values.reduce((s, d) => s + d.mean / values.length, 0);
  const variance = values.reduce(
    (s, d) => s + (d.sd ** 2 + (d.mean - mean) ** 2) / values.length,
    0,
  );
  return {
    mean: Math.max(anchor.mean - 2 * anchor.sd, Math.min(anchor.mean + 2 * anchor.sd, mean)),
    sd: Math.max(anchor.sd * 0.5, Math.sqrt(variance)),
  };
}

export function forecastAnswer(f: RoundForecast) {
  return {
    ...(f.topline ? { topline: f.topline } : {}),
    ...(f.profile ? { profile: f.profile } : {}),
    ...(f.ranking ? { ranking: f.ranking } : {}),
  };
}

export interface PortfolioInputs {
  round: ArenaRound;
  lock: ArenaLock;
  start: RoundForecast;
  dossier?: ResearchDossier;
}
export type PortfolioComplete = (
  spec: string,
  system: string,
  user: string,
  signal: AbortSignal,
) => Promise<string>;
export interface PortfolioNode {
  forecast?: RoundForecast;
  error?: string;
  elapsedMs: number;
}

export async function portfolioModels(env: NodeJS.ProcessEnv, maxTokens = 2000) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8000)
    throw new Error("maxTokens must be 1–8000");
  const { modelComplete } = await import("./model-backend");
  const usage: Usage = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  const complete: PortfolioComplete = async (spec, system, user, signal) => {
    const model = modelComplete(spec, env, { signal, maxTokens });
    try {
      return await model.complete(system, user);
    } finally {
      for (const k of Object.keys(usage) as Array<keyof Usage>) usage[k] += model.usage[k];
    }
  };
  return { complete, usage };
}

/** Runs only frozen, typed inputs. Every model call, including recursive children,
 * uses the SAME budget. Each formation remains anchored to the original start. */
export async function runArenaPortfolio(
  original: ArenaPlan,
  originalInputs: PortfolioInputs,
  budget: WorkBudget,
  complete: PortfolioComplete,
) {
  const plan = structuredClone(original);
  validateArenaPlan(plan);
  const inputs = structuredClone(originalInputs);
  const audit = auditForecastInputs(inputs.round, inputs.lock);
  if (!audit.ok) throw new Error(`input audit failed: ${audit.issues.join("; ")}`);
  if (inputs.round.target_type === "ranking_list")
    throw new Error("portfolio formations do not support ranking rounds");
  const check = (f: RoundForecast) => {
    const bad = validateForecastBody(inputs.round, {
      round_id: inputs.round.round_id,
      entrant: "shadow",
      ...forecastAnswer(f),
    });
    if (bad) throw new Error(bad);
    return f;
  };
  check(inputs.start);
  const nodes: Record<string, PortfolioNode> = {};
  const run = async (
    p: ArenaPlan,
    depth: number,
    prefix: string,
    inherited: string[],
    signal: AbortSignal,
  ): Promise<string> => {
    const dispatch = async (ctx: DispatchContext): Promise<string> => {
      const key = `${prefix}${ctx.step.id}`;
      const started = performance.now();
      const op = p.operations[ctx.step.id]!;
      const prior = [...inherited, ...ctx.inputs.map((i) => i.output)];
      try {
        let forecast: RoundForecast;
        if (op.kind === "conduct") {
          forecast = JSON.parse(await run(op.plan, ctx.depth, `${key}/`, prior, ctx.signal));
        } else if (op.kind === "aggregate") {
          const forecasts = ctx.inputs.map((i) => check(JSON.parse(i.output) as RoundForecast));
          forecast = { ...inputs.start, note: "Equal mixture of candidate distributions" };
          if (inputs.start.topline)
            forecast.topline = mixtureDistribution(
              forecasts.map((f) => f.topline!),
              inputs.start.topline,
            );
          else
            forecast.profile = Object.fromEntries(
              Object.entries(inputs.start.profile!).map(([cell, anchor]) => [
                cell,
                mixtureDistribution(
                  forecasts.map((f) => f.profile![cell]!),
                  anchor,
                ),
              ]),
            );
        } else {
          const briefing = [
            inputs.dossier ? dossierBlock(inputs.dossier) : "",
            ...(ctx.step.id === "control" ? [] : [`Step: ${ctx.step.instruction}`]),
            ...(prior.length
              ? ["Upstream candidate distributions (hypotheses, not new observations):", ...prior]
              : []),
          ]
            .filter(Boolean)
            .join("\n\n");
          forecast = await formationForecastRound(
            op.pattern,
            structuredClone(inputs.round),
            structuredClone(inputs.lock),
            op.models.map((model, i) => ({
              name: `${i + 1}:${model}`,
              complete: (system, user) =>
                budget.run((callSignal) => complete(model, system, user, callSignal), ctx.signal),
            })),
            structuredClone(inputs.start),
            briefing,
          );
        }
        ctx.signal.throwIfAborted();
        budget.signal.throwIfAborted(); // formation protocols catch failed calls; budget failures must remain failures
        check(forecast);
        nodes[key] = { forecast, elapsedMs: performance.now() - started };
        return JSON.stringify({
          ...forecastAnswer(forecast),
          rules: forecast.rules,
          note: forecast.note,
        });
      } catch (error) {
        nodes[key] = { error: getErrorMessage(error), elapsedMs: performance.now() - started };
        throw error;
      }
    };
    const out = await executeScore(p.score, dispatch, {
      conduct: dispatch,
      depth,
      maxDepth: 3,
      concurrency: budget.limits.concurrency,
      signal,
    });
    return out.result;
  };
  let result: RoundForecast | undefined;
  let error: string | undefined;
  try {
    result = JSON.parse(await run(plan, 0, "", [], budget.signal));
  } catch (e) {
    error = getErrorMessage(budget.signal.aborted ? budget.signal.reason : e);
    budget.cancel(e);
  }
  // Snapshot: an upstream transport ignoring cancellation may settle later, but
  // cannot mutate the returned trace or resurrect a completed/failed run.
  return structuredClone({
    version: 1 as const,
    plan,
    planHash: portfolioHash(plan),
    inputHash: portfolioHash(inputs),
    inputs,
    nodes,
    result,
    error,
    budget: budget.snapshot(),
    complete: !error && !!result,
  });
}
