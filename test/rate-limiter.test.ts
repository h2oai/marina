// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;
  let clock: number;

  beforeEach(() => {
    clock = 1_000_000;
    limiter = new RateLimiter({
      maxTokens: 5,
      refillRate: 2,
      refillInterval: 1000,
      now: () => clock,
    });
  });

  it("names the wait until the next token", () => {
    expect(limiter.retryAfterMs("fresh")).toBe(0);
    for (let i = 0; i < 5; i++) limiter.consume("user1");
    expect(limiter.retryAfterMs("user1")).toBe(1000);
    clock += 400;
    expect(limiter.retryAfterMs("user1")).toBe(600);
    expect(limiter.retryAfterMs("user1", 3)).toBe(1600); // two refills of 2 tokens
    clock += 600;
    expect(limiter.retryAfterMs("user1")).toBe(0);
    expect(limiter.consume("user1")).toBe(true);
  });

  it("should allow requests within capacity", () => {
    expect(limiter.consume("user1")).toBe(true);
    expect(limiter.consume("user1")).toBe(true);
    expect(limiter.consume("user1")).toBe(true);
    expect(limiter.consume("user1")).toBe(true);
    expect(limiter.consume("user1")).toBe(true);
  });

  it("should reject when tokens exhausted", () => {
    for (let i = 0; i < 5; i++) {
      limiter.consume("user1");
    }
    expect(limiter.consume("user1")).toBe(false);
  });

  it("should track keys independently", () => {
    for (let i = 0; i < 5; i++) {
      limiter.consume("user1");
    }
    expect(limiter.consume("user1")).toBe(false);
    expect(limiter.consume("user2")).toBe(true);
  });

  it("should support variable cost", () => {
    expect(limiter.consume("user1", 3)).toBe(true);
    expect(limiter.consume("user1", 3)).toBe(false); // only 2 tokens left
    expect(limiter.consume("user1", 2)).toBe(true);
  });

  it("should refill tokens over time", () => {
    for (let i = 0; i < 5; i++) {
      limiter.consume("user1");
    }
    expect(limiter.consume("user1")).toBe(false);

    // Advance clock past one refill interval
    clock += 1100;

    // Should have 2 tokens refilled
    expect(limiter.consume("user1")).toBe(true);
    expect(limiter.consume("user1")).toBe(true);
    expect(limiter.consume("user1")).toBe(false);
  });

  it("should reset a key", () => {
    for (let i = 0; i < 5; i++) {
      limiter.consume("user1");
    }
    expect(limiter.consume("user1")).toBe(false);
    limiter.reset("user1");
    expect(limiter.consume("user1")).toBe(true);
  });

  it("should report remaining tokens", () => {
    expect(limiter.getRemaining("user1")).toBe(5);
    limiter.consume("user1");
    limiter.consume("user1");
    expect(limiter.getRemaining("user1")).toBe(3);
  });

  it("should not exceed max tokens on refill", () => {
    limiter.consume("user1"); // trigger bucket creation
    clock += 3100;
    expect(limiter.getRemaining("user1")).toBeLessThanOrEqual(5);
  });

  it("should use default config when none provided", () => {
    const defaultLimiter = new RateLimiter();
    expect(defaultLimiter.getRemaining("test")).toBe(30);
  });
});
