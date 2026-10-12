// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

const PROVIDER_DEFAULTS = [
  ["ANTHROPIC_API_KEY", "anthropic", "claude-opus-5-5"],
  ["OPENAI_API_KEY", "openai", "gpt-6.1-sol"],
  ["GEMINI_API_KEY", "google", "gemini-3.1-pro-preview"],
  ["OPENROUTER_API_KEY", "openrouter", "google/gemini-3.1-pro-preview"],
  ["GROQ_API_KEY", "groq", "openai/gpt-oss-120b"],
  ["HUGGINGFACE_API_KEY", "huggingface", "zai-org/GLM-5.3-Flash"],
] as const;

/** Provider key env vars consulted by inferCodeDefaultModel, in precedence order. */
export const PROVIDER_KEY_ENV_VARS: readonly string[] = PROVIDER_DEFAULTS.map(([key]) => key);

/** Select a routable default for the first configured provider. Explicit choice always wins. */
export function inferCodeDefaultModel(env: Record<string, string | undefined>): string | undefined {
  if (env.MARINA_DEFAULT_MODEL?.trim()) return env.MARINA_DEFAULT_MODEL.trim();
  for (const [key, provider, builtIn] of PROVIDER_DEFAULTS) {
    if (!env[key]?.trim()) continue;
    const override = env[`MARINA_DEFAULT_${key.replace(/_API_KEY$/, "")}_MODEL`]?.trim();
    return `${provider}/${override || builtIn}`;
  }
  return undefined;
}

/** Preferred "fast" (cheapest-tier) routable models, cheapest first. When
 *  prices are unknown, ordering falls back to each vendor's light/cheap tier
 *  (flash/lite/luna/sonnet/open-weight). `/fast` picks the first one reachable. */
const FAST_MODELS = [
  ["GEMINI_API_KEY", "google/gemini-3.1-flash-lite"],
  ["GROQ_API_KEY", "groq/openai/gpt-oss-120b"],
  ["OPENAI_API_KEY", "openai/gpt-6-luna"],
  ["HUGGINGFACE_API_KEY", "huggingface/zai-org/GLM-5.3-Flash"],
  ["OPENROUTER_API_KEY", "openrouter/google/gemini-3.1-flash-lite"],
  ["ANTHROPIC_API_KEY", "anthropic/claude-sonnet-5"],
] as const;

/** Cheapest reachable model: the first configured key in `FAST_MODELS`. */
export function fastestModelFor(env: Record<string, string | undefined>): string | undefined {
  for (const [key, model] of FAST_MODELS) {
    if (env[key]?.trim()) return model;
  }
  return undefined;
}
