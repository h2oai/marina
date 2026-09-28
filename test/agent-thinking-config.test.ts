// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Thinking budgets and tool-execution ordering are configuration, not
 * hard-coded: `AgentConfig.thinkingLevel` (spawn/config parsing, the
 * `MARINA_AGENT_THINKING` default, the crew-responder exception) reaches the
 * pi-agent Agent state and — on the marina proxy model — the request body as
 * `reasoning_effort`; world-mutating tools carry `executionMode: "sequential"`
 * unless `MARINA_TOOL_EXECUTION` says otherwise.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  defaultAgentThinkingLevel,
  parseAgentThinkingLevel,
  resolveAgentThinkingLevel,
} from "../src/agent/agent-types";
import {
  applyThinkingLevel,
  LeanAgentAdapter,
  resolveModel,
} from "../src/agent/lean-agent-adapter";
import { piModels } from "../src/agent/pi-models";
import {
  agentToolExecutionMode,
  applyToolExecutionModes,
  isMutatingToolName,
  READ_ONLY_TOOL_NAMES,
  toolExecutionPolicy,
} from "../src/agent/tools";
import { parseSpawnOptions } from "../src/engine/commands/agent";
import { Logger } from "../src/engine/logger";
import { scopeProcessState } from "./process-state";

const ENV_KEYS = ["MARINA_AGENT_THINKING", "MARINA_TOOL_EXECUTION"] as const;
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]] as const));
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("thinking level — parsing and defaults", () => {
  it("parses the level names (case-insensitive, `none` = off) and rejects the rest", () => {
    expect(parseAgentThinkingLevel("HIGH")).toBe("high");
    expect(parseAgentThinkingLevel("none")).toBe("off");
    expect(parseAgentThinkingLevel("xhigh")).toBe("xhigh");
    expect(parseAgentThinkingLevel("max")).toBeUndefined();
    expect(parseAgentThinkingLevel(undefined)).toBeUndefined();
  });

  it("MARINA_AGENT_THINKING sets the instance default; unset or invalid → off", () => {
    expect(defaultAgentThinkingLevel({} as NodeJS.ProcessEnv)).toBe("off");
    expect(
      defaultAgentThinkingLevel({ MARINA_AGENT_THINKING: "medium" } as NodeJS.ProcessEnv),
    ).toBe("medium");
    expect(defaultAgentThinkingLevel({ MARINA_AGENT_THINKING: "loud" } as NodeJS.ProcessEnv)).toBe(
      "off",
    );
  });

  it("explicit config wins; crew responders default to off regardless of the env default", () => {
    const env = { MARINA_AGENT_THINKING: "high" } as NodeJS.ProcessEnv;
    expect(resolveAgentThinkingLevel({}, env)).toBe("high");
    expect(resolveAgentThinkingLevel({ crewResponder: true }, env)).toBe("off");
    expect(resolveAgentThinkingLevel({ crewResponder: true, thinkingLevel: "low" }, env)).toBe(
      "low",
    );
    expect(resolveAgentThinkingLevel({ thinkingLevel: "off" }, env)).toBe("off");
  });
});

describe("thinking level — persisted column (migration 120)", () => {
  it("a NULL thinking_level stays unset and resolves like no explicit level", () => {
    delete process.env.MARINA_AGENT_THINKING;
    // What the respawn path does with an `agent_configs` row: parse the
    // column (NULL → undefined), then resolve at spawn.
    const fromRow = (thinking_level: string | null) =>
      parseAgentThinkingLevel(thinking_level ?? undefined);
    expect(fromRow(null)).toBeUndefined();
    expect(resolveAgentThinkingLevel({ thinkingLevel: fromRow(null) })).toBe("off");
    process.env.MARINA_AGENT_THINKING = "medium";
    expect(resolveAgentThinkingLevel({ thinkingLevel: fromRow(null) })).toBe("medium");
    expect(resolveAgentThinkingLevel({ thinkingLevel: fromRow(null), crewResponder: true })).toBe(
      "off",
    );
    // A stored level wins over both the env default and the crew exception.
    expect(fromRow("high")).toBe("high");
    expect(resolveAgentThinkingLevel({ thinkingLevel: fromRow("high"), crewResponder: true })).toBe(
      "high",
    );
    // An explicit `off` is a real choice, distinct from unset.
    expect(fromRow("off")).toBe("off");
    expect(resolveAgentThinkingLevel({ thinkingLevel: fromRow("off") })).toBe("off");
  });
});

