// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agents on models that reason without being asked (OpenRouter routes, ids the
 * registry does not know) must still reach a tool call:
 *  - the compact crew output cap leaves room for hidden reasoning, and a turn
 *    that ends on its length limit without a tool call grows an automatic cap
 *    (never an operator's explicit one);
 *  - OpenRouter requests with tools ask for `require_parameters`; the reasoning
 *    disable is sent only for a model a probe verified, and an upstream that
 *    refuses either field teaches the adapter to drop it;
 *  - the spawn-time tool-calling probe reports a model that answers in prose.
 *
 * The upstream replies below are recorded shapes from OpenRouter (2026-10),
 * reduced to the fields Marina reads.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AgentRuntime } from "../src/agent/agent-runtime";
import {
  grownPromptTimeoutMs,
  LeanAgentAdapter,
  resolveModel,
} from "../src/agent/lean-agent-adapter";
import {
  grownOutputCap,
  isReasoningOffVerified,
  markReasoningOffVerified,
  noteUpstreamRejection,
  REASONING_HEADROOM_TOKENS,
  reasoningHeadroomCap,
  resetReasoningControlForTests,
  shapeOpenRouterPayload,
} from "../src/agent/reasoning-control";
import {
  describeToolProbe,
  INCONCLUSIVE_PROBE_RETRY_MS,
  listToolProbeResults,
  type ProbeComplete,
  probeToolCalling,
  recordToolProbeResultForTests,
  resetToolProbeForTests,
  shouldProbeTools,
  toolProbeMode,
  toolProbeResult,
} from "../src/agent/tool-call-probe";
import { recordSpend, resetSpendLedgerForTests } from "../src/engine/spend-ledger";
import { scopeProcessState } from "./process-state";

const OR_MODEL = {
  id: "deepseek/deepseek-v4-pro-0813",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
};
const TOOLS = [{ type: "function", function: { name: "marina_command", parameters: {} } }];

afterEach(() => {
  resetReasoningControlForTests();
  resetToolProbeForTests();
});

describe("OpenRouter request shaping", () => {
  it("asks for providers that honour every parameter when tools are sent", () => {
    const shaped = shapeOpenRouterPayload(
      { model: OR_MODEL.id, tools: TOOLS },
      OR_MODEL,
      "off",
      {},
    );
    expect(shaped?.provider).toEqual({ require_parameters: true });
    expect(shaped?.reasoning).toBeUndefined();
    // No tools → nothing to require; a non-OpenRouter model is never touched.
    expect(shapeOpenRouterPayload({ model: OR_MODEL.id }, OR_MODEL, "off", {})).toBeUndefined();
    expect(
      shapeOpenRouterPayload(
        { tools: TOOLS },
        { id: "claude-sonnet-5", provider: "anthropic", baseUrl: "https://api.anthropic.com" },
        "off",
        {},
      ),
    ).toBeUndefined();
  });

  it("merges into an existing provider preference and never overrides an explicit flag", () => {
    const merged = shapeOpenRouterPayload(
      { tools: TOOLS, provider: { order: ["Together"] } },
      OR_MODEL,
      "off",
      {},
    );
    expect(merged?.provider).toEqual({ order: ["Together"], require_parameters: true });
    expect(
      shapeOpenRouterPayload(
        { tools: TOOLS, provider: { require_parameters: false } },
        OR_MODEL,
        "off",
        {},
      ),
    ).toBeUndefined();
  });

  it("sends the reasoning disable only for a probe-verified model with thinking off", () => {
    expect(shapeOpenRouterPayload({}, OR_MODEL, "off", {})).toBeUndefined();
    markReasoningOffVerified(OR_MODEL.id);
    expect(shapeOpenRouterPayload({}, OR_MODEL, "off", {})?.reasoning).toEqual({ enabled: false });
    // Thinking on, an explicit directive, or the env switch → untouched.
    expect(shapeOpenRouterPayload({}, OR_MODEL, "medium", {})).toBeUndefined();
    expect(
      shapeOpenRouterPayload({ reasoning_effort: "low" }, OR_MODEL, "off", {}),
    ).toBeUndefined();
    expect(
      shapeOpenRouterPayload({}, OR_MODEL, "off", { MARINA_OPENROUTER_REASONING_OFF: "off" }),
    ).toBeUndefined();
    expect(
      shapeOpenRouterPayload({ tools: TOOLS }, OR_MODEL, "off", {
        MARINA_OPENROUTER_REQUIRE_PARAMETERS: "off",
      })?.provider,
    ).toBeUndefined();
  });

  it("learns from upstream refusals and stops sending the refused field", () => {
    markReasoningOffVerified(OR_MODEL.id);
    // Recorded: google/gemini-3.5-flash-lite with reasoning disabled.
    expect(
      noteUpstreamRejection(
        OR_MODEL.id,
        "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
      ),
    ).toBe("reasoning-mandatory");
    expect(isReasoningOffVerified(OR_MODEL.id)).toBe(false);
    markReasoningOffVerified(OR_MODEL.id); // a later probe cannot re-enable it
    expect(shapeOpenRouterPayload({}, OR_MODEL, "off", {})).toBeUndefined();
    // Learned once: a repeat is not a new lesson.
    expect(noteUpstreamRejection(OR_MODEL.id, "Reasoning is mandatory")).toBeUndefined();

    expect(
      noteUpstreamRejection(
        OR_MODEL.id,
        "404 No endpoints found that can handle the requested parameters.",
      ),
    ).toBe("no-endpoint-for-parameters");
    expect(shapeOpenRouterPayload({ tools: TOOLS }, OR_MODEL, "off", {})).toBeUndefined();
    expect(noteUpstreamRejection(OR_MODEL.id, "429 rate limited")).toBeUndefined();
  });
});

