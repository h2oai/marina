// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import type { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { OutstandingRequests } from "../src/agent/outstanding-requests";
import { piModels } from "../src/agent/pi-models";
import type { MarinaClient } from "../src/sdk/client";
import type { Perception } from "../src/types";
import { scopeProcessState } from "./process-state";

type Internals = {
  agent: Agent;
  client: Pick<MarinaClient, "capabilities" | "isConnected"> & {
    emit(event: "perception", p: Perception): void;
  };
  platformMemory: PlatformMemoryBackend;
  autonomousMode: boolean;
  autonomousLoopRunning: boolean;
  currentPromptActionable: boolean;
  outstandingRequests: OutstandingRequests;
  setupActionTracking(): void;
  buildContinuationPrompt(): Promise<string>;
  runAutonomousLoop(): Promise<void>;
  pauseSleep(): Promise<void>;
};

function request(message: string, extra: Record<string, unknown> = {}): Perception {
  return {
    kind: "message",
    timestamp: 1,
    tag: "tell",
    data: {
      text: `Boss tells you: ${message}`,
      senderName: "Boss",
      message,
      ...extra,
    },
  };
}

function adapter(model = "marina/default") {
  const i = new LeanAgentAdapter(
    { name: "Worker", model, crewResponder: true },
    "ws://127.0.0.1:3300",
    null,
  ) as unknown as Internals;
  i.platformMemory.saveFocus = async () => ({ success: true, text: "" });
  i.platformMemory.saveOutstandingRequests = async () => {};
  i.platformMemory.workInbox = async () => ({ success: true, text: "" });
  i.client.capabilities = async () => ({
    schema: "marina.capabilities.v1",
    revision: 1,
    commands: [],
  });
  // The loop makes no model call while the world connection is down.
  i.client.isConnected = () => true;
  i.agent.transformContext = undefined;
  i.agent.prepareNextTurnWithContext = undefined;
  i.agent.getApiKey = () => undefined;
  return i;
}

function stream(
  i: Internals,
  content: (call: number) => AssistantMessage["content"],
  options: { truncateFirst?: boolean; omitUsage?: boolean } = {},
) {
  let calls = 0;
  i.agent.streamFunction = async (model) => {
    const blocks = content(++calls);
    const reason =
      options.truncateFirst && calls === 1
        ? "length"
        : blocks.some((block) => block.type === "toolCall")
          ? "toolUse"
          : "stop";
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: calls,
      content: blocks,
      stopReason: reason,
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
    events.push({
      type: "done",
      reason,
      message: options.omitUsage
        ? ({ ...message, usage: undefined } as unknown as AssistantMessage)
        : message,
    });
    events.end();
    return events;
  };
  return () => calls;
}

const modelCases = [
  "marina/default",
  "ollama/small-local",
  ...["anthropic", "openai", "google"].map((provider) => {
    const model =
      piModels.getModels(provider).find((entry) => entry.reasoning) ??
      piModels.getModels(provider)[0]!;
    return `${provider}/${model.id}`;
  }),
];
for (const model of modelCases)
  for (const executionMode of ["sequential", "parallel"] as const) {
    it(`${model}: journals ${executionMode} results before yielding and refuses excess tools`, async () => {
      using _state = scopeProcessState({ env: { AGENT_MAX_TOOL_CALLS_PER_RUN: "2" } });
      const i = adapter(model);
      const journal: AgentMessage[] = [];
      i.platformMemory.journalMessage = async (message, signal) => {
        signal?.throwIfAborted();
        journal.push(message as AgentMessage);
      };
      i.setupActionTracking();
      let effects = 0;
      i.agent.state.tools = [
        {
          name: "probe",
          label: "Probe",
          description: "test",
          executionMode,
          parameters: Type.Object({}),
          execute: async () => {
            effects++;
            await Promise.resolve();
            return { content: [{ type: "text", text: "completed effect" }], details: {} };
          },
        },
      ];
      const calls = stream(i, () =>
        [1, 2, 3].map((n) => ({
          type: "toolCall",
          id: `probe-${n}`,
          name: "probe",
          arguments: {},
        })),
      );
      await i.agent.prompt("perform three operations");
      expect(calls()).toBe(1);
      expect(effects).toBe(2);
      const results = journal.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(3);
      expect(results.map((result) => result.isError)).toEqual([false, false, true]);
      expect(i.agent.state.errorMessage).toBeUndefined();
    });
  }

