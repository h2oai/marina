// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { friendlyFeedType } from "../canvas/nodes/TextNode";

describe("friendlyFeedType — fallback for unknown feed types", () => {
  it("title-cases snake_case names", () => {
    // Customer-demo regression: unknown feed types were rendering raw
    // technical names like "note_link_created" in the canvas UI. The
    // renderer now title-cases unknown types so users see "Note Link
    // Created" instead.
    expect(friendlyFeedType("note_link_created")).toBe("Note Link Created");
    expect(friendlyFeedType("rank_change")).toBe("Rank Change");
  });

  it("title-cases hyphenated names", () => {
    expect(friendlyFeedType("market-resolution")).toBe("Market Resolution");
  });

  it("handles single-word feed types", () => {
    expect(friendlyFeedType("manual")).toBe("Manual");
  });

  it("collapses repeated separators", () => {
    expect(friendlyFeedType("foo__bar")).toBe("Foo Bar");
    expect(friendlyFeedType("--foo--")).toBe("Foo");
  });
});
