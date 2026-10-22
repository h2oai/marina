// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One model turn with tools, for any `provider/model` Marina can call
 * (`modelAccess` — the same resolution agents and forecasts use, so a single
 * local model works as well as a vendor one). Every turn goes through the
 * shared core (`modelCall`): priced, recorded in the daily spend ledger,
 * refused once the daily cap is reached, traced and retried on transient
 * errors.
 */

import type { AssistantMessage, Context, ToolChoice } from "@earendil-works/pi-ai";
import { tierOutputCapFor } from "../config/model-tiers";
import { dailyCapRefusal } from "../engine/spend-ledger";
import { modelAccess, type Usage } from "./access";
import { type CallBinding, type ModelCallOptions, modelCall } from "./call";
import { spendSourceFor } from "./purpose";

export type TurnFn = (
  context: Context,
  opts?: { toolChoice?: ToolChoice; signal?: AbortSignal; maxTokens?: number },
) => Promise<AssistantMessage>;

export interface ModelTurns {
  spec: string;
  turn: TurnFn;
  usage: Usage;
}

const FAIL_ON_ERROR_OR_ABORT = new Set(["error", "aborted"] as const);

/** A turn's output cap when the caller sets none. */
const DEFAULT_TURN_MAX_TOKENS = 16_000;

export interface ModelTurnsOptions extends ModelCallOptions {
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with each turn's cost (a run's own spend guard). */
  onCost?: (usd: number) => void;
}

/**
 * Turns of `spec`, accumulating usage across every call. The ledger source
 * defaults to `agent` (a tool-using turn) and the purpose to `research`.
 */
export function modelTurns(
  spec: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: ModelTurnsOptions = {},
): ModelTurns {
  const { model, apiKey } = modelAccess(spec, env);
  const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const purpose = opts.purpose ?? "research";
  // `marina/cheap` with no caller cap: the tier's output cap bounds every turn.
  const tierCap = opts.maxTokens === undefined ? tierOutputCapFor(spec, env) : undefined;
  const defaultMax = Math.min(
    DEFAULT_TURN_MAX_TOKENS,
    tierCap?.maxTokens ?? Number.POSITIVE_INFINITY,
  );
  const binding: CallBinding = {
    target: { spec, model, apiKey },
    env,
    usage,
    purpose,
    source: opts.spendSource ?? (opts.purpose ? spendSourceFor(opts.purpose) : "agent"),
    ...(opts.trace ? { trace: opts.trace } : {}),
    inputTokens: (u) => (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0),
    failOn: FAIL_ON_ERROR_OR_ABORT,
    ...(opts.onCost ? { onCost: opts.onCost } : {}),
  };
  const turn: TurnFn = async (context, o = {}) => {
    opts.signal?.throwIfAborted();
    const capped = dailyCapRefusal(env);
    if (capped) throw new Error(capped);
    const maxTokens = Math.min(
      opts.maxTokens ?? defaultMax,
      o.maxTokens ?? Number.POSITIVE_INFINITY,
    );
    return modelCall(binding, {
      context,
      maxTokens,
      // A per-turn cap below the tier's is the caller's own, not a tier hit.
      ...(tierCap && maxTokens === defaultMax ? { tierCapped: true } : {}),
      ...(o.toolChoice ? { toolChoice: o.toolChoice } : {}),
      timeoutMs: opts.timeoutMs ?? 300_000,
      signals: [opts.signal, o.signal],
    });
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
