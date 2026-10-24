import { describe, expect, test } from "bun:test";
import {
  fitLeadBeta,
  type LeadCase,
  leadNowcast,
  leadWalkForward,
} from "../src/quant/lead-nowcast";

/** Deterministic pseudo-noise in [-1, 1). */
function noise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return (s / 2147483648) * 2 - 1;
  };
}

function cases(n: number, beta: number, noiseSize: number, seed = 1): LeadCase[] {
  const r = noise(seed);
  return Array.from({ length: n }, () => {
    const x = 2 * r();
    return { x: [x], y: beta * x + noiseSize * r() };
  });
}

describe("lead nowcast", () => {
  test("fitLeadBeta recovers the coefficient with a weak prior and shrinks with a strong one", () => {
    const cs = cases(200, 0.5, 0.05);
    expect(fitLeadBeta(cs, 0)[0]!).toBeCloseTo(0.5, 1);
    const weak = fitLeadBeta(cs, 1)[0]!;
    const strong = fitLeadBeta(cs, 200)[0]!;
    expect(strong).toBeLessThan(weak);
    expect(strong).toBeGreaterThan(0);
  });

  test("two indicators are fitted jointly", () => {
    const r = noise(3);
    const cs: LeadCase[] = Array.from({ length: 300 }, () => {
      const a = r();
      const b = r();
      return { x: [a, b], y: 0.8 * a - 0.3 * b + 0.01 * r() };
    });
    const [ba, bb] = fitLeadBeta(cs, 0);
    expect(ba!).toBeCloseTo(0.8, 1);
    expect(bb!).toBeCloseTo(-0.3, 1);
  });

  test("applies a real lead and reports the walk-forward spread", () => {
    const cs = cases(40, 0.6, 0.1);
    const n = leadNowcast(10, [1], cs);
    expect(n.applied).toBe(true);
    expect(n.mean).toBeCloseTo(10 + n.move, 9);
    expect(n.move).toBeGreaterThan(0.3);
    expect(n.leadRms!).toBeLessThan(n.persistenceRms!);
    expect(n.sd).toBe(n.leadRms);
  });

  test("keeps persistence when the indicator does not lead", () => {
    const r = noise(9);
    const cs: LeadCase[] = Array.from({ length: 40 }, () => ({ x: [r()], y: r() }));
    const n = leadNowcast(10, [1], cs);
    expect(n.applied).toBe(false);
    expect(n.mean).toBe(10);
    expect(n.sd).toBe(n.persistenceRms);
  });

  test("too few cases to judge ⇒ persistence", () => {
    const n = leadNowcast(5, [2], cases(4, 1, 0));
    expect(n.applied).toBe(false);
    expect(n.mean).toBe(5);
  });

  test("a non-finite reading today ⇒ persistence", () => {
    const n = leadNowcast(5, [Number.NaN], cases(40, 1, 0.1));
    expect(n.applied).toBe(false);
    expect(n.mean).toBe(5);
  });

  test("walk-forward errors use only earlier cases", () => {
    const cs = cases(20, 0.5, 0.2);
    const before = leadWalkForward(cs).lead;
    const changed = [...cs.slice(0, 19), { x: [100], y: -100 }];
    const after = leadWalkForward(changed).lead;
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
  });
});
