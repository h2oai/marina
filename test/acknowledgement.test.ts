// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  ACK_NOT_SENT,
  isPureAcknowledgement,
  outgoingAcknowledgementRefusal,
  stripCommandPleasantry,
  stripPleasantry,
} from "../src/agent/acknowledgement";
import {
  ACKNOWLEDGEMENT_PRIORITY,
  acknowledgementReplyRefusal,
  LeanAgentAdapter,
} from "../src/agent/lean-agent-adapter";
import type { OutstandingRequests } from "../src/agent/outstanding-requests";
import type { Perception } from "../src/types";

describe("isPureAcknowledgement", () => {
  it.each([
    "Thanks!",
    "Acknowledged.",
    "Understood—thanks.",
    "Great, thanks.",
    "You’re welcome.",
    "Noted, no further reply needed.",
    "Confirmed, thanks.",
    "Got it.",
    "Thanks for confirming; the task is complete with the single verified note.",
    "Understood. I’ll handle strict-format requests when they arrive.",
  ])("%s is an acknowledgement", (message) => {
    expect(isPureAcknowledgement(message)).toBe(true);
  });

  it.each([
    "can you check C3 against calc?",
    "Can you check X",
    "Thanks! Could you post the summary",
    "Thanks — please send your estimate.",
    "Got it. Send me C3 next.",
    "Acknowledged. What value did you get?",
    "Thanks, is the draft final?",
    "Confirmed: T1 PRIMES: 83, 89, 97",
    "Thanks [re:abc123]",
    "Verify the draft",
    "",
    `Thanks. ${"The draft is on the channel and I will merge it after the reviews land. ".repeat(3)}`,
  ])("%s is not an acknowledgement", (message) => {
    expect(isPureAcknowledgement(message)).toBe(false);
  });
});

type Internals = {
  agent: Agent;
  client: { emit(event: "perception", p: Perception): void };
  platformMemory: { saveOutstandingRequests(batch: unknown[]): Promise<void> };
  autonomousMode: boolean;
  attentionMode: "focused" | "balanced" | "open";
  outstandingRequests: OutstandingRequests;
  pendingPerceptions: Array<{ text: string; priority: number; shouldRespond: boolean }>;
  lastTellWasAck: Set<string>;
};

function tell(sender: string, message: string, messageId: string): Perception {
  return {
    kind: "message",
    timestamp: 1,
    tag: "tell",
    data: { senderName: sender, text: `${sender} tells you: ${message}`, message, messageId },
  };
}

function adapter(): Internals {
  const i = new LeanAgentAdapter(
    { name: "AckWorker", model: "marina/default", crewResponder: true },
    "ws://unused",
    null,
  ) as unknown as Internals;
  i.platformMemory.saveOutstandingRequests = async () => {};
  i.autonomousMode = true;
  return i;
}

describe("incoming acknowledgement tells", () => {
  it("an acknowledgement creates no outstanding request and no forced response, but stays visible", () => {
    const i = adapter();
    // Focused attention would drop low-priority events; acknowledgements stay.
    i.attentionMode = "focused";
    i.client.emit("perception", tell("Peer", "Acknowledged — no further reply needed.", "m1"));
    expect(i.outstandingRequests.size).toBe(0);
    expect(i.pendingPerceptions).toHaveLength(1);
    const [event] = i.pendingPerceptions;
    expect(event!.shouldRespond).toBe(false);
    expect(event!.priority).toBeLessThanOrEqual(ACKNOWLEDGEMENT_PRIORITY);
    expect(event!.text).toContain("Acknowledged");
    expect(event!.text).toContain("no reply owed");
    expect(i.lastTellWasAck.has("peer")).toBe(true);
  });

  it("a real request still creates a reply obligation and a forced response", () => {
    const i = adapter();
    i.client.emit("perception", tell("Peer", "can you check X?", "m2"));
    expect(i.outstandingRequests.size).toBe(1);
    expect(i.pendingPerceptions[0]!.shouldRespond).toBe(true);
    expect(i.pendingPerceptions[0]!.priority).toBe(100);
    expect(i.lastTellWasAck.has("peer")).toBe(false);
  });

  it("an acknowledgement that asks a question counts as a request", () => {
    const i = adapter();
    i.client.emit("perception", tell("Peer", "Thanks, got it. Which case is next?", "m3"));
    expect(i.outstandingRequests.size).toBe(1);
    expect(i.pendingPerceptions[0]!.shouldRespond).toBe(true);
  });

  it("a later real request from the same peer clears the acknowledgement mark", () => {
    const i = adapter();
    i.client.emit("perception", tell("Peer", "Thanks!", "m4"));
    i.client.emit("perception", tell("Peer", "Please verify C2.", "m5"));
    expect(i.lastTellWasAck.has("peer")).toBe(false);
    expect(i.outstandingRequests.size).toBe(1);
  });
});

