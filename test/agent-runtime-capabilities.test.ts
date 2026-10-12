// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPromptTimeoutMs } from "../src/agent/lean-agent-adapter";
import { normalizeAllowedCodeCommand } from "../src/coding/local-workspace";
import { isTestCommand } from "../src/coding/project-detection";
import { isSpendRefusal } from "../src/engine/spend-ledger";
import {
  isSamplingRejection,
  noteSamplingRejected,
  rejectsSamplingParams,
  resetSamplingParamsForTests,
  samplingFor,
  withoutRejectedSampling,
} from "../src/net/model/sampling-params";
import { prepareUpstreamBody } from "../src/net/model-api/upstream";

afterEach(() => resetSamplingParamsForTests());

describe("sampling parameters follow the model", () => {
  it("OpenAI reasoning families and Claude 5 refuse them; others keep them", () => {
    for (const m of [
      "gpt-6.1-sol",
      "openai/gpt-6.1-sol",
      "openrouter/openai/gpt-5.6-luna",
      "o4-mini",
    ])
      expect(rejectsSamplingParams(m)).toBe(true);
    expect(rejectsSamplingParams("anthropic/claude-opus-5-5")).toBe(true);
    for (const m of ["gpt-4.1", "deepseek/deepseek-v4-pro-0813", "google/gemini-3.1-pro-preview"])
      expect(rejectsSamplingParams(m)).toBe(false);
    expect(samplingFor("gpt-6.1-sol", 0.3)).toEqual({});
    expect(samplingFor("gpt-4.1", 0.3)).toEqual({ temperature: 0.3 });
  });

  it("a refusal is learned once per model", () => {
    expect(isSamplingRejection("Unsupported value: 'temperature' does not support 0.3")).toBe(true);
    expect(isSamplingRejection("rate limited")).toBe(false);
    expect(rejectsSamplingParams("acme/new-model")).toBe(false);
    noteSamplingRejected("acme/new-model");
    expect(rejectsSamplingParams("openrouter/acme/new-model")).toBe(true);
    const body: Record<string, unknown> = {
      model: "acme/new-model",
      temperature: 0,
      top_p: 1,
      x: 1,
    };
    expect(withoutRejectedSampling(body)).toEqual({ model: "acme/new-model", x: 1 });
  });

  it("the passthru drops refused sampling fields upstream and keeps accepted ones", () => {
    const sol = prepareUpstreamBody(
      { model: "gpt-6.1-sol", temperature: 0, messages: [] },
      "openai",
    );
    expect("temperature" in sol).toBe(false);
    const other = prepareUpstreamBody({ model: "gpt-4.1", temperature: 0, messages: [] }, "openai");
    expect(other.temperature).toBe(0);
  });
});

describe("spend refusals are not retried like outages", () => {
  it("recognizes caps, budget proxies and providers out of credits", () => {
    for (const m of [
      "429 spend_cap_reached",
      "daily spend cap reached ($7.00 today ≥ $7.00)",
      "402 Payment Required",
      "insufficient_quota: You exceeded your current quota",
      "reservation exceeds the remaining attempt budget",
    ])
      expect(isSpendRefusal(m)).toBe(true);
    for (const m of [
      "429 Too Many Requests: rate limited",
      "500 internal error",
      "port 4020 closed",
    ])
      expect(isSpendRefusal(m)).toBe(false);
  });
});

describe("prompt bound starts where the reasoning fits", () => {
  it("scales with the thinking level", () => {
    expect(defaultPromptTimeoutMs("off")).toBe(120_000);
    expect(defaultPromptTimeoutMs("low")).toBe(180_000);
    expect(defaultPromptTimeoutMs("medium")).toBe(300_000);
    expect(defaultPromptTimeoutMs("high")).toBe(600_000);
  });
});

describe("Python checks without pytest", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const root = () => {
    const d = mkdtempSync(join(tmpdir(), "py-runner-"));
    dirs.push(d);
    mkdirSync(join(d, "tests"));
    writeFileSync(join(d, "tests", "check_output.py"), "print('ok')\n");
    writeFileSync(join(d, "test_api.py"), "print('ok')\n");
    return d;
  };

  it("allows unittest and workspace test scripts in fixed shapes", () => {
    const r = root();
    expect(
      normalizeAllowedCodeCommand(r, ["python", "-m", "unittest", "discover", "-s", "tests", "-q"]),
    ).toEqual(["python", "-m", "unittest", "discover", "-s", "tests", "-q"]);
    expect(
      normalizeAllowedCodeCommand(r, ["python3", "-m", "unittest", "tests.test_x", "-v"]),
    ).toEqual(["python3", "-m", "unittest", "tests.test_x", "-v"]);
    expect(normalizeAllowedCodeCommand(r, ["python", "tests/check_output.py"])).toEqual([
      "python",
      "tests/check_output.py",
    ]);
    expect(normalizeAllowedCodeCommand(r, ["python", "test_api.py"])).toEqual([
      "python",
      "test_api.py",
    ]);
  });

  it("refuses arbitrary scripts, missing files and unsafe arguments", () => {
    const r = root();
    expect(() => normalizeAllowedCodeCommand(r, ["python", "setup.py"])).toThrow();
    expect(() => normalizeAllowedCodeCommand(r, ["python", "tests/missing.py"])).toThrow();
    expect(() => normalizeAllowedCodeCommand(r, ["python", "-m", "unittest", "--foo"])).toThrow();
    expect(() =>
      normalizeAllowedCodeCommand(r, ["python", "-m", "unittest", "discover", "-s", "/etc"]),
    ).toThrow();
    expect(() => normalizeAllowedCodeCommand(r, ["python", "../test_x.py"])).toThrow();
  });

  it("counts them as test commands", () => {
    expect(isTestCommand("python -m unittest discover")).toBe(true);
    expect(isTestCommand("python tests/check_output.py")).toBe(true);
    expect(isTestCommand("python setup.py")).toBe(false);
  });
});
