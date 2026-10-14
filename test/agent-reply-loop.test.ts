// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The reply loop: a resident owes a reply only when it is ADDRESSED (a tell, a
 * vocative `Name, …` / `@Name` / `to:Name`) with a request — never because its
 * name appears inside someone's status post. Each side of a conversation
 * owing the other made two agents naming each other answer each other
 * indefinitely. Driven through the real adapter; the ping-pong case runs two
 * real loops against fake upstreams and counts model calls.
 */

import { describe, expect, it } from "bun:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { forcedActionNudgeMode, LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import type { OutstandingRequests } from "../src/agent/outstanding-requests";
import { isAddressedTo, SocialAwareness } from "../src/agent/social";
import type { Perception } from "../src/types";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";

type Message = { role: string; content: unknown };

type Internals = {
  agent: Agent;
  client: {
    emit(event: string, ...args: unknown[]): void;
    isConnected(): boolean;
    capabilities(): Promise<unknown>;
    command(cmd: string): Promise<Perception[]>;
  };
  platformMemory: Record<string, unknown>;
  outstandingRequests: OutstandingRequests;
  pendingPerceptions: Array<{ text: string; priority: number; shouldRespond?: boolean }>;
  autonomousLoopRunning: boolean;
  autonomousMode: boolean;
  cycleWaiter: { wake(): void };
  computeDynamicDelay(): number;
  getTickRate(): { min: number; normal: number; idle: number };
  runAutonomousLoop(): Promise<void>;
  buildContinuationPrompt(): Promise<string>;
  setupActionTracking(): void;
};

function textReply(model: { api: string; provider: string; id: string }, n: number) {
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api as AssistantMessage["api"],
    provider: model.provider,
    model: model.id,
    timestamp: n,
    content: [{ type: "text", text: "ok" }],
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  return message;
}

/** A resident wired to a fake upstream and an inert world. */
function resident(name: string, config: Record<string, unknown> = {}) {
  const adapter = new LeanAgentAdapter(
    { name, model: "anthropic/claude-haiku-4-5", ...config } as never,
    "ws://localhost:39995",
    null,
    "sk-test",
  );
  const i = adapter as unknown as Internals;
  const pm = i.platformMemory;
  pm.saveOutstandingRequests = async () => {};
  pm.journalMessage = async () => {};
  pm.workInbox = async () => ({ success: true, text: "" });
  pm.getNoveltySuggestions = async () => [];
  pm.orient = async () => ({ success: true, text: "" });
  pm.questStatus = async () => ({ active: false, text: "" });
  pm.unifiedContext = async () => ({ success: true, text: "", context: null });
  pm.lessonsFor = async () => ({ lines: [], ids: [] });
  pm.getCoreValue = async () => undefined;
  pm.getPace = async () => null;
  pm.saveFocus = async () => ({ success: true, text: "" });
  i.client.isConnected = () => true;
  i.client.capabilities = async () => ({
    schema: "marina.capabilities.v1",
    revision: 1,
    commands: [],
  });
  i.client.command = async () => [];
  i.agent.transformContext = undefined;
  i.agent.prepareNextTurnWithContext = undefined;
  const steered: string[] = [];
  const realSteer = i.agent.steer.bind(i.agent);
  i.agent.steer = ((m: Message) => {
    steered.push(String(m.content));
    realSteer(m as never);
  }) as Agent["steer"];
  i.autonomousMode = true;
  i.setupActionTracking();
  return { i, steered };
}

function channelPost(message: string, id: string, from = "Lead"): Perception {
  return {
    kind: "message",
    timestamp: Date.now(),
    data: { from, channel: "crew", message, text: `[crew] ${from}: ${message}`, messageId: id },
  } as Perception;
}

function tell(message: string, id: string, from = "Peer"): Perception {
  return {
    kind: "message",
    timestamp: Date.now(),
    tag: "tell",
    data: { senderName: from, text: `${from} tells you: ${message}`, message, messageId: id },
  } as Perception;
}