it("a crew request survives a capped run and sleeps only after its reply is journaled", async () => {
  using _state = scopeProcessState({ env: { AGENT_MAX_TOOL_CALLS_PER_RUN: "2" } });
  const i = adapter();
  const journal: AgentMessage[] = [];
  i.platformMemory.journalMessage = async (message, signal) => {
    signal?.throwIfAborted();
    journal.push(message as AgentMessage);
  };
  i.setupActionTracking();
  i.autonomousMode = true;
  i.autonomousLoopRunning = true;
  i.client.emit("perception", request("check status [re:abcdef]"));
  i.agent.state.tools = [
    {
      name: "observe",
      label: "Observe",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "observed" }], details: {} }),
    },
    {
      name: "reply",
      label: "Reply",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "delivered" }],
        details: {
          deliveries: [{ kind: "tell", target: "Boss", message: "done [re:abcdef]" }],
        },
      }),
    },
  ];
  const calls = stream(i, (call) =>
    call <= 3
      ? [
          {
            type: "toolCall",
            id: `call-${call}`,
            name: call === 3 ? "reply" : "observe",
            arguments: {},
          },
        ]
      : [{ type: "text", text: "done" }],
  );
  let cycles = 0;
  i.pauseSleep = async () => {
    if (++cycles > 4) i.autonomousLoopRunning = false;
  };
  await i.runAutonomousLoop();
  expect(calls()).toBe(4);
  expect(journal.filter((message) => message.role === "toolResult")).toHaveLength(3);
  expect(i.outstandingRequests.size).toBe(0);
  expect(i.currentPromptActionable).toBe(false);
  expect(
    journal.some(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("Reply still owed"),
    ),
  ).toBe(true);
});

it("an observation followed by prose still requires a delivered answer", async () => {
  const i = adapter();
  i.platformMemory.journalMessage = async () => {};
  i.setupActionTracking();
  i.autonomousMode = true;
  i.client.emit("perception", request("check status [re:abcdef]"));
  const prompt = await i.buildContinuationPrompt();
  i.agent.state.tools = [
    {
      name: "observe",
      label: "Observe",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "observed" }], details: {} }),
    },
  ];
  const calls = stream(i, (call) =>
    call === 1
      ? [{ type: "toolCall", id: "observation", name: "observe", arguments: {} }]
      : [{ type: "text", text: "private answer" }],
  );
  await i.agent.prompt(prompt);
  expect(calls()).toBe(3); // observation, prose, bounded recovery
  expect(i.outstandingRequests.size).toBe(1);
  expect(i.currentPromptActionable).toBe(true);
  expect(await i.buildContinuationPrompt()).toContain("Reply still owed");
});

it("truncated tool arguments never execute or settle a request, even without usage metadata", async () => {
  const i = adapter("ollama/small-local");
  i.platformMemory.journalMessage = async () => {};
  i.setupActionTracking();
  i.autonomousMode = true;
  i.client.emit("perception", request("check status [re:abcdef]"));
  const prompt = await i.buildContinuationPrompt();
  let effects = 0;
  i.agent.state.tools = [
    {
      name: "reply",
      label: "Reply",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => {
        effects++;
        return {
          content: [{ type: "text", text: "delivered" }],
          details: { deliveries: [{ kind: "tell", target: "Boss", message: "done [re:abcdef]" }] },
        };
      },
    },
  ];
  stream(
    i,
    (call) =>
      call === 1
        ? [{ type: "toolCall", id: "truncated", name: "reply", arguments: {} }]
        : [{ type: "text", text: "cannot finish" }],
    { truncateFirst: true, omitUsage: true },
  );
  await i.agent.prompt(prompt);
  expect(effects).toBe(0);
  expect(i.outstandingRequests.size).toBe(1);
});