describe("agent spawn / config option parsing", () => {
  it("accepts thinking:high, --thinking high and the legacy `thinking high` word pair", () => {
    expect(
      parseSpawnOptions(["model", "x/y", "thinking:high", "budget:30", "goal", "do", "it"]),
    ).toEqual({
      model: "x/y",
      role: undefined,
      goal: "do it",
      key: undefined,
      budgetCalls: 30,
      thinkingLevel: "high",
    });
    expect(parseSpawnOptions(["--thinking", "medium", "role", "coder"])).toMatchObject({
      role: "coder",
      thinkingLevel: "medium",
    });
    expect(parseSpawnOptions(["thinking", "low"])).toMatchObject({ thinkingLevel: "low" });
    expect(parseSpawnOptions(["thinking=off"])).toMatchObject({ thinkingLevel: "off" });
    expect(parseSpawnOptions(["budget", "12"])).toMatchObject({ budgetCalls: 12 });
  });

  it("reports a bad level or budget instead of spawning", () => {
    expect(parseSpawnOptions(["thinking:loud"])).toMatchObject({
      error: expect.stringContaining("thinking expects one of"),
    });
    expect(parseSpawnOptions(["budget:zero"])).toMatchObject({
      error: expect.stringContaining("budget"),
    });
    expect(parseSpawnOptions(["budget", "0"])).toMatchObject({
      error: expect.stringContaining("positive whole number"),
    });
  });
});

