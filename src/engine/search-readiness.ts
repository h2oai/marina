// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `search` readiness check: which search backends this installation has
 * (keys / URLs), what forecasting retrieves with, and — from the health ledger
 * of real calls — which backend is failing and why. Never probes a paid API.
 * Pure over (env, health, now) so it is testable without an engine.
 */

import { forecastRetrieverSpec } from "../forecast/retriever-default";
import type { SearchBackendHealth } from "./search-providers/health";
import { isQuotaOrAuthError, SEARCH_BACKOFF_MS } from "./search-providers/health";

export interface SearchReadiness {
  status: "ok" | "degraded";
  detail: string;
  remediation?: string;
}

export function describeSearchReadiness(
  env: NodeJS.ProcessEnv,
  health: readonly SearchBackendHealth[],
  now = Date.now(),
): SearchReadiness {
  const configured: string[] = [];
  if (env.TAVILY_API_KEY?.trim()) configured.push("tavily");
  if (env.EXA_API_KEY?.trim()) configured.push("exa");
  if (env.SEARXNG_URL?.trim()) configured.push("searxng");
  const chain = [
    ...configured,
    "duckduckgo",
    ...(env.OPENROUTER_API_KEY?.trim() ? ["openrouter (Exa plugin, research)"] : []),
  ];
  const failing = health.filter(
    (h) =>
      h.consecutiveFailures > 0 &&
      h.lastErrorAt !== undefined &&
      now - h.lastErrorAt < SEARCH_BACKOFF_MS * 6,
  );
  const failingText = failing.map(
    (h) =>
      `${h.name} failing (${h.consecutiveFailures}× in a row${isQuotaOrAuthError(h.lastError ?? "") ? ", quota or key" : ""}: ${h.lastError ?? "error"})`,
  );
  const working = health.filter((h) => h.consecutiveFailures === 0 && h.lastOkAt !== undefined);
  const parts = [
    `web search chain: ${chain.join(" → ")}`,
    `forecast retrieval: ${forecastRetrieverSpec(env)}`,
    ...(working.length ? [`answering: ${working.map((h) => h.name).join(", ")}`] : []),
    ...failingText,
  ];
  const keyedFailing = failing.some((h) => h.name !== "duckduckgo");
  if (failing.length > 0) {
    return {
      status: "degraded",
      detail: parts.join("; "),
      remediation: keyedFailing
        ? "A search backend is failing (often an exhausted plan: Tavily answers HTTP 432). Queries fall through to the next backend; top up or replace the key, or set MARINA_RESEARCH_SEARCH_BACKENDS to reorder the chain."
        : "Keyless search is failing (rate limit or outage). Configure TAVILY_API_KEY, EXA_API_KEY or SEARXNG_URL for a keyed backend.",
    };
  }
  if (configured.length === 0 && !env.OPENROUTER_API_KEY?.trim()) {
    return {
      status: "degraded",
      detail: `${parts.join("; ")} (keyless only)`,
      remediation:
        "Only keyless DuckDuckGo search is configured. Set TAVILY_API_KEY, EXA_API_KEY or SEARXNG_URL (or OPENROUTER_API_KEY for web-grounded research) for more reliable evidence.",
    };
  }
  return { status: "ok", detail: parts.join("; ") };
}
