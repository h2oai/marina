// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type LogEntry, Logger, logRepeatLimit, RepeatLimiter } from "../src/engine/logger";

const entry = (
  message: string,
  timestamp: number,
  level: LogEntry["level"] = "warn",
): LogEntry => ({
  level,
  category: "lean-agent",
  message,
  timestamp,
});

describe("console repeat limit", () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  it("prints a repeated message up to the limit per minute, then one summary", () => {
    const limiter = new RepeatLimiter(3);
    const t = 1_000_000;
    // Numbers in a message do not make it a different message.
    const outcomes = [1, 2, 3, 4, 5].map((i) => limiter.admit(entry(`silent turn ${i}`, t + i)));
    expect(outcomes).toEqual([undefined, undefined, undefined, false, false]);
    // A different message has its own budget.
    expect(limiter.admit(entry("reply ledger full", t + 6))).toBeUndefined();
    // The next window opens with a summary of what was dropped.
    const summary = limiter.admit(entry("silent turn 9", t + 61_000));
    expect(summary).toMatchObject({ level: "warn", category: "lean-agent" });
    expect((summary as LogEntry).message).toContain("2 more like");
    expect(limiter.admit(entry("silent turn 10", t + 61_001))).toBeUndefined();
  });

  it("is off at 0 and reads MARINA_LOG_REPEAT_LIMIT", () => {
    const off = new RepeatLimiter(0);
    for (let i = 0; i < 50; i++) expect(off.admit(entry("x", i))).toBeUndefined();
    expect(logRepeatLimit({})).toBe(10);
    expect(logRepeatLimit({ MARINA_LOG_REPEAT_LIMIT: "off" })).toBe(0);
    expect(logRepeatLimit({ MARINA_LOG_REPEAT_LIMIT: "25" })).toBe(25);
    expect(logRepeatLimit({ MARINA_LOG_REPEAT_LIMIT: "junk" })).toBe(10);
  });

  it("limits only the console: sinks receive every entry", () => {
    const printed = spyOn(console, "log").mockImplementation(() => {});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    spies.push(printed, errors);
    const logger = new Logger({ level: "debug" });
    const seen: LogEntry[] = [];
    logger.addSink((e) => seen.push(e));
    for (let i = 0; i < 30; i++) logger.info("model-api", `obligations ${i}`);
    expect(seen).toHaveLength(30);
    expect(printed.mock.calls.length + errors.mock.calls.length).toBe(10);
  });
});
