// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * A resumed agent's orientation turn: the adapter states what it already
 * restored (focus and loop preferences) so the turn does not re-read it, and
 * it starts from what is owed and its focus, not from looking around.
 */
import { describe, expect, it } from "bun:test";
import { defaultLoopPreferences, describeLoadedState } from "../src/agent/loop-preferences";
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

describe("an agent does not look around to start", () => {
  it("the first-turn prompt starts from what is in hand, not the surroundings or a brief", () => {
    const p = getLeanDiscoveryPrompt();
    expect(p).not.toMatch(/surroundings|world brief/);
    expect(p).toContain("answer what is owed");
    expect(p).toContain("You do not need to look around first");
  });
});
