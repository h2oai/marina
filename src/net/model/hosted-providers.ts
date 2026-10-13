// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Shared transport metadata for hosted OpenAI-compatible inference services. */
export const HOSTED_PROVIDERS = {
  together: {
    name: "Together AI",
    envKey: "TOGETHER_API_KEY",
    baseUrlEnv: "TOGETHER_BASE_URL",
    baseUrl: "https://api.together.ai/v1",
    defaultModel: "MiniMaxAI/MiniMax-M3",
  },
  nebius: {
    name: "Nebius Token Factory",
    envKey: "NEBIUS_API_KEY",
    baseUrlEnv: "NEBIUS_BASE_URL",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    defaultModel: "MiniMaxAI/MiniMax-M3",
  },
} as const;

export type HostedProvider = keyof typeof HOSTED_PROVIDERS;
export function isHostedProvider(provider: string): provider is HostedProvider {
  return Object.hasOwn(HOSTED_PROVIDERS, provider);
}

export function hostedBaseUrl(provider: HostedProvider, env = process.env): string {
  const spec = HOSTED_PROVIDERS[provider];
  return (env[spec.baseUrlEnv]?.trim() || spec.baseUrl).replace(/\/+$/, "");
}

export function hostedModelsUrl(provider: HostedProvider): string {
  return `${hostedBaseUrl(provider)}/models${provider === "nebius" ? "?verbose=true" : ""}`;
}
