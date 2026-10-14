// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One answer to "how do I give Marina a model?", derived from the provider
 * registry so every surface (boot log, `agent spawn`, `key`, `brief`, `ask`,
 * readiness, `/v1` 503) names the same options.
 */

import {
  CLOUD_PROVIDER_KEY_ENVS,
  LOCAL_PROVIDERS,
  MODEL_DISCOVERY_PROVIDERS,
} from "./model-discovery";

/** Providers whose keys feed media generation only (images, video). */
export const MEDIA_KEY_PROVIDERS = ["stability", "runway", "flux", "luma"] as const;

/** Every provider name `key add` accepts: model providers, then media providers. */
export const KEY_PROVIDERS: readonly string[] = [
  ...MODEL_DISCOVERY_PROVIDERS,
  ...MEDIA_KEY_PROVIDERS,
];

/** Listed first: OpenRouter (one key, many vendors), then the frontier vendors. */
const FIRST = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"];

/** Every keyed provider's env var from the registry, the common ones first. */
export function cloudKeyEnvs(): string[] {
  const envs = CLOUD_PROVIDER_KEY_ENVS.map((p) => p.envKey);
  return [...FIRST.filter((e) => envs.includes(e)), ...envs.filter((e) => !FIRST.includes(e))];
}

/**
 * The provider-setup line: env keys, the in-world `key add`, and the local
 * runtimes (Ollama, llama.cpp) with their base-URL variables.
 */
export function providerSetupHint(): string {
  const ollama = LOCAL_PROVIDERS.ollama!;
  const llama = LOCAL_PROVIDERS.llama!;
  return (
    `Set one of ${cloudKeyEnvs().join(", ")}; ` +
    "or in-world: key add <name> <provider> <key>; " +
    `or a local runtime: ${ollama.baseUrlEnv}=${ollama.defaultBaseUrl} (Ollama) or ${llama.baseUrlEnv}=${llama.defaultBaseUrl} (llama.cpp).`
  );
}
