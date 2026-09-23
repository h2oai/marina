// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// What every passthru surface (chat, Responses, Ollama, the Anthropic bridge)
// shares before touching its protocol: identity resolution, memory injection
// prep + receipt, the trace/upstream hints handed to `proxyToUpstream`, the
// response-cache hooks and the fire-and-forget transcript capture.

import type { Engine } from "../../engine/engine";
import type { EntityId } from "../../types";
import {
  encodeMemoryReceiptAttribute,
  encodeMemoryReceiptHeader,
  finalizeMemoryReceipt,
  MEMORY_RECEIPT_HEADER,
  type MemoryReceipt,
} from "../memory-receipt";
import {
  buildInjectedContext,
  capturePassthruTranscript,
  type InjectionFormat,
  type OpenAIMessage,
  type PassthruIdentity,
  resolvePassthruIdentity,
} from "../passthru-context";
import {
  lookupResponseCache,
  RESPONSE_CACHE_HEADER,
  responseCacheEnabled,
  storeResponseCache,
} from "../response-cache";
import { chatToolCallsToResponses, type ResponsesFunctionCall } from "../responses-tools";
import {
  type CompletionUsage,
  isInternalCaller,
  MODEL_CORS,
  newRequestId,
  type PassthruAuthResult,
  promptTokensDetails,
  requestTrace,
} from "./shared";

/**
 * Whether the request carries any signal that a specific passthru identity is
 * intended. Absent all of these, the request is the anonymous default and we
 * skip identity resolution entirely to stay byte-identical (and write-free).
 */
function passthruSignalPresent(req: Request, authResult: PassthruAuthResult): boolean {
  if (authResult.boundEntityName) return true;
  if (req.headers.get("X-Marina-Agent")) return true;
  const ctx = req.headers.get("X-Marina-Context");
  return ctx != null && ctx.toLowerCase() === "on";
}

/**
 * Resolve the passthru caller to a Marina entity, but only when a real identity
 * signal is present. Returns undefined for the anonymous default so the passthru
 * path performs no entity resolve-or-create and no memory writes.
 */
function maybePassthruIdentity(
  engine: Engine,
  req: Request,
  authResult?: PassthruAuthResult,
): PassthruIdentity | undefined {
  if (!authResult) return undefined;
  if (!passthruSignalPresent(req, authResult)) return undefined;
  const identity = resolvePassthruIdentity(engine, req.headers, authResult);
  // The shared/anonymous default entity is pure passthru: every non-distinct
  // caller collapses onto it, so it must NOT capture transcripts or receive
  // cross-context injection (that would leak caller A's data to caller B). Only a
  // DISTINCT identity — a scoped bound key or an authorized name-map to an
  // existing entity — participates in the shared world.
  if (identity.shared) return undefined;
  return identity;
}

/**
 * Everything the four proxy surfaces share before they touch their protocol:
 * the resolved identity, the injected addendum (built once from the unified
 * memory surface for the caller's query), the finalized receipt and the
 * pre-minted request id that ties header, trace and cache together.
 */
export interface PassthruPrep {
  identity?: PassthruIdentity;
  addendum: string | null;
  receipt?: MemoryReceipt;
  requestId: string;
  /** Protocol surface the request arrived on; rides every lifecycle event so
   *  receipts and trace spans can be grouped per surface. */
  surface: InjectionFormat;
  /** The caller is one of Marina's own runtime agents (internal model token).
   *  Such requests are ALWAYS proxied upstream regardless of the endpoint mode
   *  and carry `routeReason: "internal"` on their lifecycle events. */
  internal: boolean;
}

export async function preparePassthru(
  engine: Engine,
  req: Request,
  authResult: PassthruAuthResult | undefined,
  messages: OpenAIMessage[],
  surface: InjectionFormat,
): Promise<PassthruPrep> {
  const requestId = newRequestId();
  const internal = isInternalCaller(authResult);
  const identity = maybePassthruIdentity(engine, req, authResult);
  if (!identity?.contextOptIn) return { identity, addendum: null, requestId, surface, internal };
  const built = await buildInjectedContext(engine, identity.entityId, messages);
  return {
    identity,
    addendum: built.systemAddendum,
    receipt: built.receipt ? finalizeMemoryReceipt(built.receipt, requestId) : undefined,
    requestId,
    surface,
    internal,
  };
}

/** The trace options every passthru surface hands `proxyToUpstream`. */
export function passthruTraceOptions(prep: PassthruPrep) {
  return {
    routeKind: "passthru" as const,
    ...(prep.internal ? { routeReason: "internal" } : {}),
    entityId: prep.identity?.entityId,
    requestId: prep.requestId,
    memoryReceipt: prep.receipt,
    surface: prep.surface,
  };
}

/** Upstream hints every passthru surface hands `proxyToUpstream`: the memory
 *  addendum, when injected, is the LAST system block (`applyInjection`). */
export function passthruUpstreamHints(
  prep: PassthruPrep,
  extra: { anthropicNative?: Record<string, unknown> } = {},
) {
  return { ...extra, injectedSystemTail: !!prep.addendum };
}

/** The identity string the response cache keys on — the pinned passthru model
 *  when the operator set one, else whatever the client asked for. */
function passthruModelIdentity(body: Record<string, unknown>, forceModel: string): string {
  return forceModel || (typeof body.model === "string" ? body.model : "marina");
}

/**
 * Response-cache read for an identified, opted-in, non-streaming passthru
 * request. Returns a ready OpenAI-shaped Response on a hit (with its own
 * lifecycle spans so `trace show` still works), undefined otherwise.
 */
