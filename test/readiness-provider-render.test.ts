// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `readiness providers` renders an explicit tool-call column per provider so
 * an operator sees "tool call ok" / "TOOL CALL DROPPED" / "tool call not probed"
 * at a glance; `error` keeps its own line and semantics.
 */

import { describe, expect, it } from "bun:test";
import { renderProviderProbe, renderToolCallCheck } from "../src/engine/commands/readiness";
import type { ProviderProbeResult } from "../src/net/model-api";

function result(overrides: Partial<ProviderProbeResult>): ProviderProbeResult {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5",
    ok: true,
    status: 200,
    latencyMs: 210,
    textOk: true,
    systemHonored: true,
    text: "ok",
    checkedAt: Date.now(),
    ...overrides,
  };
}

describe("readiness providers — tool-call column", () => {
  it("renders the three states", () => {
    expect(renderToolCallCheck({ toolCallOk: true })).toBe("tool call ok");
    expect(renderToolCallCheck({ toolCallOk: false })).toBe("TOOL CALL DROPPED");
    expect(renderToolCallCheck({})).toBe("tool call not probed");
  });

  it("shows tool call ok on a passing tool-probed provider, in the check row", () => {
    const [line] = renderProviderProbe([result({ toolCallOk: true })]).slice(1);
    expect(line).toContain("✓ anthropic/claude-sonnet-5");
    expect(line).toContain("text ok · second system message honored · tool call ok · 210 ms");
  });

  it("marks a dropped tool call, keeps the error line, and explains the consequence", () => {
    const lines = renderProviderProbe([
      result({
        ok: false,
        toolCallOk: false,
        toolCallError: "HTTP 200: answered in text",
        error: "tool call dropped — HTTP 200: answered in text",
      }),
    ]).join("\n");
    expect(lines).toContain("✗ anthropic/claude-sonnet-5");
    expect(lines).toContain("TOOL CALL DROPPED");
    expect(lines).toContain("error: tool call dropped — HTTP 200: answered in text");
    expect(lines).toContain("→ tool call dropped (HTTP 200: answered in text)");
  });

  it("says 'not probed' for providers whose passthru path does not translate tools", () => {
    const lines = renderProviderProbe([
      result({ provider: "gemini", model: "gemini-2.5-pro", toolCallOk: undefined }),
    ]).join("\n");
    expect(lines).toContain("gemini/gemini-2.5-pro");
    expect(lines).toContain("tool call not probed");
    expect(lines).not.toContain("DROPPED");
  });
});
