// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The forecast retriever when `MARINA_FORECAST_RETRIEVER` is unset — kept
 * dependency-free so `readiness` can report it without loading the model stack.
 */

/**
 * OpenRouter's web plugin on Exa (ten results with page excerpts, which the
 * citation check reads) plus `search`, which searches every planned query
 * through the configured backend chain and quotes the most relevant passages
 * of the pages it reads.
 */
export const DEFAULT_RETRIEVER = "openrouter-web:openai/gpt-6-luna@exa,search";

/**
 * The retriever spec when MARINA_FORECAST_RETRIEVER is unset: OpenRouter web
 * search plus `search` with an OpenRouter key; else `search` alone (its chain:
 * Tavily / Exa / SearXNG when configured, then keyless DuckDuckGo — a backend
 * out of credit falls through to the next) — never an error. Backtests name a
 * date-strict spec (`asof…`) explicitly.
 */
export function defaultRetrieverSpec(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENROUTER_API_KEY?.trim()) return DEFAULT_RETRIEVER;
  return "search";
}

/** The retriever spec forecasts use in this environment. */
export function forecastRetrieverSpec(env: NodeJS.ProcessEnv = process.env): string {
  return env.MARINA_FORECAST_RETRIEVER?.trim() || defaultRetrieverSpec(env);
}
