// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one place an in-process model call happens: `modelComplete` and
 * `modelTurns` both go through {@link modelCall}. Per logical call it
 *
 *   - mints a request id and emits `model_request_lifecycle` events
 *     (`trace.ts`) carrying the purpose and the caller's trace context;
 *   - prices every attempt (`callCost`) and records it ONCE in the daily
 *     spend ledger under the purpose's source plus a `purpose:<name>` row —
 *     except a loopback `marina/*` call, which the `/v1` passthru records;
 *   - retries transient failures (429, 5xx, network) a bounded number of
 *     times with backoff (`retry.ts`; default one retry);
 *   - with `MARINA_MODEL_ROUTE_FALLBACK=on` (default off), reuses route
 *     health (`src/net/model/route-health.ts`): a first-party route under a
 *     usage limit is served by the SAME model via OpenRouter, and a usage
 *     limit seen here marks the route for every caller. Never another model.
 */

import type {
  AssistantMessage,
  Context,
  StopReason,
  TextContent,
  ToolChoice,
} from "@earendil-works/pi-ai";
import { prepareHostedModel } from "../agent/hosted-model";
import { resolveModel } from "../agent/lean-agent-adapter";
import { piModels } from "../agent/pi-models";
import { PROVIDER_MAX_RETRIES } from "../engine/constants";
import { getErrorMessage } from "../engine/errors";
import { dailyCapRefusal, recordPurposeSpend, type SpendSource } from "../engine/spend-ledger";
import { beginObservedSpend, withSpendObservation } from "../engine/spend-observation";
import {
  classifyUpstreamRefusal,
  isDirectRoute,
  noteRouteRefusal,
  routeLimited,
  sameModelFallback,
} from "../net/model/route-health";
import { noteTierOutputCapReply } from "../net/model/tier-output-cap";
import { callCost, isLoopbackMarinaSpec, type ResolvedModel, type Usage } from "./access";
import { checkOutputPayload } from "./output-payload";
import type { ModelPurpose } from "./purpose";
import {
  backoff,
  failureKind,
  isTransientFailure,
  modelRetries,
  modelRetryBaseMs,
  retryDelayMs,
} from "./retry";
import {
  emitModelTrace,
  type ModelLifecycleEvent,
  type ModelTraceContext,
  newModelRequestId,
  traceContextAttributes,
} from "./trace";
/** Options every `src/model` entry point accepts. */
export interface ModelCallOptions {
  /** What the call is for — the ledger's purpose row and the span's `purpose`. */
  purpose?: ModelPurpose;
  /** Override the ledger source the purpose maps to. */
  spendSource?: SpendSource;
  /** Caller, task, round, question and an optional trace to join. */
  trace?: ModelTraceContext;
}

/** `MARINA_MODEL_ROUTE_FALLBACK=on` lets library calls use the same-model OpenRouter route. */
export function modelRouteFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MARINA_MODEL_ROUTE_FALLBACK ?? "").trim().toLowerCase() === "on";
}

/** One model and the key to reach it. */
export interface CallTarget {
  spec: string;
  model: ResolvedModel;
  apiKey: string;
}

/** Everything fixed across the calls of one `modelComplete` / `modelTurns`. */
export interface CallBinding {
  target: CallTarget;
  env: NodeJS.ProcessEnv;
  usage: Usage;
  purpose: ModelPurpose;
  source: SpendSource;
  trace?: ModelTraceContext;
  /** Input tokens to add to `usage` for one reply. */
  inputTokens: (u: AssistantMessage["usage"] | undefined) => number;
  /** Stop reasons that fail the call (the reply's own `errorMessage`, else `model <reason>`). */
  failOn: ReadonlySet<StopReason>;
  /** Called with each attempt's cost (a run's own spend guard). */
  onCost?: (usd: number) => void;
}

export interface CallRequest {
  context: Context;
  maxTokens: number;
  explicitOutputCap?: boolean;
  toolChoice?: ToolChoice;
  timeoutMs: number;
  signals: readonly (AbortSignal | undefined)[];
  /** Set when `maxTokens` is the tier's default cap (`marina/cheap`, the caller
   *  set none): a reply that stops on its length limit is a cap hit. */
  tierCapped?: boolean;
}

