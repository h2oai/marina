// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Output repair on the lean-agent silent-turn path: a crew lead owes a
 * `model_request`, its run ends on silent turns whose prose holds the answer,
 * and no tool call delivered it. Once the in-run recovery is spent, the answer
 * is delivered as the `model_response` with a `repaired` label and the
 * obligation is settled durably — exactly once, to exactly the owed request.
 */

import { expect, it } from "bun:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentEvent } from "../src/agent/agent-types";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import type { PlatformMemoryBackend } from "../src/agent/memory-platform";
import type { OutstandingRequests } from "../src/agent/outstanding-requests";
import type { Perception } from "../src/types";
import { scopeProcessState } from "./process-state";

type Internals = {
  agent: Agent;
  client: { command(cmd: string): Promise<Perception[]>; isConnected(): boolean };
  platformMemory: PlatformMemoryBackend;
  outstandingRequests: OutstandingRequests;
  currentPromptActionable: boolean;
  setupActionTracking(): void;
  salvageOwedModelReply(message: unknown): Promise<boolean>;
};

const CHANNEL = "model:answerer";

function modelRequest(id: string): Perception {
  const content = JSON.stringify({
    type: "model_request",
    id,
    content: "Sum of the first 50 primes?",
  });
  return {
    kind: "message",
    timestamp: 1,
    tag: "channel",
    data: { channel: CHANNEL, senderName: "model-api", content, text: content },
  };
}

function setup() {
  const i = new LeanAgentAdapter(
    { name: "Answerer", model: "marina/default", crewResponder: true },
    "ws://127.0.0.1:3300",
    null,
  ) as unknown as Internals;
  const sent: string[] = [];
  const completed: string[][] = [];
  i.platformMemory.saveOutstandingRequests = async () => {};
  i.platformMemory.saveFocus = async () => ({ success: true, text: "" });
  i.platformMemory.journalMessage = async () => {};
  i.platformMemory.completeOutstandingRequests = async (ids) => {
    completed.push([...ids]);
  };
  i.client.isConnected = () => true;
  i.client.command = async (cmd: string) => {
    sent.push(cmd);
    const message = cmd.slice(`channel send ${CHANNEL} `.length);
    return [
      {
        kind: "message",
        timestamp: 2,
        data: { text: "sent", delivery: { kind: "channel", target: CHANNEL, message } },
      } as Perception,
    ];
  };
  const events: AgentEvent[] = [];
  (i as unknown as LeanAgentAdapter).subscribe((e) => events.push(e));
  return { i, sent, completed, events };
}

function owe(i: Internals, id: string): string {
  const key = i.outstandingRequests.add(modelRequest(id), 1, "model request")!;
  i.outstandingRequests.present(key);
  return key;
}

const prose = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

it("delivers a marked answer as a labelled model_response and settles the obligation", async () => {
  const { i, sent, completed, events } = setup();
  const key = owe(i, "req-1");
  expect(
    await i.salvageOwedModelReply(prose("Adding them up carefully.\nFinal answer: 5117")),
  ).toBe(true);
  expect(sent).toHaveLength(1);
  const envelope = JSON.parse(sent[0]!.slice(`channel send ${CHANNEL} `.length));
  expect(envelope).toEqual({
    type: "model_response",
    id: "req-1",
    content: "5117",
    repaired: "repaired:parse",
  });
  expect(completed).toEqual([[key]]);
  expect(i.outstandingRequests.size).toBe(0);
  const decision = events.find((e) => e.type === "decision") as
    | Extract<AgentEvent, { type: "decision" }>
    | undefined;
  expect(decision?.stage).toBe("repair");
  expect(decision?.verdict).toBe("repaired:parse");
});

it("never guesses: no marker under parse-only mode, no prose, or two owed requests → nothing sent", async () => {
  using _state = scopeProcessState({ env: { MARINA_OUTPUT_REPAIR: "parse" } });
  const { i, sent } = setup();
  owe(i, "req-1");
  expect(await i.salvageOwedModelReply(prose("Let me check the table first."))).toBe(false);
  expect(await i.salvageOwedModelReply({ role: "assistant", content: [] })).toBe(false);
  owe(i, "req-2");
  expect(await i.salvageOwedModelReply(prose("Final answer: 5117"))).toBe(false);
  expect(sent).toHaveLength(0);
});

it("is off with MARINA_OUTPUT_REPAIR=off", async () => {
  using _state = scopeProcessState({ env: { MARINA_OUTPUT_REPAIR: "off" } });
  const { i, sent } = setup();
  owe(i, "req-1");
  expect(await i.salvageOwedModelReply(prose("Final answer: 5117"))).toBe(false);
  expect(sent).toHaveLength(0);
});

it("in a run: the first silent turn gets the forced-action nudge, the second is salvaged", async () => {
  const { i, sent } = setup();
  i.setupActionTracking();
  owe(i, "req-9");
  i.agent.transformContext = undefined;
  i.agent.prepareNextTurnWithContext = undefined;
  i.agent.getApiKey = () => undefined;
  i.agent.state.tools = [];
  let calls = 0;
  i.agent.streamFunction = async (model) => {
    calls++;
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: calls,
      content: [{ type: "text", text: "The sum is computed below.\nFinal answer: 5117" }],
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
    const events = createAssistantMessageEventStream();
    events.push({ type: "done", reason: "stop", message });
    events.end();
    return events;
  };
  i.currentPromptActionable = true;
  await i.agent.prompt("[World Events] model_request req-9");
  expect(calls).toBe(2);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('"repaired":"repaired:parse"');
  expect(i.outstandingRequests.size).toBe(0);
});
