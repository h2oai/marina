import { describe, expect, test } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import { SPIKE_DECAY_DEFAULTS, spikeDecay } from "../src/arena/spike-decay";

const weeks = (values: number[]) =>
  values.map((value, i) => ({
    date: new Date(Date.UTC(2026, 6, 4) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

describe("spike decay", () => {
  test("moves only the spiking cell part of the way toward its recent level and renormalises", () => {
    const history = {
      a: weeks([40, 41, 40, 39, 40, 41, 40, 40, 55]), // event week
      b: weeks([30, 29, 30, 31, 30, 30, 29, 30, 22]),
      c: weeks([30, 30, 30, 30, 30, 29, 31, 30, 23]),
    };
    const start = { a: { mean: 55, sd: 2 }, b: { mean: 22, sd: 1.5 }, c: { mean: 23, sd: 1.5 } };
    const { profile, decayed } = spikeDecay(start, history);
    expect(Object.keys(decayed).sort()).toEqual(["a", "b", "c"]);
    expect(decayed.a!.toward).toBe(40);
    expect(decayed.a!.mean).toBeCloseTo(47.5, 6);
    const total = Object.values(profile).reduce((s, d) => s + d.mean, 0);
    expect(total).toBeCloseTo(100, 2);
    expect(profile.a!.sd).toBe(2);
    expect(profile.a!.mean).toBeLessThan(55);
  });

  test("an ordinary week is unchanged (no spike, shares already sum to 100)", () => {
    const history = {
      a: weeks([40, 42, 39, 41, 40, 43, 40, 41, 42]),
      b: weeks([30, 29, 31, 30, 30, 28, 30, 30, 29]),
      c: weeks([30, 29, 30, 29, 30, 29, 30, 29, 29]),
    };
    const start = { a: { mean: 42, sd: 2 }, b: { mean: 29, sd: 1.5 }, c: { mean: 29, sd: 1.5 } };
    const { profile, decayed } = spikeDecay(start, history);
    expect(decayed).toEqual({});
    expect(profile.a!.mean).toBeCloseTo(42, 3);
    expect(profile.b!.mean).toBeCloseTo(29, 3);
  });

  test("a cell with too little history keeps its start mean", () => {
    const start = { a: { mean: 60, sd: 2 }, b: { mean: 40, sd: 2 } };
    const { decayed } = spikeDecay(start, { a: weeks([40, 60]), b: weeks([60, 40]) });
    expect(decayed).toEqual({});
  });

  test("rejects invalid options", () => {
    expect(() =>
      spikeDecay({ a: { mean: 1, sd: 1 } }, {}, { ...SPIKE_DECAY_DEFAULTS, lambda: 2 }),
    ).toThrow();
  });

  test("is a valid forecaster spec, so earned routes can consider it as a challenger", () => {
    expect(parseForecasterSpec("spike-decay")).toBe("spike-decay");
    expect(parseForecasterSpec("route:google_trends=spike-decay;*=nowcast")).toBe(
      "route:google_trends=spike-decay;*=nowcast",
    );
  });
});
