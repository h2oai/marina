// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Extended thinking through the Anthropic passthru translation: an OpenAI-shaped
 * body carrying `reasoning_effort` (what pi-ai emits for a thinking agent on the
 * marina proxy) or a `thinking` field becomes `thinking: {type:"enabled",
 * budget_tokens}`, sampling overrides are dropped (Claude 5 rejects them while
 * thinking), and `max_tokens` always leaves answer room above the budget.
 */

import { describe, expect, test } from "bun:test";
import {
  anthropicThinking,
  buildAnthropicRequest,
  MIN_ANSWER_TOKENS,
  THINKING_BUDGET_TOKENS,
} from "../src/net/anthropic-tools";

const base = {
  model: "marina",
  messages: [{ role: "user", content: "hi" }],
};

describe("anthropicThinking", () => {
  test("maps reasoning_effort levels to pi-ai's budget table", () => {
    for (const [level, budget] of Object.entries(THINKING_BUDGET_TOKENS)) {
      expect(anthropicThinking({ reasoning_effort: level }, undefined)).toEqual({
        type: "enabled",
        budget_tokens: budget,
      });
    }
    expect(THINKING_BUDGET_TOKENS).toMatchObject({
      minimal: 1024,
      low: 2048,
      medium: 8192,
      high: 16384,
      xhigh: 16384,
    });
  });

  test("off / none / unknown / absent leave thinking off", () => {
    expect(anthropicThinking({}, undefined)).toBeUndefined();
    expect(anthropicThinking({ reasoning_effort: "none" }, undefined)).toBeUndefined();
    expect(anthropicThinking({ reasoning_effort: "off" }, undefined)).toBeUndefined();
    expect(anthropicThinking({ reasoning_effort: "bogus" }, undefined)).toBeUndefined();
    expect(
      anthropicThinking({ thinking: { type: "disabled" }, reasoning_effort: "high" }, undefined),
    ).toBeUndefined();
  });

  test("a native thinking object wins over reasoning_effort; level strings/effort objects map", () => {
    expect(
      anthropicThinking(
        { thinking: { type: "enabled", budget_tokens: 3000 }, reasoning_effort: "high" },
        undefined,
      ),
    ).toEqual({ type: "enabled", budget_tokens: 3000 });
    expect(anthropicThinking({ thinking: "low" }, undefined)).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
    expect(anthropicThinking({ thinking: { effort: "medium" } }, undefined)).toEqual({
      type: "enabled",
      budget_tokens: 8192,
    });
    expect(anthropicThinking({ thinking: { type: "enabled" } }, undefined)).toEqual({
      type: "enabled",
      budget_tokens: 8192,
    });
  });

  test("a client cap clamps the budget to leave MIN_ANSWER_TOKENS; a tiny cap does not shrink it", () => {
    expect(anthropicThinking({ reasoning_effort: "high" }, 8000)).toEqual({
      type: "enabled",
      budget_tokens: 8000 - MIN_ANSWER_TOKENS,
    });
    // 1500 - 1024 < 1024: the caller raises max_tokens instead.
    expect(anthropicThinking({ reasoning_effort: "high" }, 1500)).toEqual({
      type: "enabled",
      budget_tokens: 16384,
    });
  });
});

describe("buildAnthropicRequest with thinking", () => {
  test("reasoning_effort → thinking; temperature/top_p omitted; default max_tokens raised", () => {
    const req = buildAnthropicRequest(
      { ...base, reasoning_effort: "high", temperature: 0.2, top_p: 0.9 },
      "claude-sonnet-5",
      false,
    );
    expect(req.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("top_p");
    expect(req.max_tokens).toBe(16384 + MIN_ANSWER_TOKENS);
  });

  test("an explicit client max_tokens is honored and the budget fits under it", () => {
    const req = buildAnthropicRequest(
      { ...base, reasoning_effort: "medium", max_tokens: 6000 },
      "claude-sonnet-5",
      true,
    );
    expect(req.max_tokens).toBe(6000);
    expect(req.thinking).toEqual({ type: "enabled", budget_tokens: 6000 - MIN_ANSWER_TOKENS });
    expect(req.stream).toBe(true);
  });

  test("a too-small explicit cap is raised above the budget rather than truncating thinking", () => {
    const req = buildAnthropicRequest(
      { ...base, reasoning_effort: "low", max_completion_tokens: 1200 },
      "claude-sonnet-5",
      false,
    );
    expect(req.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(req.max_tokens).toBe(2048 + MIN_ANSWER_TOKENS);
  });

  test("thinking off keeps temperature and the plain body", () => {
    const req = buildAnthropicRequest(
      { ...base, reasoning_effort: "none", temperature: 0.4 },
      "claude-sonnet-5",
      false,
    );
    expect(req).not.toHaveProperty("thinking");
    expect(req.temperature).toBe(0.4);
    expect(req.max_tokens).toBe(4096);
  });
});
