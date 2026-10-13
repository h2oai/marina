// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Built-in default model per provider key — one table for the passthru proxy
 * (`model-api/upstream.ts`) and for code that must find *a* model without a
 * server (`src/agent/available-models.ts`). Production ids that were confirmed
 * against each provider's live API (2026-10-11); Together/Nebius defaults are
 * documented catalog IDs (2026-10-13), pending account-level verification. Strong models,
 * not its cheapest model. Override per provider with
 * `MARINA_DEFAULT_<PROVIDER>_MODEL` (see `config/environment.reference`).
 */

import { HOSTED_PROVIDERS } from "./hosted-providers";
import { localProviderDefaultModel } from "./model-discovery";

export const BUILTIN_DEFAULT_MODELS: Record<string, string> = {
  ...Object.fromEntries(Object.values(HOSTED_PROVIDERS).map((p) => [p.envKey, p.defaultModel])),
  ANTHROPIC_API_KEY: "claude-opus-5-5",
  OPENAI_API_KEY: "gpt-6.1-sol",
  GEMINI_API_KEY: "gemini-3.1-pro-preview",
  // OpenRouter carries models from vendors OTHER than Anthropic and OpenAI,
  // whose models go through their own keys (`vendorModelSpec`).
  OPENROUTER_API_KEY: "google/gemini-3.1-pro-preview",
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
  return BUILTIN_DEFAULT_MODELS[envKey] ?? "gpt-6.1-sol";
}

/** First-party vendors reached through their own key; OpenRouter is only their fallback. */
const DIRECT_VENDOR_KEYS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
};

/**
 * The model spec for a built-in default that names an Anthropic or OpenAI
 * model: the vendor's own API when its key is set (`anthropic/claude-opus-5-5`),
 * else OpenRouter's id for the same model when OpenRouter is configured
 * (`openrouter/anthropic/claude-opus-5.5`), else undefined. `direct` is the
 * vendor's native id, `openrouter` OpenRouter's (`<vendor>/<id>`).
 */
export function vendorModelSpec(
  vendor: "anthropic" | "openai",
  ids: { direct: string; openrouter: string },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (DIRECT_VENDOR_KEYS[vendor]!.some((k) => env[k]?.trim())) return `${vendor}/${ids.direct}`;
  if (env.OPENROUTER_API_KEY?.trim()) return `openrouter/${ids.openrouter}`;
  return undefined;
}
