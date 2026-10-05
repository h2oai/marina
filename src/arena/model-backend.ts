// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot completions for the arena's model forecaster, through the same model
 * resolution agents use (`resolveModel` + pi). Loaded lazily so the baseline
 * path never pulls the agent stack in. Keys come from the provider's usual
 * environment variable; nothing is logged but the model id.
 */

import type { Message, TextContent } from "@earendil-works/pi-ai";
import { resolveModel } from "../agent/lean-agent-adapter";
import { piModels } from "../agent/pi-models";
import {
  costFromTokens,
  defaultModelPrice,
  isUnpricedModel,
  openRouterModelPrice,
  type TokenUsage,
} from "../agent/provider-cost";
import { dailyCapRefusal, recordSpend } from "../engine/spend-ledger";
import { HUGGINGFACE_ENV_KEYS, LOCAL_PROVIDERS } from "../net/model-discovery";
import type { Complete } from "./model-forecaster";

const PROVIDER_KEYS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
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
): { model: ReturnType<typeof resolveModel>; apiKey: string } {
  const provider = spec.split("/")[0] ?? "";
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

/** A `Complete` for `provider/model`, plus the running usage it has accumulated. */
export function modelComplete(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { maxTokens?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): { complete: Complete; usage: Usage; contextWindow?: number } {
  const { model, apiKey } = modelAccess(spec, env);
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const complete: Complete = async (system, user) => {
    opts.signal?.throwIfAborted();
    const capped = dailyCapRefusal(env);
    if (capped) throw new Error(capped);
    const messages = [{ role: "user", content: user, timestamp: Date.now() }] as Message[];
    const result = await piModels.completeSimple(
      model,
      { systemPrompt: system, messages },
      {
        apiKey,
        maxTokens: opts.maxTokens ?? 8_000,
        signal: AbortSignal.any([
          AbortSignal.timeout(opts.timeoutMs ?? 180_000),
          ...(opts.signal ? [opts.signal] : []),
        ]),
      },
    );
    usage.calls++;
    usage.inputTokens += result.usage?.input ?? 0;
    usage.outputTokens += result.usage?.output ?? 0;
    const cost = await callCost(spec, model, result.usage);
    usage.costUsd += cost;
    recordSpend("forecast", cost);
    if (result.stopReason === "error") throw new Error(result.errorMessage ?? "model error");
    return (Array.isArray(result.content) ? result.content : [])
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };
  const window = (model as { contextWindow?: number }).contextWindow;
  return {
    complete,
    usage,
    ...(window && Number.isFinite(window) && window > 0 ? { contextWindow: window } : {}),
  };
}
