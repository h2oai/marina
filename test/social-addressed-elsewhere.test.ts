// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A room post addressed by name to someone else never wakes a bystander: the
 * "a question in the room" heuristic in `shouldRespond` is random, so without
 * this rule an unaddressed agent answered other agents' questions by chance.
 */

import { describe, expect, it } from "bun:test";
import { RECENT_SPEAKERS_MAX, SocialAwareness, type SocialEvent } from "../src/agent/social";

function connect(social: SocialAwareness, name: string): void {
  social.handlePerception({
    kind: "system",
    timestamp: Date.now(),
    data: { type: "connect", entityName: name },
  });
}

const says = (message: string): SocialEvent => ({
  type: "player_says",
  speaker: "qop",
  message,
  timestamp: Date.now(),
});

describe("posts addressed to someone else", () => {
  const posts = [
    "Rowan, in one line, what is 12 plus 30?",
    "Setup is done. Rowan, in one line, what is 12 plus 30? And can you name the capital of France, Kestrel?",
    "@Kestrel what is the capital of France?",
    "Hey Rowan, are you there?",
  ];

  it("never wakes a bystander who saw the addressees connect", () => {
    const social = new SocialAwareness();
    connect(social, "Rowan");
    connect(social, "Kestrel");
    for (const post of posts)
      for (let i = 0; i < 50; i++) expect(social.shouldRespond(says(post), "Tidewell")).toBe(false);
  });

  it("still wakes the agent it names", () => {
    const social = new SocialAwareness();
    connect(social, "Tidewell");
    expect(social.shouldRespond(says("Tidewell, what is 2 plus 2?"), "Tidewell")).toBe(true);
    expect(
      social.shouldRespond(says("Rowan, check this. Tidewell, what is 2 plus 2?"), "Tidewell"),
    ).toBe(true);
  });

  it("knows names from the room, recent speakers and connects; a disconnect forgets the connect", () => {
    const social = new SocialAwareness();
    social.updateEntitiesInRoom([{ name: "Iris" }]);
    social.handlePerception({
      kind: "message",
      timestamp: Date.now(),
      data: { from: "Lark", message: "hello" },
    });
    connect(social, "Cedar");
    expect(social.addressesSomeoneElse("Iris, ready?", "Tidewell")).toBe(true);
    expect(social.addressesSomeoneElse("Lark, ready?", "Tidewell")).toBe(true);
    expect(social.addressesSomeoneElse("Cedar, ready?", "Tidewell")).toBe(true);
    expect(social.addressesSomeoneElse("Anyone ready?", "Tidewell")).toBe(false);
    social.handlePerception({
      kind: "system",
      timestamp: Date.now(),
      data: { type: "disconnect", entityName: "Cedar" },
    });
    expect(social.addressesSomeoneElse("Cedar, ready?", "Tidewell")).toBe(false);
  });

  it("keeps the connect set bounded", () => {
    const social = new SocialAwareness();
    for (let i = 0; i < RECENT_SPEAKERS_MAX + 50; i++) connect(social, `ghost${i}`);
    expect(social.addressesSomeoneElse("ghost0, ready?", "me")).toBe(false);
    expect(social.addressesSomeoneElse(`ghost${RECENT_SPEAKERS_MAX + 49}, ready?`, "me")).toBe(
      true,
    );
  });
});
