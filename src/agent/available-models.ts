// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What intelligence this installation has — read from configuration only (no
 * server, no network probe), so the CLI, the forecaster, decisions and
 * readiness agree. Marina sizes itself to whatever is here: many vendors, one
 * cloud key, or a single local model (llama.cpp / Ollama / vLLM). A missing
 * vendor key is never an error; zero models is the only impossibility.
 *
 * Order: self-hosted runtimes the operator opted into (key or base URL set),
 * then keyed cloud providers (first-party before the OpenRouter aggregator).
 * Each entry is a `provider/model` spec `modelComplete` and `resolveModel` can
 * run directly, using the provider's default model (`MARINA_DEFAULT_<P>_MODEL`
 * overrides it).
 */

import { getDefaultUpstreamModel } from "../net/default-models";
import { LOCAL_PROVIDERS, localProviderDefaultModel } from "../net/model-discovery";

export interface AvailableModel {
  /** `provider/model`, runnable by `modelComplete` / `resolveModel`. */
  spec: string;
  provider: string;
  /** A self-hosted runtime (no vendor key needed). */
  local: boolean;
}

/** Cloud providers in preference order, with the env keys that unlock each. */
const CLOUD_PROVIDERS: ReadonlyArray<{ provider: string; envKeys: readonly string[] }> = [
  { provider: "anthropic", envKeys: ["ANTHROPIC_API_KEY"] },
  { provider: "openai", envKeys: ["OPENAI_API_KEY"] },
  { provider: "google", envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  { provider: "groq", envKeys: ["GROQ_API_KEY"] },
  { provider: "deepseek", envKeys: ["DEEPSEEK_API_KEY"] },
  { provider: "mistral", envKeys: ["MISTRAL_API_KEY"] },
  { provider: "xai", envKeys: ["XAI_API_KEY"] },
  { provider: "huggingface", envKeys: ["HUGGINGFACE_API_KEY", "HF_TOKEN"] },
  { provider: "openrouter", envKeys: ["OPENROUTER_API_KEY"] },
];

/** True when the operator opted into a self-hosted runtime (its key or base URL is set). */
export function localRuntimeConfigured(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const spec = LOCAL_PROVIDERS[provider];
  return !!spec && (!!env[spec.keyEnv]?.trim() || !!env[spec.baseUrlEnv]?.trim());
}

/** Every model this installation can call, best-first (see the module comment). */
export function availableModels(env: NodeJS.ProcessEnv = process.env): AvailableModel[] {
  const out: AvailableModel[] = [];
  for (const [provider, spec] of Object.entries(LOCAL_PROVIDERS)) {
    if (!localRuntimeConfigured(provider, env)) continue;
    const override = env[`MARINA_DEFAULT_${provider.toUpperCase()}_MODEL`]?.trim();
    const model = override || localProviderDefaultModel(provider) || spec.defaultModel;
    out.push({ spec: `${provider}/${model}`, provider, local: true });
  }
  for (const { provider, envKeys } of CLOUD_PROVIDERS) {
    if (!envKeys.some((k) => env[k]?.trim())) continue;
    out.push({
      spec: `${provider}/${getDefaultUpstreamModel(envKeys[0]!, env)}`,
      provider,
      local: false,
    });
  }
  return out;
}

/** How much intelligence there is, and what each harness feature does at that scale. */
export interface IntelligenceScale {
  /** `multi`: several vendors (or an aggregator); `single`: one model; `none`: nothing to call. */
  tier: "multi" | "single" | "none";
  models: string[];
  /** One line an operator can read: what changes at this scale. */
  summary: string;
}

export function intelligenceScale(env: NodeJS.ProcessEnv = process.env): IntelligenceScale {
  const models = availableModels(env);
  const aggregator = models.some(
    (m) => m.provider === "openrouter" || m.provider === "huggingface",
  );
  const specs = models.map((m) => m.spec);
  if (models.length === 0) {
    return {
      tier: "none",
      models: [],
      summary:
        "no model configured: agents, forecasts, verification and classifier decisions cannot run (set any provider key, or point LLAMA_BASE_URL / OLLAMA_BASE_URL at a local runtime)",
    };
  }
  if (models.length === 1 && !aggregator) {
    return {
      tier: "single",
      models: specs,
      summary: `single model (${specs[0]}): verification = self-check, decisions = uncalibrated classifier on the same model, forecasts = one analyst × K runs, routing = one candidate`,
    };
  }
  return {
    tier: "multi",
    models: specs,
    summary: `${aggregator ? "aggregator + " : ""}${models.length} provider(s): cross-vendor analysts, checkers and routing candidates`,
  };
}

/** Every env variable that can make a model available — what "no model at all" unsets. */
export function modelSourceEnvKeys(): string[] {
  const keys: string[] = CLOUD_PROVIDERS.flatMap((p) => [...p.envKeys]);
  for (const spec of Object.values(LOCAL_PROVIDERS)) keys.push(spec.keyEnv, spec.baseUrlEnv);
  return keys;
}
