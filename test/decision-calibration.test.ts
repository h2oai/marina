// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { gateToolCall } from "../src/decisions/gate";
import { decideGate, UNCALIBRATED_GATE_POLICY } from "../src/decisions/policy";
import { chatClassifierProvider, decisionsApiProvider } from "../src/decisions/providers";
import type { DecisionAnswer, DecisionProvider } from "../src/decisions/types";
import { Engine } from "../src/engine/engine";
import { computeReadiness } from "../src/engine/readiness";
import { roomId } from "../src/types";

const n = (p: number): DecisionAnswer => ({ type: "noul", noul: p });
const risk = (p: number) => ({ destructive: n(p), irreversible: n(0), outsideScope: n(0) });

function stub(calibrated: boolean | undefined, worst: number): DecisionProvider {
  return {
    kind: "stub",
    model: "stub",
    ...(calibrated === undefined ? {} : { calibrated }),
    ask: async () => ({ answers: risk(worst), model: "stub", provider: "stub", latencyMs: 1 }),
  };
}

describe("calibration-aware gate", () => {
  it("marks decision models calibrated and chat classifiers not", () => {
    const opts = { baseUrl: "http://x", model: "m", timeoutMs: 10 };
    expect(decisionsApiProvider(opts).calibrated).toBe(true);
    expect(chatClassifierProvider(opts).calibrated).toBe(false);
  });

  it("an uncalibrated backend gets one threshold and asks instead of blocking", () => {
    expect(decideGate(risk(1), UNCALIBRATED_GATE_POLICY).action).toBe("ask");
    expect(decideGate(risk(0.5), UNCALIBRATED_GATE_POLICY).action).toBe("ask");
    expect(decideGate(risk(0.49), UNCALIBRATED_GATE_POLICY).action).toBe("allow");
    // Outage still fails closed regardless of calibration.
    expect(decideGate(undefined, UNCALIBRATED_GATE_POLICY).action).toBe("block");
  });

  it("gateToolCall picks the policy from the backend unless one is given", async () => {
    const calibrated = await gateToolCall(stub(true, 0.95), "marina_command", { command: "x" });
    expect(calibrated).toMatchObject({ action: "block" });
    expect(calibrated.calibrated).toBeUndefined();

    const legacyStub = await gateToolCall(stub(undefined, 0.95), "marina_command", {
      command: "x",
    });
    expect(legacyStub.action).toBe("block");

    const uncalibrated = await gateToolCall(stub(false, 1), "marina_command", { command: "x" });
    expect(uncalibrated).toMatchObject({ action: "ask", calibrated: false });
    expect(uncalibrated.reason).toContain("uncalibrated backend");

    const explicit = await gateToolCall(
      stub(false, 0.95),
      "marina_command",
      { command: "x" },
      {
        blockAt: 0.9,
        askAt: 0.6,
      },
    );
    expect(explicit.action).toBe("block");
  });
});

function computeReadinessFromEnv(env: Record<string, string>) {
  for (const k of ["MARINA_DECISIONS", "MARINA_DECISION_MODEL", "MARINA_DECISION_BASE_URL"]) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
  return computeReadiness(engine).checks.find((c) => c.id === "decisions");
}

describe("readiness explains an uncalibrated backend", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of [
      "MARINA_DECISIONS",
      "MARINA_DECISION_MODEL",
      "MARINA_DECISION_BASE_URL",
      "OPENROUTER_API_KEY",
    ]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("notes the one-threshold behaviour for chat-classifier only", () => {
    const classifier = computeReadinessFromEnv({
      MARINA_DECISIONS: "chat-classifier",
      MARINA_DECISION_MODEL: "qwen3:4b",
      MARINA_DECISION_BASE_URL: "http://localhost:11434/v1",
    });
    expect(classifier?.detail).toContain("uncalibrated");
    const jev = computeReadinessFromEnv({ MARINA_DECISIONS: "jev", OPENROUTER_API_KEY: "k" });
    expect(jev?.detail).not.toContain("uncalibrated");
  });
});
