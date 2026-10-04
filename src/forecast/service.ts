// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring for `forecastQuestion` and `forecastTyped`: the real retriever,
 * analysts, planner, critic, judge and lookups. Env:
 *
 *   MARINA_FORECAST_ANALYSTS   comma-separated model ids, one per vendor
 *                              (default: DeepSeek V4 Pro, Claude Sonnet 5, GPT-6 Luna via OpenRouter;
 *                              without an OpenRouter key, the configured providers or local model).
 *                              `marina:<crew>` asks a crew on a Marina server
 *                              (MARINA_FORECAST_MARINA_URL / _KEY) — e.g. a crew
 *                              in the verification formation.
 *   MARINA_FORECAST_RETRIEVER  one or more of openrouter-web:<model>[@exa|@native],
 *                              sonar:<model>, tavily:<basic|advanced>, search[:<backends>]
 *                              (every planned query through a backend chain, pages read and
 *                              quoted), asof[:<providers>] (keyless and date-strict: gdelt,
 *                              wikipedia, hn, arxiv, wayback)
 *                              (default openrouter-web:openai/gpt-6-luna@exa,search; `search`
 *                              alone without an OpenRouter key)
 *   MARINA_FORECAST_DOSSIER_CHARS  evidence characters given to each run (default: sized to
 *                              the analysts' context window, 12 000–60 000)
 *   MARINA_FORECAST_FOLLOWUP   on | off (default on): one extra research round on the gaps
 *                              when no run is grounded in verified evidence
 *   MARINA_FORECAST_JUDGE      jev (default when an OpenRouter key is set) |
 *                              decisions (the configured MARINA_DECISIONS backend,
 *                              falling back to jev) | none
 *   Typed forecasts also read:
 *   MARINA_FORECAST_PLANNER    the model that plans and names research gaps (default: the first analyst)
 *   MARINA_FORECAST_CRITIC     the disconfirmation model (default: the planner)
 *   MARINA_FORECAST_RUNS       independent answer runs, 1–9 (default 3)
 *   MARINA_FORECAST_RESEARCH_ROUNDS  research rounds, 1–4 (default 2)
 *   MARINA_FORECAST_CRITIQUE   on | off (default on)
 *   MARINA_FORECAST_LOOKUPS    optional structured sources: polymarket, kalshi, odds, fred,
 *                              bls, markets, all (default none; keys ODDS_API_KEY,
 *                              FRED_API_KEY, BLS_API_KEY)
 *   MARINA_FORECAST_VERIFY     on | off (default off): each run's draft is checked by
 *                              MARINA_FORECAST_VERIFIER (default: the critic) before it counts
 *   MARINA_FORECAST_RETRIEVAL_FILTER  strict | none (default none): keep only report lines
 *                              whose cited pages are provably published by the cutoff
 *                              (src/arena/research/isolation.ts)
 *   MARINA_FORECAST_PRIOR, _PRIOR_WEIGHT, _CALIBRATION, _CALIBRATION_MARGIN,
 *   _CALIBRATION_SCORE, _HISTORY, _HISTORY_MIN   prior shrink and recalibration from
 *                              resolved history (`./adjust.ts`; all off by default)
 *
 * No vendor key is required. Unset, every part resolves to what this
 * installation has (`src/agent/available-models.ts`): OpenRouter's three-vendor
 * default with a key, else the configured providers or a single local model
 * (llama.cpp / Ollama) as the only analyst; keyless `asof` search without a
 * search key; no judge (equal weights) when neither Jev nor MARINA_DECISIONS is
 * reachable. The substitutions are reported as `scale` (tier `degraded` with
 * notes). Only zero models is an error. Every model call is priced and
 * recorded against the daily spend cap (`modelComplete`).
 */

import { availableModels } from "../agent/available-models";
import { modelComplete } from "../arena/model-backend";
import { strictDateFilter } from "../arena/research/isolation";
import { type Retriever, retrieverFromSpec } from "../arena/research/retrieve";
import { defaultPageText } from "../arena/research/verify";
import { researchJudge } from "../decisions/config";
import { dailyCapRefusal } from "../engine/spend-ledger";
import { type AdjustSettings, adjustSettingsFromEnv } from "./adjust";
import { SELECTION_MODES, type SelectionMode } from "./answer-types";
import type { ForecastHistory } from "./history";
import type { LessonStore } from "./lessons";
import { lookupsFromSpec } from "./lookups";
import type { ForecastDeps } from "./question";
import { DEFAULT_RETRIEVER, defaultRetrieverSpec } from "./retriever-default";
import type { ModelPart, TypedForecastDeps, TypedForecastOptions } from "./typed";

export { DEFAULT_RETRIEVER, defaultRetrieverSpec };

export const DEFAULT_ANALYSTS = [
  "openrouter/deepseek/deepseek-v4-pro",
  "openrouter/anthropic/claude-sonnet-5",
  "openrouter/openai/gpt-6-luna",
];

/**
 * What the forecaster runs on, for the answer's audit trail and the operator:
 * `full` is the multi-vendor default; `degraded` names what was substituted
 * because a vendor key is missing (one local model, keyless search, no judge).
 */
export interface ForecastScale {
  tier: "full" | "degraded";
  analysts: string[];
  retriever: string;
  judge: string;
  /** Why it is degraded (empty when full). */
  notes: string[];
}

interface Wired {
  retriever: Retriever;
  analysts: Array<ModelPart & { usage?: { costUsd: number } }>;
  judge?: ReturnType<typeof researchJudge>;
  researchCost: () => number;
  scale: ForecastScale;
}

/**
 * Analyst specs when MARINA_FORECAST_ANALYSTS is unset: the three-vendor
 * default through OpenRouter, else whatever this installation has (up to three
 * distinct providers; one model is enough — K runs supply the samples).
 */
export function defaultAnalystSpecs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.OPENROUTER_API_KEY?.trim()) return DEFAULT_ANALYSTS;
  return availableModels(env)
    .slice(0, 3)
    .map((m) => m.spec);
}

