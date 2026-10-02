// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `model:route` on saved and seeded agent configs: a boot-seeded agent whose
 * model is `route` / `model:route` (e.g. via MARINA_AGENT_MODELS) is resolved by
 * the router at its first spawn — the respawn path included — and a seed that
 * keeps saying `route` keeps the resolved model instead of re-routing each boot.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRuntime, resolveRouteModel, spawnConfigFromSaved } from "../src/agent/agent-runtime";
import { isRouteModel } from "../src/decisions/route";
import { MarinaDB } from "../src/persistence/database";
import type { BenchmarkItemInput } from "../src/persistence/db-benchmarks";
import type { EngineEvent } from "../src/types";
import { resetSeededAgentNamesForTests, seedSystemAgent } from "../worlds/seed";

const ENV_KEYS = [
  "MARINA_DECISIONS",
  "MARINA_DECISION_ENGINE",
  "MARINA_ROUTES",
  "MARINA_ROUTE_FALLBACK",
  "MARINA_ROUTE_FAST_MODEL",
  "MARINA_ROUTE_POWERFUL_MODEL",
  "MARINA_ROUTE_EVIDENCE",
  "MARINA_ROUTE_EVIDENCE_FAMILIES",
  "MARINA_ROUTE_EVIDENCE_MIN_N",
  "MARINA_AGENT_MODELS",
] as const;

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetSeededAgentNamesForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Deliberately unknown provider prefixes: a spawn then fails validation on the
// model the router picked, which proves the route ran without starting an agent.
const ROUTES = JSON.stringify({
  small: { model: "smallprov/s", criteria: "Quick lookups." },
  big: { model: "bigprov/opus-x", criteria: "Hard reasoning." },
});

function recordModelRun(db: MarinaDB, id: string, model: string, correct: number, total: number) {
  const now = Date.now();
  const items: BenchmarkItemInput[] = Array.from({ length: total }, (_, i) => ({
    item_id: `q${i}`,
    correct: i < correct,
    score: null,
    latency_ms: 10,
    cost_usd: 0.01,
    trace_id: null,
    participants_json: null,
    judge_verdict: "exact",
  }));
  db.recordBenchmarkLedgerRun(
    {
      id,
      benchmark: "hle",
      config_hash: id,
      config_json: "{}",
      started_at: now,
      completed_at: now,
      duration_ms: 1,
      score: correct / total,
      answered: total,
      total,
      cost_usd: 0.01 * total,
      n: total,
      ci_low: 0,
      ci_high: 1,
      seed: 42,
      slice_hash: "s",
      judge: "j",
      target_kind: "model",
      target_json: JSON.stringify({ model }),
      label: null,
      source: "import",
      content_hash: id,
    },
    items,
  );
}

describe("isRouteModel", () => {
  it("accepts `route` and the `model:route` spelling, nothing else", () => {
    expect(isRouteModel("route")).toBe(true);
    expect(isRouteModel(" Model:Route ")).toBe(true);
    expect(isRouteModel("model:route")).toBe(true);
    expect(isRouteModel("openrouter/route")).toBe(false);
    expect(isRouteModel("model:auto")).toBe(false);
    expect(isRouteModel(undefined)).toBe(false);
  });
});

describe("resolveRouteModel", () => {
  it("refuses with the configuration error when no table or tiers are set", async () => {
    await expect(resolveRouteModel({ name: "A", goal: "x" }, undefined)).rejects.toThrow(
      /MARINA_ROUTES/,
    );
  });

  it("uses the table's fallback with no decision backend and records the route", async () => {
    process.env.MARINA_ROUTES = ROUTES;
    process.env.MARINA_ROUTE_FALLBACK = "small";
    const events: EngineEvent[] = [];
    const model = await resolveRouteModel({ name: "A", goal: "solve it" }, undefined, (e) =>
      events.push(e),
    );
    expect(model).toBe("smallprov/s");
    expect(events[0]).toMatchObject({ type: "agent_decision", stage: "route", subject: model });
  });

  it("evidence on: the measured best lower bound wins among the same candidates", async () => {
    process.env.MARINA_ROUTES = ROUTES;
    process.env.MARINA_ROUTE_FALLBACK = "small";
    process.env.MARINA_ROUTE_EVIDENCE = "on";
    process.env.MARINA_ROUTE_EVIDENCE_FAMILIES = "hle";
    const db = new MarinaDB(":memory:");
    try {
      recordModelRun(db, "r-big", "bigprov/opus-x", 36, 40);
      recordModelRun(db, "r-small", "smallprov/s", 20, 40);
      expect(await resolveRouteModel({ name: "A", goal: "solve it" }, db)).toBe("bigprov/opus-x");
      // evidence off: the router's own pick (the fallback) stands
      process.env.MARINA_ROUTE_EVIDENCE = "off";
      expect(await resolveRouteModel({ name: "A", goal: "solve it" }, db)).toBe("smallprov/s");
    } finally {
      db.close();
    }
  });
});

describe("respawn of a seeded `model:route` agent", () => {
  it("routes on the respawn path before model validation", async () => {
    process.env.MARINA_ROUTES = ROUTES;
    process.env.MARINA_ROUTE_FALLBACK = "big";
    process.env.MARINA_AGENT_MODELS = "Answerer=model:route";
    const db = new MarinaDB(":memory:");
    const events: EngineEvent[] = [];
    try {
      seedSystemAgent(db, { name: "Answerer", model: "openai/gpt-6-luna", role: "r", goal: "g" });
      const row = db.getAgentConfig("Answerer")!;
      expect(row.model).toBe("model:route");
      const runtime = new AgentRuntime({ db, wsPort: 39997, onEvent: (e) => events.push(e) });
      // The routed model, not "model:route", is what fails validation.
      await expect(runtime.spawn(spawnConfigFromSaved(row))).rejects.toThrow(/bigprov/);
      expect(events.find((e) => e.type === "agent_decision")).toMatchObject({
        stage: "route",
        subject: "bigprov/opus-x",
      });
    } finally {
      db.close();
    }
  });
});

describe("seedSystemAgent with a `route` seed", () => {
  const seed = (db: MarinaDB) =>
    seedSystemAgent(db, { name: "Answerer", model: "openai/gpt-6-luna", role: "r", goal: "g" });

  it("keeps the resolved model while the seed keeps saying route; a seed change applies", () => {
    const db = new MarinaDB(":memory:");
    try {
      process.env.MARINA_AGENT_MODELS = "Answerer=route";
      seed(db);
      expect(db.getAgentConfig("Answerer")?.model).toBe("route");
      // first spawn resolved and persisted a concrete model
      db.saveAgentConfig({
        name: "Answerer",
        model: "openrouter/openai/gpt-6.1-sol",
        role: "r",
        goal: "g",
        spawnedBy: "system",
      });

      seed(db); // next boot, seed still says route → keep the resolved model
      expect(db.getAgentConfig("Answerer")?.model).toBe("openrouter/openai/gpt-6.1-sol");

      process.env.MARINA_AGENT_MODELS = "Answerer=openrouter/anthropic/claude-opus-5.5";
      seed(db); // the seed changed to a concrete id → applied
      expect(db.getAgentConfig("Answerer")?.model).toBe("openrouter/anthropic/claude-opus-5.5");

      process.env.MARINA_AGENT_MODELS = "Answerer=model:route";
      seed(db); // back to route from a concrete id → re-route at the next spawn
      expect(db.getAgentConfig("Answerer")?.model).toBe("model:route");
    } finally {
      db.close();
    }
  });
});