describe("output cap for models that reason unasked", () => {
  it("leaves reasoning headroom and grows toward a ceiling", () => {
    expect(reasoningHeadroomCap(2048, 384_000)).toBe(REASONING_HEADROOM_TOKENS);
    expect(reasoningHeadroomCap(2048, 4096)).toBe(4096);
    expect(grownOutputCap(2048, 64_000)).toBe(8192);
    expect(grownOutputCap(8192, 64_000)).toBe(16_384);
    expect(grownOutputCap(60_000, 64_000)).toBe(64_000);
    expect(grownOutputCap(64_000, 64_000)).toBeUndefined();
  });

  it("gives an OpenRouter crew lead headroom; registry and proxy models keep 2048", () => {
    using _state = scopeProcessState({ env: { AGENT_CREW_MAX_TOKENS: undefined } });
    const lead = (model: string) =>
      new LeanAgentAdapter(
        { name: "lead", model, crewResponder: true },
        "ws://127.0.0.1:3300",
        null,
      );
    expect(lead("openrouter/deepseek/deepseek-v4-pro-0813").getStatus().maxOutputTokens).toBe(
      REASONING_HEADROOM_TOKENS,
    );
    expect(lead("anthropic/claude-sonnet-4-6").getStatus().maxOutputTokens).toBe(2048);
    expect(lead("marina/default").getStatus().maxOutputTokens).toBe(2048);
  });

  it("grows an automatic cap after a length stop with no tool call, never an explicit one", () => {
    using _state = scopeProcessState({ env: { AGENT_CREW_MAX_TOKENS: undefined } });
    type Internals = {
      growOutputCapAfterLengthStop(message: unknown): number | undefined;
      model: Model<Api>;
    };
    const auto = new LeanAgentAdapter(
      { name: "auto", model: "marina/default", crewResponder: true },
      "ws://127.0.0.1:3300",
      null,
    );
    const a = auto as unknown as Internals;
    expect(a.growOutputCapAfterLengthStop({ stopReason: "stop" })).toBeUndefined();
    expect(a.growOutputCapAfterLengthStop({ stopReason: "length" })).toBe(8192);
    expect(auto.getStatus().maxOutputTokens).toBe(8192);
    expect(a.model.maxTokens).toBe(8192);
    expect(a.growOutputCapAfterLengthStop({ stopReason: "length" })).toBe(16_384);

    const pinned = new LeanAgentAdapter(
      { name: "pinned", model: "marina/default", crewResponder: true, maxTokens: 2048 },
      "ws://127.0.0.1:3300",
      null,
    );
    expect(
      (pinned as unknown as Internals).growOutputCapAfterLengthStop({ stopReason: "length" }),
    ).toBeUndefined();
    expect(pinned.getStatus().maxOutputTokens).toBe(2048);
  });

  it("a timed-out prompt bound grows toward 10 minutes unless the operator set it", () => {
    expect(grownPromptTimeoutMs(120_000, false)).toBe(240_000);
    expect(grownPromptTimeoutMs(480_000, false)).toBe(600_000);
    expect(grownPromptTimeoutMs(600_000, false)).toBeUndefined();
    expect(grownPromptTimeoutMs(120_000, true)).toBeUndefined();
  });

  it("an operator's env cap is never grown", () => {
    using _state = scopeProcessState({ env: { AGENT_CREW_MAX_TOKENS: "3000" } });
    const adapter = new LeanAgentAdapter(
      { name: "env-cap", model: "openrouter/deepseek/deepseek-v4-pro-0813", crewResponder: true },
      "ws://127.0.0.1:3300",
      null,
    );
    expect(adapter.getStatus().maxOutputTokens).toBe(3000);
    expect(
      (
        adapter as unknown as { growOutputCapAfterLengthStop(m: unknown): number | undefined }
      ).growOutputCapAfterLengthStop({ stopReason: "length" }),
    ).toBeUndefined();
  });

  it("the agent's payload hook adds require_parameters for OpenRouter tool requests", () => {
    const adapter = new LeanAgentAdapter(
      { name: "shaped", model: "openrouter/deepseek/deepseek-v4-pro-0813", crewResponder: true },
      "ws://127.0.0.1:3300",
      null,
    );
    const agent = (
      adapter as unknown as {
        agent: { onPayload: (payload: unknown, model: Model<Api>) => unknown };
      }
    ).agent;
    const model = resolveModel("openrouter/deepseek/deepseek-v4-pro-0813");
    const body = agent.onPayload({ model: model.id, tools: TOOLS, messages: [] }, model) as Record<
      string,
      unknown
    >;
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.reasoning).toBeUndefined();
  });
});

