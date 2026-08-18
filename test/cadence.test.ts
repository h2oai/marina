// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isDue, parseCadence, renderCadence } from "../src/resolvers/cadence";

describe("parseCadence", () => {
  it("parses bare durations: 30s, 5m, 1h, 7d, 1w", () => {
    function cad(input: string) {
      const r = parseCadence(input);
      if (!r.ok) throw new Error(`parseCadence(${input}) failed: ${r.error}`);
      return r.cadence;
    }
    expect(cad("30s")).toEqual({ kind: "interval", ms: 30_000 });
    expect(cad("5m")).toEqual({ kind: "interval", ms: 300_000 });
    expect(cad("1h")).toEqual({ kind: "interval", ms: 3_600_000 });
    expect(cad("7d")).toEqual({ kind: "interval", ms: 7 * 86_400_000 });
    expect(cad("1w")).toEqual({ kind: "interval", ms: 604_800_000 });
  });

  it("parses 'once' as a one-shot cadence", () => {
    const r = parseCadence("once");
    if (!r.ok) throw new Error(r.error);
    expect(r.cadence).toEqual({ kind: "once" });
  });

  it("is case-insensitive", () => {
    expect(parseCadence("ONCE").ok).toBe(true);
    expect(parseCadence("1H").ok).toBe(true);
  });

  it("rejects empty and missing input", () => {
    expect(parseCadence("").ok).toBe(false);
    expect(parseCadence(undefined).ok).toBe(false);
    expect(parseCadence("   ").ok).toBe(false);
  });

  it("rejects hyphens and underscores in user-facing input (voice-friendly)", () => {
    const r = parseCadence("every-1h");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/hyphens/i);
    expect(parseCadence("1_h").ok).toBe(false);
  });

  it("rejects unknown units", () => {
    expect(parseCadence("5y").ok).toBe(false);
    expect(parseCadence("3x").ok).toBe(false);
  });

  it("rejects zero or negative durations", () => {
    expect(parseCadence("0h").ok).toBe(false);
  });
});

describe("renderCadence (machine-only storage form)", () => {
  it("renders 'once' verbatim", () => {
    expect(renderCadence({ kind: "once" })).toBe("once");
  });

  it("picks the largest clean unit", () => {
    expect(renderCadence({ kind: "interval", ms: 3_600_000 })).toBe("every 1h");
    // 7d == 1w; renderCadence prefers the larger unit for readability.
    expect(renderCadence({ kind: "interval", ms: 7 * 86_400_000 })).toBe("every 1w");
    expect(renderCadence({ kind: "interval", ms: 3 * 86_400_000 })).toBe("every 3d");
    expect(renderCadence({ kind: "interval", ms: 60_000 })).toBe("every 1m");
    expect(renderCadence({ kind: "interval", ms: 30_000 })).toBe("every 30s");
  });
});

describe("isDue", () => {
  const cad1h = { kind: "interval", ms: 3_600_000 } as const;

  it("is due if no prior sample exists", () => {
    expect(isDue(cad1h, undefined)).toBe(true);
    expect(isDue({ kind: "once" }, undefined)).toBe(true);
  });

  it("interval: due iff (now - last) >= ms", () => {
    const now = 10_000_000;
    expect(isDue(cad1h, now - 3_600_001, now)).toBe(true);
    expect(isDue(cad1h, now - 1_800_000, now)).toBe(false);
    expect(isDue(cad1h, now - 3_600_000, now)).toBe(true); // boundary inclusive
  });

  it("once: never due once a sample exists", () => {
    expect(isDue({ kind: "once" }, 1, 2)).toBe(false);
    expect(isDue({ kind: "once" }, 0, 9_999_999_999)).toBe(false);
  });
});
