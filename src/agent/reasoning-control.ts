// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Request shaping for OpenRouter-routed agents, the per-model facts Marina
 * learns about them, and the output budget for models that reason by default.
 *
 * Measured against OpenRouter (2026-10): with `thinkingLevel: "off"` Marina
 * sends no reasoning directive (`neutralizeUnusedReasoning`), and many models
 * then REASON BY DEFAULT — their hidden reasoning tokens count against
 * `max_tokens`. On a compact crew output cap the reasoning can fill the whole
 * completion, so the turn ends on its length limit before any tool call (an
 * agent that looks "silent"). An explicit disable is no universal fix: several
 * models reject it ("Reasoning is mandatory for this endpoint") and at least one
 * accepts it but then stops calling tools. So:
 *
 *  - The output cap for a model that may reason by default leaves room for that
 *    reasoning (`reasoningHeadroomCap`), and a turn that ends on its length limit
 *    without a tool call grows the cap (`grownOutputCap`).
 *  - The explicit disable `reasoning: { enabled: false }` is sent only for a
 *    model a probe has VERIFIED still makes tool calls with it (`model-probe`'s
 *    tool-calling probe records that here); it is dropped for a model an
 *    upstream later says cannot disable reasoning.
 *  - With tools present, OpenRouter is asked to `require_parameters`, so a
 *    request is never routed to a provider that silently ignores `tools`; that
 *    stops for a model where no endpoint supports every parameter.
 *
 * Every lesson is per model id, per process. `MARINA_OPENROUTER_REQUIRE_PARAMETERS=off`
 * and `MARINA_OPENROUTER_REASONING_OFF=off` turn the shaping off.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

const reasoningOffVerified = new Set<string>();
const reasoningMandatory = new Set<string>();
const requireParametersUnsatisfiable = new Set<string>();

/** A model whose requests go to OpenRouter (registry or synthesized). */
export function isOpenRouterModel(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
  return (
    model.provider === "openrouter" || /(^|\/\/)openrouter\.ai(\/|$)/.test(model.baseUrl ?? "")
  );
}

function enabled(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() !== "off";
}

/** Record that `modelId` still makes tool calls with reasoning disabled (from a probe). */
export function markReasoningOffVerified(modelId: string): void {
  if (!reasoningMandatory.has(modelId)) reasoningOffVerified.add(modelId);
}

/** Whether an upstream said `modelId` cannot disable reasoning ("reasoning is mandatory"). */
export function isReasoningMandatory(modelId: string): boolean {
  return reasoningMandatory.has(modelId);
}

/** Whether `modelId` is known to accept an explicit reasoning disable and still call tools. */
export function isReasoningOffVerified(modelId: string): boolean {
  return reasoningOffVerified.has(modelId) && !reasoningMandatory.has(modelId);
}

/**
 * Patch an outgoing OpenRouter chat-completions body. Returns the new body, or
 * `undefined` to keep the payload as it is. Never overrides a reasoning
 * directive or a provider preference the request already carries.
 */
export function shapeOpenRouterPayload(
  payload: unknown,
  model: Pick<Model<Api>, "id" | "provider" | "baseUrl">,
  thinkingLevel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | undefined {
  if (!isOpenRouterModel(model)) return undefined;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  let next: Record<string, unknown> | undefined;
  const thinkingOff = !thinkingLevel || thinkingLevel === "off";
  if (
    thinkingOff &&
    enabled(env.MARINA_OPENROUTER_REASONING_OFF) &&
    isReasoningOffVerified(model.id) &&
    body.reasoning === undefined &&
    body.reasoning_effort === undefined
  ) {
    next = { ...body, reasoning: { enabled: false } };
  }
  const tools = body.tools;
  const provider = body.provider;
  const providerHasFlag =
    provider !== null &&
    typeof provider === "object" &&
    "require_parameters" in (provider as Record<string, unknown>);
  if (
    Array.isArray(tools) &&
    tools.length > 0 &&
    enabled(env.MARINA_OPENROUTER_REQUIRE_PARAMETERS) &&
    !requireParametersUnsatisfiable.has(model.id) &&
    !providerHasFlag
  ) {
    next = {
      ...(next ?? body),
      provider: {
        ...(provider !== null && typeof provider === "object"
          ? (provider as Record<string, unknown>)
          : {}),
        require_parameters: true,
      },
    };
  }
  return next;
}

/** What an upstream rejection taught us. */
export type UpstreamLesson = "reasoning-mandatory" | "no-endpoint-for-parameters";

/**
 * Learn from an upstream error message for `modelId` so the NEXT request is
 * sent without the offending field: a model that cannot disable reasoning
 * stops receiving the disable; a model with no endpoint that supports every
 * parameter stops receiving `require_parameters`. `undefined` = nothing new.
 */
export function noteUpstreamRejection(
  modelId: string,
  errorText: string | undefined,
): UpstreamLesson | undefined {
  if (!errorText) return undefined;
  if (/reasoning is mandatory|cannot be disabled/i.test(errorText)) {
    if (reasoningMandatory.has(modelId)) return undefined;
    reasoningMandatory.add(modelId);
    reasoningOffVerified.delete(modelId);
    return "reasoning-mandatory";
  }
  if (
    /no endpoints found|requested parameters|support all (of )?the (requested )?parameters/i.test(
      errorText,
    )
  ) {
    if (requireParametersUnsatisfiable.has(modelId)) return undefined;
    requireParametersUnsatisfiable.add(modelId);
    return "no-endpoint-for-parameters";
  }
  return undefined;
}

/** Test hook: forget every learned fact. */
export function resetReasoningControlForTests(): void {
  reasoningOffVerified.clear();
  reasoningMandatory.clear();
  requireParametersUnsatisfiable.clear();
}

/**
 * Output-cap floor for a model that may reason by default (an OpenRouter
 * model, an id the registry does not know, or a registry reasoning model the
 * agent calls with thinking off): hidden reasoning counts against the cap, so a
 * 2048-token crew default can be spent before a tool call. `max_tokens` is a
 * ceiling, not a spend — a larger cap costs nothing unless it is used.
 */
export const REASONING_HEADROOM_TOKENS = 8192;

/** The automatic cap with headroom applied (never above `ceiling`). */
export function reasoningHeadroomCap(base: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(base, REASONING_HEADROOM_TOKENS));
}

/**
 * The output cap to use after a turn ended on its length limit without a tool
 * call: double it (at least {@link REASONING_HEADROOM_TOKENS}), never past
 * `ceiling`. `undefined` when the cap cannot grow.
 */
export function grownOutputCap(current: number, ceiling: number): number | undefined {
  const next = Math.min(ceiling, Math.max(current * 2, REASONING_HEADROOM_TOKENS));
  return next > current ? next : undefined;
}
