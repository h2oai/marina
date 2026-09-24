// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import { isRouteModel, routeModelForGoal, routeTiersFromEnv } from "../src/decisions/route";
import type { DecisionAnswer, DecisionProvider } from "../src/decisions/types";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent } from "../src/types";
import { cleanupDb } from "./helpers";

const TIERS = { fast: "openai/gpt-4o-mini", powerful: "anthropic/claude-opus-4-6" };

function stub(
  answers: Record<string, DecisionAnswer> | Error,
): DecisionProvider & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    kind: "stub",
    model: "stub-jev",
    seen,
    async ask(req) {
      seen.push(req.state);
      if (answers instanceof Error) throw answers;
      return { answers, model: "stub-jev", provider: "stub", latencyMs: 4 };
    },
  };
}

const route = (
  tier: string,
  complexity: number,
  confidence = 0.9,
): Record<string, DecisionAnswer> => ({
  tier: { type: "choice", choice: tier, confidence },
  complexity: { type: "score", score: complexity },
});

describe("spawn-time routing", () => {
  it("recognises the route selector and reads both tiers from env", () => {
    expect(isRouteModel(" Route ")).toBe(true);
    expect(isRouteModel("openai/gpt-4o")).toBe(false);
    expect(routeTiersFromEnv({ MARINA_ROUTE_FAST_MODEL: "a/b" })).toBeUndefined();
    expect(
      routeTiersFromEnv({ MARINA_ROUTE_FAST_MODEL: "a/b", MARINA_ROUTE_POWERFUL_MODEL: "c/d" }),
    ).toEqual({ fast: "a/b", powerful: "c/d" });
  });

  it("routes an easy goal to the fast tier and a hard one to the powerful tier", async () => {
    const easy = stub(route("fast", 0.3));
    const picked = await routeModelForGoal(
      "read the README and summarise it",
      "scholar",
      TIERS,
      easy,
    );
    expect(picked).toMatchObject({ model: TIERS.fast, tier: "fast", decisionModel: "stub-jev" });
    expect(easy.seen[0]).toEqual({ goal: "read the README and summarise it", role: "scholar" });

    const hard = await routeModelForGoal(
      "find why builds hang",
      undefined,
      TIERS,
      stub(route("fast", 1.4)),
    );
    expect(hard).toMatchObject({ model: TIERS.powerful, tier: "powerful" });
    expect(hard.verdict.reason).toContain("complexity");
  });

  it("fails open to the powerful tier: no backend, no goal, or a backend error", async () => {
    expect((await routeModelForGoal("x", undefined, TIERS, undefined)).model).toBe(TIERS.powerful);
    expect((await routeModelForGoal("  ", undefined, TIERS, stub(route("fast", 0)))).model).toBe(
      TIERS.powerful,
    );
    const failed = await routeModelForGoal("x", undefined, TIERS, stub(new Error("503")));
    expect(failed).toMatchObject({ model: TIERS.powerful, tier: "powerful" });
    expect(failed.error).toContain("503");
  });
});

describe("AgentRuntime.spawn with model:route", () => {
  const DB = `test_decision_route_${process.pid}.db`;
  const keys = ["MARINA_ROUTE_FAST_MODEL", "MARINA_ROUTE_POWERFUL_MODEL", "MARINA_DECISIONS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    cleanupDb(DB);
  });

  it("refuses without both tier models configured", async () => {
    delete process.env.MARINA_ROUTE_FAST_MODEL;
    delete process.env.MARINA_ROUTE_POWERFUL_MODEL;
    const db = new MarinaDB(DB);
    try {
      const runtime = new AgentRuntime({ db, wsPort: 39998 });
      await expect(runtime.spawn({ name: "Routed", model: "route", goal: "x" })).rejects.toThrow(
        /MARINA_ROUTE_FAST_MODEL and MARINA_ROUTE_POWERFUL_MODEL/,
      );
    } finally {
      db.close();
    }
  });

  it("resolves the route before validation and records the decision", async () => {
    // Deliberately unknown provider prefixes: spawn then fails validation on
    // the model the router picked, which proves which tier was chosen without
    // starting an agent. No decision backend ⇒ fails open to powerful.
    delete process.env.MARINA_DECISIONS;
    process.env.MARINA_ROUTE_FAST_MODEL = "fastprov/small";
    process.env.MARINA_ROUTE_POWERFUL_MODEL = "bigprov/large";
    const db = new MarinaDB(DB);
    const events: EngineEvent[] = [];
    try {
      const runtime = new AgentRuntime({ db, wsPort: 39998, onEvent: (e) => events.push(e) });
      await expect(
        runtime.spawn({ name: "Routed", model: "route", goal: "refactor the scheduler" }),
      ).rejects.toThrow(/bigprov/);
      expect(events.find((e) => e.type === "agent_decision")).toMatchObject({
        type: "agent_decision",
        name: "Routed",
        stage: "route",
        verdict: "powerful",
        subject: "bigprov/large",
      });
    } finally {
      db.close();
    }
  });
});
