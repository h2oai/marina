// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  createProvider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { HOSTED_PROVIDERS } from "../net/model/hosted-providers";
import { defaultModelPrice } from "./provider-cost";

// In-memory provider runtime: Marina owns credentials and durable agent state.
// Do not refresh catalogs or persist credentials here. Per-request keys (including
// rotated resident/internal tokens) take precedence over provider environment keys.
export const piModels = builtinModels();
// Nebius is not in pi's bundled registry. Marina keeps its literal provider ID
// and uses the same Chat Completions transport; credentials remain per request.
for (const [id, spec] of Object.entries(HOSTED_PROVIDERS)) {
  if (piModels.getProvider(id)) continue;
  piModels.setProvider(
    createProvider({
      id,
      name: spec.name,
      models: [],
      api: openAICompletionsApi(),
      auth: {
        apiKey: {
          name: `${spec.name} API key`,
          resolve: async ({ ctx, credential, signal }) => {
            signal.throwIfAborted();
            const key = credential?.key || (await ctx.env(spec.envKey));
            return key ? { auth: { apiKey: key }, source: spec.envKey } : undefined;
          },
        },
      },
    }),
  );
}

// Deterministic fake model for E2E plumbing tests: no provider key, no network.
// Enabled with MARINA_FAKE_MODEL=1; every model call returns a fixed text reply so
// the agent loop, tool gate, compaction and spend ledger can be exercised in CI.
if (process.env.MARINA_FAKE_MODEL === "1") {
  const fakeMessage = (): AssistantMessage => ({
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: "openai-completions",
    provider: "openai",
    model: "fake",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  piModels.completeSimple = async () => fakeMessage();
  piModels.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const msg = fakeMessage();
    stream.push({ type: "start", partial: msg });
    stream.end(msg);
    return stream;
  };
}

// Pi's OpenAI catalog now uses Responses. Marina and local runtimes also use
// OpenAI-compatible Chat Completions, with their own model.baseUrl and literal ID.
const openai = piModels.getProvider("openai")!;
const openaiModels = [...openai.getModels()];
const sol = openaiModels.find((model) => model.id === "gpt-6-sol");
// Verified against https://developers.openai.com/api/docs/models/gpt-6.1-sol
// on 2026-10-08. The generic unknown-model fallback inherits GPT-4's 8K window;
// pi then clamps long research prompts to a 16-token response. Preserve the
// actual context/output limits and mandatory reasoning until the catalog catches up.
if (sol && !openaiModels.some((model) => model.id === "gpt-6.1-sol")) {
  openaiModels.push({
    ...sol,
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: { ...sol.thinkingLevelMap, off: null, minimal: null },
    cost: {
      ...defaultModelPrice("gpt-6.1-sol")!,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    },
  });
}
piModels.setProvider(
  createProvider({
    id: openai.id,
    name: openai.name,
    auth: openai.auth,
    models: openaiModels,
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  }),
);
