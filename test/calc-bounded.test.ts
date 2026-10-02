// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { evalExpressionBounded } from "../src/engine/commands/calc";

// Regression: `calc rationalize(...)` of a degree-9 product ran synchronously on
// the server's event loop and froze every agent and HTTP request for over an
// hour. Evaluation now runs in a worker that is terminated at its deadline.
const EXPENSIVE =
  'rationalize("(x-1)*(x-2)*(x-3)*(x-4)*(x-5)*(x-6)*(x-7)*(x-8)*(x-9) - (x^3-x)^3")';

describe("calc runs off the event loop, bounded", () => {
  test("an expensive expression times out without blocking the main thread", async () => {
    let ticks = 0;
    const interval = setInterval(() => ticks++, 25);
    const started = performance.now();
    const result = await evalExpressionBounded(EXPENSIVE, 1_000);
    clearInterval(interval);
    expect(result.error).toContain("timed out after 1000 ms");
    expect(result.outputs).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
    // The main thread kept running while the worker was busy.
    expect(ticks).toBeGreaterThan(10);
  });

  test("the pool recovers: the next evaluation after a timeout succeeds", async () => {
    await evalExpressionBounded(EXPENSIVE, 500);
    const ok = await evalExpressionBounded("42 * 1729");
    expect(ok).toMatchObject({ outputs: ["72618"], error: undefined });
  });

  test("concurrent evaluations all complete", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => evalExpressionBounded(`${n} * 1000 + 1`)),
    );
    expect(results.map((r) => r.outputs[0])).toEqual(["1001", "2001", "3001", "4001", "5001"]);
  });

  test("errors and sandboxing behave as inline", async () => {
    expect((await evalExpressionBounded("evaluate('1')")).error).toBe("evaluate disabled");
    expect((await evalExpressionBounded("")).outputs).toEqual([]);
  });
});