/** A recorded-shape assistant reply. */
function reply(over: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "openrouter",
    model: OR_MODEL.id,
    usage: {
      input: 60,
      output: 52,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 112,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...over,
  } as AssistantMessage;
}

const TOOL_REPLY = reply({
  stopReason: "toolUse",
  content: [
    {
      type: "toolCall",
      id: "c1",
      name: "send_message",
      arguments: { channel: "general", text: "ready" },
    },
  ],
});

describe("spawn-time tool-calling probe", () => {
  it("probes only unlisted ids and OpenRouter routes, and is off under a test runner", () => {
    expect(shouldProbeTools("openrouter/deepseek/deepseek-v4-pro-0813", "exact")).toBe(true);
    expect(shouldProbeTools("openai/some-new-id", "synthesized")).toBe(true);
    expect(shouldProbeTools("anthropic/claude-sonnet-5", "exact")).toBe(false);
    expect(shouldProbeTools("marina/default", "exact")).toBe(false);
    expect(shouldProbeTools("llama/qwen3", "exact")).toBe(false);
    expect(toolProbeMode({ NODE_ENV: "test" })).toBe("off");
    expect(toolProbeMode({})).toBe("warn");
    expect(toolProbeMode({ MARINA_TOOL_PROBE: "refuse", NODE_ENV: "test" })).toBe("refuse");
  });

  it("records a tool-calling model and verifies the reasoning disable for it", async () => {
    const payloads: unknown[] = [];
    const complete: ProbeComplete = async (_m, _c, options) => {
      payloads.push(options.onPayload({ tools: TOOLS, messages: [] }));
      return TOOL_REPLY;
    };
    const model = resolveModel("openrouter/deepseek/deepseek-v4-pro-0813");
    const result = await probeToolCalling("openrouter/deepseek/deepseek-v4-pro-0813", model, "k", {
      complete,
    });
    expect(result.outcome).toBe("tools");
    expect(result.reasoningOff).toBe("tools");
    expect(isReasoningOffVerified(model.id)).toBe(true);
    expect((payloads[0] as Record<string, unknown>).provider).toEqual({ require_parameters: true });
    expect((payloads[0] as Record<string, unknown>).reasoning).toBeUndefined();
    expect((payloads[1] as Record<string, unknown>).reasoning).toEqual({ enabled: false });
    expect(describeToolProbe("openrouter/deepseek/deepseek-v4-pro-0813")).toContain(
      "reasoning-off verified",
    );
  });

  it("reports prose, keeps a mandatory-reasoning model off the disable, and retries inconclusive probes", async () => {
    const model = resolveModel("openrouter/google/gemini-3.5-flash-lite");
    let call = 0;
    const result = await probeToolCalling("openrouter/google/gemini-3.5-flash-lite", model, "k", {
      complete: async () =>
        ++call === 1
          ? reply({ content: [{ type: "text", text: "I would send 'ready' to general." }] })
          : reply({
              stopReason: "error",
              errorMessage: "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
            }),
    });
    expect(result.outcome).toBe("no-tool-call");
    expect(result.reasoningOff).toBe("rejected");
    expect(isReasoningOffVerified(model.id)).toBe(false);
    expect(describeToolProbe(result.model)).toContain("NO tool call");
    expect(listToolProbeResults().map((r) => r.model)).toEqual([result.model]);

    const other = resolveModel("openrouter/moonshotai/kimi-k3");
    const failed = await probeToolCalling("openrouter/moonshotai/kimi-k3", other, "k", {
      complete: async () => {
        throw new Error("network down");
      },
    });
    expect(failed.outcome).toBe("unknown");
    expect(toolProbeResult("openrouter/moonshotai/kimi-k3")).toBeUndefined();
  });

  it("backs off an inconclusive probe and sends none at the daily spend cap", async () => {
    let calls = 0;
    let clock = 1_000;
    const failing: ProbeComplete = async () => {
      calls++;
      throw new Error("network down");
    };
    const id = "openrouter/moonshotai/kimi-k3";
    const model = resolveModel(id);
    const opts = { complete: failing, now: () => clock, env: {} as NodeJS.ProcessEnv };
    expect((await probeToolCalling(id, model, "k", opts)).outcome).toBe("unknown");
    expect(calls).toBe(1);
    // A respawn inside the back-off reuses the inconclusive result: no new request.
    clock += INCONCLUSIVE_PROBE_RETRY_MS - 1;
    expect((await probeToolCalling(id, model, "k", opts)).outcome).toBe("unknown");
    expect(calls).toBe(1);
    clock += 2;
    await probeToolCalling(id, model, "k", opts);
    expect(calls).toBe(2);

    resetSpendLedgerForTests();
    try {
      recordSpend("model_api", 5);
      let capped = 0;
      const result = await probeToolCalling("openrouter/example/new-model", model, "k", {
        complete: async () => {
          capped++;
          return TOOL_REPLY;
        },
        env: { MARINA_DAILY_SPEND_CAP_USD: "5" } as NodeJS.ProcessEnv,
      });
      expect(capped).toBe(0);
      expect(result.outcome).toBe("unknown");
      expect(result.detail).toContain("daily spend cap reached");
      expect(toolProbeResult("openrouter/example/new-model")).toBeUndefined();
    } finally {
      resetSpendLedgerForTests();
    }
  });

  it("shares one probe between concurrent spawns", async () => {
    let calls = 0;
    const complete: ProbeComplete = async () => {
      calls++;
      return TOOL_REPLY;
    };
    const model = resolveModel("openrouter/deepseek/deepseek-v4-pro-0813");
    await Promise.all([
      probeToolCalling("openrouter/deepseek/deepseek-v4-pro-0813", model, "k", { complete }),
      probeToolCalling("openrouter/deepseek/deepseek-v4-pro-0813", model, "k", { complete }),
    ]);
    expect(calls).toBe(2); // one probe: the default request + the reasoning-off variant
  });
});

