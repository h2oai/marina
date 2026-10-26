// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * An agent's thinking level reaches the upstream on every route it can take,
 * and an explicit level wins over Marina's automatic reasoning shaping:
 *
 *  (a) a direct OpenRouter chat-completions model — `reasoning.effort`;
 *  (b) a Claude model on the Anthropic Messages API, through OpenRouter or
 *      Anthropic directly — adaptive thinking at the level's effort with
 *      sampling fields omitted; `off` sends `thinking: {type: "disabled"}`
 *      (before, a managed-effort Claude thought at `high` with thinking off);
 *  (c) `marina/cheap` through Marina's own `/v1` passthru — the agent sends
 *      `reasoning_effort`, the passthru forwards it upstream (moved to an
 *      effort the routed OpenRouter model accepts), the cheap tier's output cap
 *      adds no reasoning budget over it, and the reasoning tokens the upstream
 *      reports land on `model_request_lifecycle`;
 *  (d) a direct OpenAI key — Responses `reasoning.effort`.
 *
 * Each route drives the real adapter (pi-agent `Agent.prompt` → the adapter's
 * `streamFn` / `onPayload`) against a mocked upstream; nothing leaves the
 * process. Off sends no reasoning setting except where the provider takes an
 * explicit disable that cannot be refused (Anthropic).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentThinkingLevel } from "../src/agent/agent-types";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import {
  effectiveThinkingLevel,
  resetEffectiveThinkingForTests,
  runningThinkingLevel,
} from "../src/agent/effective-thinking";
import { extractTurnUsage, LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import {
  markReasoningOffVerified,
  resetReasoningControlForTests,
} from "../src/agent/reasoning-control";
import { describeThinking } from "../src/engine/commands/agent";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests } from "../src/engine/trust-profile";
import { handleModelApi } from "../src/net/model/model-api";
import { setEndpointConfig } from "../src/net/model/model-endpoint";
import { openRouterEffortFor, withOpenRouterEffort } from "../src/net/model/reasoning-effort";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

// Fake credentials, built at runtime (never a secret-shaped literal).
const fakeKey = (provider: string) => ["test", provider, "key", "0"].join("-");

const OPENAI_SSE = `data: ${JSON.stringify({
  id: "c",
  object: "chat.completion.chunk",
  model: "m",
  choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
})}\n\ndata: ${JSON.stringify({
  id: "c",
  object: "chat.completion.chunk",
  model: "m",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
})}\n\ndata: ${JSON.stringify({
  id: "c",
  object: "chat.completion.chunk",
  model: "m",
  choices: [],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 300,
    completion_tokens_details: { reasoning_tokens: 250 },
  },
})}\n\ndata: [DONE]\n\n`;

