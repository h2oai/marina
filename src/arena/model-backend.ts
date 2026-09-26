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
import { dailyCapRefusal, recordSpend } from "../engine/spend-ledger";
import { HUGGINGFACE_ENV_KEYS } from "../net/model-discovery";
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

/** A `Complete` for `provider/model`, plus the running usage it has accumulated. */
export function modelComplete(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): { complete: Complete; usage: Usage } {
  const provider = spec.split("/")[0] ?? "";
  const apiKey = (PROVIDER_KEYS[provider] ?? []).map((k) => env[k]).find(Boolean);
  if (!apiKey) {
    throw new Error(
      `no API key for ${provider} (set ${(PROVIDER_KEYS[provider] ?? ["?"]).join(" or ")})`,
    );
  }
  const model = resolveModel(spec);
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const complete: Complete = async (system, user) => {
    const capped = dailyCapRefusal(env);
    if (capped) throw new Error(capped);
    const messages = [{ role: "user", content: user, timestamp: Date.now() }] as Message[];
    const result = await piModels.completeSimple(
      model,
      { systemPrompt: system, messages },
      {
        apiKey,
        maxTokens: opts.maxTokens ?? 8_000,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
      },
    );
    usage.calls++;
    usage.inputTokens += result.usage?.input ?? 0;
    usage.outputTokens += result.usage?.output ?? 0;
    usage.costUsd += result.usage?.cost?.total ?? 0;
    recordSpend("forecast", result.usage?.cost?.total);
    if (result.stopReason === "error") throw new Error(result.errorMessage ?? "model error");
    return (Array.isArray(result.content) ? result.content : [])
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };
  return { complete, usage };
}
