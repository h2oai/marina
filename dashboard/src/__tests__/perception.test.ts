// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseSpeech, speakerName } from "../lib/perception";

describe("parseSpeech", () => {
  it("returns null for empty/blank input", () => {
    expect(parseSpeech(undefined, "say")).toBeNull();
    expect(parseSpeech("   ", "say")).toBeNull();
  });

  it("parses self vs other for say", () => {
    expect(parseSpeech("You say: hello", "say")).toEqual({
      speaker: "You",
      body: "hello",
      perspective: "self",
    });
    expect(parseSpeech("Alice says: hi there", "say")).toEqual({
      speaker: "Alice",
      body: "hi there",
      perspective: "other",
    });
  });

  it("parses inbound and outbound tells", () => {
    expect(parseSpeech("> Bob tells you: psst", "tell")).toEqual({
      speaker: "Bob",
      body: "psst",
      perspective: "other",
    });
    expect(parseSpeech("> You tell Bob: ok", "tell")).toEqual({
      speaker: "Bob",
      body: "ok",
      perspective: "self",
    });
  });

  it("parses shouts with a tone", () => {
    expect(parseSpeech("Cara shouts: over here", "shout")).toMatchObject({
      speaker: "Cara",
      perspective: "other",
      tone: "shout",
    });
    expect(parseSpeech("You shout: HELLO", "shout")).toMatchObject({
      speaker: "You",
      perspective: "self",
      tone: "shout",
    });
  });

  it("parses emote as speaker-less body", () => {
    expect(parseSpeech("* Alice waves", "emote")).toEqual({
      body: "Alice waves",
      perspective: "other",
      tone: "emote",
    });
  });

  it("uses structured channel data when present", () => {
    const meta = parseSpeech("ignored fallback", undefined, {
      kind: "message",
      data: { channel: "ops", senderName: "Dana", content: "deploy done" },
    });
    expect(meta).toEqual({
      speaker: "Dana",
      body: "deploy done",
      perspective: "other",
      channel: "ops",
    });
  });

  it("flags self perspective for channel messages from You", () => {
    const meta = parseSpeech("x", undefined, {
      kind: "message",
      data: { channel: "ops", senderName: "You", content: "hi" },
    });
    expect(meta?.perspective).toBe("self");
  });

  it("marks broadcast perceptions", () => {
    expect(parseSpeech("server restarting", undefined, { kind: "broadcast" })).toMatchObject({
      tone: "broadcast",
      perspective: "other",
    });
  });

  it("falls back to a plain other-body for unrecognized text", () => {
    expect(parseSpeech("some narration", "system")).toEqual({
      body: "some narration",
      perspective: "other",
    });
  });
});

describe("speakerName", () => {
  it("resolves say/tell/shout speakers", () => {
    expect(speakerName("You say: hi", "say")).toBe("You");
    expect(speakerName("Alice says: hi", "say")).toBe("Alice");
    expect(speakerName("> Bob tells you: yo", "tell")).toBe("Bob");
    expect(speakerName("> You tell Bob: yo", "tell")).toBe("You");
    expect(speakerName("Cara shouts: hey", "shout")).toBe("Cara");
  });

  it("attributes emotes to the first token", () => {
    expect(speakerName("* Alice waves", "emote")).toBe("Alice");
  });

  it("handles synthetic say-self and broadcast tags", () => {
    expect(speakerName("anything", "say-self")).toBe("You");
    expect(speakerName("anything", "broadcast")).toBe("System");
  });

  it("returns null for non-dialogue tags so they aren't counted", () => {
    expect(speakerName("a room description", "room")).toBeNull();
    expect(speakerName("command output", undefined)).toBeNull();
  });
});