export async function passthruCacheLookup(
  engine: Engine,
  prep: PassthruPrep,
  body: Record<string, unknown>,
  forceModel: string,
): Promise<Response | undefined> {
  if (!prep.identity?.contextOptIn || !engine.db || body.stream === true) return undefined;
  const entity = engine.entities.get(prep.identity.entityId);
  if (!entity || !responseCacheEnabled(entity)) return undefined;
  const lookup = await lookupResponseCache(
    engine.db,
    prep.identity.name,
    body,
    passthruModelIdentity(body, forceModel),
  );
  if (!lookup.hit) return undefined;
  const requestedModel = typeof body.model === "string" ? body.model : "marina";
  const now = Date.now();
  const receipt = encodeMemoryReceiptAttribute(lookup.value.receipt);
  engine.logEvent({
    type: "model_request_lifecycle",
    phase: "received",
    requestId: prep.requestId,
    ...requestTrace(prep.requestId),
    model: requestedModel,
    routeKind: "passthru",
    ...(prep.internal ? { routeReason: "internal" } : {}),
    entityId: prep.identity.entityId,
    memoryReceipt: receipt,
    surface: prep.surface,
    timestamp: now,
  });
  engine.logEvent({
    type: "model_request_lifecycle",
    phase: "completed",
    requestId: prep.requestId,
    ...requestTrace(prep.requestId),
    model: requestedModel,
    target: "response-cache",
    routeKind: "passthru",
    ...(prep.internal ? { routeReason: "internal" } : {}),
    entityId: prep.identity.entityId,
    memoryReceipt: receipt,
    surface: prep.surface,
    durationMs: Date.now() - now,
    timestamp: Date.now(),
  });
  return new Response(JSON.stringify(lookup.value.body), {
    status: lookup.value.status,
    headers: {
      ...MODEL_CORS,
      "Content-Type": lookup.value.contentType || "application/json",
      "x-request-id": prep.requestId,
      [RESPONSE_CACHE_HEADER]: "hit",
      // The ORIGINAL receipt: the tiers that shaped the cached answer.
      [MEMORY_RECEIPT_HEADER]: encodeMemoryReceiptHeader(lookup.value.receipt),
    },
  });
}

/** Fire-and-forget response-cache write; the RESPONSE checks live in `storeResponseCache`. */
export function passthruCacheStore(
  engine: Engine,
  prep: PassthruPrep,
  body: Record<string, unknown>,
  forceModel: string,
  resp: Response,
): void {
  if (!prep.identity?.contextOptIn || !prep.receipt || !engine.db) return;
  if (body.stream === true || !resp.ok) return;
  const entity = engine.entities.get(prep.identity.entityId);
  if (!entity || !responseCacheEnabled(entity)) return;
  const db = engine.db;
  void storeResponseCache(
    db,
    prep.identity.name,
    body,
    passthruModelIdentity(body, forceModel),
    resp.clone(),
    prep.receipt,
  ).catch(() => {
    // Best-effort: a cache write failure never affects the caller's response.
  });
}

/** Best-effort text + usage extraction from a completed (non-streaming) proxy response. */
export async function extractResponseTextAndUsage(
  resp: Response,
): Promise<{ content: string; usage?: CompletionUsage; toolCalls?: ResponsesFunctionCall[] }> {
  const ct = resp.headers.get("content-type") ?? "";
  // Streaming capture is intentionally skipped in v1 — keep the memory write cheap.
  if (ct.includes("text/event-stream")) return { content: "" };
  try {
    const data = (await resp.json()) as {
      choices?: {
        message?: { content?: unknown; tool_calls?: unknown };
        text?: unknown;
      }[];
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
      };
    };
    const choice = data?.choices?.[0];
    const content = choice?.message?.content ?? choice?.text;
    // `call_id` on the Responses item is the upstream `tool_calls[].id` verbatim.
    const toolCalls = chatToolCallsToResponses(choice?.message?.tool_calls);
    const u = data?.usage;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const prompt = num(u?.prompt_tokens);
    const completion = num(u?.completion_tokens);
    const details = promptTokensDetails(u);
    const usage: CompletionUsage | undefined =
      prompt !== undefined || completion !== undefined
        ? {
            prompt_tokens: prompt ?? 0,
            completion_tokens: completion ?? 0,
            total_tokens: num(u?.total_tokens) ?? (prompt ?? 0) + (completion ?? 0),
            ...(details ? { prompt_tokens_details: details } : {}),
          }
        : undefined;
    return {
      content: typeof content === "string" ? content : "",
      usage,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    };
  } catch {
    return { content: "" };
  }
}

export async function extractResponseText(resp: Response): Promise<string> {
  return (await extractResponseTextAndUsage(resp)).content;
}

/**
 * Fire-and-forget capture of a passthru exchange into the caller's OWN memory so
 * future injections see it. Clones the response synchronously (before the caller
 * consumes it), then extracts and records off the hot path.
 */
export async function capturePassthruResponse(
  engine: Engine,
  entityId: EntityId,
  inboundMessages: OpenAIMessage[],
  resp: Response,
): Promise<void> {
  if (!resp.ok) return;
  const clone = resp.clone();
  try {
    const text = await extractResponseText(clone);
    if (text) capturePassthruTranscript(engine, entityId, inboundMessages, text);
  } catch {
    // Best-effort only — capture must never affect the caller's response.
  }
}
