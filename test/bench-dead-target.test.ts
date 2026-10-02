// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import {
  DEAD_TARGET_AFTER_TIMEOUTS,
  queryWithUsage,
  resetEndpointHealth,
} from "../benchmarks/modes/passthrough";

// Regression: a frozen target cost the full per-item timeout for every remaining
// item, so a dead crew server stalled a 200-item run for hours. After consecutive
// timeouts the harness probes /health; a target that answers nothing fails fast.
const msgs = [{ role: "user" as const, content: "q" }];

function server(opts: { healthAnswers: boolean }) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health" && opts.healthAnswers) return new Response("ok");
      // Never answers: completion requests and (when dead) the health probe.
      return new Promise<Response>(() => {});
    },
  });
}

afterEach(() => resetEndpointHealth());

describe("dead-target detection", () => {
  test("after consecutive timeouts a target whose /health is silent fails fast", async () => {
    const s = server({ healthAnswers: false });
    const endpoint = `http://localhost:${s.port}`;
    try {
      for (let i = 0; i < DEAD_TARGET_AFTER_TIMEOUTS; i++) {
        await expect(queryWithUsage(endpoint, "m", msgs, undefined, 200, 200)).rejects.toThrow();
      }
      const started = performance.now();
      await expect(queryWithUsage(endpoint, "m", msgs, undefined, 5_000, 200)).rejects.toThrow(
        "target unresponsive",
      );
      // The probe's 200 ms, not the 5 s request timeout.
      expect(performance.now() - started).toBeLessThan(2_000);
      // Known dead: the next request fails without probing again.
      const again = performance.now();
      await expect(queryWithUsage(endpoint, "m", msgs, undefined, 5_000, 200)).rejects.toThrow(
        "target unresponsive",
      );
      expect(performance.now() - again).toBeLessThan(100);
    } finally {
      s.stop(true);
    }
  });

  test("a slow target whose /health answers keeps being called", async () => {
    const s = server({ healthAnswers: true });
    const endpoint = `http://localhost:${s.port}`;
    try {
      for (let i = 0; i < DEAD_TARGET_AFTER_TIMEOUTS + 1; i++) {
        const err = await queryWithUsage(endpoint, "m", msgs, undefined, 200, 200).catch(
          (e: Error) => e,
        );
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).not.toContain("target unresponsive");
      }
    } finally {
      s.stop(true);
    }
  });

  test("an answered request clears the timeout count", async () => {
    let hang = true;
    const s = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/health") return new Promise<Response>(() => {});
        if (hang) return new Promise<Response>(() => {});
        return Response.json({ choices: [{ message: { content: "A" } }] });
      },
    });
    const endpoint = `http://localhost:${s.port}`;
    try {
      await expect(queryWithUsage(endpoint, "m", msgs, undefined, 200, 200)).rejects.toThrow();
      hang = false;
      expect((await queryWithUsage(endpoint, "m", msgs, undefined, 2_000, 200)).content).toBe("A");
      hang = true;
      // One timeout after a success is below the threshold again: no probe, a plain timeout.
      const err = await queryWithUsage(endpoint, "m", msgs, undefined, 200, 200).catch(
        (e: Error) => e,
      );
      expect((err as Error).message).not.toContain("target unresponsive");
    } finally {
      s.stop(true);
    }
  });
});
