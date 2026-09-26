// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DecisionProvider } from "../src/decisions/types";
import { decisionCommand, resetDecisionQualifyForTests } from "../src/engine/commands/decision";
import { evolveCommand } from "../src/engine/commands/evolve";
import { renderAutonomy, renderAutonomyTrend } from "../src/engine/commands/readiness";
import type { ReadinessReport } from "../src/engine/readiness";
import { autonomyPulseTicks } from "../src/engine/tick-jobs";
import { MarinaDB } from "../src/persistence/database";
import type { Entity, EntityId, RoomContext } from "../src/types";
import { cleanupDb, stripAnsi } from "./helpers";

let out: string[] = [];
const ctx = {
  send: (_e: string, text: string) => out.push(stripAnsi(text)),
} as unknown as RoomContext;
const me = { id: "e_1", name: "Tester", properties: {} } as unknown as Entity;
const input = (line: string, entity = "e_1") => {
  const tokens = line.split(/\s+/).slice(1);
  return { entity: entity as EntityId, tokens, args: tokens.join(" "), raw: line } as never;
};

describe("decision qualify — the world's own backend on the labeled cases", () => {
  // Holds nothing and always routes to the powerful tier: a weak but valid backend.
  const stub: DecisionProvider = {
    kind: "stub",
    model: "stub-model",
    async ask(req) {
      if (req.questions.route) {
        return {
          answers: { route: { type: "choice", choice: "powerful", confidence: 0.9 } },
          model: "stub-model",
          provider: "stub",
          latencyMs: 1,
        };
      }
      const answers = Object.fromEntries(
        Object.keys(req.questions).map((id) => [id, { type: "noul" as const, noul: 0.05 }]),
      );
      return { answers, model: "stub-model", provider: "stub", latencyMs: 1 };
    },
  };
  beforeEach(() => resetDecisionQualifyForTests(["e_1"]));

  it("reports gate and route accuracy, then rate limits", async () => {
    const cmd = decisionCommand({ getEntity: () => me, provider: () => stub });
    out = [];
    await cmd.handler(ctx, input("decision qualify"));
    const text = out.join("\n");
    expect(text).toContain("Decision backend qualification");
    expect(text).toContain("stub-model");
    // Holding nothing misses every dangerous call.
    expect(text).toContain("hold recall 0%");
    await cmd.handler(ctx, input("decision qualify"));
    out = [];
    await cmd.handler(ctx, input("decision qualify"));
    expect(out.join("\n")).toContain("rate limited");
  });

  it("says so when the world has no backend", async () => {
    const cmd = decisionCommand({ getEntity: () => me, provider: () => undefined });
    out = [];
    await cmd.handler(ctx, input("decision qualify"));
    expect(out.join("\n")).toContain("MARINA_DECISIONS");
  });
});

describe("readiness autonomy — requirement by requirement", () => {
  const report = (demo: Partial<ReadinessReport["demo"]>) =>
    ({
      demo: {
        activeAgents: 0,
        recentPrimitiveActions: 0,
        recentCommunications: 0,
        marinaToolCalls: 0,
        autonomyQualified: false,
        ...demo,
      },
    }) as ReadinessReport;

  it("marks what is missing and what is met", () => {
    const text = renderAutonomy(report({ activeAgents: 2, marinaToolCalls: 1 })).join("\n");
    expect(text).toContain("not yet");
    expect(text).toMatch(/✓ active agents\s+2/);
    expect(text).toMatch(/✗ Marina tool calls\s+1/);
    expect(text).toContain("qualify:autonomy");
  });

  it("reports QUALIFIED with no remediation", () => {
    const text = renderAutonomy(
      report({
        activeAgents: 3,
        recentPrimitiveActions: 5,
        recentCommunications: 2,
        marinaToolCalls: 4,
        medianResponseMs: 4_000,
        autonomyQualified: true,
      }),
    ).join("\n");
    expect(text).toContain("QUALIFIED");
    expect(text).not.toContain("✗");
  });
});

describe("evolve qualify — the qualify:evolution verdict, read-only", () => {
  const DB = `test_inworld_qualify_${process.pid}.db`;
  let db: MarinaDB;
  const prior = process.env.MARINA_EVOLUTION_PROTOCOLS;
  beforeEach(() => {
    db = new MarinaDB(DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
    if (prior === undefined) delete process.env.MARINA_EVOLUTION_PROTOCOLS;
    else process.env.MARINA_EVOLUTION_PROTOCOLS = prior;
  });

  it("is not qualified with no sessions, and names why", () => {
    process.env.MARINA_EVOLUTION_PROTOCOLS = "true";
    out = [];
    evolveCommand({ getEntity: () => me, db }).handler(ctx, input("evolve qualify"));
    const text = out.join("\n");
    expect(text).toContain("not yet");
    expect(text).toContain("no evolution session is visible");
  });

  it("stays behind the protocols opt-in", () => {
    delete process.env.MARINA_EVOLUTION_PROTOCOLS;
    out = [];
    evolveCommand({ getEntity: () => me, db }).handler(ctx, input("evolve qualify"));
    expect(out.join("\n")).toContain("MARINA_EVOLUTION_PROTOCOLS");
  });
});

describe("autonomy pulse history", () => {
  const DB = `test_autonomy_pulse_${process.pid}.db`;
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
  });

  it("stores snapshots and reports the 24 h share against the 70% goal", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      db.recordAutonomyPulse({
        at: now - i * 300_000,
        activeAgents: i < 8 ? 3 : 1,
        primitiveActions: 5,
        communications: 2,
        toolCalls: 3,
        qualified: i < 8,
      });
    }
    db.recordAutonomyPulse({
      at: now - 2 * 86_400_000,
      activeAgents: 0,
      primitiveActions: 0,
      communications: 0,
      toolCalls: 0,
      qualified: false,
    });
    const rows = db.listAutonomyPulse(now - 86_400_000);
    expect(rows).toHaveLength(10);
    const line = renderAutonomyTrend(rows).join("\n");
    expect(line).toContain("qualified in 8 of 10 snapshots (80%)");
    expect(line).toContain("✓");
    expect(renderAutonomyTrend([]).join("")).toContain("no snapshots yet");
  });

  it("the tick cadence is ~5 minutes of wall clock at any tick interval", () => {
    expect(autonomyPulseTicks(1_000)).toBe(300);
    expect(autonomyPulseTicks(60_000)).toBe(5);
    expect(autonomyPulseTicks(600_000)).toBe(1);
  });
});
