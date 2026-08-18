// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { mergeGroups } from "../lib/model-catalog";
import type { ProviderGroup } from "../lib/types";

const group = (provider: string, values: string[]): ProviderGroup => ({
  provider,
  error: null,
  keySource: "db",
  models: values.map((v) => ({ value: v, label: v })),
});

describe("mergeGroups ordering", () => {
  it("hoists local runtimes (llama/ollama) to the top, cloud after", () => {
    const live = [
      group("anthropic", ["anthropic/claude"]),
      group("openai", ["openai/gpt-4o"]),
      group("llama", ["llama/local-model"]),
      group("ollama", ["ollama/llama3"]),
    ];
    const out = mergeGroups(live).map((g) => g.provider);
    expect(out.slice(0, 2)).toEqual(["llama", "ollama"]);
    expect(out).toEqual(["llama", "ollama", "anthropic", "openai"]);
  });

  it("preserves relative order within the cloud partition", () => {
    const live = [
      group("openai", ["openai/gpt-4o"]),
      group("ollama", ["ollama/llama3"]),
      group("anthropic", ["anthropic/claude"]),
    ];
    const out = mergeGroups(live).map((g) => g.provider);
    expect(out).toEqual(["ollama", "openai", "anthropic"]);
  });

  it("is a no-op on ordering when there are no local providers", () => {
    const live = [group("anthropic", ["a"]), group("openai", ["b"])];
    const out = mergeGroups(live).map((g) => g.provider);
    expect(out).toEqual(["anthropic", "openai"]);
  });
});