describe("probe results surface to operators", () => {
  it("agent status and readiness name a model that made no tool call", async () => {
    recordToolProbeResultForTests({
      model: "openrouter/example/prose-only",
      outcome: "no-tool-call",
      detail: "no tool call (stop=stop, 40 output tokens)",
      at: 1,
    });
    const adapter = new LeanAgentAdapter(
      { name: "prose", model: "openrouter/example/prose-only" },
      "ws://127.0.0.1:3300",
      null,
    );
    expect(adapter.getStatus().toolProbe).toContain("NO tool call");
  });

  it("refuse mode stops a crew lead whose model answered in prose", async () => {
    using _state = scopeProcessState({ env: { MARINA_TOOL_PROBE: "refuse" } });
    const events: Array<{ type: string; error?: string }> = [];
    const runtime = new AgentRuntime({
      onEvent: (e) => events.push(e as { type: string; error?: string }),
      toolProbeComplete: async () => reply({ content: [{ type: "text", text: "ready" }] }),
    });
    const internals = runtime as unknown as {
      agents: Map<string, unknown>;
      startToolProbe(name: string, config: Record<string, unknown>, key?: string): void;
      stop(name: string): Promise<void>;
    };
    const stopped: string[] = [];
    internals.agents.set("Lead", {});
    internals.stop = async (name: string) => {
      stopped.push(name);
    };
    internals.startToolProbe(
      "Lead",
      { name: "Lead", model: "openrouter/example/prose-lead", crewResponder: true },
      "k",
    );
    await runtime.settleToolProbes();
    expect(stopped).toEqual(["Lead"]);
    expect(
      events.some((e) => e.type === "agent_error" && e.error?.includes("stopped this crew lead")),
    ).toBe(true);
  });
});
