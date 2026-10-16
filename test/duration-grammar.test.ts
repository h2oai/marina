// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Four parsers used to carry their own duration grammar; they now go through
// `parseDuration`. Each old grammar is frozen below as a reference: every input
// it accepted must still give the identical result. Inputs it rejected may now
// parse (the shared grammar is a superset: `mo`, long spellings, inner space).

import { describe, expect, test } from "bun:test";
import { parseRetentionValue } from "../src/engine/retention";
import { parseSince } from "../src/net/api/asset-library-view";
import { parseCadence } from "../src/resolvers/cadence";
import { parseRetirement } from "../src/resolvers/watch-spec";

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
