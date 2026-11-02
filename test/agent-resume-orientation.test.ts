// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * A resumed agent's orientation turn: the adapter states what it already
 * restored (focus and loop preferences) so the turn does not re-read it, and
 * read-only orientation calls do not count against the per-run tool cap
 * (`isOrientationRead`, `ORIENTATION_FREE_READS`).
 */
import { describe, expect, it } from "bun:test";
import {
  defaultLoopPreferences,
  describeLoadedState,
  isOrientationRead,
  ORIENTATION_FREE_READS,
} from "../src/agent/loop-preferences";
import { getLeanDiscoveryPrompt } from "../src/agent/prompts/lean-system";

describe("describeLoadedState", () => {
  it("states the focus and every loop preference in one block", () => {
    const text = describeLoadedState(
      { ...defaultLoopPreferences(), rest: "waiting for the seed owner", channelSends: 2 },
      "review task 17",
    );
    expect(text).toContain("# ALREADY IN HAND");
    expect(text).toContain("focus: review task 17");
    expect(text).toContain("rest: waiting for the seed owner");
    expect(text).toContain("channel_sends: 2");
    expect(text).toContain("focus_persistent: false");
    expect(text).toContain("autonomy: default");
    expect(text).toContain("review: operator ceiling");
  });

  it("says so when nothing is set", () => {
    const text = describeLoadedState(defaultLoopPreferences(), null);
    expect(text).toContain("focus: none");
    expect(text).toContain("rest: not resting");
    expect(text).toContain("channel_sends: default");
  });

  it("the orientation prompt tells the agent not to re-read them", () => {
    expect(getLeanDiscoveryPrompt()).toContain("ALREADY IN HAND");
    expect(getLeanDiscoveryPrompt()).toContain("do not read them again");
  });
});

describe("isOrientationRead", () => {
  it("accepts read-only orientation commands and tools", () => {
    for (const command of [
      "look",
      "brief",
      "recall standby note",
      "task list",
      "task info 17",
      "tell inbox",
      "channel history general",
      "chronicle pending",
      "memory get focus",
      "memory kv get rest",
      "work",
    ])
      expect(isOrientationRead("marina_command", { command })).toBe(true);
    expect(isOrientationRead("marina_brief", {})).toBe(true);
    expect(isOrientationRead("marina_look", {})).toBe(true);
    expect(isOrientationRead("memory", { action: "get", key: "focus" })).toBe(true);
    expect(isOrientationRead("memory", { action: "recall", query: "x" })).toBe(true);
  });

  it("never exempts a write, a send or a spend", () => {
    for (const command of [
      "task claim 17",
      "memory set focus x",
      "memory delete rest",
      "tell Builder hi",
      "channel send general hello",
      "say hello",
      "forecast will it rain",
      "build code workbench/start",
      "lookup", // not `look`: the word boundary matters
    ])
      expect(isOrientationRead("marina_command", { command })).toBe(false);
    expect(isOrientationRead("memory", { action: "rest", content: "why" })).toBe(false);
    expect(isOrientationRead("memory", { action: "set", key: "focus" })).toBe(false);
    expect(isOrientationRead("marina_channel", { action: "send" })).toBe(false);
    expect(isOrientationRead("marina_command", {})).toBe(false);
  });

  it("the free-read allowance is bounded", () => {
    expect(ORIENTATION_FREE_READS).toBeGreaterThan(0);
    expect(ORIENTATION_FREE_READS).toBeLessThanOrEqual(8);
  });
});
