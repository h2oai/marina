// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Only a REQUEST owes a reply. Phrases below are taken from crew transcripts
// measured 2026-09 (delphi, tournament and chorus habitat runs): what members
// actually sent each other.
import { describe, expect, it } from "bun:test";
import {
  classifyIncomingTell,
  isStatusEcho,
  numericTokens,
  outgoingAcknowledgementRefusal,
  STATUS_ECHO_NOT_SENT,
} from "../src/agent/acknowledgement";
import { INFORMATION_TELL_PRIORITY, LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import type { OutstandingRequests } from "../src/agent/outstanding-requests";
import type { Perception } from "../src/types";

describe("classifyIncomingTell", () => {
  it.each([
    // questions, asks, imperatives
    "What source supports defining posture as an agent’s chosen stance on autonomy?",
    "Please deposit your independent candidate draft for contested T2.",
    "Please judge this tournament pair as non-author: Reflector vs Translator.",
    "Integrated: keep benchmark-specific changes gated on run/feed evidence.",
    "Treat both posture definitions as unsupported hypotheses.",
    "Winner: Reflector. Graft Translator’s clearest rationale into the final.",
    "Integrated: only one note is needed; you should not add another.",
    "Your turn: pick the pair-2 winner.",
    "Need you to re-run C4 against calc.",
    // a caller is waiting, dispatches and model requests
    "findings ready [re:z2lqh9]",
    "[crew-task] T6: fix the table",
    '{"type":"model_request","id":"req-1","messages":[]}',
    "",
  ])("%j is a request", (message) => {
    expect(classifyIncomingTell(message)).toBe("request");
  });

  it.each([
    // delivered results
    "estimate: 83, 89, 97 | calc returned nonzero remainders for each candidate.",
    "estimate: C1=391; C2=12; C3=1024; C4=9801; C5=504; C6=5555 | Full calc checks.",
    "estimate: B | LRU retains the frequently reused hot keys under the 90% read skew.",
    "T1 candidate draft deposited: `T1 PRIMES: 83, 89, 97`.",
    "Verified pool eval-artifacts recall: exactly one matching note found, #239.",
    "No authoritative definition found: `help posture` is unrecognized.",
    // statements and status echoes
    "Integrated: #241 remains unchanged; I won't add a replacement.",
    "Confirmed: T4 #245 and T5 #247 are final; Answerer alone deposits.",
    "Task 3 is verified complete at note #243.",
  ])("%j is information", (message) => {
    expect(classifyIncomingTell(message)).toBe("information");
  });
});

describe("isStatusEcho", () => {
  // Numbers the agent already saw (in what peers told it / its own sends).
  const known = new Set(["239", "241", "243", "245", "247"]);

  it.each([
    "Integrated: #241 remains unchanged; I won't add a replacement.",
    "Integrated: T5 #247 is complete; T6 remains pending. I won’t add a pool note.",
    "Confirmed: T4 #245 remains sole and unchanged.",
    "Integrated: #241 remains the sole T2 deposit; no duplicate is needed.",
    "Confirmed: T1 is complete and #239 is the sole required note; no further deposit from me.",
    "Integrated: T2 remains final with #241 as the sole deposit; no duplicate is needed.",
    "No further action from me.",
    "Answerer remains the sole depositor.",
    "Verified state stands; I have no further changes to contribute.",
    "Integrated: my final choice and graft stand; Answerer’s T5 note #247 is the sole deposit. I made no competing note.",
    "I will make no further deposits.",
    "Integrated.",
  ])("%j is a status echo", (message) => {
    expect(isStatusEcho(message, known)).toBe(true);
  });

  it.each([
    // a new number, result, ID or value
    "Integrated: #251 remains the sole T6 deposit.",
    "T6 FIXED: C1=107; C2=19 deposited as #249.",
    "estimate: 83, 89, 97 | direct enumeration",
    "C1 is final at 391.",
    // decisions, findings, corrections, reasons
    "Integrated: Answerer wins pair 1; grafting Mathematician’s cutoff into its finalist.",
    "Integrated: Mathematician selected finalist A and grafted my embedded-storage point.",
    "Correction: my direct pool recall confirms T5 Answerer note #247 is present.",
    "Confirmed: T4 closed, T5 consensus B/LRU. I checked eval-artifacts; no T5 note appears yet.",
    "Integrated: the threshold should be sustained/high write contention, not any concurrent writes.",
    "T2 remains final, but C3 is wrong.",
    "Integrated: T3 #243 remains closed because the source is missing.",
    "Integrated: the T6 candidates match and my calc array verifies all 24 values.",
    "Confirmed: T5 #247 is complete. T6 remains separate, with my draft posted and no T6 note in recall.",
    // questions, requests, tags
    "Integrated: #241 remains final. Is T3 next?",
    "Integrated: #241 remains final. Please send the T3 draft.",
    "Integrated: #241 remains final [re:ab12cd]",
    '{"type":"model_response","id":"req-1","content":"#241 remains final"}',
    "",
  ])("%j carries information", (message) => {
    expect(isStatusEcho(message, known)).toBe(false);
  });

  it("any number is new without a known set", () => {
    expect(isStatusEcho("Integrated: #241 remains unchanged.")).toBe(false);
    expect(isStatusEcho("Integrated: T2 remains unchanged.")).toBe(true);
  });

  it("numericTokens skips labels and strips the ID mark", () => {
    expect(numericTokens("T4 #245 and C12=9801, pair 2")).toEqual(["245", "9801", "2"]);
  });
});

describe("outgoing status echoes", () => {
  const known = new Set(["241"]);

  it("a status echo is not sent unless the target is owed a reply", () => {
    const args = {
      target: "Peer",
      message: "Integrated: #241 remains unchanged; I won't add one.",
    };
    expect(outgoingAcknowledgementRefusal("marina_tell", args, new Set(), known)).toBe(
      STATUS_ECHO_NOT_SENT,
    );
    expect(
      outgoingAcknowledgementRefusal(
        "marina_command",
        { command: "channel send crew-1 Confirmed: #241 remains final." },
        new Set(),
        known,
      ),
    ).toBe(STATUS_ECHO_NOT_SENT);
    // The answer to an ask ("is #241 still final?") goes through.
    expect(outgoingAcknowledgementRefusal("marina_tell", args, new Set(["peer"]), known)).toBe(
      undefined,
    );
  });

  it("a message with a new number, a decision or a request goes through", () => {
    for (const message of [
      "Integrated: #249 remains the sole T6 deposit.",
      "Winner: Reflector; Translator's rationale grafted.",
      "#241 remains final; please draft T3.",
    ])
      expect(
        outgoingAcknowledgementRefusal(
          "marina_tell",
          { target: "Peer", message },
          new Set(),
          known,
        ),
      ).toBe(undefined);
  });
});

type Buffered = { text: string; priority: number; shouldRespond: boolean; addressed?: boolean };
type Internals = {
  agent: {
    beforeToolCall: (ctx: unknown) => Promise<{ block: boolean; reason: string } | undefined>;
  };
  client: { emit(event: "perception", p: Perception): void };
  platformMemory: { saveOutstandingRequests(batch: unknown[]): Promise<void> };
  autonomousMode: boolean;
  attentionMode: "focused" | "balanced" | "open";
  outstandingRequests: OutstandingRequests;
  pendingPerceptions: Buffered[];
  cycleWaiter: { sleep(ms: number): Promise<void> };
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
    { name: "Lead", model: "marina/default", crewResponder: true },
    "ws://unused",
    null,
  ) as unknown as Internals;
  i.platformMemory.saveOutstandingRequests = async () => {};
  i.autonomousMode = true;
  return i;
}

