// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Four parsers used to carry their own duration grammar; they now go through
// `parseDuration`. Each old grammar is frozen below as a reference: every input
// it accepted must still give the identical result. Inputs it rejected may now
// parse (the shared grammar is a superset: `mo`, long spellings, inner space).

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { parseDuration } from "../src/engine/commands/format-duration";
import { parseRetentionValue } from "../src/engine/retention";
import { parseSince } from "../src/net/api/asset-library-view";
import { parseCadence } from "../src/resolvers/cadence";
import { parseRetirement } from "../src/resolvers/watch-spec";
import { propertyOptions } from "./property-options";

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

function oldRetention(raw: string) {
  const value = raw.trim().toLowerCase();
  if (value === "0" || value === "off" || value === "never") return { disabled: true };
  const match = /^(\d+)([smhdw])?$/.exec(value);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  const unit = match[2];
  if (!unit) return { keepRows: n };
  return { keepMs: n * UNITS[unit]! };
}

function oldCadence(raw: string) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || /[-_]/.test(trimmed)) return "err";
  if (trimmed === "once") return { kind: "once" };
  const m = trimmed.match(/^(\d+)\s*([smhdw])$/);
  if (!m) return "err";
  const n = Number.parseInt(m[1]!, 10);
  if (n <= 0) return "err";
  return { kind: "interval", ms: n * UNITS[m[2]!]! };
}

function oldRetirement(raw: string) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return { kind: "resolved" };
  if (/[-_]/.test(trimmed)) return "err";
  if (trimmed === "resolved") return { kind: "resolved" };
  if (trimmed === "forever") return { kind: "forever" };
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return n <= 0 ? "err" : { kind: "samples", n };
  }
  const m = trimmed.match(/^(\d+)([smhdw])$/);
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    return n <= 0 ? "err" : { kind: "duration", ms: n * UNITS[m[2]!]! };
  }
  return "err";
}

const NOW = 1_800_000_000_000;
function oldSince(raw: string) {
  const window = /^(\d+)([mhdw])$/i.exec(raw.trim());
  if (window) return NOW - Number(window[1]) * UNITS[window[2]!.toLowerCase()]!;
  if (/^\d{10,}$/.test(raw.trim())) return Number(raw.trim());
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : undefined;
}

const INPUTS = [
  "0",
  "00",
  "1",
  "42",
  "off",
  "never",
  "once",
  "resolved",
  "forever",
  "0s",
  "0m",
  "0d",
  "1s",
  "45s",
  "5m",
  "90m",
  "12h",
  "1d",
  "30d",
  "2w",
  "30D",
  "12H",
  " 7d ",
  "5 m",
  "1 h",
  "007h",
  "9007199254740991s",
  "99999999999999999999d",
  "1mo",
  "1y",
  "500ms",
  "1.5h",
  "-1h",
  "1_h",
  "h",
  "every 1h",
  "1h30m",
  "1700000000000",
  "2026-10-01",
  "2026-10-01T12:00:00Z",
  "",
];

function cadenceOf(raw: string) {
  const r = parseCadence(raw);
  return r.ok ? r.cadence : "err";
}

function retirementOf(raw: string) {
  const r = parseRetirement(raw);
  return r.ok ? r.rule : "err";
}

describe("duration parsers route through parseDuration without changing old results", () => {
  test("retention overrides", () => {
    for (const raw of INPUTS) {
      const old = oldRetention(raw);
      if (old !== undefined) expect<unknown>([raw, parseRetentionValue(raw)]).toEqual([raw, old]);
    }
  });

  test("watch cadence", () => {
    for (const raw of INPUTS) {
      const old = oldCadence(raw);
      if (old !== "err") expect<unknown>([raw, cadenceOf(raw)]).toEqual([raw, old]);
    }
  });

  test("watch retirement", () => {
    for (const raw of INPUTS) {
      const old = oldRetirement(raw);
      if (old !== "err") expect<unknown>([raw, retirementOf(raw)]).toEqual([raw, old]);
    }
  });

  test("asset library since", () => {
    for (const raw of INPUTS) {
      const old = oldSince(raw);
      if (old !== undefined) expect<unknown>([raw, parseSince(raw, NOW)]).toEqual([raw, old]);
    }
  });

  test("still rejected: zero, fractions, ms, negatives, compound, junk", () => {
    for (const raw of ["0d", "1.5h", "500ms", "-1h", "1h30m", "1y", "h"]) {
      expect(parseRetentionValue(raw)).toBeUndefined();
      expect(cadenceOf(raw)).toBe("err");
      expect(retirementOf(raw)).toBe("err");
    }
    expect(cadenceOf("every 1h")).toBe("err");
  });

  test("newly accepted: the shared grammar's months and long spellings", () => {
    expect(parseRetentionValue("1mo")).toEqual({ keepMs: 30 * UNITS.d! });
    expect(cadenceOf("2hours")).toEqual({ kind: "interval", ms: 2 * UNITS.h! });
    expect(retirementOf("1 week")).toEqual({ kind: "duration", ms: UNITS.w! });
    expect(parseSince("30s", NOW)).toBe(NOW - 30 * UNITS.s!);
  });
});