/** The retrieval filter in force: `strict` keeps only provably pre-cutoff report lines. */
export function retrievalFilterFromEnv(env: NodeJS.ProcessEnv = process.env): "strict" | "none" {
  return env.MARINA_FORECAST_RETRIEVAL_FILTER?.trim().toLowerCase() === "strict"
    ? "strict"
    : "none";
}

function wire(env: NodeJS.ProcessEnv): Wired | { error: string } {
  const key = env.OPENROUTER_API_KEY?.trim() || undefined;
  const notes: string[] = [];
  const retrieverSpec = env.MARINA_FORECAST_RETRIEVER?.trim() || defaultRetrieverSpec(env);
  if (!env.MARINA_FORECAST_RETRIEVER?.trim() && retrieverSpec !== DEFAULT_RETRIEVER) {
    notes.push(`no OpenRouter key: research uses ${retrieverSpec}`);
  }
  let base: Retriever;
  try {
    base = retrieverFromSpec(
      retrieverSpec,
      {
        ...(key ? { openrouter: key } : {}),
        ...(env.TAVILY_API_KEY?.trim() ? { tavily: env.TAVILY_API_KEY.trim() } : {}),
        ...(env.EXA_API_KEY?.trim() ? { exa: env.EXA_API_KEY.trim() } : {}),
      },
      { env },
    );
    if (retrievalFilterFromEnv(env) === "strict") base = strictDateFilter(base);
  } catch (err) {
    return {
      error: (err as Error).message.replace(
        "MARINA_ARENA_RESEARCH_RETRIEVER",
        "MARINA_FORECAST_RETRIEVER",
      ),
    };
  }
  let researchCost = 0;
  const explicitAnalysts = env.MARINA_FORECAST_ANALYSTS?.trim();
  const specs = explicitAnalysts
    ? explicitAnalysts
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : defaultAnalystSpecs(env);
  if (specs.length === 0) {
    // The one real impossibility: nothing to think with.
    return {
      error:
        "No model is available to forecast with. Set any provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, …) or point LLAMA_BASE_URL / OLLAMA_BASE_URL at a local runtime, or name models in MARINA_FORECAST_ANALYSTS.",
    };
  }
  if (!explicitAnalysts && !key) {
    notes.push(
      specs.length === 1
        ? `single model: one analyst (${specs[0]}) × K runs`
        : `no OpenRouter key: analysts are this installation's providers (${specs.join(", ")})`,
    );
  }
  let analysts: Wired["analysts"];
  try {
    analysts = specs.map((m) => modelPart(m, env));
  } catch (err) {
    return { error: (err as Error).message };
  }
  const judgeSpec = env.MARINA_FORECAST_JUDGE?.trim() || "jev";
  const judge = researchJudge(judgeSpec, env, key);
  if (!judge && judgeSpec.toLowerCase() !== "none") {
    notes.push(
      "no judge reachable (Jev needs OpenRouter or a configured MARINA_DECISIONS backend): analysts weighted equally",
    );
  }
  const scale: ForecastScale = {
    tier: notes.length > 0 ? "degraded" : "full",
    analysts: specs,
    retriever: retrieverSpec,
    judge: judge ? judge.model : "none",
    notes,
  };
  return {
    retriever: async (brief) => {
      const r = await base(brief);
      researchCost += r.costUsd;
      return r;
    },
    analysts,
    ...(judge ? { judge } : {}),
    researchCost: () => researchCost,
    scale,
  };
}