/** The OpenRouter route for the same model while `target`'s direct route is limited. */
async function fallbackTarget(
  target: CallTarget,
  env: NodeJS.ProcessEnv,
): Promise<CallTarget | undefined> {
  const provider = String(target.model.provider);
  if (!isDirectRoute(provider, target.model.baseUrl)) return undefined;
  const orKey = env.OPENROUTER_API_KEY?.trim();
  const fb = await sameModelFallback(provider, target.model.id, {
    hasOpenRouterKey: !!orKey,
    env,
  });
  if (!fb || !orKey) return undefined;
  const base = resolveModel(`openrouter/${fb.model}`);
  return {
    spec: `openrouter/${fb.model}`,
    model: {
      ...base,
      contextWindow: target.model.contextWindow,
      maxTokens: target.model.maxTokens,
    } as ResolvedModel,
    apiKey: orKey,
  };
}

function lifecycle(
  binding: CallBinding,
  requestId: string,
  phase: ModelLifecycleEvent["phase"],
  extra: Partial<ModelLifecycleEvent> = {},
): ModelLifecycleEvent {
  const ctx = binding.trace;
  const traceContext = traceContextAttributes(ctx);
  return {
    type: "model_request_lifecycle",
    phase,
    requestId,
    runId: ctx?.traceId ?? requestId,
    traceId: ctx?.traceId ?? requestId,
    spanId: `span-${requestId}`,
    ...(ctx?.parentSpanId ? { parentSpanId: ctx.parentSpanId } : {}),
    model: binding.target.spec,
    routeKind: "direct",
    purpose: binding.purpose,
    ...(traceContext ? { traceContext } : {}),
    timestamp: Date.now(),
    ...extra,
  };
}

/**
 * One logical model call: attempts, retries and an optional route fallback,
 * each attempt priced and recorded. Resolves with the reply; rejects with the
 * last attempt's error (a thrown error unchanged, a failed reply as `Error`).
 */