// `project budget duration` had its own grammar: decimals and `ms`, units
// ms|s|m|h only, case-insensitive. Frozen here as the reference oracle.
function oldProjectDuration(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw.toLowerCase());
  if (!match) return undefined;
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]!]!;
  return Number(match[1]) * scale;
}

// parseDuration before the allowDecimal/allowMs options, frozen: the defaults
// every other caller relies on must not move.
const OLD_UNITS: Record<string, number> = { ...UNITS, mo: 30 * 86_400_000 };
const OLD_ALIASES: Record<string, string> = {
  sec: "s",
  secs: "s",
  second: "s",
  seconds: "s",
  min: "m",
  mins: "m",
  minute: "m",
  minutes: "m",
  hr: "h",
  hrs: "h",
  hour: "h",
  hours: "h",
  day: "d",
  days: "d",
  wk: "w",
  wks: "w",
  week: "w",
  weeks: "w",
  month: "mo",
  months: "mo",
};
const OLD_RANK: Record<string, number> = { s: 0, m: 1, h: 2, d: 3, w: 4, mo: 5 };
function oldDefaultDuration(arg: string, opts: { minUnit?: string }): number | undefined {
  if (!arg) return undefined;
  const m = arg.match(/^(\d+)\s*([a-z]+)$/i);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  const spelled = m[2]!.toLowerCase();
  const unit = OLD_UNITS[spelled] !== undefined ? spelled : OLD_ALIASES[spelled];
  if (!unit) return undefined;
  if (opts.minUnit && OLD_RANK[unit]! < OLD_RANK[opts.minUnit]!) return undefined;
  return n * OLD_UNITS[unit]!;
}

const PROJECT = { allowDecimal: true, allowMs: true } as const;

const PROJECT_INPUTS = [
  ...INPUTS,
  "250ms",
  "250MS",
  "0.5ms",
  "1.5h",
  "1.5H",
  "0.25s",
  "2.75m",
  "0.0001ms",
  "007.50s",
  "1.h",
  ".5h",
  "1..5h",
  "1.5.5h",
  "1e3ms",
  "1,5h",
  "0x10s",
  "Infinityh",
  "NaNs",
  "1.5",
  "ms",
  "1msec",
];

describe("project budget durations go through parseDuration", () => {
  test("every input the old project parser accepted gives the identical result", () => {
    for (const raw of PROJECT_INPUTS) {
      const old = oldProjectDuration(raw);
      if (old !== undefined)
        expect<unknown>([raw, parseDuration(raw, PROJECT)]).toEqual([raw, old]);
    }
  });

  test("property: the old grammar's inputs agree", () => {
    const unit = fc.constantFrom("ms", "s", "m", "h", "MS", "Ms", "mS", "S", "M", "H");
    const decimal = fc.option(fc.stringMatching(/^[0-9]{1,6}$/), { nil: undefined });
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{1,9}$/), decimal, unit, (whole, frac, u) => {
        const raw = `${whole}${frac === undefined ? "" : `.${frac}`}${u}`;
        const old = oldProjectDuration(raw);
        expect(old).not.toBeUndefined();
        expect(parseDuration(raw, PROJECT)).toBe(old!);
      }),
      propertyOptions(200),
    );
  });

  test("property: on arbitrary tokens, old acceptance implies the same result", () => {
    const token = fc.stringMatching(/^[0-9.msMShHdwo x-]{0,8}$/);
    fc.assert(
      fc.property(token, (raw) => {
        const old = oldProjectDuration(raw);
        if (old !== undefined) expect(parseDuration(raw, PROJECT)).toBe(old);
      }),
      propertyOptions(500),
    );
  });

  test("project-only forms stay rejected by default (and under minUnit)", () => {
    for (const raw of ["1.5h", "0.25s", "250ms", "0.5ms", "1ms", "1.0m"]) {
      expect(parseDuration(raw)).toBeUndefined();
      expect(parseDuration(raw, { minUnit: "s" })).toBeUndefined();
    }
    expect(parseDuration("250ms", { allowDecimal: true })).toBeUndefined();
    expect(parseDuration("1.5h", { allowMs: true })).toBeUndefined();
    expect(parseDuration("250ms", { allowMs: true, minUnit: "s" })).toBeUndefined();
    expect(parseDuration("1.5h", { allowDecimal: true, minUnit: "h" })).toBe(5_400_000);
  });

  test("property: default parseDuration matches its pre-option behaviour", () => {
    const token = fc.oneof(
      fc.stringMatching(/^[0-9.msMShHdwoinrecu x-]{0,10}$/),
      fc.constantFrom(...INPUTS, "5min", "2hours", "1month", "3 weeks", "1.5h", "250ms"),
    );
    const minUnit = fc.constantFrom(undefined, "s", "m", "h", "d" as const);
    fc.assert(
      fc.property(token, minUnit, (raw, min) => {
        const opts = min === undefined ? {} : { minUnit: min };
        expect(parseDuration(raw, opts)).toBe(oldDefaultDuration(raw, opts));
      }),
      propertyOptions(500),
    );
  });

  test("newly accepted for project budgets: the shared grammar's units and spellings", () => {
    expect(parseDuration("1d", PROJECT)).toBe(UNITS.d!);
    expect(parseDuration("1.5days", PROJECT)).toBe(1.5 * UNITS.d!);
    expect(parseDuration("2 hours", PROJECT)).toBe(2 * UNITS.h!);
  });
});
