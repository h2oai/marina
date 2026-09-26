// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-world daily spend cap: every upstream dollar recorded once, where it
 * leaves Marina, persisted by UTC day, and refused at the cap on every surface
 * that spends — the `/v1` passthru (benchmark runs go through it), decisions,
 * and readiness reporting it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerFromConfig } from "../src/decisions/config";
import { Engine } from "../src/engine/engine";
import { computeReadiness } from "../src/engine/readiness";
import {
  attachSpendLedger,
  dailyCapRefusal,
  dailySpend,
  formatSpendUsd,
  recordSpend,
  resetSpendLedgerForTests,
  spentTodayUsd,
  utcDay,
} from "../src/engine/spend-ledger";
import { resetTrustProfileForTests } from "../src/engine/trust-profile";
import { handleModelApi } from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";

const ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_ANTHROPIC_AUTO_CACHE",
  "MARINA_PROFILE",
  "MARINA_DAILY_SPEND_CAP_USD",
] as const;
let saved: Map<string, string | undefined>;

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  resetSpendLedgerForTests();
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetSpendLedgerForTests();
});

describe("spend ledger", () => {
  it("sums the day, refuses at the cap, and starts fresh the next UTC day", () => {
    const day1 = Date.parse("2026-09-26T10:00:00Z");
    recordSpend("model_api", 30, day1);
    recordSpend("decision", 0.5, day1);
    recordSpend("agent", 0, day1); // nothing spent, nothing recorded
    expect(spentTodayUsd(day1)).toBeCloseTo(30.5);
    const env = { MARINA_DAILY_SPEND_CAP_USD: "50" };
    expect(dailyCapRefusal(env, day1)).toBeUndefined();
    recordSpend("forecast", 20, day1);
    expect(dailySpend(env, day1)).toMatchObject({ reached: true, capUsd: 50 });
    expect(dailyCapRefusal(env, day1)).toContain("daily spend cap reached ($50.50 today ≥ $50.00");
    expect(dailyCapRefusal(env, Date.parse("2026-09-27T00:00:01Z"))).toBeUndefined();
    expect(dailyCapRefusal({}, day1)).toBeUndefined(); // no cap set
    expect(formatSpendUsd(0.00007)).toBe("$0.000070");
    expect(formatSpendUsd(50.5)).toBe("$50.50");
  });

  it("persists by day and source, and reloads the day's total after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-"));
    const db = new MarinaDB(join(dir, "w.db"));
    try {
      const sink = {
        add: (d: string, s: string, u: number) => db.addDailySpend(d, s, u),
        totalFor: (d: string) => db.getDailySpend(d).reduce((t, r) => t + r.cost_usd, 0),
      };
      attachSpendLedger(sink);
      recordSpend("model_api", 1.25);
      recordSpend("model_api", 0.75);
      recordSpend("decision", 0.01);
      const rows = db.getDailySpend(utcDay());
      expect(rows.find((r) => r.source === "model_api")).toMatchObject({ cost_usd: 2, calls: 2 });
      resetSpendLedgerForTests(); // a restart…
      attachSpendLedger(sink); // …reloads today's total from the ledger
      expect(spentTodayUsd()).toBeCloseTo(2.01);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("enforcement", () => {
  let originalFetch: typeof fetch;
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  let upstreamCalls: number;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.MARINA_OPEN_API = "true";
    process.env.MARINA_ANTHROPIC_AUTO_CACHE = "false";
    resetTrustProfileForTests();
    originalFetch = globalThis.fetch;
    upstreamCalls = 0;
    globalThis.fetch = (async () => {
      upstreamCalls++;
      return Response.json({
        id: "msg_up",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1_000, output_tokens: 1_000 },
      });
    }) as unknown as typeof fetch;
    dir = mkdtempSync(join(tmpdir(), "spend-cap-"));
    db = new MarinaDB(join(dir, "w.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    setEndpointConfig(db, { mode: "passthru", passthruModel: "anthropic/claude-sonnet-5" });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetTrustProfileForTests();
    engine.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const chat = async () => {
    const url = new URL("http://localhost:3300/v1/chat/completions");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "marina", messages: [{ role: "user", content: "hi" }] }),
    });
    return (await handleModelApi(url, "POST", req, engine))!;
  };

  it("passthru records what it pays upstream, then refuses at the cap without calling upstream", async () => {
    process.env.MARINA_DAILY_SPEND_CAP_USD = "0.000001";
    const first = await chat();
    expect(first.status).toBe(200);
    await first.text();
    expect(upstreamCalls).toBe(1);
    const recorded = db.getDailySpend(utcDay()).find((r) => r.source === "model_api");
    expect(recorded?.cost_usd).toBeGreaterThan(0);

    const second = await chat();
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("spend_cap_reached");
    expect(body.error.message).toContain("daily spend cap reached");
    expect(upstreamCalls).toBe(1);

    const check = computeReadiness(engine).checks.find((c) => c.id === "daily-spend");
    expect(check?.status).toBe("off");
  });

  it("decision backends refuse at the cap before any network call", async () => {
    process.env.MARINA_DAILY_SPEND_CAP_USD = "1";
    recordSpend("model_api", 5);
    const provider = providerFromConfig({
      kind: "decisions-api",
      model: "typesafe/jev-1.13",
      baseUrl: "http://127.0.0.1:9",
      timeoutMs: 500,
    });
    await expect(
      provider.ask({ state: "x", questions: { ok: { type: "noul", instructions: "?" } } }),
    ).rejects.toMatchObject({ code: "spend_cap" });
    expect(upstreamCalls).toBe(0);
  });
});