export async function modelCall(
  binding: CallBinding,
  request: CallRequest,
): Promise<AssistantMessage> {
  const { env, usage } = binding;
  const requestId = newModelRequestId();
  const started = Date.now();
  const retries = modelRetries(env);
  const fallbackOn = modelRouteFallbackEnabled(env);
  const signals = request.signals.filter((s): s is AbortSignal => !!s);
  const aborted = () => signals.some((s) => s.aborted);
  const anySignal = signals.length ? AbortSignal.any(signals) : undefined;
  const ledger = !isLoopbackMarinaSpec(binding.target.spec);
  let target = binding.target;
  let routed = false;
  let attempt = 0;
  let tokens = { input: 0, output: 0, reasoning: 0, cost: 0 };
  emitModelTrace(lifecycle(binding, requestId, "received", { timestamp: started }));

  if (fallbackOn && routeLimited(String(target.model.provider))) {
    const fb = await fallbackTarget(target, env);
    if (fb) {
      target = fb;
      routed = true;
    }
  }

  for (;;) {
    if (attempt > 0) {
      // A retry is a new upstream call: the daily cap applies to it too.
      const capped = dailyCapRefusal(env);
      if (capped) return fail(new Error(capped), capped);
    }
    let failure: unknown;
    let message: string;
    let observed: ReturnType<typeof beginObservedSpend>;
    let outputDetail: string | undefined;
    try {
      await prepareHostedModel(target.model, target.apiKey, undefined, anySignal);
      observed = beginObservedSpend(binding.source, target.spec);
      const result = await piModels.completeSimple(target.model, request.context, {
        apiKey: target.apiKey,
        maxTokens: request.maxTokens,
        // pi-ai retries a 408/409/429/5xx inside the request, honouring Retry-After
        // (bounded, abortable) — but only when asked; its default is 0. Without this
        // a 429 that names its wait reached Marina's header-blind loop below, whose
        // one retry after ~1 s lost the call. Same allowance as an agent turn.
        maxRetries: PROVIDER_MAX_RETRIES,
        onPayload: (payload) => {
          checkOutputPayload(
            payload,
            request.maxTokens,
            request.explicitOutputCap === true,
            (detail) => {
              outputDetail = detail;
            },
          );
        },
        ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
        signal: AbortSignal.any([AbortSignal.timeout(request.timeoutMs), ...signals]),
      });
      usage.calls++;
      const input = binding.inputTokens(result.usage);
      const output = result.usage?.output ?? 0;
      usage.inputTokens += input;
      usage.outputTokens += output;
      const cost = await callCost(target.spec, target.model, result.usage);
      usage.costUsd += cost;
      tokens = {
        input: tokens.input + input,
        output: tokens.output + output,
        reasoning: tokens.reasoning + (result.usage?.reasoning ?? 0),
        cost: tokens.cost + cost,
      };
      if (ledger)
        withSpendObservation(undefined, () =>
          recordPurposeSpend(binding.purpose, binding.source, cost, env),
        );
      observed?.settle(
        result.usage ? cost : undefined,
        result.usage ? undefined : "Provider returned no usage",
      );
      binding.onCost?.(cost);
      if (!binding.failOn.has(result.stopReason)) {
        const capHit = !!request.tierCapped && result.stopReason === "length";
        if (request.tierCapped) noteTierOutputCapReply(capHit);
        emitModelTrace(
          lifecycle(binding, requestId, "completed", {
            ...(routed ? { routeKind: "fallback" as const, target: target.spec } : {}),
            durationMs: Date.now() - started,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            ...(tokens.reasoning > 0 ? { reasoningTokens: tokens.reasoning } : {}),
            costUsd: tokens.cost,
            ...(request.tierCapped ? { outputCap: request.maxTokens } : {}),
            ...(capHit ? { outputCapHit: true } : {}),
            ...(attempt > 0 || outputDetail
              ? {
                  detail: [outputDetail, attempt > 0 ? `retries:${attempt}` : undefined]
                    .filter(Boolean)
                    .join("; "),
                }
              : {}),
          }),
        );
        return result;
      }
      message = result.errorMessage ?? `model ${result.stopReason}`;
      failure = new Error(message);
      if (result.stopReason === "aborted") return fail(failure, message);
    } catch (error) {
      observed?.settle(undefined, "Provider attempt failed without a priced receipt");
      failure = error;
      message = getErrorMessage(error);
    }
    if (aborted()) return fail(failure, message);
    const kind = failureKind(message);
    const refusal = classifyUpstreamRefusal(message);
    // Only a provider's usage limit moves a call to another route — never Marina's own cap.
    if (refusal.kind === "usage-limit" && fallbackOn && !routed) {
      const provider = String(target.model.provider);
      if (isDirectRoute(provider, target.model.baseUrl)) {
        noteRouteRefusal(provider, refusal);
        const fb = await fallbackTarget(target, env);
        if (fb) {
          target = fb;
          routed = true;
          continue;
        }
      }
    }
    if (!isTransientFailure(kind) || attempt >= retries) return fail(failure, message);
    try {
      await backoff(retryDelayMs(attempt, modelRetryBaseMs(env)), anySignal);
    } catch {
      return fail(failure, message);
    }
    attempt++;
  }

  function fail(failure: unknown, message: string): never {
    emitModelTrace(
      lifecycle(binding, requestId, "failed", {
        ...(routed ? { routeKind: "fallback" as const, target: target.spec } : {}),
        durationMs: Date.now() - started,
        errorKind: failureKind(message, aborted()),
        detail: message.replace(/\s+/g, " ").slice(0, 200),
        ...(tokens.cost > 0 ? { costUsd: tokens.cost } : {}),
      }),
    );
    throw failure;
  }
}

/** The text blocks of a reply, joined with newlines (untrimmed). */
export function replyText(result: AssistantMessage): string {
  return (Array.isArray(result.content) ? result.content : [])
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
