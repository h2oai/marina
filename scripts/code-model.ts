// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

const PROVIDER_DEFAULTS = [
  ["ANTHROPIC_API_KEY", "anthropic", "claude-sonnet-5"],
  ["OPENAI_API_KEY", "openai", "gpt-6-luna"],
  ["GEMINI_API_KEY", "google", "gemini-3.1-flash-lite"],
  ["OPENROUTER_API_KEY", "openrouter", "openai/gpt-6-luna"],
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
