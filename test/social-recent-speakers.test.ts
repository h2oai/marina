// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `SocialAwareness.recentSpeakers` eviction — the map must be bounded by the
 * speakers active inside the five-minute window, not by everyone ever heard.
 */

import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { RECENT_SPEAKERS_MAX, SocialAwareness } from "../src/agent/social";

const MINUTE = 60 * 1000;

function say(social: SocialAwareness, from: string): void {
  social.handlePerception({
    kind: "message",
    timestamp: Date.now(),
    data: { from, message: "hi" },
  });
}

describe("SocialAwareness recent-speaker eviction", () => {
  afterEach(() => setSystemTime());

  it("1,000 distinct stale speakers are swept on the next write", () => {
    const t0 = new Date("2026-09-23T12:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const social = new SocialAwareness();
    for (let i = 0; i < 1000; i++) say(social, `ghost-${i}`);
    // All still inside the window: nothing is evicted yet.
    expect(social.recentSpeakerCount()).toBe(1000);
    expect(social.getActiveSpeakers().length).toBe(1000);

    // Ten minutes later a single new speaker arrives.
    setSystemTime(new Date(t0 + 10 * MINUTE));
    say(social, "newcomer");
    expect(social.recentSpeakerCount()).toBeLessThanOrEqual(RECENT_SPEAKERS_MAX);
    expect(social.recentSpeakerCount()).toBe(1);
    expect(social.getActiveSpeakers()).toEqual(["newcomer"]);
  });

  it("an active speaker survives the sweep; stale ones do not", () => {
    const t0 = new Date("2026-09-23T12:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const social = new SocialAwareness();
    for (let i = 0; i < 500; i++) say(social, `ghost-${i}`);

    setSystemTime(new Date(t0 + 4 * MINUTE));
    say(social, "alice"); // spoke 4 min after the ghosts

    setSystemTime(new Date(t0 + 7 * MINUTE)); // ghosts are 7 min old, alice 3 min
    say(social, "bob");
    const active = social.getActiveSpeakers().sort();
    expect(active).toEqual(["alice", "bob"]);
    expect(social.recentSpeakerCount()).toBe(2);
    // Relationship counts are untouched by speaker eviction.
    expect(social.getInteractionCount("ghost-0")).toBe(1);
  });

  it("below the cap, stale speakers are swept periodically rather than on every write", () => {
    const t0 = new Date("2026-09-23T12:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const social = new SocialAwareness();
    for (let i = 0; i < 10; i++) say(social, `early-${i}`);

    setSystemTime(new Date(t0 + 6 * MINUTE));
    // Within a sweep interval the stale entries may linger, but they never
    // count as active — getActiveSpeakers semantics are unchanged.
    say(social, "late");
    expect(social.getActiveSpeakers()).toEqual(["late"]);
    // Enough writes to cross the periodic sweep: stale entries are gone.
    for (let i = 0; i < 70; i++) say(social, "late");
    expect(social.recentSpeakerCount()).toBe(1);
    expect(social.getActiveSpeakers()).toEqual(["late"]);
  });

  it("broadcast speakers are tracked and evicted the same way", () => {
    const t0 = new Date("2026-09-23T12:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const social = new SocialAwareness();
    for (let i = 0; i < 300; i++) {
      social.handlePerception({
        kind: "broadcast",
        timestamp: Date.now(),
        data: { from: `crier-${i}`, message: "hear ye" },
      });
    }
    setSystemTime(new Date(t0 + 6 * MINUTE));
    say(social, "solo");
    expect(social.recentSpeakerCount()).toBe(1);
    expect(social.getActiveSpeakers()).toEqual(["solo"]);
  });

  it("reset clears the tracked speakers", () => {
    const social = new SocialAwareness();
    say(social, "x");
    social.reset();
    expect(social.recentSpeakerCount()).toBe(0);
    expect(social.getActiveSpeakers()).toEqual([]);
  });
});
