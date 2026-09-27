// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Marina's own harness (gate, router, verifier, `decision` commands) on a
// decision ENGINE (`MARINA_DECISION_ENGINE`), and readiness for engines and
// calibration. Unset ⇒ the configured backend, exactly as before.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCalibrationCacheForTests } from "../src/decisions/calibrate";
import { getDecisionProvider } from "../src/decisions/config";
import { harnessDecisionProvider, harnessGateEnabled } from "../src/decisions/engines";
import { gateToolCall } from "../src/decisions/gate";
import { resetClassifierCapabilitiesForTests } from "../src/decisions/providers";
import type { DecisionProvider } from "../src/decisions/types";
import { Engine } from "../src/engine/engine";
import { computeReadiness } from "../src/engine/readiness";
import { roomId } from "../src/types";

const KEYS = [
  "MARINA_DECISIONS",
  "MARINA_DECISION_MODEL",
  "MARINA_DECISION_BASE_URL",
  "MARINA_DECISION_ENGINE",
  "MARINA_DECISION_ENGINES",
  "MARINA_DECISION_ENSEMBLE",
  "MARINA_DECISION_METHOD",
  "MARINA_DECISION_CALIBRATION",
  "MARINA_DECISION_GATE",
  "OPENROUTER_API_KEY",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetCalibrationCacheForTests();
  resetClassifierCapabilitiesForTests();
});

describe("harness provider", () => {
  it("is the configured backend unless an engine is chosen", () => {
    const env = { MARINA_DECISIONS: "jev", OPENROUTER_API_KEY: "k" };
    expect(harnessDecisionProvider(env)).toBe(getDecisionProvider(env));
    expect(harnessDecisionProvider({})).toBeUndefined();
  });

  it("uses the chosen engine, and falls back to the configured backend when it does not resolve", () => {
    const env = {
      MARINA_DECISIONS: "jev",
      OPENROUTER_API_KEY: "k",
      MARINA_DECISION_ENGINES: "z-ai/glm-5.3-flash",
    };
    expect(harnessDecisionProvider({ ...env, MARINA_DECISION_ENGINE: "marina/auto" })?.model).toBe(
      "marina/auto",
    );
    expect(harnessDecisionProvider({ ...env, MARINA_DECISION_ENGINE: "marina/nope" })?.model).toBe(
      "typesafe/jev-1.13",
    );
  });

  it("the gate can run on an engine alone, without MARINA_DECISIONS", () => {
    const env = {
      MARINA_DECISION_ENGINES: "z-ai/glm-5.3-flash",
      MARINA_DECISION_ENGINE: "marina/classifier:z-ai/glm-5.3-flash",
    };
    expect(harnessGateEnabled({ ...env, MARINA_DECISION_GATE: "on" })).toBe(true);
    expect(harnessGateEnabled(env)).toBe(false);
    expect(harnessGateEnabled({ MARINA_DECISION_GATE: "on" })).toBe(false);
  });
});

describe("the gate picks its policy from what answered", () => {
  // A composite that is uncalibrated as a whole, answering 0.6 on every risk.
  const composite = (replyCalibrated: boolean | undefined): DecisionProvider => ({
    kind: "marina-auto",
    model: "marina/auto",
    calibrated: false,
    async ask(req) {
      const answers = Object.fromEntries(
        Object.keys(req.questions).map((id) => [id, { type: "noul" as const, noul: 0.6 }]),
      );
      return {
        answers,
        model: "marina/auto",
        provider: "marina-auto",
        latencyMs: 1,
        ...(replyCalibrated === undefined ? {} : { calibrated: replyCalibrated }),
      };
    },
  });

  it("Jev answered alone ⇒ the graded policy (0.6 is allowed)", async () => {
    const d = await gateToolCall(composite(true), "marina_command", { command: "x" });
    expect(d.action).toBe("allow");
    expect(d.calibrated).toBeUndefined();
  });

  it("a classifier took part ⇒ the one-cut policy (0.6 goes to a person)", async () => {
    const d = await gateToolCall(composite(false), "marina_command", { command: "x" });
    expect(d.action).toBe("ask");
    expect(d.calibrated).toBe(false);
    const legacy = await gateToolCall(composite(undefined), "marina_command", { command: "x" });
    expect(legacy.action).toBe("ask");
  });
});