describe("thinking level — model shaping and request body", () => {
  it("reserves pi-ai's medium thinking allowance plus room for the tool call on the wire", async () => {
    using _state = scopeProcessState({ env: { AGENT_CREW_MAX_TOKENS: undefined } });
    const seen: Record<string, unknown>[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    }) as typeof fetch;
    const adapter = new LeanAgentAdapter(
      {
        name: "thinking-output",
        model: "marina/default",
        crewResponder: true,
        thinkingLevel: "medium",
      },
      "ws://127.0.0.1:3300",
      null,
      undefined,
      undefined,
      undefined,
      fetchImpl,
    );
    const internals = adapter as unknown as {
      model: Model<Api>;
      providerStreamOptions(model: Model<Api>, options: SimpleStreamOptions): SimpleStreamOptions;
    };
    expect(adapter.getStatus().maxOutputTokens).toBe(8192 + 2048);
    const options = internals.providerStreamOptions(internals.model, {
      reasoning: "medium",
      apiKey: "test",
      fetch: fetchImpl,
    });
    const stream = piModels.streamSimple(
      internals.model,
      {
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      },
      options,
    );
    const response = await stream.result();
    expect(response.stopReason).not.toBe("error");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.max_tokens ?? seen[0]!.max_completion_tokens).toBe(10240);
    expect(seen[0]!.reasoning_effort).toBe("medium");
  });

  it("uses custom thinking budgets for compact agents", () => {
    using _state = scopeProcessState({ env: { AGENT_COMPACT_MAX_TOKENS: undefined } });
    const adapter = new LeanAgentAdapter(
      {
        name: "custom-thinking-output",
        model: "marina/default",
        toolProfile: "crew",
        thinkingLevel: "high",
        thinkingBudgets: { high: 12000 },
      },
      "ws://127.0.0.1:3300",
      null,
    );
    expect(adapter.getStatus().maxOutputTokens).toBe(14048);
  });

  it("honors operator caps and warns when thinking and a tool call cannot fit", () => {
    using _state = scopeProcessState({ env: { AGENT_CREW_MAX_TOKENS: "3000" } });
    const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    try {
      const config = {
        name: "capped-thinking",
        model: "marina/default",
        crewResponder: true,
        thinkingLevel: "medium" as const,
      };
      const explicit = new LeanAgentAdapter(
        { ...config, maxTokens: 2048 },
        "ws://127.0.0.1:3300",
        null,
      );
      const env = new LeanAgentAdapter(config, "ws://127.0.0.1:3300", null);
      expect(explicit.getStatus().maxOutputTokens).toBe(2048);
      expect(env.getStatus().maxOutputTokens).toBe(3000);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]![1]).toContain("thinking budget 8192 plus 2048");
    } finally {
      warn.mockRestore();
    }
  });

  it("bounds automatic output to leave prompt room and recalculates it when thinking changes", async () => {
    using _state = scopeProcessState({ env: { AGENT_CREW_MAX_TOKENS: undefined } });
    const adapter = new LeanAgentAdapter(
      {
        name: "reconfigured-thinking",
        model: "anthropic/claude-sonnet-4-6",
        crewResponder: true,
        thinkingLevel: "off",
      },
      "ws://127.0.0.1:3300",
      null,
    );
    const internals = adapter as unknown as { effectiveContextWindow: number; model: Model<Api> };
    internals.effectiveContextWindow = 32000;
    expect(adapter.getStatus().maxOutputTokens).toBe(2048);
    await adapter.reconfigure({ thinkingLevel: "medium" });
    expect(adapter.getStatus().maxOutputTokens).toBe(10240);
    expect(internals.model.reasoning).toBe(true);
    expect(internals.effectiveContextWindow).toBe(32000);
    await adapter.reconfigure({ thinkingLevel: "off" });
    expect(adapter.getStatus().maxOutputTokens).toBe(2048);

    const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    try {
      const small = new LeanAgentAdapter(
        {
          name: "small-thinking",
          model: "marina/default",
          contextWindow: 16384,
          crewResponder: true,
          thinkingLevel: "high",
        },
        "ws://127.0.0.1:3300",
        null,
      );
      expect(small.getStatus().maxOutputTokens).toBe(8192);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("marks the marina proxy model reasoning-capable only when thinking is on", () => {
    const off = applyThinkingLevel(resolveModel("marina/default"), "off");
    expect(off.reasoning).toBe(false);
    const high = applyThinkingLevel(resolveModel("marina/default"), "high");
    expect(high.reasoning).toBe(true);
    expect((high.compat as { supportsReasoningEffort?: boolean }).supportsReasoningEffort).toBe(
      true,
    );
    // Back to off: the reasoning directive is dropped again.
    expect(applyThinkingLevel(high, "off").reasoning).toBe(false);
  });

  it("the adapter hands pi-agent the resolved level (explicit → env default → crew off)", () => {
    const explicit = new LeanAgentAdapter(
      { name: "think-explicit", thinkingLevel: "high" },
      "ws://127.0.0.1:3300",
      null,
    );
    const agent = (
      explicit as unknown as {
        agent: { state: { thinkingLevel: string; model: { reasoning: boolean } } };
      }
    ).agent;
    expect(agent.state.thinkingLevel).toBe("high");
    expect(agent.state.model.reasoning).toBe(true);

    process.env.MARINA_AGENT_THINKING = "medium";
    const fromEnv = new LeanAgentAdapter({ name: "think-env" }, "ws://127.0.0.1:3300", null);
    expect(
      (fromEnv as unknown as { agent: { state: { thinkingLevel: string } } }).agent.state
        .thinkingLevel,
    ).toBe("medium");
    const crew = new LeanAgentAdapter(
      { name: "think-crew", crewResponder: true },
      "ws://127.0.0.1:3300",
      null,
    );
    expect(
      (
        crew as unknown as {
          agent: { state: { thinkingLevel: string; model: { reasoning: boolean } } };
        }
      ).agent.state.thinkingLevel,
    ).toBe("off");
  });

  it("on the marina proxy, a thinking agent's request carries reasoning_effort; off sends none", async () => {
    const seen: Record<string, unknown>[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        model: "m",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      })}\n\ndata: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`;
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const context = {
      systemPrompt: "",
      messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
    };
    const drain = async (model: ReturnType<typeof resolveModel>, reasoning?: "high") => {
      const stream = piModels.streamSimple(model, context, {
        reasoning,
        apiKey: "test",
        fetch: fetchImpl,
        maxRetries: 0,
      });
      for await (const _event of stream) {
        // consume
      }
    };
    await drain(applyThinkingLevel(resolveModel("marina/default"), "high"), "high");
    await drain(applyThinkingLevel(resolveModel("marina/default"), "off"));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.reasoning_effort).toBe("high");
    expect(seen[1]).not.toHaveProperty("reasoning_effort");
  });
});

describe("tool execution ordering", () => {
  const tool = (name: string): AgentTool =>
    ({
      name,
      label: name,
      description: "",
      parameters: {},
      execute: async () => ({}),
    }) as unknown as AgentTool;

  it("classifies observing tools as read-only and everything else as mutating", () => {
    expect(READ_ONLY_TOOL_NAMES.has("marina_look")).toBe(true);
    expect(isMutatingToolName("marina_code_read_file")).toBe(false);
    for (const name of [
      "marina_say",
      "marina_move",
      "marina_command",
      "memory",
      "marina_code_write",
    ])
      expect(isMutatingToolName(name)).toBe(true);
  });

  it("auto policy stamps mutators sequential and leaves reads parallel; env overrides", () => {
    const stamped = applyToolExecutionModes([tool("marina_say"), tool("marina_look")], {});
    expect(stamped[0]!.executionMode).toBe("sequential");
    expect(stamped[1]!.executionMode).toBeUndefined();
    expect(agentToolExecutionMode({})).toBeUndefined();
    const parallel = { MARINA_TOOL_EXECUTION: "parallel" } as NodeJS.ProcessEnv;
    expect(toolExecutionPolicy(parallel)).toBe("parallel");
    expect(
      applyToolExecutionModes([tool("marina_say")], parallel)[0]!.executionMode,
    ).toBeUndefined();
    expect(agentToolExecutionMode(parallel)).toBe("parallel");
    const sequential = { MARINA_TOOL_EXECUTION: "sequential" } as NodeJS.ProcessEnv;
    expect(agentToolExecutionMode(sequential)).toBe("sequential");
    expect(toolExecutionPolicy({ MARINA_TOOL_EXECUTION: "weird" } as NodeJS.ProcessEnv)).toBe(
      "auto",
    );
  });

  it("the adapter's resident tools carry the stamps and the Agent keeps the library default", () => {
    delete process.env.MARINA_TOOL_EXECUTION;
    const adapter = new LeanAgentAdapter({ name: "exec-order" }, "ws://127.0.0.1:3300", null);
    const agent = (
      adapter as unknown as { agent: { toolExecution: string; state: { tools: AgentTool[] } } }
    ).agent;
    expect(agent.toolExecution).toBe("parallel");
    const byName = new Map(agent.state.tools.map((t) => [t.name, t.executionMode]));
    expect(byName.get("marina_command")).toBe("sequential");
    expect(byName.get("marina_tell")).toBe("sequential");
    expect(byName.get("marina_brief")).toBeUndefined();
    expect(byName.get("think")).toBeUndefined();

    process.env.MARINA_TOOL_EXECUTION = "sequential";
    const strict = new LeanAgentAdapter({ name: "exec-strict" }, "ws://127.0.0.1:3300", null);
    expect((strict as unknown as { agent: { toolExecution: string } }).agent.toolExecution).toBe(
      "sequential",
    );
  });
});