describe("addressing", () => {
  it("defaults the forced-action nudge to requests; `all` stays available", () => {
    expect(forcedActionNudgeMode({})).toBe("requests");
    expect(forcedActionNudgeMode({ MARINA_FORCED_ACTION_NUDGE: "junk" })).toBe("requests");
    expect(forcedActionNudgeMode({ MARINA_FORCED_ACTION_NUDGE: " All " })).toBe("all");
  });

  it("vocatives address; a name inside a sentence does not", () => {
    expect(isAddressedTo("Nudged, what is the total?", "Nudged")).toBe(true);
    expect(isAddressedTo("nudged: status?", "Nudged")).toBe(true);
    expect(isAddressedTo("Nudged what is the total", "Nudged")).toBe(true);
    expect(isAddressedTo("@Nudged can you check", "Nudged")).toBe(true);
    expect(isAddressedTo("can you check, @nudged?", "Nudged")).toBe(true);
    expect(isAddressedTo("to:Nudged please verify", "Nudged")).toBe(true);
    expect(isAddressedTo("Hey Nudged, come here", "Nudged")).toBe(true);
    expect(isAddressedTo("thanks nudged", "Nudged")).toBe(true);
    expect(isAddressedTo("hey team, Nudged found it", "Nudged")).toBe(false);
    expect(isAddressedTo("I agree with what Nudged said earlier", "Nudged")).toBe(false);
    expect(isAddressedTo("Nudgedness is a word now", "Nudged")).toBe(false);
    expect(isAddressedTo("Nudged-Bot, are you there?", "Nudged")).toBe(false);
    expect(isAddressedTo("Nudged-Bot, are you there?", "Nudged-Bot")).toBe(true);
    expect(isAddressedTo("a.b, hi", "a.b")).toBe(true);
    expect(isAddressedTo("axb, hi", "a.b")).toBe(false);
  });

  it("social scoring: a mention scores as ordinary chatter, a vocative at 80", () => {
    const social = new SocialAwareness();
    const at = (message: string) => ({
      type: "channel_message" as const,
      speaker: "Lead",
      message,
      channel: "crew",
      timestamp: 0,
    });
    expect(social.scorePerception(at("as Nudged said, the total is 12"), "Nudged")).toBe(40);
    expect(social.scorePerception(at("Nudged, what is the total?"), "Nudged")).toBe(80);
    expect(social.shouldRespond(at("as Nudged said, the total is 12"), "Nudged")).toBe(false);
  });

  it("a name substring creates no debt; a vocative request does", () => {
    using _s = scopeProcessState({ env: { MARINA_FORCED_ACTION_NUDGE: undefined } });
    const { i } = resident("Nudged");
    i.client.emit("perception", channelPost("as Nudged said, what is next for the team?", "m1"));
    expect(i.outstandingRequests.size).toBe(0);
    expect(i.pendingPerceptions[0]?.shouldRespond).toBe(false);
    i.client.emit("perception", channelPost("Nudged, what is the shard 2 total?", "m2"));
    expect(i.outstandingRequests.size).toBe(1);
  });

  it("an addressed acknowledgement on a channel owes nothing, even under `all`", () => {
    using _s = scopeProcessState({ env: { MARINA_FORCED_ACTION_NUDGE: "all" } });
    const { i } = resident("Nudged");
    i.client.emit("perception", channelPost("Nudged: thanks, no reply needed", "m3"));
    expect(i.outstandingRequests.size).toBe(0);
    expect(i.pendingPerceptions[0]?.shouldRespond).toBe(false);
  });

  it("a guide owes nothing to an arrival", () => {
    const { i } = resident("Guide", { role: "guide" });
    i.client.emit("perception", {
      kind: "movement",
      timestamp: Date.now(),
      data: { entityName: "Visitor", type: "arrive", text: "Visitor arrives." },
    } as Perception);
    expect(i.pendingPerceptions[0]?.shouldRespond).toBe(false);
    expect(i.outstandingRequests.size).toBe(0);
  });
});

