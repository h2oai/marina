// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * The `~meanonly` formation variant: the members' mean, the start's sd. It
 * parses as a forecaster spec, keeps its own method key (so the spread
 * calibrator learns it apart from the plain formation), replaces every sd the
 * formation set with the start's, records what it replaced, and leaves a
 * forecast with nothing to replace alone.
 */
import { describe, expect, it } from "bun:test";
import { methodOf } from "../src/arena/calibration";
import { parseForecasterSpec } from "../src/arena/config";
import type { RoundForecast } from "../src/arena/forecast";
import { meanOnlyForecast } from "../src/arena/formations";

describe("~meanonly formation variant", () => {
  it("parses as a forecaster spec and keeps its own method key", () => {
    const spec = "formation:delphi~meanonly:openrouter/a/b,openrouter/c/d";
    expect(parseForecasterSpec(spec)).toBe(spec);
    expect(parseForecasterSpec(`${spec}+research@search:tavily`)).toBe(
      `${spec}+research@search:tavily`,
    );
    expect(parseForecasterSpec("formation:ensemble:a/b+then:delphi~meanonly:c/d")).toBe(
      "formation:ensemble:a/b+then:delphi~meanonly:c/d",
    );
    expect(() => parseForecasterSpec("formation:delphi~loose:openrouter/a/b")).toThrow();
    expect(methodOf(`route civiqs → ${spec}+research@search:tavily; x`)).toBe(
      "formation:delphi~meanonly+research",
    );
    expect(methodOf(`route civiqs → ${spec}; x`)).toBe("formation:delphi~meanonly");
  });

  it("files the members' mean with the start's sd, scalar and profile, and records it", () => {
    const start: RoundForecast = {
      rules: {},
      note: "start",
      topline: { mean: 40, sd: 1.2 },
      profile: { a: { mean: 10, sd: 0.9 }, b: { mean: 30, sd: 1.5 } },
    };
    const f: RoundForecast = {
      rules: {},
      note: "route x → formation:delphi~meanonly:m; marina delphi formation",
      topline: { mean: 42.5, sd: 2.4 },
      profile: { a: { mean: 12, sd: 2 }, b: { mean: 30, sd: 1.5 } },
    };
    const out = meanOnlyForecast(f, start);
    expect(out).toBe(f);
    expect(out.topline).toEqual({ mean: 42.5, sd: 1.2 });
    expect(out.profile).toEqual({ a: { mean: 12, sd: 0.9 }, b: { mean: 30, sd: 1.5 } });
    expect(out.meanOnly).toEqual({
      sdFrom: "start",
      replaced: { topline: { from: 2.4, to: 1.2 }, a: { from: 2, to: 0.9 } },
    });
    expect(out.note).toContain("sd from the start (mean-only variant)");
  });

  it("leaves a forecast with nothing to replace alone", () => {
    const ranking: RoundForecast = { rules: {}, note: "r", ranking: ["A", "B"] };
    const out = meanOnlyForecast(ranking, { rules: {}, note: "s", ranking: ["B", "A"] });
    expect(out.meanOnly).toBeUndefined();
    expect(out.note).toBe("r");
    const same: RoundForecast = { rules: {}, note: "n", topline: { mean: 41, sd: 1.2 } };
    meanOnlyForecast(same, { rules: {}, note: "s", topline: { mean: 40, sd: 1.2 } });
    expect(same.meanOnly).toBeUndefined();
    expect(same.note).toBe("n");
  });
});
