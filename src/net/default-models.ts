// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in default model per provider key — one table for the passthru proxy
 * (`model-api/upstream.ts`) and for code that must find *a* model without a
 * server (`src/agent/available-models.ts`). Production ids that were confirmed
 * against each provider's live API. Override per provider with
 * `MARINA_DEFAULT_<PROVIDER>_MODEL` (see `config/environment.reference`).
 */

import { localProviderDefaultModel } from "./model-discovery";

export const BUILTIN_DEFAULT_MODELS: Record<string, string> = {
  ANTHROPIC_API_KEY: "claude-sonnet-5",
  OPENAI_API_KEY: "gpt-6-luna",
  GEMINI_API_KEY: "gemini-3.1-flash-lite",
  OPENROUTER_API_KEY: "openai/gpt-6-luna",
  GROQ_API_KEY: "openai/gpt-oss-120b",
  HUGGINGFACE_API_KEY: "zai-org/GLM-5.3-Flash",
  // Ids from pi-ai's bundled catalog (native ids, priced there).
  CEREBRAS_API_KEY: "gpt-oss-120b",
  DEEPSEEK_API_KEY: "deepseek-flash",
  MISTRAL_API_KEY: "mistral-small-latest",
  XAI_API_KEY: "grok-4.7",
};

/** Local runtimes resolve their default at call time (Ollama's is detected at boot). */
export const LOCAL_DEFAULT_MODEL_KEYS: Record<string, string> = {
  LLAMA_API_KEY: "llama",
  OLLAMA_API_KEY: "ollama",
  VIBETHINKER_API_KEY: "vibethinker",
};

/** The default model id (without provider prefix) for a provider key. */
export function getDefaultUpstreamModel(
  envKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Per-provider override: e.g. ANTHROPIC_API_KEY → MARINA_DEFAULT_ANTHROPIC_MODEL.
  const providerName = envKey.replace(/_API_KEY$/, "");
  const override = env[`MARINA_DEFAULT_${providerName}_MODEL`];
  if (override && override.trim().length > 0) return override.trim();
  const local = LOCAL_DEFAULT_MODEL_KEYS[envKey];
  if (local) return localProviderDefaultModel(local) ?? "default";
  return BUILTIN_DEFAULT_MODELS[envKey] ?? "gpt-6-luna";
}
