// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenRouter's `web` plugin engines and their list prices — shared by the
 * `openrouter-web:<model>@<engine>[:<mode>]` research retriever (which prices
 * each call with them) and the `search` readiness check (which lists them).
 */

/** Search engines OpenRouter's `web` plugin accepts. */
export const OPENROUTER_WEB_ENGINES = [
  "native",
  "exa",
  "parallel",
  "perplexity",
  "firecrawl",
] as const;
export type OpenRouterWebEngine = (typeof OPENROUTER_WEB_ENGINES)[number];

/**
 * The plugin's list prices per engine (https://openrouter.ai/docs/guides/features/plugins/web-search),
 * in USD: `perRequest` by mode (`""` = the engine's default mode), the results
 * a request includes, and the price of each result beyond them. `native` is
 * the model vendor's own search, passed through by OpenRouter (not estimated
 * here). Estimates: OpenRouter may change them.
 */
export const OPENROUTER_WEB_PRICES: Record<
  OpenRouterWebEngine,
  {
    modes: Record<string, number>;
    defaultMode?: string;
    includedResults: number;
    perExtraResult: number;
  }
> = {
  native: { modes: { "": 0 }, includedResults: Number.POSITIVE_INFINITY, perExtraResult: 0 },
  exa: {
    modes: {
      instant: 0.007,
      fast: 0.007,
      auto: 0.007,
      "deep-lite": 0.012,
      deep: 0.012,
      "deep-reasoning": 0.015,
    },
    defaultMode: "auto",
    includedResults: 10,
    perExtraResult: 0.001,
  },
  parallel: {
    modes: { turbo: 0.001, fast: 0.001, basic: 0.005, advanced: 0.005 },
    defaultMode: "basic",
    includedResults: 10,
    perExtraResult: 0.001,
  },
  perplexity: {
    modes: { "": 0.005 },
    includedResults: Number.POSITIVE_INFINITY,
    perExtraResult: 0,
  },
  firecrawl: { modes: { "": 0.005 }, includedResults: 0, perExtraResult: 0.0125 },
};

/**
 * `<engine>[:<mode>]` after the `@` of `openrouter-web:<model>@…` — validated
 * against `OPENROUTER_WEB_PRICES`. Throws a message naming the valid choices.
 */
export function parseOpenRouterWebEngine(raw: string): {
  engine: OpenRouterWebEngine;
  mode?: string;
} {
  const [e = "", ...rest] = raw.trim().toLowerCase().split(":");
  const mode = rest.join(":") || undefined;
  if (!(OPENROUTER_WEB_ENGINES as readonly string[]).includes(e)) {
    throw new Error(`unknown web plugin engine "${e}" (${OPENROUTER_WEB_ENGINES.join(", ")})`);
  }
  const engine = e as OpenRouterWebEngine;
  const modes = Object.keys(OPENROUTER_WEB_PRICES[engine].modes).filter(Boolean);
  if (mode !== undefined && !modes.includes(mode)) {
    throw new Error(
      modes.length
        ? `unknown ${engine} mode "${mode}" (${modes.join(", ")})`
        : `the ${engine} engine takes no mode`,
    );
  }
  return { engine, ...(mode ? { mode } : {}) };
}

/**
 * The plugin's estimated charge for one call: per search, the engine's
 * per-request price for the mode plus each result beyond those included
 * (`maxResults` is what the plugin is asked for — the most it returns).
 */
export function openRouterWebPluginUsd(
  engine: OpenRouterWebEngine | undefined,
  mode: string | undefined,
  maxResults: number,
  searches = 1,
): number {
  if (!engine) return 0;
  const price = OPENROUTER_WEB_PRICES[engine];
  const perRequest = price.modes[mode ?? price.defaultMode ?? ""] ?? 0;
  const extra = Math.max(0, maxResults - price.includedResults) * price.perExtraResult;
  return Math.max(1, searches) * (perRequest + extra);
}
