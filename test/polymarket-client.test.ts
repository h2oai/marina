// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import {
  cancelOrder,
  isPaperMode,
  isPolymarketConfigured,
  placeOrder,
} from "../src/net/polymarket-client";

const KEYS = [
  "MARINA_TRADING_ENABLED",
  "POLYMARKET_API_KEY",
  "POLYMARKET_API_SECRET",
  "POLYMARKET_API_PASSPHRASE",
  "POLYMARKET_PRIVATE_KEY",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const order = { market: "m", token_id: "m-yes", side: "BUY" as const, price: 0.4, size: 2 };

describe("polymarket client", () => {
  it("requires the passphrase, too, to count as configured", () => {
    expect(isPolymarketConfigured("k", "s", "pk", "")).toBe(false);
    expect(isPolymarketConfigured("k", "s", "pk", "pass")).toBe(true);
    process.env.MARINA_TRADING_ENABLED = "true";
    expect(isPaperMode({ apiKey: "k", apiSecret: "s", privateKey: "pk", apiPassphrase: "" })).toBe(
      true,
    );
  });

  it("stays in paper mode without the flag or a full credential set", async () => {
    const res = await placeOrder(order, { apiKey: "k", apiSecret: "s", privateKey: "pk" });
    expect(res.ok && res.paper).toBe(true);
  });

  it("fails closed outside paper mode: live orders are unsupported and nothing is sent", async () => {
    process.env.MARINA_TRADING_ENABLED = "true";
    const opts = { apiKey: "k", apiSecret: "s", privateKey: "pk", apiPassphrase: "pass" };
    const original = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      throw new Error("no network");
    }) as unknown as typeof fetch;
    try {
      const placed = await placeOrder(order, opts);
      expect(placed.ok).toBe(false);
      if (!placed.ok) expect(placed.error).toContain("not supported");
      const cancelled = await cancelOrder("o1", opts);
      expect(cancelled.ok).toBe(false);
      expect(fetched).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
