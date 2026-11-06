// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import type { ConnectorRuntime } from "../src/engine/connector-runtime";
import { openRouterFallbackProvider } from "../src/engine/search-providers/index";
import { openRouterWebSearchEnabled } from "../src/engine/search-providers/openrouter-web-engines";
import { describeSearchReadiness } from "../src/engine/search-readiness";
import { resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";

const reply = {
  choices: [
    {
      message: {
        annotations: [
          {
            url_citation: {
              url: "https://investors.example.com/fy2025",
              title: "Fiscal 2025 results",
              content: "Revenue was $3,427.2 million.",
            },
          },
        ],
      },
    },
  ],
  usage: { cost: 0.0074 },
};

describe("web search falls back to OpenRouter's Exa plugin", () => {
  it("turns citations into results, records the spend, and names the carrier model", async () => {
    resetSpendLedgerForTests();
    let sent: { model?: string; plugins?: { engine?: string }[] } = {};
    const provider = openRouterFallbackProvider(
      "sk-or-test",
      { MARINA_RESEARCH_SEARCH_MODEL: "test/carrier" },
      async (_url, init) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify(reply), { status: 200 });
      },
    );
    expect(provider.name).toBe("openrouter");
    expect(provider.disabled?.()).toBeUndefined();
    const results = await provider.search(
      "Datadog fiscal 2025 revenue",
      { maxResults: 5 },
      undefined as unknown as ConnectorRuntime,
    );
    expect(results).toEqual([
      expect.objectContaining({
        url: "https://investors.example.com/fy2025",
        title: "Fiscal 2025 results",
        source: "openrouter",
      }),
    ]);
    expect(sent.model).toBe("test/carrier");
    expect(sent.plugins?.[0]?.engine).toBe("exa");
    expect(spentTodayUsd()).toBeCloseTo(0.0074, 6);
  });

  it("stays out of web search while MARINA_SEARCH_OPENROUTER=off, and readiness says so", () => {
    const env = { MARINA_SEARCH_OPENROUTER: "off", OPENROUTER_API_KEY: "sk-or-test" };
    expect(openRouterWebSearchEnabled(env)).toBe(false);
    expect(openRouterFallbackProvider("sk-or-test", env).disabled?.()).toContain("off");
    expect(describeSearchReadiness(env, []).detail).toContain("research only");
    expect(describeSearchReadiness({ OPENROUTER_API_KEY: "k" }, []).detail).toContain(
      "openrouter (Exa plugin)",
    );
  });
});
