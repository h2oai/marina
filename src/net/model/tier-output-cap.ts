// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * The cheap tier's default output cap on the wire, and how often it fires.
 *
 * A request Marina routes through `marina/cheap` that sets no output limit
 * gets `max_tokens` from `cheapTierOutputCap` (src/config/model-tiers.ts), and
 * on an OpenRouter route also `reasoning.max_tokens` (a hidden-reasoning
 * budget below the cap, so the answer still has room) unless the caller sent
 * a reasoning directive of its own. A caller's explicit limit is never
 * touched: not lowered, not raised. Explicit model ids and the strong tier
 * never come here.
 *
 * A reply that ends on its length limit under a cap Marina applied is a cap
 * hit: it is marked on the `model_request_lifecycle` event (`outputCap`,
 * `outputCapHit`), on a buffered reply's {@link OUTPUT_CAP_HEADER}, and in the
 * per-process counts `admin models` shows.
 */
import type { TierOutputCap } from "../../config/model-tiers";
import { explicitOutputCap } from "./reasoning-effort";

/**
 * `<cap>` on a reply whose request Marina capped, `<cap>; hit` when the reply
 * ended on that limit (buffered replies; a stream's ending is in its trace).
 */
export const OUTPUT_CAP_HEADER = "x-marina-output-cap";

/**
 * `body` with the tier's cap applied, or `undefined` when the caller set its
 * own output limit (`max_tokens` / `max_completion_tokens`) and the body is
 * left alone. `provider` is the routed provider (`openrouter`, …): only
 * OpenRouter takes the `reasoning` object.
 */
export function withTierOutputCap(
  body: Record<string, unknown>,
  cap: TierOutputCap,
  provider: string,
): Record<string, unknown> | undefined {
  if (explicitOutputCap(body) !== undefined) return undefined;
  const next: Record<string, unknown> = { ...body, max_tokens: cap.maxTokens };
  if (
    provider === "openrouter" &&
    cap.reasoningMaxTokens !== undefined &&
    body.reasoning === undefined &&
    body.reasoning_effort === undefined
  ) {
    next.reasoning = { max_tokens: cap.reasoningMaxTokens };
  }
  return next;
}

/** Whether an OpenAI-shaped finish reason (or Anthropic stop reason) means the output limit. */
export function isLengthFinish(reason: unknown): boolean {
  return reason === "length" || reason === "max_tokens";
}

/** The first choice's `finish_reason` of a buffered `chat.completion`, if any. */
export function completionFinishReason(data: unknown): unknown {
  const choices = (data as { choices?: { finish_reason?: unknown }[] } | null)?.choices;
  return Array.isArray(choices) ? choices[0]?.finish_reason : undefined;
}

const counts = { capped: 0, hits: 0 };

/** Count one finished reply under a Marina-applied cap; `hit` when it ended on the cap. */
export function noteTierOutputCapReply(hit: boolean): void {
  counts.capped++;
  if (hit) counts.hits++;
}

/** Replies under a Marina-applied cheap-tier cap since this process started, and how many hit it. */
export function tierOutputCapCounts(): { capped: number; hits: number } {
  return { ...counts };
}

/** The `admin models` line for the counts. */
export function describeTierOutputCapCounts(): string {
  const { capped, hits } = counts;
  const share = capped > 0 ? ` (${((100 * hits) / capped).toFixed(1)} %)` : "";
  return `  cheap output cap since start: ${capped} capped repl${capped === 1 ? "y" : "ies"}, ${hits} cut at the cap${share}`;
}

/** Test hook. */
export function resetTierOutputCapCountsForTests(): void {
  counts.capped = 0;
  counts.hits = 0;
}
