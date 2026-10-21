// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { inferCodeDefaultModel } from "../scripts/code-model";
import { AgentRuntime } from "../src/agent/agent-runtime";
import { availableModels, modelSourceEnvKeys } from "../src/agent/available-models";
import { prepareHostedModel } from "../src/agent/hosted-model";
import {
  classifyModelResolution,
  LeanAgentAdapter,
  resolveModel,
} from "../src/agent/lean-agent-adapter";
import type { PlatformMemoryBackend } from "../src/agent/memory-platform";
import { piModels } from "../src/agent/pi-models";
import { decisionConfigFromEnv } from "../src/decisions/config";
import { testKeyConnectivity } from "../src/engine/commands/key";
import { dailyBudget, resetSpendLedgerForTests } from "../src/engine/spend-ledger";
import { parseEmbeddingEnv } from "../src/memory/embedding-config";
import { modelAccess } from "../src/model/access";
import { modelComplete } from "../src/model/complete";
import { modelTurns } from "../src/model/turns";
import {
  fetchHostedModels,
  hostedPrice,
  resetHostedCatalogsForTests,
} from "../src/net/model/hosted-catalog";
import {
  HOSTED_PROVIDERS,
  type HostedProvider,
  hostedModelsUrl,
} from "../src/net/model/hosted-providers";
import {
  discoverModels,
  MODEL_DISCOVERY_PROVIDERS,
  parseProviderResponse,
} from "../src/net/model/model-discovery";
import {
  describeDefaultUpstream,
  proxyToUpstream,
  upstreamCostUsd,
} from "../src/net/model-api/upstream";
import { __setDnsResolverForTest } from "../src/net/url-guard";
import type { EngineEvent } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState, scopeProperty } from "./process-state";

