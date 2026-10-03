// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring for `forecastQuestion` and `forecastTyped`: the real retriever,
 * analysts, planner, critic, judge and lookups. Env:
 *
 *   MARINA_FORECAST_ANALYSTS   comma-separated model ids, one per vendor
 *                              (default: DeepSeek V4 Pro, Claude Sonnet 5, GPT-6 Luna via OpenRouter).
 *                              `marina:<crew>` asks a crew on a Marina server
 *                              (MARINA_FORECAST_MARINA_URL / _KEY) — e.g. a crew
 *                              in the verification formation.
 *   MARINA_FORECAST_RETRIEVER  one or more of openrouter-web:<model>, sonar:<model>,
 *                              tavily:<basic|advanced>, asof[:<providers>] (keyless and
 *                              date-strict: gdelt, wikipedia, hn, arxiv, wayback)
 *                              (default openrouter-web:openai/gpt-6-luna)
 *   MARINA_FORECAST_JUDGE      jev (default when an OpenRouter key is set) |
 *                              decisions (the configured MARINA_DECISIONS backend,
 *                              falling back to jev) | none
 *   Typed forecasts also read:
 *   MARINA_FORECAST_PLANNER    the model that plans and names research gaps (default: the first analyst)
 *   MARINA_FORECAST_CRITIC     the disconfirmation model (default: the planner)
 *   MARINA_FORECAST_RUNS       independent answer runs, 1–9 (default 3)
 *   MARINA_FORECAST_RESEARCH_ROUNDS  research rounds, 1–4 (default 2)
 *   MARINA_FORECAST_CRITIQUE   on | off (default on)
 *   MARINA_FORECAST_LOOKUPS    optional structured sources: polymarket (default none)
 *
 * Retrieval and the Jev judge go through OpenRouter today, so OPENROUTER_API_KEY
 * is required; analysts may be any model Marina routes. Every model call is
 * priced and recorded against the daily spend cap (`modelComplete`).
 */

import { modelComplete } from "../arena/model-backend";
import { type Retriever, retrieverFromSpec } from "../arena/research/retrieve";
import { defaultPageText } from "../arena/research/verify";
import { researchJudge } from "../decisions/config";
import { dailyCapRefusal } from "../engine/spend-ledger";
import { lookupsFromSpec } from "./lookups";
import type { ForecastDeps } from "./question";
import type { ModelPart, TypedForecastDeps, TypedForecastOptions } from "./typed";

export const DEFAULT_ANALYSTS = [
  "openrouter/deepseek/deepseek-v4-pro",
  "openrouter/anthropic/claude-sonnet-5",
  "openrouter/openai/gpt-6-luna",
];

export const DEFAULT_RETRIEVER = "openrouter-web:openai/gpt-6-luna";

interface Wired {
  retriever: Retriever;
  analysts: Array<ModelPart & { usage?: { costUsd: number } }>;
  judge?: ReturnType<typeof researchJudge>;
  researchCost: () => number;
}

function wire(env: NodeJS.ProcessEnv): Wired | { error: string } {
  const key = env.OPENROUTER_API_KEY;
  if (!key) {
    return {
      error:
        "Forecasting needs OPENROUTER_API_KEY (web retrieval and the Jev judge run through OpenRouter). Set it and retry.",
    };
  }
  let base: Retriever;
  try {
    base = retrieverFromSpec(env.MARINA_FORECAST_RETRIEVER?.trim() || DEFAULT_RETRIEVER, {
      openrouter: key,
      ...(env.TAVILY_API_KEY?.trim() ? { tavily: env.TAVILY_API_KEY.trim() } : {}),
    });
  } catch (err) {
    return {
      error: (err as Error).message.replace(
        "MARINA_ARENA_RESEARCH_RETRIEVER",
        "MARINA_FORECAST_RETRIEVER",
      ),
    };
  }
  let researchCost = 0;
  const specs = (env.MARINA_FORECAST_ANALYSTS?.trim() || DEFAULT_ANALYSTS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let analysts: Wired["analysts"];
  try {
    analysts = specs.map((m) => modelPart(m, env));
  } catch (err) {
    return { error: (err as Error).message };
  }
  const judge = researchJudge(env.MARINA_FORECAST_JUDGE?.trim() || "jev", env, key);
  return {
    retriever: async (brief) => {
      const r = await base(brief);
      researchCost += r.costUsd;
      return r;
    },
    analysts,
    ...(judge ? { judge } : {}),
    researchCost: () => researchCost,
  };
}

/** One model as a forecasting part: a provider model, or `marina:<crew>` on a Marina server. */
export function modelPart(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelPart & { usage?: { costUsd: number } } {
  if (spec.startsWith("marina:")) return crewPart(spec, env);
  const made = modelComplete(spec, env);
  return { name: spec.replace(/^openrouter\//, ""), complete: made.complete, usage: made.usage };
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
): { deps: ForecastDeps; costUsd: () => number } | { error: string } {
  const w = wire(env);
  if ("error" in w) return w;
  return {
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
  return {
    ...(runs !== undefined ? { runs } : {}),
    ...(rounds !== undefined ? { researchRounds: rounds } : {}),
    ...(critique === "off" || critique === "false" || critique === "0" ? { critique: false } : {}),
    ...overrides,
  };
}

export function typedForecastDeps(
  env: NodeJS.ProcessEnv = process.env,
  overrides: TypedForecastOptions & { analysts?: string[]; planner?: string; critic?: string } = {},
): { deps: TypedForecastDeps; costUsd: () => number } | { error: string } {
  const analystEnv = overrides.analysts?.length
    ? { ...env, MARINA_FORECAST_ANALYSTS: overrides.analysts.join(",") }
    : env;
  const w = wire(analystEnv);
  if ("error" in w) return w;
  const extra: Array<{ costUsd: number }> = [];
  let planner: ModelPart | undefined;
  let critic: ModelPart | undefined;
  try {
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
  const { analysts: _a, planner: _p, critic: _c, ...options } = overrides;
  return {
    deps: {
      retriever: w.retriever,
      analysts: w.analysts.map((m) => ({ name: m.name, complete: m.complete })),
      ...(planner ? { planner } : {}),
      ...(critic ? { critic } : {}),
      ...(w.judge ? { judge: w.judge } : {}),
      pageText: defaultPageText(),
      lookups: lookupsFromSpec(env.MARINA_FORECAST_LOOKUPS),
      options: typedOptionsFromEnv(env, options),
    },
    costUsd: () =>
      w.researchCost() +
      w.analysts.reduce((s, m) => s + (m.usage?.costUsd ?? 0), 0) +
      extra.reduce((s, u) => s + u.costUsd, 0),
  };
}
