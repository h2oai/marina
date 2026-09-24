// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { DECISIONS_WINDOW_MS, decisionsOverview } from "../src/net/ops-api";
import type { EngineEvent } from "../src/types";
import { roomId } from "../src/types";

function decision(
  name: string,
  stage: "gate" | "route" | "verify",
  verdict: string,
  at = Date.now(),
): EngineEvent {
  return {
    type: "agent_decision",
    name,
    stage,
    verdict,
    subject: stage === "gate" ? "marina_command" : "x",
    reason: "r",
    signals: { destructive: 0.5 },
    timestamp: at,
  };
}

describe("Ops overview: decisions", () => {
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
  engine.logEvent(decision("Scout", "gate", "block"));
  engine.logEvent(decision("Scout", "gate", "allow"));
  engine.logEvent(decision("Other", "route", "coder"));
  engine.logEvent(decision("Alice", "verify", "retry"));
  engine.logEvent(decision("Scout", "gate", "ask", Date.now() - DECISIONS_WINDOW_MS - 1_000));
  const env = { MARINA_DECISIONS: "jev", MARINA_DECISION_GATE: "on" };

  it("a privileged observer sees every decision in the window, newest first", () => {
    const d = decisionsOverview(engine, { privileged: true }, [], Date.now(), env);
    expect(d).toMatchObject({
      configured: true,
      backend: "decisions-api",
      calibrated: true,
      gate: true,
      verify: false,
    });
    expect(d.counts).toEqual({
      gate: { block: 1, allow: 1 },
      route: { coder: 1 },
      verify: { retry: 1 },
    });
    expect(d.recent).toHaveLength(4);
    expect(d.recent[0]!.timestamp).toBeGreaterThanOrEqual(d.recent[3]!.timestamp);
    expect((d.recent[0] as { type?: string }).type).toBeUndefined();
  });

  it("a resident sees only its own agents and itself", () => {
    const d = decisionsOverview(
      engine,
      { privileged: false, entityName: "Alice" },
      ["Scout"],
      Date.now(),
      env,
    );
    expect(d.recent.map((r) => r.name).sort()).toEqual(["Alice", "Scout", "Scout"]);
    expect(d.counts.route).toBeUndefined();
  });

  it("reports an unconfigured backend", () => {
    const d = decisionsOverview(engine, { privileged: true }, [], Date.now(), {});
    expect(d).toMatchObject({ configured: false, backend: null, model: null, calibrated: null });
  });
});
