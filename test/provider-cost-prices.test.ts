// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import {
  costFromTokens,
  defaultModelPrice,
  openRouterModelPrice,
  resetOpenRouterPricesForTests,
} from "../src/agent/provider-cost";

describe("model list prices", () => {
  afterEach(() => resetOpenRouterPricesForTests());

  it("prices the current frontier and arena models the bundled catalog lacks", () => {
    for (const id of [
      "openrouter/anthropic/claude-sonnet-5.5",
      "anthropic/claude-opus-5.5",
      "openrouter/anthropic/claude-fable-5.1",
      "openrouter/openai/gpt-6-astra",
      "openai/gpt-6-sol",
      "openrouter/deepseek/deepseek-v4-pro-0813",
    ]) {
      expect(defaultModelPrice(id)?.input).toBeGreaterThan(0);
    }
    expect(defaultModelPrice("openrouter/some/unknown-model")).toBeUndefined();
  });

  it("computes USD from token counts", () => {
    const price = defaultModelPrice("claude-sonnet-5.5")!;
    // 10k in at $2/M + 1k out at $10/M = $0.02 + $0.01
    expect(costFromTokens(price, { input: 10_000, output: 1_000 })).toBeCloseTo(0.03, 6);
  });

  it("reads OpenRouter's live catalog once, and never invents a price", async () => {
    let fetches = 0;
    const fetcher = async () => {
      fetches++;
      return Response.json({
        data: [
          { id: "vendor/new-model", pricing: { prompt: "0.000001", completion: "0.000004" } },
          { id: "vendor/free-model", pricing: { prompt: "0", completion: "0" } },
        ],
      });
    };
    expect(await openRouterModelPrice("openrouter/vendor/new-model", fetcher)).toMatchObject({
      input: 1,
      output: 4,
    });
    expect(await openRouterModelPrice("vendor/free-model", fetcher)).toBeUndefined();
    expect(await openRouterModelPrice("vendor/missing", fetcher)).toBeUndefined();
    expect(fetches).toBe(1);
    resetOpenRouterPricesForTests();
    const down = async () => new Response("", { status: 503 });
    expect(await openRouterModelPrice("vendor/new-model", down)).toBeUndefined();
  });
});
