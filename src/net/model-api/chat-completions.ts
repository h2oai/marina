// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `/v1/chat/completions`: the parsed-body core (`runOpenaiChat`) shared with the
// `/v1/messages` bridge — passthru / internal proxy branch, the verified
// arithmetic fast path, agents / open / panel routing, streaming and the
// 503 → upstream fallback.

import type { Engine } from "../../engine/engine";
import { getEndpointConfig } from "../model-endpoint";
import {
  applyInjection,
  type InjectionFormat,
  messageText,
  type OpenAIMessage,
} from "../passthru-context";
import {
  capturePassthruResponse,
  passthruCacheLookup,
  passthruCacheStore,
  passthruTraceOptions,
  passthruUpstreamHints,
  preparePassthru,
} from "./passthru";
import {
  bufferedOpenaiStream,
  type RouteOptions,
  type RouteResult,
  rejectUnsupportedForAgents,
  routeOpen,
  routePanel,
  routeToChannel,
  routeToChannelStreaming,
  usageFromTrace,
} from "./routing";
import {
  errorJson,
  extractConversationId,
  extractStrategy,
  HttpError,
  isInternalCaller,
  json,
  liveOrchestrationChannel,
  MODEL_CORS,
  modelToChannelName,
  openaiCompletion,
  type PassthruAuthResult,
  requestTrace,
} from "./shared";
import { proxyToUpstream } from "./upstream";

/** Resolve only an explicit, single binary arithmetic expression. This is
 * intentionally conservative: no precedence, variables, units, or inferred
 * operations. Those remain agent work. */
export function tryVerifiedArithmetic(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 300) return undefined;
  const question = input.split("?")[0]!.trim();
  const match = question.match(
    /^(?:(?:what\s+is|calculate|compute)\s+)?(-?\d+(?:\.\d+)?)\s*(multiplied\s+by|times|plus|minus|divided\s+by|[+*/-])\s*(-?\d+(?:\.\d+)?)$/i,
  );
  if (!match) return undefined;
  const left = Number(match[1]);
  const right = Number(match[3]);
  const operator = match[2]!.toLowerCase().replace(/\s+/g, " ");
  if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;

  let result: number;
  let symbol: string;
  if (operator === "multiplied by" || operator === "times" || operator === "*") {
    result = left * right;
    symbol = "×";
  } else if (operator === "plus" || operator === "+") {
    result = left + right;
    symbol = "+";
  } else if (operator === "minus" || operator === "-") {
    result = left - right;
    symbol = "−";
  } else {
    if (right === 0) return undefined;
    result = left / right;
    symbol = "÷";
  }
  if (!Number.isFinite(result)) return undefined;
  const rendered = Number.isInteger(result)
    ? String(result)
    : String(Number(result.toPrecision(12)));
  return `${rendered}. Verified directly: ${left} ${symbol} ${right} = ${rendered}.`;
}

export async function handleOpenaiChat(
  req: Request,
  engine: Engine,
  authResult?: PassthruAuthResult,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorJson(400, "Invalid JSON body");
  }
  return runOpenaiChat(engine, req, body, authResult);
}

/**
 * Core OpenAI chat handling over an already-parsed body. Reached directly by
 * `handleOpenaiChat` and via the `/v1/messages` runInternal callback (the
 * Anthropic Messages bridge translates its request into an OpenAI body first).
 * `req` is still passed for headers (conversation id, load-balance, passthru
 * identity) and auth context; `runOpts.stream` lets a bridge override the body's
 * stream flag.
 */
