// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { pickDefaultModel } from "../lib/model-catalog";
import type { ProviderGroup } from "../lib/types";

const group = (provider: string, values: string[]): ProviderGroup => ({
  provider,
  error: null,
  keySource: "db",
  models: values.map((v) => ({ value: v, label: v })),
});

describe("pickDefaultModel", () => {
  it("prefers a mainstream model over an alphabetically-first obscure one", () => {
    // OpenRouter's catalog sorts `ai21/...` first — the regression we fixed.
    const groups = [
      group("openrouter", [
        "openrouter/ai21/jamba-large-1.7",
        "openrouter/openai/gpt-4o",
        "openrouter/anthropic/claude-sonnet-4-5",
      ]),
    ];
    expect(pickDefaultModel(groups)).toBe("openrouter/anthropic/claude-sonnet-4-5");
  });

  it("falls back to the first model when none are recognized", () => {
    const groups = [group("openrouter", ["openrouter/ai21/jamba-large-1.7", "openrouter/foo/bar"])];
    expect(pickDefaultModel(groups)).toBe("openrouter/ai21/jamba-large-1.7");
  });

  it("returns undefined when there are no models", () => {
    expect(pickDefaultModel([group("openai", [])])).toBeUndefined();
    expect(pickDefaultModel([])).toBeUndefined();
  });

  it("prefers the current cheap generation when no claude is present", () => {
    const groups = [
      group("openai", ["openai/gpt-4o", "openai/gpt-6-luna", "openai/gpt-6-sol"]),
      group("google", ["google/gemini-3.1-flash-lite"]),
    ];
    expect(pickDefaultModel(groups)).toBe("openai/gpt-6-luna");
  });

  it("falls back to an older family only when nothing current is keyed", () => {
    const groups = [
      group("openai", ["openai/gpt-3.5-turbo", "openai/text-embedding-3-small"]),
      group("groq", ["groq/openai/gpt-oss-120b"]),
    ];
    expect(pickDefaultModel(groups)).toBe("groq/openai/gpt-oss-120b");
  });
});