describe("acknowledgementReplyRefusal", () => {
  const acked = new Set(["peer"]);

  it("refuses an acknowledgement back to a peer who just acknowledged", () => {
    expect(
      acknowledgementReplyRefusal("marina_tell", { target: "Peer", message: "Thanks!" }, acked),
    ).toContain("no reply owed");
    expect(
      acknowledgementReplyRefusal("marina_command", { command: "tell Peer Understood." }, acked),
    ).toContain("not sent");
  });

  it("lets real messages, other peers and non-acknowledged peers through", () => {
    expect(
      acknowledgementReplyRefusal(
        "marina_tell",
        { target: "Peer", message: "Can you re-run C4?" },
        acked,
      ),
    ).toBeUndefined();
    expect(
      acknowledgementReplyRefusal("marina_tell", { target: "Other", message: "Thanks!" }, acked),
    ).toBeUndefined();
    expect(
      acknowledgementReplyRefusal("marina_tell", { target: "Peer", message: "Thanks!" }, new Set()),
    ).toBeUndefined();
    expect(
      acknowledgementReplyRefusal("marina_command", { command: "look" }, acked),
    ).toBeUndefined();
  });
});

describe("outgoingAcknowledgementRefusal", () => {
  it.each([
    ["marina_tell", { target: "Peer", message: "Thanks!" }],
    ["marina_tell", { target: "Peer", message: "Acknowledged — no further reply needed." }],
    ["marina_channel", { action: "send", channel: "crew-1", message: "Understood, thanks." }],
    ["marina_command", { command: "tell Peer Got it." }],
    ["marina_command", { command: "channel send crew-1 Noted." }],
  ])("%s %j is not sent", (tool, args) => {
    expect(outgoingAcknowledgementRefusal(tool, args)).toBe(ACK_NOT_SENT);
  });

  it.each([
    "T1 PRIMES: 83, 89, 97",
    "Thanks — result: 42",
    "Can you re-run C4?",
    "Acknowledged. What value did you get?",
    "Verify the draft against calc.",
    "Thanks [re:ab12cd]",
    "estimate: 3 primes | direct enumeration",
    '{"type":"model_response","id":"req-1","content":"ok"}',
  ])("an information-carrying message goes through: %s", (message) => {
    expect(outgoingAcknowledgementRefusal("marina_tell", { target: "Peer", message })).toBe(
      undefined,
    );
    expect(
      outgoingAcknowledgementRefusal("marina_command", { command: `tell Peer ${message}` }),
    ).toBe(undefined);
  });

  it("an acknowledgement that answers a reply still owed to the target is sent", () => {
    const owed = new Set(["peer", "crew-1"]);
    expect(
      outgoingAcknowledgementRefusal(
        "marina_tell",
        { target: "Peer", message: "Confirmed." },
        owed,
      ),
    ).toBe(undefined);
    expect(
      outgoingAcknowledgementRefusal(
        "marina_channel",
        { action: "send", channel: "crew-1", message: "Got it." },
        owed,
      ),
    ).toBe(undefined);
  });

  it("ignores non-message tools and other channel actions", () => {
    expect(outgoingAcknowledgementRefusal("marina_command", { command: "look" })).toBe(undefined);
    expect(
      outgoingAcknowledgementRefusal("marina_channel", { action: "join", channel: "Thanks" }),
    ).toBe(undefined);
    expect(outgoingAcknowledgementRefusal("marina_say", { message: "Thanks!" })).toBe(undefined);
  });
});

