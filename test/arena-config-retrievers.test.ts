// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import { WEB_SEARCH_BACKEND_NAMES } from "../src/arena/research/web-search";
import {
  OPENROUTER_WEB_ENGINES,
  OPENROUTER_WEB_PRICES,
} from "../src/engine/search-providers/openrouter-web-engines";

const formation = (retrievers: string) =>
  `formation:delphi:openrouter/google/gemini-3.1-pro-preview,anthropic/claude-fable-5-1+research@${retrievers}`;

describe("forecaster specs accept every retriever the research layer accepts", () => {
  it("every OpenRouter web engine and mode, inside a formation and a route", () => {
    for (const engine of OPENROUTER_WEB_ENGINES) {
      const modes = ["", ...Object.keys(OPENROUTER_WEB_PRICES[engine].modes).filter(Boolean)];
      for (const mode of modes) {
        const r = `openrouter-web:deepseek/deepseek-v4.1-flash@${engine}${mode ? `:${mode}` : ""}`;
        expect(
          parseForecasterSpec(formation(`search:duckduckgo,${r},sonar:sonar-pro`)),
        ).toBeString();
        expect(parseForecasterSpec(`route:civiqs=${formation(r)};*=nowcast`)).toBeString();
      }
    }
  });

  it("every web search backend in a search: chain", () => {
    for (const name of WEB_SEARCH_BACKEND_NAMES) {
      expect(parseForecasterSpec(formation(`search:duckduckgo+${name}`))).toBeString();
    }
  });

  it("the legacy forms still parse and nonsense is refused", () => {
    expect(parseForecasterSpec(formation("openrouter-web:openai/gpt-6-astra@exa"))).toBeString();
    expect(parseForecasterSpec(formation("sonar:sonar-pro"))).toBeString();
    expect(() => parseForecasterSpec(formation("openrouter-web:x/y@bogus"))).toThrow();
  });
});
