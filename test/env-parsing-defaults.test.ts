// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Invalid env values fall back to their defaults instead of misbehaving. */

import { describe, expect, it } from "bun:test";
import { parseStandingHalfLifeDays } from "../src/agent/standing";
import { parseLogLevel } from "../src/engine/logger";
import { HOT_RELOADABLE_VARS } from "../src/net/dashboard-api/keys";

describe("LOG_LEVEL", () => {
  it("accepts the four levels case-insensitively; anything else is info (flagged)", () => {
    expect(parseLogLevel(undefined)).toEqual({ level: "info", invalid: false });
    expect(parseLogLevel("DEBUG")).toEqual({ level: "debug", invalid: false });
    expect(parseLogLevel(" warn ")).toEqual({ level: "warn", invalid: false });
    expect(parseLogLevel("verbose")).toEqual({ level: "info", invalid: true });
  });
});

describe("STANDING_HALF_LIFE_DAYS", () => {
  it("non-numeric ⇒ 60, never NaN; floor at 1", () => {
    expect(parseStandingHalfLifeDays(undefined)).toBe(60);
    expect(parseStandingHalfLifeDays("sixty")).toBe(60);
    expect(parseStandingHalfLifeDays("30")).toBe(30);
    expect(parseStandingHalfLifeDays("0.2")).toBe(1);
  });
});

describe("HOT_RELOADABLE_VARS", () => {
  it("lists only variables read at call time", () => {
    for (const bootOnly of [
      "START_ROOM",
      "TAVILY_API_KEY",
      "SEARXNG_URL",
      "AGENT_AUTORESPAWN",
      "MAX_AGENTS",
      "MAX_AGENT_UPTIME_MS",
    ]) {
      expect(HOT_RELOADABLE_VARS.has(bootOnly)).toBe(false);
    }
    expect(HOT_RELOADABLE_VARS.has("OPENROUTER_API_KEY")).toBe(true);
    expect(HOT_RELOADABLE_VARS.has("MODEL_API_KEYS")).toBe(true);
  });
});