describe("the gate on marina/auto", () => {
  let orig: typeof fetch;
  let jev: number | "down";
  let glm: number | "down";
  beforeEach(() => {
    orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        questions?: Record<string, unknown>;
        response_format?: {
          json_schema: { schema: { properties: { answers: { properties: object } } } };
        };
      };
      if (String(url).includes("/decisions")) {
        if (jev === "down") return new Response("{}", { status: 503 });
        const answers = Object.fromEntries(
          Object.keys(body.questions ?? {}).map((id) => [id, { noul: jev }]),
        );
        return new Response(JSON.stringify({ answers, model: "typesafe/jev-1.13" }));
      }
      if (glm === "down") return new Response("{}", { status: 500 });
      const ids = Object.keys(
        body.response_format!.json_schema.schema.properties.answers.properties,
      );
      const answers = Object.fromEntries(ids.map((id) => [id, { noul: glm }]));
      return new Response(
        JSON.stringify({
          model: "z-ai/glm-5.3-flash",
          choices: [{ message: { content: JSON.stringify({ answers }) } }],
        }),
      );
    }) as typeof fetch;
    setEnv({
      MARINA_DECISIONS: "jev",
      OPENROUTER_API_KEY: "k",
      MARINA_DECISION_ENGINES: "z-ai/glm-5.3-flash",
      MARINA_DECISION_METHOD: "verbalized",
      MARINA_DECISION_ENGINE: "marina/auto",
    });
  });
  afterEach(() => {
    globalThis.fetch = orig;
  });

  const gate = () =>
    gateToolCall(
      harnessDecisionProvider(process.env, { token: async () => "t" })!,
      "marina_command",
      {
        command: "build destroy old-lobby",
      },
    );

  it("a sure Jev answers alone, on its graded policy", async () => {
    jev = 0.95;
    glm = 0.1;
    const d = await gate();
    expect(d.action).toBe("block");
    expect(d.model).toBe("marina/auto");
  });

  it("a Jev outage no longer blocks everything: the fallback judges, holds go to a person", async () => {
    jev = "down";
    glm = 0.9;
    const held = await gate();
    expect(held.action).toBe("ask");
    expect(held.error).toBeUndefined();
    glm = 0.05;
    expect((await gate()).action).toBe("allow");
  });

  it("both down still fails closed", async () => {
    jev = "down";
    glm = "down";
    const d = await gate();
    expect(d.action).toBe("block");
    expect(d.error).toBeDefined();
  });
});

describe("readiness: decision engines", () => {
  const check = () =>
    computeReadiness(
      new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 }),
    ).checks.find((c) => c.id === "decision-engines");
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-engines-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("off when nothing answers /v1/systemone", () => {
    setEnv({});
    expect(check()).toMatchObject({ status: "off" });
  });

  it("lists what is served, the harness engine and earned calibrations", () => {
    const path = join(dir, "cal.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: "x",
        cases: "c",
        engines: {
          "typesafe/jev-1.13": {
            method: "platt",
            stage: "gate",
            a: 1,
            b: 0,
            cases: 50,
            holds: 25,
            raw: { brier: 0, ece: 0, logLoss: 0 },
            fitted: { brier: 0, ece: 0, logLoss: 0 },
            earned: true,
            reasons: [],
          },
        },
      }),
    );
    chmodSync(path, 0o644);
    setEnv({
      MARINA_DECISIONS: "jev",
      OPENROUTER_API_KEY: "k",
      MARINA_DECISION_ENGINES: "z-ai/glm-5.3-flash",
      MARINA_DECISION_ENGINE: "marina/auto",
      MARINA_DECISION_CALIBRATION: path,
    });
    const c = check()!;
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("marina/classifier:z-ai/glm-5.3-flash");
    expect(c.detail).toContain("harness uses marina/auto");
    expect(c.detail).toContain("calibration earned for typesafe/jev-1.13");
  });

  it("degraded when a requested engine, ensemble or calibration file does not resolve", () => {
    const loose = join(dir, "loose.json");
    writeFileSync(loose, "{}");
    chmodSync(loose, 0o666);
    setEnv({
      MARINA_DECISIONS: "jev",
      OPENROUTER_API_KEY: "k",
      MARINA_DECISION_ENGINE: "marina/nope",
      MARINA_DECISION_ENSEMBLE: "typesafe/jev-1.13",
      MARINA_DECISION_CALIBRATION: loose,
    });
    const c = check()!;
    expect(c.status).toBe("degraded");
    expect(c.detail).toContain("MARINA_DECISION_ENGINE=marina/nope");
    expect(c.detail).toContain("MARINA_DECISION_ENSEMBLE");
    expect(c.detail).toContain("MARINA_DECISION_CALIBRATION");
  });
});
