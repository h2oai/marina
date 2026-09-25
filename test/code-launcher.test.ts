// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { inferCodeDefaultModel } from "../scripts/code-model";

describe("folder-scoped code launcher model selection", () => {
  it("preserves an explicit Marina default", () => {
    expect(
      inferCodeDefaultModel({
        ANTHROPIC_API_KEY: "key",
        MARINA_DEFAULT_MODEL: "anthropic/operator-choice",
      }),
    ).toBe("anthropic/operator-choice");
  });

  it("selects a model compatible with the configured provider", () => {
    expect(inferCodeDefaultModel({ ANTHROPIC_API_KEY: "key" })).toBe("anthropic/claude-sonnet-5");
    expect(inferCodeDefaultModel({ OPENAI_API_KEY: "key" })).toBe("openai/gpt-6-luna");
    expect(inferCodeDefaultModel({ GEMINI_API_KEY: "key" })).toBe("google/gemini-3.1-flash-lite");
    expect(inferCodeDefaultModel({ HUGGINGFACE_API_KEY: "key" })).toBe(
      "huggingface/zai-org/GLM-5.3-Flash",
    );
  });

  it("honors provider-specific model overrides", () => {
    expect(
      inferCodeDefaultModel({
        ANTHROPIC_API_KEY: "key",
        MARINA_DEFAULT_ANTHROPIC_MODEL: "claude-custom",
      }),
    ).toBe("anthropic/claude-custom");
  });

  it("returns undefined when no supported provider is configured", () => {
    expect(inferCodeDefaultModel({})).toBeUndefined();
  });
});
