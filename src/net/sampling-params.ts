// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Which models refuse caller sampling parameters (`temperature`, `top_p`).
 * The Claude 5 family rejects them (`omitsSamplingParams`); OpenAI's reasoning
 * families (gpt-5 and later, the o-series) accept only the default temperature
 * and answer any other value with a 400. Marina's own helpers (compaction
 * summaries, memory planners, note writers, decision classifiers) ask for a
 * low temperature out of habit — for these models they must not send one.
 *
 * Beyond the static rule, a model an upstream refused sampling parameters for
 * is remembered per process (`noteSamplingRejected`), so a new family is
 * learned from its first 400 rather than failing every call.
 */
import { omitsSamplingParams } from "./anthropic-tools";

const OPENAI_REASONING = /^(?:gpt-(?:[5-9]|\d{2,})|o[1-9])(?:[.-]|$)/;
const learned = new Set<string>();

/** The model id without routing prefixes (`openrouter/`, `openai/`, `anthropic/`, …). */
function bareModelId(model: string): string {
  const parts = model.trim().toLowerCase().split("/");
  return parts[parts.length - 1] ?? "";
}

/** True when this model refuses caller sampling parameters. */
export function rejectsSamplingParams(model: string): boolean {
  if (!model) return false;
  if (learned.has(model) || learned.has(bareModelId(model))) return true;
  return omitsSamplingParams(model) || OPENAI_REASONING.test(bareModelId(model));
}

/** `{ temperature }` for a model that accepts it, else nothing. */
export function samplingFor(model: string, temperature: number): { temperature?: number } {
  return rejectsSamplingParams(model) ? {} : { temperature };
}

/** A copy of an OpenAI-style body without the sampling fields this model refuses. */
export function withoutRejectedSampling<T extends Record<string, unknown>>(
  body: T,
  model = String(body.model ?? ""),
): T {
  if (!rejectsSamplingParams(model)) return body;
  if (!("temperature" in body) && !("top_p" in body)) return body;
  const { temperature: _t, top_p: _p, ...rest } = body;
  return rest as T;
}

/** True when an upstream error says sampling parameters are unsupported. */
export function isSamplingRejection(message: string): boolean {
  return (
    /\b(temperature|top_p)\b/i.test(message) &&
    /unsupported|not support|deprecated|only the default|does not support|invalid/i.test(message)
  );
}

/** Remember that `model` refused sampling parameters (per process). */
export function noteSamplingRejected(model: string): void {
  if (model) learned.add(bareModelId(model));
}

/** Tests: forget learned refusals. */
export function resetSamplingParamsForTests(): void {
  learned.clear();
}