const providers: HostedProvider[] = ["together", "nebius"];
const id = "vendor/new-model:fast";
const usage = { prompt_tokens: 1_000, completion_tokens: 100, cached_tokens: 400 };
const expectedCost = 0.001 + 0.0004; // 600*$1/M + 400*$1/M + 100*$4/M
function catalog(provider: HostedProvider) {
  return provider === "together"
    ? [
        {
          id,
          display_name: "New model",
          type: "chat",
          context_length: 65536,
          pricing: { input: 1, output: 4 },
        },
      ]
    : {
        data: [
          {
            id,
            name: "New model",
            context_length: 65536,
            architecture: { modality: "text->text" },
            pricing: { prompt: "0.000001", completion: "0.000004" },
          },
        ],
      };
}
function completion(stream = false) {
  const message = {
    role: "assistant",
    content: "ok",
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"test"}' } },
    ],
  };
  if (!stream)
    return Response.json({
      id: "c-1",
      model: id,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: "tool_calls" }],
      usage,
    });
  return new Response(
    `${[
      {
        id: "c-1",
        choices: [
          {
            index: 0,
            delta: { ...message, tool_calls: message.tool_calls.map((c) => ({ index: 0, ...c })) },
            finish_reason: null,
          },
        ],
      },
      { id: "c-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
    ]
      .map((v) => `data: ${JSON.stringify(v)}\n\n`)
      .join("")}data: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const isolatedEnv = () =>
  Object.fromEntries(
    [
      ...modelSourceEnvKeys(),
      "TOGETHER_BASE_URL",
      "NEBIUS_BASE_URL",
      "MARINA_DEFAULT_MODEL",
      "MARINA_DEFAULT_TOGETHER_MODEL",
      "MARINA_DEFAULT_NEBIUS_MODEL",
      "MARINA_DECISIONS",
      "MARINA_FAKE_MODEL",
    ].map((key) => [key, undefined]),
  );
afterEach(() => {
  resetHostedCatalogsForTests();
  resetSpendLedgerForTests();
  __setDnsResolverForTest(null);
});

it("preserves exact bundled Together capabilities while using service catalog prices", () => {
  const known = piModels.getModel("together", "MiniMaxAI/MiniMax-M3")!;
  const model = resolveModel("together/MiniMaxAI/MiniMax-M3");
  expect(model.input).toEqual(known.input);
  expect(model.reasoning).toBe(known.reasoning);
  expect(model.compat).toEqual(known.compat);
  expect(model.contextWindow).toBe(known.contextWindow);
  expect(model.cost.input).toBe(0);
});

describe("hosted model catalogs", () => {
  it.each(providers)("%s normalizes prices, context and provider-qualified IDs", (provider) => {
    expect(parseProviderResponse(provider, catalog(provider))).toEqual([
      {
        value: `${provider}/${id}`,
        label: "New model",
        contextLength: 65536,
        capabilities: { text: true },
        pricing: { input: 1, output: 4, cacheRead: 1, cacheWrite: 1 },
      },
    ]);
    expect(hostedPrice(provider, {})).toBeUndefined();
  });

  it("distinguishes free, missing and invalid prices; excludes non-chat modalities", () => {
    expect(hostedPrice("together", { input: 0, output: "0" })).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    for (const input of [null, "", -1, "NaN", Infinity])
      expect(hostedPrice("together", { input, output: 1 })).toBeUndefined();
    expect(hostedPrice("together", { input: 1, output: 4, cached_input: 0.2 })?.cacheRead).toBe(
      0.2,
    );
    expect(
      hostedPrice("nebius", {
        prompt: "0.000001",
        completion: "0.000004",
        input_cache_read: "0.0000002",
      })?.cacheRead,
    ).toBeCloseTo(0.2);
    expect(
      parseProviderResponse("together", [
        { id: "embed", type: "embedding" },
        { id: "image", type: "image" },
      ]),
    ).toEqual([]);
    expect(
      parseProviderResponse("nebius", {
        data: [
          { id: "image", architecture: { modality: "text->image" } },
          { id: "vision", architecture: { modality: "text+image->text" } },
        ],
      }),
    ).toEqual([
      { value: "nebius/vision", label: "vision", capabilities: { text: true, imageInput: true } },
    ]);
    expect(() => parseProviderResponse("nebius", { invalid: [] })).toThrow("Invalid model catalog");
  });

  it("deduplicates concurrent reads; scopes rates by credentials and endpoint", async () => {
    using _state = scopeProcessState({ env: isolatedEnv() });
    let calls = 0;
    const fetcher = async (_url: string, init: RequestInit) => {
      calls++;
      const input = new Headers(init.headers).get("authorization") === "Bearer second" ? 2 : 1;
      return Response.json([{ id, type: "chat", pricing: { input, output: 4 } }]);
    };
    const [a, b] = await Promise.all([
      fetchHostedModels("together", "first", { fetcher }),
      fetchHostedModels("together", "first", { fetcher }),
    ]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    expect((await fetchHostedModels("together", "second", { fetcher }))[0]?.pricing?.input).toBe(2);
    process.env.TOGETHER_BASE_URL = "https://dedicated.example/v1/";
    await fetchHostedModels("together", "first", { fetcher });
    expect(calls).toBe(3);
    await fetchHostedModels("together", "first", { fetcher, refresh: true });
    expect(calls).toBe(4);
  });

  it("does not forward keys on cross-origin catalog redirects", async () => {
    __setDnsResolverForTest(async () => ["8.8.8.8"]);
    let calls = 0;
    using _network = scopeProperty(globalThis, "fetch", (async (_input, _init) => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://other.example/models" },
      });
    }) as typeof fetch);
    await expect(fetchHostedModels("nebius", "secret")).rejects.toThrow(
      "Model catalog unavailable",
    );
    expect(calls).toBe(1);
  });

  it.each(providers)(
    "%s catalog outage preserves literal selection without borrowing a vendor price",
    async (provider) => {
      const model = resolveModel(`${provider}/openai/gpt-6-sol`);
      const down = async () => new Response("sensitive provider detail", { status: 503 });
      await prepareHostedModel(model, "key", down);
      expect(model.id).toBe("openai/gpt-6-sol");
      expect(model.provider).toBe(provider);
      expect(model.cost.input).toBe(0);
      expect(
        upstreamCostUsd(`${provider}/openai/gpt-6-sol`, { inputTokens: 1000 }),
      ).toBeUndefined();
    },
  );
});

describe.each(providers)("%s inference integration", (provider) => {
  const spec = HOSTED_PROVIDERS[provider];
  it("supports a single configured key, overrides, native transport and self-classifier fallback", async () => {
    using _state = scopeProcessState({
      env: { ...isolatedEnv(), [spec.envKey]: "key", MARINA_DAILY_SPEND_CAP_USD: "0.001" },
    });
    const fixture = createTestEngine();
    try {
      const target = `${provider}/${spec.defaultModel}`;
      expect(MODEL_DISCOVERY_PROVIDERS).toContain(provider);
      expect(availableModels().map((m) => m.spec)).toEqual([target]);
      expect(describeDefaultUpstream(fixture.engine)).toBe(target);
      expect(inferCodeDefaultModel(process.env)).toBe(target);
      expect(decisionConfigFromEnv(process.env)?.model).toBeDefined();
      const model = modelAccess(`${provider}/${id}`).model;
      expect(model).toMatchObject({
        id,
        provider,
        api: "openai-completions",
        baseUrl: spec.baseUrl,
      });
      expect(classifyModelResolution(`${provider}/${id}`)).toBe("exact");
      process.env[`MARINA_DEFAULT_${provider.toUpperCase()}_MODEL`] = id;
      expect(describeDefaultUpstream(fixture.engine)).toBe(`${provider}/${id}`);
      expect(inferCodeDefaultModel(process.env)).toBe(`${provider}/${id}`);
      const runtime = new AgentRuntime({ wsPort: 39997, db: fixture.db });
      const key = (
        runtime as unknown as { resolveApiKey(model: string): string }
      ).resolveApiKey.bind(runtime);
      expect(key(`${provider}/${id}`)).toBe("key");
      fixture.db.saveApiKey({
        name: "hosted",
        provider,
        encryptedValue: "stored",
        isEncrypted: false,
        setBy: "test",
      });
      expect(key(`${provider}/${id}`)).toBe("stored");
    } finally {
      await fixture.dispose();
    }
  });

  it("discovers models with a stored key and tests connectivity without a completion", async () => {
    using _state = scopeProcessState({ env: isolatedEnv() });
    __setDnsResolverForTest(async () => ["8.8.8.8"]);
    const fixture = createTestEngine();
    const seen: string[] = [];
    using _network = scopeProperty(globalThis, "fetch", (async (input, init) => {
      const request = new Request(input, init);
      if (
        (new URL(request.url).pathname === "/v1/models" &&
          request.headers.get("authorization") === "Bearer stored") ||
        request.url === hostedModelsUrl(provider)
      ) {
        seen.push(request.headers.get("authorization")!);
        expect(request.method).toBe("GET");
        return Response.json(catalog(provider));
      }
      return Response.json({ data: [] });
    }) as typeof fetch);
    try {
      fixture.db.saveApiKey({
        name: "hosted",
        provider,
        encryptedValue: "stored",
        isEncrypted: false,
        setBy: "test",
      });
      const result = await discoverModels(fixture.db, { refresh: true });
      expect(result.groups.find((g) => g.provider === provider)).toMatchObject({
        keySource: "db",
        error: null,
        models: [{ value: `${provider}/${id}` }],
      });
      expect((await testKeyConnectivity(provider, "new-key")).ok).toBe(true);
      expect(seen).toEqual(["Bearer stored", "Bearer new-key"]);
    } finally {
      await fixture.dispose();
    }
  });

  it.each([false, true])(
    "proxies tools and usage with service-specific accounting (stream=%s)",
    async (stream) => {
      using _state = scopeProcessState({
        env: { ...isolatedEnv(), [spec.envKey]: "key", MARINA_DAILY_SPEND_CAP_USD: "0.001" },
      });
      __setDnsResolverForTest(async () => ["8.8.8.8"]);
      const fixture = createTestEngine();
      const events: EngineEvent[] = [];
      fixture.engine.addEventListener((event) => events.push(event));
      using _network = scopeProperty(globalThis, "fetch", (async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get("authorization")).toBe("Bearer key");
        if (request.method === "GET") return Response.json(catalog(provider));
        expect(request.url).toBe(`${spec.baseUrl}/chat/completions`);
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.model).toBe(id);
        expect(body.tools).toBeDefined();
        return completion(stream);
      }) as typeof fetch);
      try {
        const response = await proxyToUpstream(
          fixture.engine,
          {
            model: `${provider}/${id}`,
            stream,
            messages: [{ role: "user", content: "Use the lookup tool" }],
            tools: [
              {
                type: "function",
                function: {
                  name: "lookup",
                  parameters: { type: "object", properties: { q: { type: "string" } } },
                },
              },
            ],
          },
          undefined,
          { requestId: `hosted-${provider}-${stream}`, routeKind: "passthru" },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-marina-upstream-model")).toBe(`${provider}/${id}`);
        const text = await response.text();
        expect(text).toContain("lookup");
        const finished = events.filter(
          (e) => e.type === "model_request_lifecycle" && e.phase === "completed",
        );
        expect(finished).toHaveLength(1);
        expect(dailyBudget()?.spentUsd).toBeCloseTo(expectedCost, 10);
        const blocked = await proxyToUpstream(fixture.engine, { model: `${provider}/${id}` });
        expect(blocked.status).toBe(429);
        expect(finished[0]).toMatchObject({
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 400,
          costUsd: expectedCost,
        });
      } finally {
        await fixture.dispose();
      }
    },
  );

  it("native pi transport handles streamed tool calls and catalog token costs", async () => {
    using _state = scopeProcessState({ env: isolatedEnv() });
    const model = resolveModel(`${provider}/${id}`);
    await prepareHostedModel(model, "key", async () => Response.json(catalog(provider)));
    const result = await piModels.completeSimple(
      model,
      { messages: [{ role: "user", content: "lookup", timestamp: 0 }] },
      {
        apiKey: "key",
        maxTokens: 100,
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          expect(request.url).toBe(`${spec.baseUrl}/chat/completions`);
          expect(request.headers.get("authorization")).toBe("Bearer key");
          expect(((await request.json()) as { model: string }).model).toBe(id);
          return completion(true);
        }) as typeof fetch,
      },
    );
    expect(result.stopReason).toBe("toolUse");
    expect(result.content.some((c) => c.type === "toolCall" && c.name === "lookup")).toBe(true);
    expect(result.usage.cost.total).toBeCloseTo(expectedCost, 10);
  });

  it("research and forecasting share native pricing", async () => {
    using _state = scopeProcessState({
      env: { ...isolatedEnv(), [spec.envKey]: "key", MARINA_DAILY_SPEND_CAP_USD: "50" },
    });
    __setDnsResolverForTest(async () => ["8.8.8.8"]);
    using _network = scopeProperty(globalThis, "fetch", (async (input, init) =>
      new Request(input, init).method === "GET"
        ? Response.json(catalog(provider))
        : completion(true)) as typeof fetch);
    const forecast = modelComplete(`${provider}/${id}`);
    expect(await forecast.complete("system", "user")).toBe("ok");
    expect(forecast.usage.costUsd).toBeCloseTo(expectedCost, 10);
    const research = modelTurns(`${provider}/${id}`);
    await research.turn({ messages: [{ role: "user", content: "lookup", timestamp: 0 }] });
    expect(research.usage.costUsd).toBeCloseTo(expectedCost, 10);
  });
});

for (const provider of providers) {
  const spec = HOSTED_PROVIDERS[provider];
  it(`${provider} refuses a missing key without trying another configured provider`, async () => {
    using _state = scopeProcessState({ env: { ...isolatedEnv(), OPENAI_API_KEY: "other" } });
    const fixture = createTestEngine();
    let calls = 0;
    using _network = scopeProperty(globalThis, "fetch", (async (_input, _init) => {
      calls++;
      return completion();
    }) as typeof fetch);
    try {
      const response = await proxyToUpstream(fixture.engine, { model: `${provider}/${id}` });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(calls).toBe(0);
    } finally {
      await fixture.dispose();
    }
  });

  it(`${provider} preserves reported charges through a catalog outage`, async () => {
    using _state = scopeProcessState({
      env: { ...isolatedEnv(), [spec.envKey]: "key", MARINA_DAILY_SPEND_CAP_USD: "50" },
    });
    __setDnsResolverForTest(async () => ["8.8.8.8"]);
    const fixture = createTestEngine();
    using _network = scopeProperty(globalThis, "fetch", (async (input, init) =>
      new Request(input, init).method === "GET"
        ? new Response("Unavailable", { status: 503 })
        : Response.json({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { ...usage, cost: 0.25 },
          })) as typeof fetch);
    try {
      const response = await proxyToUpstream(
        fixture.engine,
        { model: `${provider}/${id}` },
        undefined,
        { requestId: `outage-${provider}`, routeKind: "passthru" },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-marina-cost-usd")).toBe("0.25000000");
      expect(dailyBudget()?.spentUsd).toBe(0.25);
    } finally {
      await fixture.dispose();
    }
  });

  it.each([401, 429, 503])(
    `${provider} preserves named-provider failures (%s) with other keys configured`,
    async (status) => {
      using _state = scopeProcessState({
        env: { ...isolatedEnv(), [spec.envKey]: "selected", OPENAI_API_KEY: "other" },
      });
      const fixture = createTestEngine();
      const calls: string[] = [];
      using _network = scopeProperty(globalThis, "fetch", (async (input, init) => {
        const req = new Request(input, init);
        calls.push(req.url);
        expect(req.headers.get("authorization")).toBe("Bearer selected");
        return Response.json({ error: { message: "provider refused", type: "test" } }, { status });
      }) as typeof fetch);
      try {
        const response = await proxyToUpstream(fixture.engine, {
          model: `${provider}/${id}`,
          messages: [{ role: "user", content: "hello" }],
        });
        expect(response.status).toBe(status);
        expect(await response.text()).toContain("provider refused");
        expect(calls).toEqual([`${spec.baseUrl}/chat/completions`]);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it(`${provider} dedicated endpoints use the same root for catalog and completion`, async () => {
    using _state = scopeProcessState({
      env: {
        ...isolatedEnv(),
        [spec.envKey]: "dedicated",
        [spec.baseUrlEnv]: "https://dedicated.example/v1/",
      },
    });
    const model = resolveModel(`${provider}/${id}`);
    expect(model.baseUrl).toBe("https://dedicated.example/v1");
    expect(hostedModelsUrl(provider)).toBe(
      `https://dedicated.example/v1/models${provider === "nebius" ? "?verbose=true" : ""}`,
    );
    const fixture = createTestEngine();
    using _network = scopeProperty(globalThis, "fetch", (async (input, init) => {
      const req = new Request(input, init);
      expect(req.url).toBe("https://dedicated.example/v1/chat/completions");
      return completion();
    }) as typeof fetch);
    try {
      expect((await proxyToUpstream(fixture.engine, { model: `${provider}/${id}` })).status).toBe(
        200,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it(`${provider} records native manual-compaction spend once`, async () => {
    using _state = scopeProcessState({
      env: { ...isolatedEnv(), MARINA_DAILY_SPEND_CAP_USD: "50" },
    });
    resetSpendLedgerForTests();
    const adapter = new LeanAgentAdapter(
      {
        name: "HostedCompactor",
        model: `${provider}/${id}`,
        budgetCalls: 10,
        contextWindow: 49152,
      },
      "ws://127.0.0.1:39998",
      null,
      "key",
    );
    const internals = adapter as unknown as {
      agent: Agent;
      providerFetch: typeof fetch;
      platformMemory: PlatformMemoryBackend;
    };
    internals.agent.state.messages = Array.from({ length: 30 }, (_, n) => ({
      role: "user",
      content: `Constraint ${n}. ${"Relevant context. ".repeat(20)}`,
      timestamp: n,
    })) as AgentMessage[];
    let catalogCalls = 0;
    internals.providerFetch = (async (input, init) => {
      const req = new Request(input, init);
      if (req.method === "GET") {
        catalogCalls++;
        return Response.json(catalog(provider));
      }
      return new Response(
        `data: ${JSON.stringify({ id: "summary", choices: [{ index: 0, delta: { content: "Keep the constraints." }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    internals.platformMemory.archiveContext = async () => {};
    const result = await adapter.compactNow();
    expect(result?.after).toBeLessThan(30);
    expect(catalogCalls).toBe(1);
    expect(adapter.getOperatorStatus().totalCostUsd).toBeCloseTo(expectedCost, 10);
    expect(adapter.getStatus().contextWindow).toBe(49152);
    expect(dailyBudget()?.spentUsd).toBeCloseTo(expectedCost, 10);
  });

  it(`${provider} embedding keys stay restricted to the official host`, () => {
    const env = {
      MARINA_MEMORY_EMBEDDINGS: "openai",
      MARINA_MEMORY_EMBEDDING_MODEL: "vendor/embed",
      MARINA_MEMORY_EMBEDDING_REVISION: "revision1",
      [spec.envKey]: "key",
    };
    expect(parseEmbeddingEnv({ ...env, MARINA_MEMORY_EMBEDDING_URL: spec.baseUrl })).toMatchObject({
      apiKey: "key",
    });
    const hostile = `${new URL(spec.baseUrl).origin}.other.example/v1`;
    expect(parseEmbeddingEnv({ ...env, MARINA_MEMORY_EMBEDDING_URL: hostile })).not.toHaveProperty(
      "apiKey",
    );
  });
}
