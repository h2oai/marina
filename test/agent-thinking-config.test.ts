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

import { afterEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
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
