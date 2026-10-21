// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// An outbound client's deadline covers the whole exchange: a server that sends
// its headers and then never finishes the body is cut off, not waited on.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { lookupFetch } from "../src/forecast/lookup-http";
import { getMarket } from "../src/net/clients/kalshi-client";
import { getEvents } from "../src/net/clients/polymarket-client";
import { tabh2oPredict } from "../src/net/clients/tabh2o-client";
import { __setDnsResolverForTest } from "../src/net/url-guard";

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

/** A fetch that answers 200 at once and then stalls the body until aborted. */
function stallingBodyFetch(): typeof fetch {
  return (async (_input: string | URL, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          controller.error(err);
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** Resolve with the outcome, or with "hung" if it does not settle within `ms`. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<"hung">((resolve) => {
    timer = realSetTimeout(() => resolve("hung"), ms);
  });
  try {
    return await Promise.race([p, hung]);
  } finally {
    clearTimeout(timer);
  }
}

describe("outbound clients time out a stalled response body", () => {
  beforeEach(() => {
    __setDnsResolverForTest(async () => ["93.184.216.34"]);
    globalThis.fetch = stallingBodyFetch();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    __setDnsResolverForTest(null);
  });

  it("Kalshi", async () => {
    const out = await settleWithin(
      getMarket("T", { base: "https://kalshi.example.com/v2", timeoutMs: 50 }),
      2000,
    );
    expect(out).not.toBe("hung");
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  });

  it("Polymarket", async () => {
    const out = await settleWithin(
      getEvents({}, { gammaBase: "https://gamma.example.com", timeoutMs: 50 }),
      2000,
    );
    expect(out).not.toBe("hung");
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  });

  it("TabH2O", async () => {
    const out = await settleWithin(
      tabh2oPredict(
        {
          task: "regression",
          training: [{ x: 1, y: 2 }],
          predict_on: [{ x: 2 }],
          target_column: "y",
        } as Parameters<typeof tabh2oPredict>[0],
        { apiKey: "k", endpoint: "https://tabh2o.example.com/api/v1/predict", timeoutMs: 50 },
      ),
      2000,
    );
    expect(out).not.toBe("hung");
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
  });

  it("forecast lookups", async () => {
    // The lookup deadline is the fixed connector timeout; shorten timers for this call.
    globalThis.setTimeout = ((fn: () => void, _ms?: number) =>
      realSetTimeout(fn, 50)) as unknown as typeof setTimeout;
    const out = await settleWithin(
      lookupFetch("Probe").json("https://lookup.example.com/data"),
      2000,
    );
    expect(out).toEqual({ ok: false, error: "Probe timed out" });
  });
});
