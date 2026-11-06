// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { toolSummary } from "../src/engine/commands/connect";

describe("connect tools: one line per tool", () => {
  it("keeps a short description whole", () => {
    expect(toolSummary("View documentation about a GitHub repository.")).toBe(
      "View documentation about a GitHub repository.",
    );
  });

  it("cuts a long one at a word, with an ellipsis, and keeps only its first line", () => {
    const long =
      "Ask any question about a GitHub repository's codebase and get an AI-powered, context-grounded response.\n\nArgs: repoName, question";
    const out = toolSummary(long, 60);
    expect(out).toBe("Ask any question about a GitHub repository's codebase and…");
    expect(out.length).toBeLessThanOrEqual(60);
    expect(toolSummary(long)).not.toContain("Args");
  });
});
