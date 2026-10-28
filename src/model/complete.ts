// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot `(system, user) → text` completions for any `provider/model`
 * (also `marina/…` through a Marina /v1 endpoint).
 */

import type { Message } from "@earendil-works/pi-ai";
import { classifyModelResolution, isMarinaProxyModel } from "../agent/lean-agent-adapter";
import { grownOutputCap } from "../agent/reasoning-control";
import { tierOutputCapFor } from "../config/model-tiers";
import { dailyCapRefusal } from "../engine/spend-ledger";
import { modelAccess, type Usage } from "./access";
import { type CallBinding, type ModelCallOptions, modelCall, replyText } from "./call";
import { configuredOutputTokens, defaultOutputTokens, requireFinishedOutput } from "./output";
import { spendSourceFor } from "./purpose";
import type { Complete } from "./reply";

const FAIL_ON_ERROR = new Set(["error", "aborted"] as const);

export interface ModelCompleteOptions extends ModelCallOptions {
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A `Complete` for `provider/model`, plus the running usage it has
 * accumulated. Without an explicit `maxTokens` the cap leaves room for hidden
 * reasoning, and any length-limited reply is asked once more with a grown cap.
 * Explicit caller/operator caps never grow. Incomplete output is never returned as text. `purpose`
 * (default `forecast`) labels the spend and the trace.
 */
export function modelComplete(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: ModelCompleteOptions = {},
): { complete: Complete; usage: Usage; contextWindow?: number } {
  const { model, apiKey } = modelAccess(spec, env);
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const own =
    isMarinaProxyModel(model) || classifyModelResolution(spec) === "synthesized"
      ? undefined
      : model.maxTokens;
  const configured = configuredOutputTokens(env);
  // `marina/cheap` with no caller cap: the tier's output cap bounds the
  // automatic cap and its one grown retry (a runaway reasoning loop stops there).
  const tierCap = opts.maxTokens === undefined ? tierOutputCapFor(spec, env) : undefined;
  const ceiling = Math.min(
    own && Number.isFinite(own) && own > 0 ? own : Math.floor(model.contextWindow / 2),
    tierCap?.maxTokens ?? Number.POSITIVE_INFINITY,
  );
  const automaticCap = Math.min(defaultOutputTokens(env), ceiling);
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
        explicitOutputCap: opts.maxTokens !== undefined || configured !== undefined,
        timeoutMs: opts.timeoutMs ?? 180_000,
        signals: [opts.signal],
        ...(tierCap ? { tierCapped: true } : {}),
      });
      const text = replyText(result);
      return { text, reason: result.stopReason };
    };
    const cap = opts.maxTokens ?? automaticCap;
    let reply = await call(cap);
    if (reply.reason === "length" && opts.maxTokens === undefined && configured === undefined) {
      const grown = grownOutputCap(cap, ceiling);
      if (grown !== undefined) reply = await call(grown);
    }
    requireFinishedOutput(reply.reason, spec);
    return reply.text;
  };
  const window = (model as { contextWindow?: number }).contextWindow;
  return {
    complete,
    usage,
    ...(window && Number.isFinite(window) && window > 0 ? { contextWindow: window } : {}),
  };
}
