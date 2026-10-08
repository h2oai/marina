// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { defaultModelPrice } from "./provider-cost";

// In-memory provider runtime: Marina owns credentials and durable agent state.
// Do not refresh catalogs or persist credentials here. Per-request keys (including
// rotated resident/internal tokens) take precedence over provider environment keys.
export const piModels = builtinModels();

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
