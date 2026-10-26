// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * What the passthru proxy knows about an upstream model's reasoning, and the
 * one rule for an output cap that hidden reasoning can fill.
 *
 * Some upstream models reason on every request and cannot turn it off. Through
 * OpenRouter the Claude 5 family beyond its first releases (claude-opus-5.5,
 * claude-sonnet-5.5, claude-fable-5 / 5.1) lists `reasoning: { mandatory: true,
 * default_effort: "high" }` with `low` as its lowest effort; its reasoning
 * tokens count against `max_tokens`. With a small cap the whole budget goes on
 * reasoning and the reply is an empty 200 with `finish_reason: "length"`
 * (verified live 2026-10-12 for anthropic/claude-opus-5.5: 32 tokens at effort
 * `low` → no content; 1024 tokens at effort `low` → the answer after 37
 * reasoning tokens). Gemini Pro (OpenRouter's default) is reasoning-mandatory
 * with `low` as its lowest effort too. The Luna family accepts
 * `reasoning_effort: "none"`.
 *
 * `lowestReasoningEffort` is the static capability table; the proxy sends that
 * effort only when Marina chose the model (the default route), the caller sent
 * no reasoning directive of its own, and either the model can stop reasoning
 * entirely (`none`) or the caller's explicit cap is below
 * {@link SMALL_OUTPUT_CAP_TOKENS}. An explicit cap is never raised.
 * `reasoningExhausted` recognizes the empty-by-cap reply so the proxy can turn
 * it into a coded error instead of a silent empty answer.
 */
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { REASONING_HEADROOM_TOKENS } from "../../agent/reasoning-control";
import { omitsSamplingParams } from "../adapters/anthropic-tools";

/** The lowest reasoning effort a known upstream model accepts. */
export type LowestReasoningEffort = "none" | "low";

/** OpenAI's Luna tier, current and previous generation (optionally `-pro`). */
export const LUNA_MODEL = /^gpt-(?:5\.6|6)-luna(?:-pro)?$/;

/**
 * Claude models served through OpenRouter whose reasoning is mandatory
 * (`reasoning.mandatory: true` in OpenRouter's catalog, 2026-10-12): the 5.5
 * generation and every Fable release. claude-opus-5 / claude-sonnet-5 /
 * claude-haiku-5.5 reason by default but can be disabled, so they are not here.
 */
const OPENROUTER_REASONING_MANDATORY = /^claude-(?:(?:opus|sonnet)-5\.5|fable-5(?:\.\d+)?)(?:$|:)/;

/**
 * Gemini Pro (2.5 and the 3.x line, `-preview` included): reasoning is
 * mandatory on OpenRouter (`supported_efforts: high, medium, low` for
 * gemini-3.1-pro-preview, 2026-10-12) and Gemini Pro thinks on Google's own
 * OpenAI-compatible endpoint too, where `low` is its lowest thinking level.
 */
const GEMINI_PRO = /^gemini-\d+(?:\.\d+)?-pro(?:$|[-:])/;

/**
 * An explicit output cap below this may be filled by hidden reasoning before
 * any answer (the same floor agents keep as reasoning headroom).
 */
export const SMALL_OUTPUT_CAP_TOKENS = REASONING_HEADROOM_TOKENS;

/**
 * The lowest reasoning effort `model` accepts on `provider`, when Marina knows
 * it: `none` for the Luna family (OpenAI, or OpenRouter's `openai/` ids), `low`
 * for the reasoning-mandatory Claude 5 family through OpenRouter and for Gemini
 * Pro (OpenRouter's `google/` ids, or Google directly). `undefined`
 * for every other model — no directive is sent, so no model is handed a value
 * it might reject.
 */
export function lowestReasoningEffort(
  provider: string,
  model: unknown,
): LowestReasoningEffort | undefined {
  if (typeof model !== "string" || !model) return undefined;
  if (provider === "openai" && LUNA_MODEL.test(model)) return "none";
  if (provider === "google" && GEMINI_PRO.test(model)) return "low";
  if (provider !== "openrouter") return undefined;
  const id = model.replace(/^~/, "");
  if (LUNA_MODEL.test(id.replace(/^openai\//, ""))) return "none";
  if (id.startsWith("google/") && GEMINI_PRO.test(id.slice("google/".length))) return "low";
  const bare = id.replace(/^anthropic\//, "");
  if (bare !== id && omitsSamplingParams(bare) && OPENROUTER_REASONING_MANDATORY.test(bare))
    return "low";
  return undefined;
}

/** The output cap the caller set (`max_tokens` / `max_completion_tokens`), if any. */
export function explicitOutputCap(body: Record<string, unknown>): number | undefined {
  for (const field of ["max_completion_tokens", "max_tokens"] as const) {
    const value = body[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * The reasoning effort to add to a default-route request, or `undefined` to
 * leave the body alone. Never overrides the caller's own `reasoning_effort` /
 * `reasoning`; never touches the cap.
 */
export function defaultRouteReasoningEffort(
  body: Record<string, unknown>,
  provider: string,
  defaultRoute: boolean,
): LowestReasoningEffort | undefined {
  if (!defaultRoute) return undefined;
  if (body.reasoning_effort !== undefined || body.reasoning !== undefined) return undefined;
  const lowest = lowestReasoningEffort(provider, body.model);
  if (!lowest) return undefined;
  // A model that can stop reasoning keeps the default route's non-reasoning role.
  if (lowest === "none") return lowest;
  const cap = explicitOutputCap(body);
  return cap !== undefined && cap < SMALL_OUTPUT_CAP_TOKENS ? lowest : undefined;
}

/** The effort names pi-ai clamps between (`off`/`none` are never moved). */
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

let catalog: ReturnType<typeof builtinModels> | undefined;

function openRouterCatalogModel(id: string): Model<Api> | undefined {
  try {
    catalog ??= builtinModels();
    return catalog.getModel("openrouter", id) as Model<Api> | undefined;
  } catch {
    return undefined;
  }
}

/**
 * The effort `model` (an OpenRouter id) takes for a requested `effort`, the
 * way pi-ai shapes a DIRECT OpenRouter request for the same model: an effort
 * the catalog marks unavailable (deepseek-v4.1-flash has no `medium`) moves to
 * the nearest available one, and a mapped name replaces the generic one.
 * `undefined` = send it as it is (unknown model, `none`, or already valid).
 */
export function openRouterEffortFor(model: unknown, effort: unknown): string | undefined {
  if (typeof model !== "string" || typeof effort !== "string") return undefined;
  const level = effort.toLowerCase();
  if (!EFFORT_LEVELS.has(level)) return undefined;
  const known = openRouterCatalogModel(model.replace(/^~/, ""));
  if (!known?.reasoning) return undefined;
  const clamped = clampThinkingLevel(known, level as Parameters<typeof clampThinkingLevel>[1]);
  if (clamped === "off") return undefined;
  const map = (known as { thinkingLevelMap?: Record<string, string | null | undefined> })
    .thinkingLevelMap;
  const mapped = map?.[clamped];
  const sent = typeof mapped === "string" ? mapped : clamped;
  return sent === effort ? undefined : sent;
}

/**
 * A request bound for OpenRouter with its reasoning effort (`reasoning_effort`
 * or `reasoning.effort`) made one the routed model accepts
 * ({@link openRouterEffortFor}), so a caller's thinking level reaches the
 * model through Marina's `/v1` exactly as it would on a direct OpenRouter
 * route. Returns the body itself when nothing needs to move.
 */
export function withOpenRouterEffort(body: Record<string, unknown>): Record<string, unknown> {
  const top = openRouterEffortFor(body.model, body.reasoning_effort);
  const reasoning =
    body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
      ? (body.reasoning as Record<string, unknown>)
      : undefined;
  const nested = reasoning ? openRouterEffortFor(body.model, reasoning.effort) : undefined;
  if (top === undefined && nested === undefined) return body;
  return {
    ...body,
    ...(top !== undefined ? { reasoning_effort: top } : {}),
    ...(nested !== undefined ? { reasoning: { ...reasoning, effort: nested } } : {}),
  };
}

/** Error code for a reply whose output cap was spent before any answer. */
export const REASONING_EXHAUSTED_CODE = "reasoning_exhausted_output";

function hasText(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const text = (part as { text?: unknown } | null)?.text;
    return typeof text === "string" && text.trim().length > 0;
  });
}

/** Reasoning tokens reported in an OpenAI-shaped usage block (0 when absent). */
export function reasoningTokens(usage: unknown): number {
  const details = (usage as { completion_tokens_details?: { reasoning_tokens?: unknown } } | null)
    ?.completion_tokens_details;
  const n = details?.reasoning_tokens;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * An OpenAI `chat.completion` whose first choice ended on its length limit with
 * no visible content and no tool call: the cap went to (hidden) reasoning. Such
 * a reply is not an answer; returning it as a 200 is a silent drop.
 */
export function reasoningExhausted(data: unknown): boolean {
  const choice = (
    data as {
      choices?: {
        finish_reason?: unknown;
        message?: { content?: unknown; tool_calls?: unknown; function_call?: unknown };
      }[];
    } | null
  )?.choices?.[0];
  if (!choice) return false;
  if (choice.finish_reason !== "length" && choice.finish_reason !== "max_tokens") return false;
  const message = choice.message ?? {};
  if (hasText(message.content)) return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
  if (message.function_call) return false;
  return true;
}

/** The caller-facing explanation for a reasoning-exhausted reply. */
export function reasoningExhaustedMessage(cap: number | undefined, reasoning: number): string {
  const spent = reasoning > 0 ? ` (${reasoning} reasoning tokens)` : "";
  const limit = cap !== undefined ? `max_tokens=${cap}` : "the output limit";
  return `The model spent ${limit} on reasoning${spent} and returned no answer. Raise max_tokens (at least ${SMALL_OUTPUT_CAP_TOKENS} leaves room for reasoning) or request a lower reasoning_effort.`;
}
