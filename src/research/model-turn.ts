// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One model turn with tools, for any `provider/model` Marina can call
 * (`modelAccess` — the same resolution agents and forecasts use, so a single
 * local model works as well as a vendor one). Every turn is priced
 * (`callCost`), recorded in the daily spend ledger, and refused once the daily
 * cap is reached.
 */

import type { AssistantMessage, Context, ToolChoice } from "@earendil-works/pi-ai";
import { piModels } from "../agent/pi-models";
import { callCost, modelAccess, type Usage } from "../arena/model-backend";
import { dailyCapRefusal, recordSpend, type SpendSource } from "../engine/spend-ledger";

export type TurnFn = (
  context: Context,
  opts?: { toolChoice?: ToolChoice },
) => Promise<AssistantMessage>;

export interface ModelTurns {
  spec: string;
  turn: TurnFn;
  usage: Usage;
}

/** Turns of `spec`, accumulating usage across every call. */
export function modelTurns(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    spendSource?: SpendSource;
    /** Called with each turn's cost (a run's own spend guard). */
    onCost?: (usd: number) => void;
  } = {},
): ModelTurns {
  const { model, apiKey } = modelAccess(spec, env);
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const turn: TurnFn = async (context, o = {}) => {
    opts.signal?.throwIfAborted();
    const capped = dailyCapRefusal(env);
    if (capped) throw new Error(capped);
    const result = await piModels.completeSimple(model, context, {
      apiKey,
      maxTokens: opts.maxTokens ?? 16_000,
      ...(o.toolChoice ? { toolChoice: o.toolChoice } : {}),
      signal: AbortSignal.any([
        AbortSignal.timeout(opts.timeoutMs ?? 300_000),
        ...(opts.signal ? [opts.signal] : []),
      ]),
    });
    usage.calls++;
    usage.inputTokens +=
      (result.usage?.input ?? 0) + (result.usage?.cacheRead ?? 0) + (result.usage?.cacheWrite ?? 0);
    usage.outputTokens += result.usage?.output ?? 0;
    const cost = await callCost(spec, model, result.usage);
    usage.costUsd += cost;
    recordSpend(opts.spendSource ?? "agent", cost);
    opts.onCost?.(cost);
    if (result.stopReason === "error" || result.stopReason === "aborted")
      throw new Error(result.errorMessage ?? `model ${result.stopReason}`);
    return result;
  };
  return { spec, turn, usage };
}

/** The text blocks of an assistant message, joined. */
export function messageText(m: AssistantMessage): string {
  return (m.content ?? [])
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