it("failed persistence cannot clear a request whose reply receipt was not journaled", async () => {
  const i = adapter();
  i.platformMemory.journalMessage = async (message) => {
    if ((message as AgentMessage).role === "toolResult") throw new Error("journal unavailable");
  };
  i.setupActionTracking();
  i.autonomousMode = true;
  i.client.emit("perception", request("check status [re:abcdef]"));
  const prompt = await i.buildContinuationPrompt();
  i.agent.state.tools = [
    {
      name: "reply",
      label: "Reply",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "delivered" }],
        details: { deliveries: [{ kind: "tell", target: "Boss", message: "done [re:abcdef]" }] },
      }),
    },
  ];
  const calls = stream(i, () => [{ type: "toolCall", id: "reply", name: "reply", arguments: {} }]);
  await i.agent.prompt(prompt);
  expect(calls()).toBe(1);
  expect(i.outstandingRequests.size).toBe(1);
  expect(i.agent.state.errorMessage).toContain("journal unavailable");
});

it("a reply started before a new request arrives cannot settle the new request", async () => {
  const i = adapter();
  i.platformMemory.journalMessage = async () => {};
  i.setupActionTracking();
  i.autonomousMode = true;
  i.client.emit("perception", request("first"));
  const prompt = await i.buildContinuationPrompt();
  i.agent.state.tools = [
    {
      name: "reply",
      label: "Reply",
      description: "test",
      parameters: Type.Object({}),
      execute: async () => {
        i.client.emit("perception", request("second"));
        return {
          content: [{ type: "text", text: "delivered first" }],
          details: { deliveries: [{ kind: "tell", target: "Boss", message: "answer to first" }] },
        };
      },
    },
  ];
  stream(i, (call) =>
    call === 1
      ? [{ type: "toolCall", id: "first", name: "reply", arguments: {} }]
      : [{ type: "text", text: "private prose" }],
  );
  await i.agent.prompt(prompt);
  expect(i.outstandingRequests.entries().map((entry) => entry.text)).toEqual([
    "Boss tells you: second",
  ]);
  expect(i.currentPromptActionable).toBe(true);
});

it("settles only the matching request; wrong destinations, model IDs and untrusted events cannot settle it", () => {
  const pending = new OutstandingRequests();
  const first = pending.add(request("first [re:aaaaaa]"), 1, "first")!;
  const second = pending.add(request("second [re:bbbbbb]"), 2, "second")!;
  pending.present(first);
  pending.present(second);
  const deliver = (target: string, message: string) =>
    pending.settle({ deliveries: [{ kind: "tell", target, message }] }, pending.presentedIds());
  deliver("Other", "answer [re:aaaaaa]");
  expect(pending.size).toBe(2);
  deliver("Boss", "answer [re:bbbbbb]");
  expect(pending.entries().map((entry) => entry.id)).toEqual([first]);
  expect(pending.add(request("untrusted", { untrusted: true }), 3, "untrusted")).toBeUndefined();
  const model = pending.add(
    request("", {
      channel: "model:crew",
      content: '{"type":"model_request","id":"r1"}',
      message: undefined,
    }),
    4,
    "model request",
  )!;
  pending.present(model);
  pending.settle(
    {
      deliveries: [
        {
          kind: "channel",
          target: "model:crew",
          message: '{"type":"model_response","id":"other"}',
        },
      ],
    },
    pending.presentedIds(),
  );
  expect(pending.size).toBe(2);
  pending.settle(
    {
      deliveries: [
        { kind: "channel", target: "model:crew", message: '{"type":"model_response","id":"r1"}' },
      ],
    },
    pending.presentedIds(),
  );
  expect(pending.entries().map((entry) => entry.id)).toEqual([first]);
});
