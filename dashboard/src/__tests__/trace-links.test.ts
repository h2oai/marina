// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { traceIdFromSearch, tracePermalink } from "../lib/trace-links";

describe("trace deep links", () => {
  it("reads a bounded trace ID without treating other parameters as evidence", () => {
    expect(traceIdFromSearch("?trace=req-123&tab=ignored")).toBe("req-123");
    expect(traceIdFromSearch("?trace=%20%20")).toBeUndefined();
    expect(traceIdFromSearch(`?trace=${"x".repeat(201)}`)).toBeUndefined();
    expect(traceIdFromSearch("?other=req-123")).toBeUndefined();
  });

  it("preserves deployment paths and unrelated parameters", () => {
    expect(tracePermalink("req/123", "https://marina.example/dashboard?world=research#panel")).toBe(
      "https://marina.example/dashboard?world=research&trace=req%2F123",
    );
  });
});
