// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ledgerFromHarnessResult } from "../src/engine/benchmark-ledger";
import { featureEnvSnapshot, isFeatureEnvName, parseServerEnv } from "../src/engine/feature-env";

describe("feature env snapshot", () => {
  it("keeps behavior switches only, sorted, never credentials or endpoints", () => {
    expect(
      featureEnvSnapshot({
        MARINA_OBLIGATIONS_REVIEW: "auto",
        MARINA_DECISIONS: "jev",
        MARINA_DECISION_API_KEY: "secret",
        MARINA_DECISION_BASE_URL: "https://x",
        MARINA_LESSONS: " on ",
        MARINA_WORLD: "empty",
        OPENROUTER_API_KEY: "secret",
        MARINA_ARGCHECK: "",
      }),
    ).toEqual({ MARINA_DECISIONS: "jev", MARINA_LESSONS: "on", MARINA_OBLIGATIONS_REVIEW: "auto" });
    expect(isFeatureEnvName("MARINA_FORECAST_JUDGE")).toBe(true);
    expect(isFeatureEnvName("MARINA_FORECAST_TOKEN")).toBe(false);
  });

  it("parses --server-env for feature variables only", () => {
    expect(parseServerEnv(["MARINA_OBLIGATIONS_CONSENT=on", "MARINA_ARGCHECK=observe"])).toEqual({
      MARINA_OBLIGATIONS_CONSENT: "on",
      MARINA_ARGCHECK: "observe",
    });
    expect(() => parseServerEnv(["MARINA_DECISION_API_KEY=x"])).toThrow("feature settings only");
    expect(() => parseServerEnv(["OPENAI_API_KEY=x"])).toThrow("feature settings only");
    expect(() => parseServerEnv(["MARINA_LESSONS"])).toThrow("KEY=VALUE");
  });

  it("filed server features make a different configuration in the ledger", () => {
    const file = (features?: Record<string, string>) => ({
      config: {
        dataset: "tau2-retail",
        model: "m",
        ...(features ? { server_features: features } : {}),
      },
      items: [{ id: "a", correct: true }],
    });
    const hash = (features?: Record<string, string>) =>
      ledgerFromHarnessResult(file(features) as never, {
        targetKind: "model",
        target: "m",
        raw: "",
        id: "r",
        now: 0,
      }).run.config_hash;
    expect(hash({ MARINA_OBLIGATIONS_REVIEW: "auto" })).not.toBe(hash());
    expect(hash({ MARINA_OBLIGATIONS_REVIEW: "auto" })).toBe(
      hash({ MARINA_OBLIGATIONS_REVIEW: "auto" }),
    );
  });
});
