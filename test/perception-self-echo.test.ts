// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Self-echo perceptions stay out of `[World Events]`. The world answers every
 * command with a `message` perception back to the same agent; the continuity
 * journal's own `memory api` acknowledgements and `You tell …` receipts made
 * up most of the buffer and drove the event-level re-queue on ~9 of 10
 * continuation prompts. Messages from other entities are never filtered.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { isSelfEchoPerception, LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { perceiveSelfEcho } from "../src/engine/constants";
import type { Perception } from "../src/types";

type Internals = {
  autonomousMode: boolean;
  client: { emit(event: "perception", p: Perception): void };
  agent: { _state: { isStreaming: boolean } };
  pendingPerceptions: Array<{ id?: number; text: string; priority: number }>;
  selfEchoesDropped: number;
  buildContinuationPrompt(): Promise<string>;
};

function makeAdapter(name: string) {
  const adapter = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null);
  const i = adapter as unknown as Internals;
  i.autonomousMode = true;
  i.agent._state.isStreaming = false;
  return { adapter, i };
}

/** The reply the `memory api {"operation":"capture",…}` journal write gets back. */
function memoryServiceAck(seq: number): Perception {
  return {
    kind: "message",
    timestamp: Date.now(),
    data: {
      text: `Captured source src_${seq} (v1)`,
      memory_service: {
        ok: true,
        request_id: `req-${seq}`,
        result: { id: `src_${seq}`, version: 1, seq },
      },
    },
  };
}

/** A `note …` reply — the legacy memory command payload. */
function legacyMemoryReply(): Perception {
  return {
    kind: "message",
    timestamp: Date.now(),
    data: {
      text: "Note #42 created (fact, importance=5)",
      memory: { schema: "marina.memory.command.v1", operation: "note", success: true },
    },
  };
}

/** A direct tell from someone else — `player_tells` scores 100. */
function tellFromOther(target: string, message: string): Perception {
  return {
    kind: "message",
    timestamp: Date.now(),
    data: { from: "Boss", to: target, message },
  };
}

describe("isSelfEchoPerception", () => {
  it("recognises memory-service acknowledgements and legacy memory payloads", () => {
    expect(isSelfEchoPerception(memoryServiceAck(1), "Captured source src_1 (v1)")).toBe(true);
    expect(isSelfEchoPerception(legacyMemoryReply(), "Note #42 created")).toBe(true);
  });

  it("recognises the agent's own send receipts, ANSI colour included", () => {
    const coloured = "\x1b[35m>\x1b[0m You tell \x1b[36mBob\x1b[0m: on my way [delivered #7]";
    const p: Perception = { kind: "message", timestamp: 0, data: { text: coloured } };
    expect(isSelfEchoPerception(p, coloured)).toBe(true);
    expect(
      isSelfEchoPerception(
        { kind: "message", timestamp: 0, data: { text: "\x1b[2mYou say:\x1b[0m hello" } },
        "\x1b[2mYou say:\x1b[0m hello",
      ),
    ).toBe(true);
    expect(
      isSelfEchoPerception(
        {
          kind: "message",
          timestamp: 0,
          data: { text: "Duplicate suppressed; existing message #3 is pending." },
        },
        "Duplicate suppressed; existing message #3 is pending.",
      ),
    ).toBe(true);
  });

  it("keeps everything addressed to the agent by others", () => {
    const fromOther = "\x1b[35m>\x1b[0m \x1b[36mBob\x1b[0m tells you: are you there?";
    expect(
      isSelfEchoPerception({ kind: "message", timestamp: 0, data: { text: fromOther } }, fromOther),
    ).toBe(false);
    expect(isSelfEchoPerception(tellFromOther("me", "hi"), "hi")).toBe(false);
    expect(
      isSelfEchoPerception(
        { kind: "broadcast", timestamp: 0, data: { message: "You tell everyone: fake" } },
        "You tell everyone: fake",
      ),
    ).toBe(false);
    // A room description that merely mentions memory is not a memory reply.
    expect(
      isSelfEchoPerception(
        { kind: "message", timestamp: 0, data: { text: "The archive hums with memory." } },
        "The archive hums with memory.",
      ),
    ).toBe(false);
  });
});

describe("perceiveSelfEcho env flag", () => {
  it("is off unless MARINA_PERCEIVE_SELF_ECHO is on/true/1", () => {
    expect(perceiveSelfEcho({})).toBe(false);
    expect(perceiveSelfEcho({ MARINA_PERCEIVE_SELF_ECHO: "off" })).toBe(false);
    expect(perceiveSelfEcho({ MARINA_PERCEIVE_SELF_ECHO: "on" })).toBe(true);
    expect(perceiveSelfEcho({ MARINA_PERCEIVE_SELF_ECHO: "TRUE" })).toBe(true);
    expect(perceiveSelfEcho({ MARINA_PERCEIVE_SELF_ECHO: "1" })).toBe(true);
  });
});

describe("LeanAgentAdapter perception buffer", () => {
  afterEach(() => {
    delete process.env.MARINA_PERCEIVE_SELF_ECHO;
  });

  it("a journaled memory api capture reply never reaches the next prompt; a tell from another does", async () => {
    const { i } = makeAdapter("echo-a");
    i.client.emit("perception", memoryServiceAck(1));
    i.client.emit("perception", legacyMemoryReply());
    expect(i.pendingPerceptions).toHaveLength(0);
    expect(i.selfEchoesDropped).toBe(2);

    i.client.emit("perception", tellFromOther("echo-a", "status please tag-OTHER-51c"));
    expect(i.pendingPerceptions).toHaveLength(1);

    const prompt = await i.buildContinuationPrompt();
    expect(prompt).toContain("tag-OTHER-51c");
    expect(prompt).not.toContain("Captured source");
    expect(prompt).not.toContain("Note #42");
  });

  it("a 10-perception cycle of self-echoes fires no re-queue marker", async () => {
    const { i } = makeAdapter("echo-b");
    for (let n = 0; n < 10; n++) i.client.emit("perception", memoryServiceAck(n));
    expect(i.pendingPerceptions).toHaveLength(0);
    const prompt = await i.buildContinuationPrompt();
    expect(prompt).not.toContain("lower-priority events deferred");
    expect(prompt).not.toContain("[World Events");
  });

  it("MARINA_PERCEIVE_SELF_ECHO=on restores the old behaviour", () => {
    process.env.MARINA_PERCEIVE_SELF_ECHO = "on";
    const { i } = makeAdapter("echo-c");
    i.client.emit("perception", memoryServiceAck(1));
    expect(i.pendingPerceptions).toHaveLength(1);
    expect(i.pendingPerceptions[0]!.text).toContain("Captured source src_1");
    expect(i.selfEchoesDropped).toBe(0);
  });
});
