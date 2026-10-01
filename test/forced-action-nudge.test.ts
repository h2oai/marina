// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `MARINA_FORCED_ACTION_NUDGE`: `all` (default) keeps today's behaviour — any
 * addressed or high-priority event is owed and nudged; `requests` reserves the
 * reply ledger and the forced-action nudge for events that ask for something.
 */

import { describe, expect, it } from "bun:test";
import { forcedActionNudgeMode, LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import type { OutstandingRequests } from "../src/agent/outstanding-requests";
import type { Perception } from "../src/sdk/client";
import { scopeProcessState } from "./process-state";

type Internals = {
  client: { emit(event: "perception", p: Perception): void };
  platformMemory: { saveOutstandingRequests(batch: unknown[]): Promise<void> };
  autonomousMode: boolean;
  outstandingRequests: OutstandingRequests;
  pendingPerceptions: Array<{ text: string; shouldRespond?: boolean; owesReply?: boolean }>;
  silentTurns: number;
  buildContinuationPrompt(): Promise<string>;
};

function adapter(): Internals {
  const i = new LeanAgentAdapter(
    { name: "Nudged", model: "marina/default" },
    "ws://unused",
    null,
  ) as unknown as Internals;
  i.platformMemory.saveOutstandingRequests = async () => {};
  i.autonomousMode = true;
  return i;
}

function channelPost(message: string, id: string): Perception {
  return {
    kind: "message",
    timestamp: Date.now(),
    data: {
      from: "Lead",
      channel: "crew",
      message,
      text: `[crew] Lead: ${message}`,
      messageId: id,
    },
  };
}

describe("forcedActionNudgeMode", () => {
  it("defaults to all; only an explicit `requests` changes it", () => {
    expect(forcedActionNudgeMode({})).toBe("all");
    expect(forcedActionNudgeMode({ MARINA_FORCED_ACTION_NUDGE: "all" })).toBe("all");
    expect(forcedActionNudgeMode({ MARINA_FORCED_ACTION_NUDGE: "junk" })).toBe("all");
    expect(forcedActionNudgeMode({ MARINA_FORCED_ACTION_NUDGE: " Requests " })).toBe("requests");
  });
});

describe("forced-action nudge scope", () => {
  const info = "Nudged: shard 2 total is 4,113, merged into the board.";

  it("all (default): an addressed information post is owed and nudged", async () => {
    using _state = scopeProcessState({ env: { MARINA_FORCED_ACTION_NUDGE: undefined } });
    const i = adapter();
    i.client.emit("perception", channelPost(info, "c1"));
    expect(i.pendingPerceptions[0]?.shouldRespond).toBe(true);
    expect(i.outstandingRequests.size).toBe(1);
    i.silentTurns = 2;
    expect(await i.buildContinuationPrompt()).toContain("[ACTION REQUIRED]");
  });

  it("requests: an addressed information post wakes but is neither owed nor nudged", async () => {
    using _state = scopeProcessState({ env: { MARINA_FORCED_ACTION_NUDGE: "requests" } });
    const i = adapter();
    i.client.emit("perception", channelPost(info, "c2"));
    const [event] = i.pendingPerceptions;
    expect(event?.shouldRespond).toBe(true);
    expect(event?.owesReply).toBe(false);
    expect(i.outstandingRequests.size).toBe(0);
    i.silentTurns = 2;
    const prompt = await i.buildContinuationPrompt();
    expect(prompt).toContain("[!]");
    expect(prompt).not.toContain("[ACTION REQUIRED]");
    expect(prompt).not.toContain("No tool call was emitted");
  });

  it("requests: an addressed request is owed and nudged", async () => {
    using _state = scopeProcessState({ env: { MARINA_FORCED_ACTION_NUDGE: "requests" } });
    const i = adapter();
    i.client.emit("perception", channelPost("Nudged, what is the shard 2 total?", "c3"));
    expect(i.pendingPerceptions[0]?.owesReply).toBe(true);
    expect(i.outstandingRequests.size).toBe(1);
    i.silentTurns = 2;
    expect(await i.buildContinuationPrompt()).toContain("[ACTION REQUIRED]");
  });

  it("requests: a request tell still owes a reply", async () => {
    using _state = scopeProcessState({ env: { MARINA_FORCED_ACTION_NUDGE: "requests" } });
    const i = adapter();
    i.client.emit("perception", {
      kind: "message",
      timestamp: Date.now(),
      tag: "tell",
      data: {
        senderName: "Peer",
        text: "Peer tells you: verify C2",
        message: "verify C2",
        messageId: "t1",
      },
    });
    expect(i.pendingPerceptions[0]?.owesReply).toBe(true);
    expect(i.outstandingRequests.size).toBe(1);
  });
});
