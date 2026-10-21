// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot `(system, user) → text` completions for any `provider/model`
 * (also `marina/…` through a Marina /v1 endpoint).
 */

import type { Message } from "@earendil-works/pi-ai";
import { grownOutputCap, reasoningHeadroomCap } from "../agent/reasoning-control";
import { tierOutputCapFor } from "../config/model-tiers";
import { dailyCapRefusal } from "../engine/spend-ledger";
import { modelAccess, type Usage } from "./access";
import { type CallBinding, type ModelCallOptions, modelCall, replyText } from "./call";
import { spendSourceFor } from "./purpose";
import type { Complete } from "./reply";

/** The automatic output cap: room for a model's hidden reasoning, never past its own ceiling. */
const AUTOMATIC_MAX_TOKENS = 8_000;

const FAIL_ON_ERROR = new Set(["error"] as const);

export interface ModelCompleteOptions extends ModelCallOptions {
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A `Complete` for `provider/model`, plus the running usage it has
 * accumulated. Without an explicit `maxTokens` the cap leaves room for hidden
 * reasoning, and a reply that ends on its length limit with no text is asked
 * once more with a grown cap; an explicit cap never grows. `purpose`
 * (default `forecast`) labels the spend and the trace.
 */
export function modelComplete(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: ModelCompleteOptions = {},
): { complete: Complete; usage: Usage; contextWindow?: number } {
  const { model, apiKey } = modelAccess(spec, env);
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const own = (model as { maxTokens?: number }).maxTokens;
  // `marina/cheap` with no caller cap: the tier's output cap bounds the
  // automatic cap and its one grown retry (a runaway reasoning loop stops there).
  const tierCap = opts.maxTokens === undefined ? tierOutputCapFor(spec, env) : undefined;
  const ceiling = Math.min(
    own && Number.isFinite(own) && own > 0 ? own : 64_000,
    tierCap?.maxTokens ?? Number.POSITIVE_INFINITY,
  );
  const automaticCap = reasoningHeadroomCap(AUTOMATIC_MAX_TOKENS, ceiling);
  const purpose = opts.purpose ?? "forecast";
  const binding: CallBinding = {
    target: { spec, model, apiKey },
    env,
    usage,
    purpose,
    source: opts.spendSource ?? spendSourceFor(purpose),
    ...(opts.trace ? { trace: opts.trace } : {}),
    inputTokens: (u) => u?.input ?? 0,
    failOn: FAIL_ON_ERROR,
  };
  const complete: Complete = async (system, user) => {
    opts.signal?.throwIfAborted();
    const capped = dailyCapRefusal(env);
    if (capped) throw new Error(capped);
    const messages = [{ role: "user", content: user, timestamp: Date.now() }] as Message[];
    const call = async (maxTokens: number) => {
      const result = await modelCall(binding, {
        context: { systemPrompt: system, messages },
        maxTokens,
        timeoutMs: opts.timeoutMs ?? 180_000,
        signals: [opts.signal],
        ...(tierCap ? { tierCapped: true } : {}),
      });
      const text = replyText(result);
      return { text, truncated: result.stopReason === "length" && !text.trim() };
    };
    if (opts.maxTokens !== undefined) return (await call(opts.maxTokens)).text;
    const first = await call(automaticCap);
    if (!first.truncated) return first.text;
    // Hidden reasoning spent the whole cap before any text: once more, with room.
    const grown = grownOutputCap(automaticCap, ceiling);
    return grown === undefined ? first.text : (await call(grown)).text;
  };
  const window = (model as { contextWindow?: number }).contextWindow;
  return {
    complete,
    usage,
    ...(window && Number.isFinite(window) && window > 0 ? { contextWindow: window } : {}),
  };
}
