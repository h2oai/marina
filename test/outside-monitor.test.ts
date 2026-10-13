// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { INITIAL_STATE, type MonitorState, parseDurationMs, probe, step } from "../scripts/monitor";
import { healthResponse } from "../src/net/api/connect-api";
import { createTestEngine } from "./engine-fixture";

const OPTS = { failures: 2, remindMs: 3_600_000 };
const DOWN = { ok: false, detail: "unreachable" };
const UP = { ok: true, detail: "ok" };
const MIN = 60_000;

describe("outside monitor state", () => {
  it("alerts once after N failures, reminds hourly, then reports recovery", () => {
    let s: MonitorState = { ...INITIAL_STATE };
    const at = (i: number) => 1_000_000 + i * MIN;
    const run = (r: typeof UP, i: number) => {
      const out = step(s, r, at(i), OPTS, "Marina");
      s = out.state;
      return out.alert;
    };
    expect(run(UP, 0)).toBeUndefined();
    // One failed check is not an outage.
    expect(run(DOWN, 1)).toBeUndefined();
    expect(run(DOWN, 2)?.kind).toBe("down");
    expect(run(DOWN, 3)).toBeUndefined();
    expect(run(DOWN, 62)?.kind).toBe("still-down");
    expect(run(DOWN, 63)).toBeUndefined();
    const back = run(UP, 64);
    expect(back?.kind).toBe("recovered");
    expect(back?.message).toContain("63 min");
    expect(run(UP, 65)).toBeUndefined();
  });

  it("a blip that recovers before the threshold sends nothing", () => {
    const a = step({ ...INITIAL_STATE }, DOWN, 1, OPTS, "M");
    expect(a.alert).toBeUndefined();
    expect(step(a.state, UP, 2, OPTS, "M").alert).toBeUndefined();
  });

  it("parses durations", () => {
    expect(parseDurationMs("90")).toBe(90_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("0")).toBeUndefined();
    expect(parseDurationMs("soon")).toBeUndefined();
  });
});

describe("outside monitor probe", () => {
  const reply = (body: unknown, status = 200) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch;

  it("reads ok, stalled, error statuses and silence", async () => {
    expect((await probe("http://x/health", 1000, reply({ status: "ok" }))).ok).toBe(true);
    const stalled = await probe(
      "http://x/health",
      1000,
      reply({ status: "stalled", tick: { agoMs: 45_000 } }, 503),
    );
    expect(stalled).toEqual({ ok: false, detail: "tick loop stalled (last tick 45 s ago)" });
    expect((await probe("http://x/health", 1000, reply({ error: "x" }, 500))).detail).toBe(
      "HTTP 500",
    );
    const hung = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as unknown as typeof fetch;
    expect((await probe("http://x/health", 50, hung)).detail).toContain("no answer within");
    const refused = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect((await probe("http://x/health", 1000, refused)).detail).toContain("unreachable");
  });
});

describe("/health tick liveness", () => {
  it("is ok when the loop never started, and reports the tick", async () => {
    const fx = createTestEngine();
    try {
      const res = healthResponse(fx.engine);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; tick: { count: number } };
      expect(body.status).toBe("ok");
      expect(typeof body.tick.count).toBe("number");
      // A running loop whose last tick is long past is stalled.
      expect(fx.engine.tickHealth(Date.now() + 10 * MIN).stalled).toBe(false);
    } finally {
      await fx.dispose();
    }
  });
});