export async function runOpenaiChat(
  engine: Engine,
  req: Request,
  requestBody: Record<string, unknown>,
  authResult?: PassthruAuthResult,
  runOpts?: {
    stream?: boolean;
    /** Protocol surface for passthru lifecycle events; `openai` unless a bridge says otherwise. */
    surface?: InjectionFormat;
    /** The client's ORIGINAL Anthropic Messages body (`/v1/messages` bridge);
     *  forwarded verbatim when the upstream is Anthropic. */
    anthropicNative?: Record<string, unknown>;
  },
): Promise<Response> {
  try {
    const body: Record<string, unknown> =
      runOpts?.stream !== undefined ? { ...requestBody, stream: runOpts.stream } : requestBody;
    const model = typeof body.model === "string" ? body.model : "marina";
    const messages = Array.isArray(body.messages) ? (body.messages as OpenAIMessage[]) : [];

    // Extract last user message
    const userMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!userMsg) return errorJson(400, "No user message found");
    const userText = messageText(userMsg.content);
    // NOTE: the empty-userText guard lives BELOW the passthru branch — passthru is
    // a thin gateway that must forward multimodal / image-only bodies (which have
    // no textual user content) unchanged. Requiring text here would break them and
    // make injection-OFF passthru non-byte-identical.

    // Build context from system/prior messages
    const contextParts: string[] = [];
    for (const msg of messages) {
      if (msg === userMsg) break;
      contextParts.push(`${msg.role}: ${messageText(msg.content)}`);
    }
    const context = contextParts.length > 0 ? contextParts.join("\n") : undefined;

    const conversationId = extractConversationId(req, body);
    const ec = getEndpointConfig(engine.db);

    // Passthru: Marina is a thin gateway — proxy straight to the configured
    // upstream model. When the caller opts into shared-world context (bound key
    // config or `X-Marina-Context: on`), inject their OWN readable context and
    // record the exchange. Strict NO-OP otherwise: no identity resolve-or-create,
    // no injected bytes, no memory writes — byte-identical to the un-instrumented
    // path (see `maybePassthruIdentity`).
    //
    // Marina's OWN agents (internal model token) take this branch in EVERY
    // endpoint mode — see `isInternalCaller`. Their lifecycle events keep
    // `routeKind: "passthru"` and add `routeReason: "internal"`.
    // An explicit id naming a live agent channel goes to those agents even in
    // passthru mode or from an internal caller (see liveOrchestrationChannel).
    const orchestration = liveOrchestrationChannel(
      engine,
      model,
      req.headers.get("X-Marina-Agent")?.split(":")[0]?.trim() || undefined,
    );
    if ((ec.mode === "passthru" || isInternalCaller(authResult)) && !orchestration) {
      // Also the `/v1/messages` path: the Anthropic bridge translates its body
      // to this shape first, so the addendum lands in the OpenAI system message
      // here and `proxyToAnthropic` moves it into the native `system` field.
      // The body is OpenAI-shaped on both, so the injection format is `openai`;
      // the SURFACE recorded on the lifecycle events is the protocol the client
      // actually spoke (`anthropic` when the bridge called in).
      const prep = await preparePassthru(
        engine,
        req,
        authResult,
        messages,
        runOpts?.surface ?? "openai",
      );
      if (prep.addendum) applyInjection(body, prep.addendum, "openai");
      // The native Anthropic body gets the same addendum in ITS native slot (a
      // leading system text block) so a `/v1/messages` client's own
      // cache_control markers survive when the upstream is Anthropic.
      let anthropicNative = runOpts?.anthropicNative;
      if (anthropicNative && prep.addendum) {
        anthropicNative = applyInjection({ ...anthropicNative }, prep.addendum, "anthropic");
      }
      const cached = await passthruCacheLookup(engine, prep, body, ec.passthruModel);
      if (cached) return cached;
      const resp = await proxyToUpstream(
        engine,
        body,
        ec.passthruModel || undefined,
        passthruTraceOptions(prep),
        passthruUpstreamHints(prep, anthropicNative ? { anthropicNative } : {}),
      );
      if (prep.identity?.contextOptIn) {
        void capturePassthruResponse(engine, prep.identity.entityId, messages, resp);
        passthruCacheStore(engine, prep, body, ec.passthruModel, resp);
      }
      return resp;
    }

    // Non-passthru routing modes synthesize an answer from the user's text, so it
    // must be present. (Passthru already returned above without this requirement.)
    if (!userText) return errorJson(400, "User message has no textual content");

    // Agents answer in text over a channel: tools / n / response_format cannot
    // be honored here. Refuse explicitly (code `unsupported_parameter`) rather
    // than return a plain answer the client will misread as "no tool call".
    const rejected = rejectUnsupportedForAgents(body);
    if (rejected) return rejected;

    const opts: RouteOptions = {
      context,
      conversationId,
      strategy: req.headers.has("X-Load-Balance") ? extractStrategy(req) : ec.strategy,
    };
    const wantStream = body.stream === true;

    // A deliberately tiny verified fast path keeps the demo reactive without
    // pretending arbitrary language tasks are deterministic. Everything that
    // is not one explicit binary arithmetic expression still goes through the
    // autonomous endpoint crew.
    const fastAnswer =
      ec.mode === "agents" &&
      modelToChannelName(model) === "model-answerer" &&
      process.env.MARINA_MODEL_FAST_PATH !== "false"
        ? tryVerifiedArithmetic(userText)
        : undefined;
    if (fastAnswer) {
      const requestId = `req-${crypto.randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: "received",
        requestId,
        ...requestTrace(requestId),
        model,
        timestamp: startedAt,
      });
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: "fast_path",
        requestId,
        ...requestTrace(requestId),
        model,
        target: "verified-arithmetic",
        timestamp: Date.now(),
      });
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: "completed",
        requestId,
        ...requestTrace(requestId),
        model,
        target: "verified-arithmetic",
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
      });
      if (wantStream) return bufferedOpenaiStream(model, fastAnswer, conversationId, requestId);
      return json(openaiCompletion(model, fastAnswer), 200, { "x-request-id": requestId });
    }

    try {
      // Agents mode streams natively (one coordinator, incremental deltas).
      if (wantStream && (ec.mode === "agents" || orchestration)) {
        const {
          stream,
          conversationId: convId,
          requestId,
        } = routeToChannelStreaming(engine, model, userText, "openai", opts);
        const headers: Record<string, string> = {
          ...MODEL_CORS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "x-request-id": requestId,
        };
        if (convId) headers["X-Conversation-Id"] = convId;
        return new Response(stream, { headers });
      }

      let result: RouteResult;
      if (orchestration) {
        result = await routeToChannel(engine, model, userText, opts);
      } else if (ec.mode === "open") {
        result = await routeOpen(engine, model, userText, opts);
      } else if (ec.mode === "panel") {
        result = await routePanel(engine, model, userText, opts, ec.panelSize, ec.panelSynthesis);
      } else {
        result = await routeToChannel(engine, model, userText, opts);
      }

      // open/panel can't stream incrementally — emit the buffered result as SSE.
      if (wantStream) {
        return bufferedOpenaiStream(model, result.content, result.conversationId, result.requestId);
      }

      const extra: Record<string, string> = { "x-request-id": result.requestId };
      if (result.conversationId) extra["X-Conversation-Id"] = result.conversationId;
      return json(
        openaiCompletion(model, result.content, usageFromTrace(engine, result.requestId)),
        200,
        extra,
      );
    } catch (routeError) {
      // No agent answered (503): fall back to direct upstream proxy when enabled.
      // 404 (unknown model variant) remains an error — caller asked for a specific model.
      if (routeError instanceof HttpError && routeError.status === 503 && ec.fallback) {
        return await proxyToUpstream(engine, body, ec.passthruModel || undefined, {
          routeKind: "fallback",
        });
      }
      throw routeError;
    }
  } catch (e) {
    if (e instanceof HttpError) return errorJson(e.status, e.message);
    return errorJson(500, "Internal error");
  }
}