/** One model as a forecasting part: a provider model, or `marina:<crew>` on a Marina server. */
export function modelPart(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelPart & { usage?: { costUsd: number } } {
  if (spec.startsWith("marina:")) return crewPart(spec, env);
  const made = modelComplete(spec, env);
  return {
    name: spec.replace(/^openrouter\//, ""),
    complete: made.complete,
    usage: made.usage,
    ...(made.contextWindow ? { contextWindow: made.contextWindow } : {}),
  };
}

/**
 * A crew as an analyst: one chat completion on a Marina server's model API.
 * The crew's own spend is recorded by that server, so nothing is recorded here.
 * The URL comes only from the operator's environment (never from a request) and
 * is usually loopback, so it is fetched directly rather than through the SSRF
 * guard, which refuses private addresses by design.
 */
function crewPart(spec: string, env: NodeJS.ProcessEnv): ModelPart {
  const url = (env.MARINA_FORECAST_MARINA_URL?.trim() || "http://localhost:3300").replace(
    /\/+$/,
    "",
  );
  const key = env.MARINA_FORECAST_MARINA_KEY?.trim();
  return {
    name: spec,
    complete: async (system, user) => {
      const capped = dailyCapRefusal(env);
      if (capped) throw new Error(capped);
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: spec,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(900_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${spec} HTTP ${res.status}: ${text.slice(0, 200)}`);
      const data = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}

export function forecastDeps(
  env: NodeJS.ProcessEnv = process.env,
): { deps: ForecastDeps; costUsd: () => number; scale: ForecastScale } | { error: string } {
  const w = wire(env);
  if ("error" in w) return w;
  return {
    scale: w.scale,
    deps: {
      retriever: w.retriever,
      analysts: w.analysts.map((m) => ({ name: m.name, complete: m.complete })),
      ...(w.judge ? { judge: w.judge } : {}),
      pageText: defaultPageText(),
    },
    costUsd: () => w.researchCost() + w.analysts.reduce((s, m) => s + (m.usage?.costUsd ?? 0), 0),
  };
}

const intEnv = (v: string | undefined) =>
  v?.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;

/** Options from the environment (explicit overrides win). */
export function typedOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: TypedForecastOptions = {},
): TypedForecastOptions {
  const runs = intEnv(env.MARINA_FORECAST_RUNS);
  const rounds = intEnv(env.MARINA_FORECAST_RESEARCH_ROUNDS);
  const critique = env.MARINA_FORECAST_CRITIQUE?.trim().toLowerCase();
  const verify = env.MARINA_FORECAST_VERIFY?.trim().toLowerCase();
  const budgetS = intEnv(env.MARINA_FORECAST_BUDGET_S);
  const selection = env.MARINA_FORECAST_SELECTION?.trim().toLowerCase();
  const dossierChars = intEnv(env.MARINA_FORECAST_DOSSIER_CHARS);
  const followUp = env.MARINA_FORECAST_FOLLOWUP?.trim().toLowerCase();
  const minEvidence = intEnv(env.MARINA_FORECAST_MIN_EVIDENCE);
  const disagreement = env.MARINA_FORECAST_DISAGREEMENT?.trim().toLowerCase();
  const pool = env.MARINA_FORECAST_POOL?.trim().toLowerCase();
  return {
    ...(SELECTION_MODES.includes(selection as SelectionMode)
      ? { selection: selection as SelectionMode }
      : {}),
    ...(budgetS !== undefined && budgetS > 0 ? { budgetMs: budgetS * 1000 } : {}),
    ...(pool === "logodds" ? { pool: "logodds" as const } : {}),
    ...(runs !== undefined ? { runs } : {}),
    ...(dossierChars !== undefined && dossierChars > 0 ? { dossierChars } : {}),
    ...(followUp === "off" || followUp === "false" || followUp === "0" ? { followUp: false } : {}),
    ...(minEvidence !== undefined && minEvidence >= 0 ? { minEvidenceLines: minEvidence } : {}),
    ...(disagreement === "off" || disagreement === "false" || disagreement === "0"
      ? { disagreementRound: false }
      : {}),
    ...(rounds !== undefined ? { researchRounds: rounds } : {}),
    ...(critique === "off" || critique === "false" || critique === "0" ? { critique: false } : {}),
    ...(verify === "on" || verify === "true" || verify === "1" ? { verify: true } : {}),
    ...overrides,
  };
}

export function typedForecastDeps(
  env: NodeJS.ProcessEnv = process.env,
  overrides: TypedForecastOptions & {
    analysts?: string[];
    planner?: string;
    critic?: string;
    verifier?: string;
    /** A retriever spec instead of MARINA_FORECAST_RETRIEVER. */
    retriever?: string;
    /** Wrap retrieval in the strict pre-cutoff filter (MARINA_FORECAST_RETRIEVAL_FILTER=strict). */
    strictRetrieval?: boolean;
    /** Wrap the wired retriever (an audit, a capture, a custom filter). */
    wrapRetriever?: (r: Retriever) => Retriever;
    lessons?: LessonStore;
    /** Prior shrink / recalibration settings instead of the environment's (`false`: none). */
    adjust?: Partial<AdjustSettings> | false;
    /** Resolved history instead of MARINA_FORECAST_HISTORY. */
    history?: ForecastHistory;
  } = {},
): { deps: TypedForecastDeps; costUsd: () => number; scale: ForecastScale } | { error: string } {
  const analystEnv: NodeJS.ProcessEnv = {
    ...env,
    ...(overrides.analysts?.length
      ? { MARINA_FORECAST_ANALYSTS: overrides.analysts.join(",") }
      : {}),
    ...(overrides.retriever ? { MARINA_FORECAST_RETRIEVER: overrides.retriever } : {}),
    ...(overrides.strictRetrieval ? { MARINA_FORECAST_RETRIEVAL_FILTER: "strict" } : {}),
  };
  const w = wire(analystEnv);
  if ("error" in w) return w;
  const extra: Array<{ costUsd: number }> = [];
  let planner: ModelPart | undefined;
  let critic: ModelPart | undefined;
  let verifier: ModelPart | undefined;
  try {
    const vSpec = overrides.verifier ?? env.MARINA_FORECAST_VERIFIER?.trim();
    if (vSpec) {
      const v = modelPart(vSpec, env);
      verifier = v;
      if (v.usage) extra.push(v.usage);
    }
    const pSpec = overrides.planner ?? env.MARINA_FORECAST_PLANNER?.trim();
    if (pSpec) {
      const p = modelPart(pSpec, env);
      planner = p;
      if (p.usage) extra.push(p.usage);
    }
    const cSpec = overrides.critic ?? env.MARINA_FORECAST_CRITIC?.trim();
    if (cSpec) {
      const c = modelPart(cSpec, env);
      critic = c;
      if (c.usage) extra.push(c.usage);
    }
  } catch (err) {
    return { error: (err as Error).message };
  }
  const {
    analysts: _a,
    planner: _p,
    critic: _c,
    verifier: _v,
    retriever: _r,
    strictRetrieval: _s,
    wrapRetriever,
    lessons,
    adjust: adjustOverride,
    history,
    ...options
  } = overrides;
  const adjust: AdjustSettings | undefined =
    adjustOverride === false
      ? undefined
      : {
          ...adjustSettingsFromEnv(env),
          ...(adjustOverride ?? {}),
          ...(history ? { history } : {}),
        };
  return {
    scale: w.scale,
    deps: {
      retriever: wrapRetriever ? wrapRetriever(w.retriever) : w.retriever,
      analysts: w.analysts.map((m) => ({
        name: m.name,
        complete: m.complete,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      })),
      ...(planner ? { planner } : {}),
      ...(critic ? { critic } : {}),
      ...(verifier ? { verifier } : {}),
      ...(lessons ? { lessons } : {}),
      ...(w.judge ? { judge: w.judge } : {}),
      pageText: defaultPageText(),
      lookups: lookupsFromSpec(env.MARINA_FORECAST_LOOKUPS, env),
      options: typedOptionsFromEnv(env, options),
      ...(adjust ? { adjust } : {}),
    },
    costUsd: () =>
      w.researchCost() +
      w.analysts.reduce((s, m) => s + (m.usage?.costUsd ?? 0), 0) +
      extra.reduce((s, u) => s + u.costUsd, 0),
  };
}
