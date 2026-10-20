// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Model access for in-process calls: the model behind `provider/model`, the
 * key to call it with, and what one call cost. The same resolution agents use
 * (`resolveModel` + pi). Keys come from the provider's usual environment
 * variable; nothing is logged but the model id.
 */

import { resolveModel } from "../agent/lean-agent-adapter";
import {
  costFromTokens,
  defaultModelPrice,
  isUnpricedModel,
  openRouterModelPrice,
  type TokenUsage,
} from "../agent/provider-cost";
import { isHostedProvider } from "../net/model/hosted-providers";
import { HUGGINGFACE_ENV_KEYS, LOCAL_PROVIDERS } from "../net/model/model-discovery";

export const PROVIDER_KEYS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  nebius: ["NEBIUS_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  huggingface: HUGGINGFACE_ENV_KEYS,
};

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type ResolvedModel = ReturnType<typeof resolveModel>;

/** The provider part of a spec (`anthropic` in `anthropic/claude…`, `marina` in `marina/x@host`). */
export function specProvider(spec: string): string {
  return spec.split("@")[0]!.split("/")[0] ?? "";
}

/**
 * True for a `marina/*` spec served by THIS world's own `/v1` (no `@host`):
 * the passthru already records the call's dollars as `model_api` where they
 * leave Marina, so the caller must not record them again.
 */
export function isLoopbackMarinaSpec(spec: string): boolean {
  // `marina/<model>@<host>` is ANOTHER Marina's /v1: no passthru here records it.
  return specProvider(spec) === "marina" && !spec.includes("@");
}

/**
 * What one call cost. pi-ai prices from its bundled catalog; a model newer
 * than the catalog is synthesized at $0, which would hide its spend from the
 * daily cap. Such a call is priced from its token counts at the known list
 * price — the built-in table first, then OpenRouter's live catalog for
 * `openrouter/…` ids. Unknown and unreachable stay at pi-ai's figure.
 */
export async function callCost(
  spec: string,
  model: { cost?: { input?: number; output?: number } },
  used: (TokenUsage & { cost?: { total?: number } }) | undefined,
): Promise<number> {
  const reported = used?.cost?.total ?? 0;
  if (reported > 0 || !used || !isUnpricedModel(model)) return reported;
  // Hosted service prices must never fall back to another vendor's list price.
  if (isHostedProvider(spec.split("/")[0]!)) return reported;
  const bare = spec.split("/").slice(1).join("/");
  const price =
    defaultModelPrice(bare) ??
    (spec.startsWith("openrouter/") ? await openRouterModelPrice(bare) : undefined);
  return price ? costFromTokens(price, used) : reported;
}

/**
 * The model behind `provider/model` and the key to call it with. A self-hosted
 * runtime (llama.cpp / Ollama / vLLM) needs no vendor key: its key is optional
 * and the transport is local (`resolveModel` builds it). Throws when a vendor
 * key is missing.
 */
export function modelAccess(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
): { model: ResolvedModel; apiKey: string } {
  const provider = specProvider(spec);
  if (provider === "marina") {
    // A Marina /v1 endpoint (this server, or `marina@<host>/…`): any key it accepts.
    const apiKey = env.MODEL_API_KEYS?.split(",")[0]?.split(":")[0]?.trim();
    if (!apiKey) throw new Error("no key for marina/* (set MODEL_API_KEYS)");
    return { model: resolveModel(spec), apiKey };
  }
  const local = LOCAL_PROVIDERS[provider];
  const apiKey = local
    ? env[local.keyEnv]?.trim() || "local"
    : (PROVIDER_KEYS[provider] ?? []).map((k) => env[k]).find(Boolean);
  if (!apiKey) {
    throw new Error(
      `no API key for ${provider} (set ${(PROVIDER_KEYS[provider] ?? ["?"]).join(" or ")})`,
    );
  }
  return { model: resolveModel(spec), apiKey };
}