/** Capture every upstream request body; answer with a short OpenAI-style stream. */
function capture(): { bodies: Record<string, unknown>[]; fetch: typeof fetch } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    // One reply shape for every route: only the request body is under test.
    return new Response(OPENAI_SSE, { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  return { bodies, fetch: fetchImpl };
}

/** The first request body the agent sends for one prompt at `thinking`. */
async function agentRequest(
  model: string,
  thinking: AgentThinkingLevel,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const { bodies, fetch } = capture();
  const adapter = new LeanAgentAdapter(
    { name: `think-${thinking}-${model.replace(/\W/g, "-")}`, model, thinkingLevel: thinking },
    "ws://127.0.0.1:3300",
    null,
    apiKey,
    undefined,
    undefined,
    fetch,
  );
  const agent = (adapter as unknown as { agent: { prompt(text: string): Promise<void> } }).agent;
  // allow-empty-catch: a reply this route cannot parse fails the turn; the request body is what is tested
  await agent.prompt("hi").catch(() => {});
  expect(bodies.length).toBeGreaterThan(0);
  return bodies[0]!;
}

/** The trailing managed-effort marker pi-ai appends for a mid-conversation-effort Claude. */
function trailingEffort(body: Record<string, unknown>): unknown {
  const messages = (body.messages ?? []) as {
    role?: string;
    output_config?: { effort?: string };
  }[];
  const last = messages.at(-1);
  return last?.role === "system" ? last.output_config?.effort : undefined;
}

let state: DisposableStack | undefined;
beforeEach(() => {
  state = scopeProcessState({
    env: { MARINA_AGENT_THINKING: undefined, AGENT_CREW_MAX_TOKENS: undefined },
  });
});
afterEach(() => {
  state?.[Symbol.dispose]();
  state = undefined;
  resetReasoningControlForTests();
  resetEffectiveThinkingForTests();
});

describe("(a) direct OpenRouter chat-completions model", () => {
  const MODEL = "openrouter/nvidia/nemotron-3.5-super-vl";

  it("thinking on sends reasoning.effort; off sends no reasoning setting", async () => {
    const on = await agentRequest(MODEL, "medium", fakeKey("openrouter"));
    expect(on.reasoning).toEqual({ effort: "medium" });
    expect(on).not.toHaveProperty("reasoning_effort");
    const off = await agentRequest(MODEL, "off", fakeKey("openrouter"));
    expect(off).not.toHaveProperty("reasoning");
    expect(off).not.toHaveProperty("reasoning_effort");
  });

  it("an explicit level wins over the probe-verified reasoning disable", async () => {
    markReasoningOffVerified("nvidia/nemotron-3.5-super-vl");
    const on = await agentRequest(MODEL, "high", fakeKey("openrouter"));
    expect(on.reasoning).toEqual({ effort: "high" });
    // Only an agent with thinking off gets the disable.
    const off = await agentRequest(MODEL, "off", fakeKey("openrouter"));
    expect(off.reasoning).toEqual({ enabled: false });
  });
});

describe("(b) Claude on the Anthropic Messages API", () => {
  for (const model of ["openrouter/anthropic/claude-haiku-5.5", "anthropic/claude-haiku-5-5"]) {
    it(`${model}: on → adaptive thinking at the level; off → thinking disabled`, async () => {
      const provider = model.startsWith("openrouter/") ? "openrouter" : "anthropic";
      const on = await agentRequest(model, "medium", fakeKey(provider));
      expect((on.thinking as { type?: string }).type).toBe("adaptive");
      expect(trailingEffort(on)).toBe("medium");
      expect(on).not.toHaveProperty("temperature");
      expect(on).not.toHaveProperty("top_p");
      const off = await agentRequest(model, "off", fakeKey(provider));
      // Before: no reasoning flag ⇒ pi-ai's managed-effort branch thought at `high`.
      expect(off.thinking).toEqual({ type: "disabled" });
      expect(trailingEffort(off)).toBeUndefined();
      expect(off).not.toHaveProperty("output_config");
    });
  }

  it("a Claude without managed effort takes the level as output_config.effort, sampling dropped", async () => {
    const on = await agentRequest("anthropic/claude-sonnet-4-6", "medium", fakeKey("anthropic"));
    expect(on.thinking).toMatchObject({ type: "adaptive" });
    expect(on.output_config).toEqual({ effort: "medium" });
    expect(on).not.toHaveProperty("temperature");
    const off = await agentRequest("anthropic/claude-sonnet-4-6", "off", fakeKey("anthropic"));
    expect(off.thinking).toEqual({ type: "disabled" });
    expect(off).not.toHaveProperty("output_config");
  });

  it("thinking off on a managed-effort Claude keeps the compact output cap (no hidden reasoning)", () => {
    const adapter = new LeanAgentAdapter(
      {
        name: "claude-off-cap",
        model: "anthropic/claude-haiku-5-5",
        crewResponder: true,
        thinkingLevel: "off",
      },
      "ws://127.0.0.1:3300",
      null,
    );
    expect(adapter.getStatus().maxOutputTokens).toBe(2048);
    expect(adapter.getStatus().thinkingSent).toBe("off");
  });
});

describe("(d) direct OpenAI key", () => {
  it("Responses reasoning.effort when on; none when off", async () => {
    const on = await agentRequest("openai/gpt-5.5", "medium", fakeKey("openai"));
    expect((on.reasoning as { effort?: string }).effort).toBe("medium");
    const off = await agentRequest("openai/gpt-5.5", "off", fakeKey("openai"));
    expect(off).not.toHaveProperty("reasoning");
  });
});

// ── (c) marina/cheap through the /v1 passthru (OpenRouter mocked) ───────────

const CHEAP = "deepseek/deepseek-v4.1-flash";
const ENV = [
  ...modelSourceEnvKeys(),
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_DAILY_SPEND_CAP_USD",
  "MARINA_MODEL_TIER_CHEAP",
  "MARINA_MODEL_TIER_STRONG",
  "MARINA_DEFAULT_MODEL",
] as const;

describe("(c) marina/cheap through the local /v1 passthru", () => {
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  let env: DisposableStack;
  let originalFetch: typeof fetch;
  let upstream: Record<string, unknown>[];

  beforeEach(() => {
    env = scopeProcessState({
      env: {
        ...Object.fromEntries(ENV.map((k) => [k, undefined])),
        MARINA_OPEN_API: "true",
        OPENROUTER_API_KEY: fakeKey("openrouter"),
      },
    });
    resetTrustProfileForTests();
    upstream = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("openrouter.ai")) throw new Error(`unexpected ${url}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstream.push(body);
      return Response.json({
        id: "c1",
        object: "chat.completion",
        model: body.model,
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 40,
          completion_tokens: 300,
          completion_tokens_details: { reasoning_tokens: body.reasoning_effort ? 250 : 0 },
          cost: 0.0001,
        },
      });
    }) as typeof fetch;
    dir = mkdtempSync(join(tmpdir(), "thinking-e2e-"));
    db = new MarinaDB(join(dir, "w.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    engine.addConnection(new MockConnection("c1"));
    engine.spawnEntity("c1", "Agent1");
    setEndpointConfig(db, { mode: "passthru" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    engine.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    env[Symbol.dispose]();
  });

  /** Send what the agent sent to `marina/cheap` through the passthru; return the upstream body. */
  async function viaPassthru(agentBody: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = new URL("http://localhost:3300/v1/chat/completions");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...agentBody, stream: false }),
    });
    const resp = await handleModelApi(url, "POST", req, engine);
    expect(resp?.status).toBe(200);
    await resp?.text();
    return upstream.at(-1)!;
  }

  type Lifecycle = Extract<EngineEvent, { type: "model_request_lifecycle" }>;
  const lastCompleted = (): Lifecycle | undefined =>
    engine
      .getEventLog()
      .filter(
        (e): e is Lifecycle => e.type === "model_request_lifecycle" && e.phase === "completed",
      )
      .at(-1);

  it("the agent's effort reaches OpenRouter (clamped to one the model takes); off sends none", async () => {
    // The agent → proxy hop: pi-ai's openai-completions body for `marina/cheap`.
    const on = await agentRequest("marina/cheap", "medium", "internal");
    expect(on.reasoning_effort).toBe("medium");
    expect(on.model).toBe("cheap");
    const off = await agentRequest("marina/cheap", "off", "internal");
    expect(off).not.toHaveProperty("reasoning_effort");

    // The proxy → upstream hop. deepseek-v4.1-flash has no `medium`: pi-ai would
    // send `high` on a direct route, so the passthru does too.
    const sentOn = await viaPassthru(on);
    expect(sentOn.model).toBe(CHEAP);
    expect(sentOn.reasoning_effort).toBe("high");
    // The agent's own max_tokens stands, so the tier adds no reasoning budget.
    expect(sentOn).not.toHaveProperty("reasoning");
    expect(lastCompleted()).toMatchObject({ reasoningTokens: 250, outputTokens: 300 });

    const sentOff = await viaPassthru(off);
    expect(sentOff).not.toHaveProperty("reasoning_effort");
    expect(sentOff).not.toHaveProperty("reasoning");
    expect(lastCompleted()?.reasoningTokens).toBe(0);
  });

  it("with no caller cap, an explicit effort still blocks the tier's reasoning budget", async () => {
    const sent = await viaPassthru({
      model: "marina/cheap",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "low",
    });
    expect(sent.reasoning_effort).toBe("low");
    expect(sent).not.toHaveProperty("reasoning");
    expect(sent.max_tokens).toBeGreaterThan(0);
  });
});

describe("OpenRouter effort clamp", () => {
  it("moves an effort the catalog marks unavailable; leaves valid, none and unknown ones", () => {
    expect(openRouterEffortFor(CHEAP, "medium")).toBe("high");
    expect(openRouterEffortFor(CHEAP, "high")).toBeUndefined();
    expect(openRouterEffortFor(CHEAP, "none")).toBeUndefined();
    expect(openRouterEffortFor("nvidia/nemotron-3.5-super-vl", "medium")).toBeUndefined();
    expect(openRouterEffortFor("vendor/unknown-model", "medium")).toBeUndefined();
    expect(withOpenRouterEffort({ model: CHEAP, reasoning: { effort: "medium" } })).toEqual({
      model: CHEAP,
      reasoning: { effort: "high" },
    });
    const untouched = { model: CHEAP };
    expect(withOpenRouterEffort(untouched)).toBe(untouched);
  });
});

describe("observability", () => {
  it("turn usage carries the provider's reasoning tokens; none reported ⇒ absent", () => {
    expect(
      extractTurnUsage({ usage: { input: 10, output: 300, reasoning: 250, cacheRead: 0 } }),
    ).toMatchObject({ outputTokens: 300, reasoningTokens: 250 });
    expect(extractTurnUsage({ usage: { input: 10, output: 30, reasoning: 0 } })).not.toHaveProperty(
      "reasoningTokens",
    );
  });

  it("the running agent registers the level it sends; status and diagnose show it", () => {
    const adapter = new LeanAgentAdapter(
      {
        name: "observed-thinker",
        model: "openrouter/nvidia/nemotron-3.5-super-vl",
        thinkingLevel: "medium",
      },
      "ws://127.0.0.1:3300",
      null,
    );
    const status = adapter.getStatus();
    expect(status.thinkingLevel).toBe("medium");
    expect(status.thinkingSent).toBe("medium");
    expect(runningThinkingLevel("observed-thinker")).toBe("medium");
    expect(effectiveThinkingLevel("observed-thinker", "off")).toBe("medium");
    // Not running: the saved level, then the instance default, then off.
    expect(effectiveThinkingLevel("nobody", "low")).toBe("low");
    expect(effectiveThinkingLevel("nobody", null, { MARINA_AGENT_THINKING: "high" })).toBe("high");
    expect(effectiveThinkingLevel("nobody", null, {})).toBe("off");

    expect(describeThinking(status)).toBe("medium");
    expect(
      describeThinking({ thinkingLevel: "high", thinkingSent: "off", modelCalls: 0 }),
    ).toContain("not sent");
    expect(
      describeThinking({
        thinkingLevel: "medium",
        thinkingSent: "medium",
        modelCalls: 4,
        totalReasoningTokens: 1000,
      }),
    ).toBe("medium · 250 reasoning tokens/call reported");
  });
});