describe("stripPleasantry", () => {
  it.each([
    ["Thanks — result: 42", "Result: 42"],
    ["Thanks; the identical candidate was selected.", "The identical candidate was selected."],
    ["Great, thanks. T2 deposited as #243.", "T2 deposited as #243."],
    ["Understood. My T2 draft stays one candidate.", "My T2 draft stays one candidate."],
    ["Got it: C3 fails on n=0.", "C3 fails on n=0."],
    ["Thanks! Could you post the summary", "Could you post the summary"],
    ["T1 deposited as #241. Thanks!", "T1 deposited as #241."],
  ])("%s → %s", (input, output) => {
    expect(stripPleasantry(input)).toBe(output);
  });

  it.each([
    "Thanks, but the value is wrong: 41, not 42.",
    "Thanks for verifying #239 via `pool memory:audit list`.",
    "Agreed: SQLite for the single-node case.",
    "Confirmed: T1 PRIMES: 83, 89, 97",
    "OK — take lot 2.",
    "Sounds good, I'll take lot 2.",
    "Thanks!",
    "Thanks — got it.",
    '{"type":"model_response","id":"req-1","content":"Thanks, 42"}',
    "[re:ab12cd] Thanks, 42",
    "T1 PRIMES: 83, 89, 97",
    "Greatest common divisor: 6",
  ])("leaves %s unchanged", (message) => {
    expect(stripPleasantry(message)).toBe(message);
  });

  it("rewrites only the body of tell and channel-send commands", () => {
    expect(stripCommandPleasantry("tell Peer Thanks — result: 42")).toBe("tell Peer Result: 42");
    expect(stripCommandPleasantry("channel send crew-1 Great, C2 passes.")).toBe(
      "channel send crew-1 C2 passes.",
    );
    expect(stripCommandPleasantry("note Thanks — result: 42")).toBe("note Thanks — result: 42");
    expect(stripCommandPleasantry("tell Peer Thanks!")).toBe("tell Peer Thanks!");
  });
});

describe("outgoing acknowledgements in the adapter", () => {
  type Gate = {
    agent: {
      beforeToolCall: (ctx: unknown) => Promise<{ block: boolean; reason: string } | undefined>;
    };
  };
  const call = (i: Internals, name: string, args: Record<string, unknown>) =>
    (i as unknown as Gate).agent.beforeToolCall({
      toolCall: { id: `t-${name}`, name, arguments: args },
      args,
      context: { tools: [] },
    });

  it("an outgoing acknowledgement returns at once, unsent; information goes through", async () => {
    const i = adapter();
    const started = Date.now();
    const blocked = await call(i, "marina_tell", { target: "Peer", message: "Thanks!" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(blocked).toEqual({ block: true, reason: ACK_NOT_SENT });
    expect(
      await call(i, "marina_tell", { target: "Peer", message: "T1 PRIMES: 83, 89, 97" }),
    ).toBeUndefined();
  });

  it("an acknowledgement that answers a request the peer is owed is sent", async () => {
    const i = adapter();
    i.client.emit("perception", tell("Peer", "Confirm you have the file?", "m9"));
    expect(i.outstandingRequests.size).toBe(1);
    expect(await call(i, "marina_tell", { target: "Peer", message: "Confirmed." })).toBeUndefined();
  });
});
