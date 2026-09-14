// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

// In-memory provider runtime: Marina owns credentials and durable agent state.
// Do not refresh catalogs or persist credentials here. Per-request keys (including
// rotated resident/internal tokens) take precedence over provider environment keys.
export const piModels = builtinModels();

// Pi's OpenAI catalog now uses Responses. Marina and local runtimes also use
// OpenAI-compatible Chat Completions, with their own model.baseUrl and literal ID.
const openai = piModels.getProvider("openai")!;
piModels.setProvider(
  createProvider({
    id: openai.id,
    name: openai.name,
    auth: openai.auth,
    models: openai.getModels(),
    api: {
      "openai-completions": openAICompletionsApi(),
      "openai-responses": openAIResponsesApi(),
    },
  }),
);