describe("settlement and cadence", () => {
  it("a reply by tell to the speaker settles a channel ask", () => {
    using _s = scopeProcessState({ env: { MARINA_FORCED_ACTION_NUDGE: undefined } });
    const { i } = resident("Nudged");
    i.client.emit("perception", channelPost("Nudged, what is the shard 2 total?", "s1"));
    const [request] = i.outstandingRequests.entries();
    expect(request?.speaker).toBe("Lead");
    const eligible = new Set([request!.id]);
    // A tell to someone else settles nothing; a tell to the asker does.
    expect(
      i.outstandingRequests.completedIds(
        { deliveries: [{ kind: "tell", target: "Other", message: "4,113" }] },
        eligible,
      ),
    ).toEqual([]);
    expect(
      i.outstandingRequests.completedIds(
        { deliveries: [{ kind: "tell", target: "lead", message: "4,113" }] },
        eligible,
      ),
    ).toEqual([request!.id]);
  });

  it("a channel post below 90 never steers a run in flight; a request tell does", () => {
    using _s = scopeProcessState({ env: { MARINA_FORCED_ACTION_NUDGE: undefined } });
    const { i, steered } = resident("Nudged");
    Object.defineProperty(i.agent.state, "isStreaming", { value: true, configurable: true });
    i.client.emit("perception", channelPost("Nudged, what is the shard 2 total?", "st1"));
    expect(steered).toHaveLength(0);
    i.client.emit("perception", tell("what is the total?", "st2"));
    expect(steered).toHaveLength(1);
  });

  it("an owed request already shown re-asks at the normal rate, not the minimum", async () => {
    const { i } = resident("Owed");
    i.client.emit("perception", tell("what is the total?", "o1"));
    expect(i.computeDynamicDelay()).toBe(i.getTickRate().min);
    await i.buildContinuationPrompt();
    expect(i.outstandingRequests.size).toBe(1);
    expect(i.computeDynamicDelay()).toBe(i.getTickRate().normal);
  });
});

describe("two residents naming each other in status posts", () => {
  it("do not ping-pong: model calls stay bounded (fake upstreams)", async () => {
    using _s = scopeProcessState({ env: { MARINA_FORCED_ACTION_NUDGE: undefined } });
    const a = resident("Alba");
    const b = resident("Brin");
    const calls = { Alba: 0, Brin: 0 };
    let seq = 0;
    // Each model call posts a status update on the shared channel that NAMES
    // the other resident (not addressed to it) — the shape that used to make
    // each post a reply debt for the other side.
    const wire = (self: typeof a, name: "Alba" | "Brin", other: typeof a, otherName: string) => {
      self.i.agent.streamFunction = async (model) => {
        calls[name]++;
        other.i.client.emit(
          "perception",
          channelPost(
            `status: merged my shard; ${otherName}'s numbers check out, total ${++seq}.`,
            `p${seq}`,
            name,
          ),
        );
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: textReply(model, seq) });
        stream.end();
        return stream;
      };
      // Cadence as configured: the fast tick runs at once; anything slower
      // parks (wakeable) past the end of the test window.
      const realDelay = self.i.computeDynamicDelay.bind(self.i);
      self.i.computeDynamicDelay = () =>
        realDelay() === self.i.getTickRate().min ? 1 : 10 * 60_000;
    };
    wire(a, "Alba", b, "Brin");
    wire(b, "Brin", a, "Alba");

    // Kick-off: one genuine request to Alba.
    a.i.client.emit("perception", channelPost("Alba, what is the merged total?", "k1", "Lead"));
    for (const r of [a, b]) r.i.autonomousLoopRunning = true;
    const loops = [a.i.runAutonomousLoop(), b.i.runAutonomousLoop()];
    a.i.cycleWaiter.wake();
    await until(() => calls.Alba >= 1);
    // Give a ping-pong every chance to develop.
    const settleBy = Date.now() + 300;
    await until(() => Date.now() >= settleBy);
    for (const r of [a, b]) {
      r.i.autonomousLoopRunning = false;
      r.i.cycleWaiter.wake();
    }
    await Promise.all(loops);

    // Alba answers its request (one run; at most one in-run recovery turn
    // because the fake model replies in prose). Brin owes nothing.
    expect(calls.Alba).toBeLessThanOrEqual(2);
    expect(calls.Brin).toBe(0);
  });
});