describe("incoming information tells", () => {
  it("a delivered result owes no reply, stays visible and wakes the loop", async () => {
    const i = adapter();
    i.attentionMode = "focused";
    const slept = i.cycleWaiter.sleep(60_000);
    i.client.emit(
      "perception",
      tell("Mathematician", "estimate: 83, 89, 97 | calc remainders all nonzero", "m20"),
    );
    await slept; // woken at once, not after 60 s
    expect(i.outstandingRequests.size).toBe(0);
    expect(i.pendingPerceptions).toHaveLength(1);
    const [event] = i.pendingPerceptions;
    expect(event!.shouldRespond).toBe(false);
    expect(event!.addressed).toBe(true);
    expect(event!.priority).toBe(INFORMATION_TELL_PRIORITY);
    expect(event!.priority).toBeLessThan(80);
    expect(event!.text).toContain("estimate: 83, 89, 97");
    expect(event!.text).toContain("no reply owed");
  });

  it("a status echo from a peer owes nothing, and an echo back is not sent", async () => {
    const i = adapter();
    i.client.emit(
      "perception",
      tell("Peer", "Integrated: #241 remains the sole T2 deposit.", "m21"),
    );
    expect(i.outstandingRequests.size).toBe(0);
    const args = { target: "Peer", message: "Confirmed: #241 remains final; no note from me." };
    const blocked = await i.agent.beforeToolCall({
      toolCall: { id: "t-echo", name: "marina_tell", arguments: args },
      args,
      context: { tools: [] },
    });
    expect(blocked).toEqual({ block: true, reason: STATUS_ECHO_NOT_SENT });
  });

  it("an echo that answers an ask from the target is sent", async () => {
    const i = adapter();
    i.client.emit("perception", tell("Peer", "Is #241 still the sole T2 deposit?", "m24"));
    expect(i.outstandingRequests.size).toBe(1);
    const args = { target: "Peer", message: "Confirmed: #241 remains the sole T2 deposit." };
    expect(
      await i.agent.beforeToolCall({
        toolCall: { id: "t-answer", name: "marina_tell", arguments: args },
        args,
        context: { tools: [] },
      }),
    ).toBeUndefined();
  });

  it("a tagged reply, a question and a crew dispatch still owe a reply", () => {
    const i = adapter();
    i.client.emit("perception", tell("Peer", "C3 = 1024 [re:ab12cd]", "m22"));
    i.client.emit("perception", tell("Peer", "Which pair is next?", "m23"));
    i.client.emit("perception", {
      kind: "message",
      timestamp: 1,
      data: {
        channel: "crew-1",
        senderName: "Operator",
        text: "[crew-1] Operator: [crew-task] T1: list the primes",
        message: "[crew-task] T1: list the primes",
      },
    });
    expect(i.outstandingRequests.size).toBe(3);
    expect(i.pendingPerceptions.every((p) => p.shouldRespond || p.priority >= 80)).toBe(true);
  });
});
