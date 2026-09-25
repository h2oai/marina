// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring for `forecastQuestion`: the real retriever, analysts and judge. Env:
 *
 *   MARINA_FORECAST_ANALYSTS   comma-separated provider/model ids, one per vendor
 *                              (default: DeepSeek V4 Pro, Claude Sonnet 5, GPT-6 Luna via OpenRouter)
 *   MARINA_FORECAST_RETRIEVER  openrouter-web:<model> (default openai/gpt-6-luna)
 *   MARINA_FORECAST_JUDGE      jev (default when an OpenRouter key is set) | none
 *
 * Retrieval and the Jev judge go through OpenRouter today, so OPENROUTER_API_KEY
 * is required; analysts may be any model Marina routes.
 */

import { modelComplete } from "../arena/model-backend";
import { openRouterWebRetriever } from "../arena/research/retrieve";
import { defaultPageText } from "../arena/research/verify";
import { providerFromConfig } from "../decisions/config";
import type { ForecastDeps } from "./question";

export const DEFAULT_ANALYSTS = [
  "openrouter/deepseek/deepseek-v4-pro",
  "openrouter/anthropic/claude-sonnet-5",
  "openrouter/openai/gpt-6-luna",
];

export function forecastDeps(
  env: NodeJS.ProcessEnv = process.env,
): { deps: ForecastDeps; costUsd: () => number } | { error: string } {
  const key = env.OPENROUTER_API_KEY;
  if (!key) {
    return {
      error:
        "Forecasting needs OPENROUTER_API_KEY (web retrieval and the Jev judge run through OpenRouter). Set it and retry.",
    };
  }
  const retrieverSpec = env.MARINA_FORECAST_RETRIEVER?.trim() || "openrouter-web:openai/gpt-6-luna";
  if (!retrieverSpec.startsWith("openrouter-web:")) {
    return { error: `unknown MARINA_FORECAST_RETRIEVER ${retrieverSpec}` };
  }
  let researchCost = 0;
  const base = openRouterWebRetriever({
    model: retrieverSpec.slice("openrouter-web:".length),
    apiKey: key,
  });
  const specs = (env.MARINA_FORECAST_ANALYSTS?.trim() || DEFAULT_ANALYSTS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let made: Array<ReturnType<typeof modelComplete> & { name: string }>;
  try {
    made = specs.map((m) => ({ name: m.replace(/^openrouter\//, ""), ...modelComplete(m, env) }));
  } catch (err) {
    return { error: (err as Error).message };
  }
  const judgeSpec = (env.MARINA_FORECAST_JUDGE?.trim() || "jev").toLowerCase();
  const judge =
    judgeSpec === "jev"
      ? providerFromConfig({
          kind: "decisions-api",
          baseUrl: "https://openrouter.ai/api/alpha",
          path: "/decisions",
          model: "typesafe/jev-1.13",
          apiKey: key,
          timeoutMs: 10_000,
        })
      : undefined;
  return {
    deps: {
      retriever: async (brief) => {
        const r = await base(brief);
        researchCost += r.costUsd;
        return r;
      },
      analysts: made.map((m) => ({ name: m.name, complete: m.complete })),
      ...(judge ? { judge } : {}),
      pageText: defaultPageText(),
    },
    costUsd: () => researchCost + made.reduce((s, m) => s + m.usage.costUsd, 0),
  };
}
