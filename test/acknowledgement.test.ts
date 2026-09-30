// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { isPureAcknowledgement } from "../src/agent/acknowledgement";
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
    ).toContain("no reply is owed");
    expect(
      acknowledgementReplyRefusal("marina_command", { command: "tell Peer Understood." }, acked),
    ).toContain("Not sent");
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
