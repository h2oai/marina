// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `/v1/responses` handlers: the owner-scoped in-memory response index (one
// instance, module state), create (passthru + agents paths), GET and DELETE.

import { createHash } from "node:crypto";
import type { Engine } from "../../engine/engine";
import { getEndpointConfig } from "../model-endpoint";
import { UnsupportedParameterError } from "../openai-errors";
import { applyInjection, capturePassthruTranscript, type OpenAIMessage } from "../passthru-context";
import {
  type ChatToolFields,
  type ResponsesFunctionCall,
  ResponsesRequestError,
  responsesInputToMessages,
  restorePriorToolCalls,
  translateResponsesTools,
} from "../responses-tools";
import {
  capturePassthruResponse,
  extractResponseTextAndUsage,
  passthruCacheLookup,
  passthruCacheStore,
  passthruTraceOptions,
  passthruUpstreamHints,
  preparePassthru,
} from "./passthru";
import {
  formatResponseRecord,
  type ResponseRecord,
  ResponsesSseEmitter,
  responsesPassthruStream,
  responsesSseStream,
} from "./responses-sse";
import {
  buildHistory,
  getOrCreateConversationChannel,
  type RouteOptions,
  rejectUnsupportedForAgents,
  routeToChannel,
  routeToChannelStreaming,
  usageFromTrace,
} from "./routing";
import {
  errorJson,
  extractStrategy,
  forwardPassthruHeaders,
  HttpError,
  isInternalCaller,
  json,
  type PassthruAuthResult,
  SSE_HEADERS,
} from "./shared";
import { proxyToUpstream } from "./upstream";

/** Stable per-credential owner key for Responses records. Hashes the matched
 *  API key so the raw secret is never stored; internal/open/anon get sentinels. */
function responseOwnerKey(auth: PassthruAuthResult | undefined): string {
  if (auth?.matchedKey) {
    return `k:${createHash("sha256").update(auth.matchedKey).digest("hex")}`;
  }
  if (auth?.internal) return "internal";
  if (auth?.openMode) return "open";
  return "anon";
}

const responseIndex = new Map<string, ResponseRecord>();
const RESPONSE_RETENTION_MS = 24 * 60 * 60 * 1000;
// Hard size cap: records hold full response content, and a time-only sweep
// leaves the index unbounded under sustained traffic (~860k live entries at
// 10 req/s). Insertion order == creation order, so evicting from the front is
// oldest-first.
const RESPONSE_INDEX_MAX = 50_000;
const RESPONSE_SWEEP_INTERVAL_MS = 60_000;
let lastResponseSweep = 0;

function trimResponseIndex(): void {
  const now = Date.now();
  // The O(n) time sweep runs at most once per interval, not per request.
  if (now - lastResponseSweep >= RESPONSE_SWEEP_INTERVAL_MS) {
    lastResponseSweep = now;
    const cutoff = now - RESPONSE_RETENTION_MS;
    for (const [id, rec] of responseIndex) {
      if (rec.createdAt < cutoff) responseIndex.delete(id);
    }
  }
  while (responseIndex.size > RESPONSE_INDEX_MAX) {
    const oldest = responseIndex.keys().next().value;
    if (oldest === undefined) break;
    responseIndex.delete(oldest);
  }
}

function newResponseId(): string {
  return `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** True when `owner` may thread onto `conversationId`: either a stored response
 *  record already binds that conversation to this owner, or nothing (no record,
 *  no `model-conv-<id>` channel) claims it yet. A conversation known only via
 *  its channel — records evicted/expired, or created by another surface — is
 *  treated as not-owned: the owner binding is gone, so nobody can resume it. */
function callerOwnsConversation(engine: Engine, owner: string, conversationId: string): boolean {
  let seen = false;
  for (const rec of responseIndex.values()) {
    if (rec.conversationId !== conversationId) continue;
    if (rec.owner === owner) return true;
    seen = true;
  }
  if (seen) return false;
  const cm = engine.channelManager;
  return !cm?.getChannelByName(`model-conv-${conversationId}`);
}

export async function handleResponsesCreate(
  req: Request,
  engine: Engine,
  auth: PassthruAuthResult | undefined,
): Promise<Response> {
  trimResponseIndex();
  const owner = responseOwnerKey(auth);
  try {
    const body = (await req.json()) as {
      model?: string;
      input?: unknown;
      instructions?: string;
      previous_response_id?: string;
      conversation_id?: string;
      store?: boolean;
      stream?: boolean;
      tools?: unknown;
      tool_choice?: unknown;
      parallel_tool_calls?: unknown;
    };

    const model = body.model ?? "marina";
    // Typed input items (message / function_call / function_call_output) →
    // chat messages for passthru, plus a text rendering for the conversation
    // channel and the agent route (`responses-tools.ts`).
    let turn: ReturnType<typeof responsesInputToMessages>;
    try {
      turn = responsesInputToMessages(body.input);
    } catch (e) {
      if (e instanceof UnsupportedParameterError) return json(e.toBody(), 400);
      if (e instanceof ResponsesRequestError) return errorJson(400, e.message, { param: e.param });
      throw e;
    }
    const userInput = turn.text;
    if (!userInput || turn.messages.length === 0) {
      return errorJson(400, "`input` is required", { param: "input" });
    }
    // Streaming: the answer is produced whole on this surface, then emitted as
    // the standard Responses SSE sequence (see `responsesSseStream`).
    const wantStream = body.stream === true;

    // Resolve conversation: previous_response_id > explicit conversation_id > new
    let conversationId: string;
    let previousResponseId: string | undefined;
    if (body.previous_response_id) {
      const prior = responseIndex.get(body.previous_response_id);
      // Owner check: a caller can only thread onto a conversation it owns.
      // Not-found and not-owned are indistinguishable (404, no existence leak).
      if (!prior || prior.owner !== owner) {
        return errorJson(404, `previous_response_id not found: ${body.previous_response_id}`);
      }
      conversationId = prior.conversationId;
      previousResponseId = prior.id;
    } else if (body.conversation_id) {
      // Owner check mirrors previous_response_id: an explicit conversation_id
      // must belong to this caller. Unknown to the index AND no live channel
      // → a fresh conversation the caller may claim. Anything else that isn't
      // ours is 404 — not-found and not-owned stay indistinguishable.
      if (!callerOwnsConversation(engine, owner, body.conversation_id)) {
        return errorJson(404, `conversation_id not found: ${body.conversation_id}`);
      }
      conversationId = body.conversation_id;
    } else {
      conversationId = crypto.randomUUID();
    }

    const ec = getEndpointConfig(engine.db);
    // Marina's own agents always proxy upstream (see `isInternalCaller`).
    if (ec.mode === "passthru" || isInternalCaller(auth)) {
      // Responses tools → chat tools before any upstream call; a hosted tool
      // type (web_search, file_search, …) is a 400 the client must see, never
      // a silent drop.
      let chatTools: ChatToolFields;
      try {
        chatTools = translateResponsesTools(body as Record<string, unknown>);
      } catch (e) {
        if (e instanceof UnsupportedParameterError) return json(e.toBody(), 400);
        if (e instanceof ResponsesRequestError)
          return errorJson(400, e.message, { param: e.param });
        throw e;
      }
      return await runResponsesPassthru(engine, req, auth, {
        model,
        body,
        userInput,
        turn: turn.messages,
        chatTools,
        priorToolCalls: previousResponseId
          ? responseIndex.get(previousResponseId)?.toolCalls
          : undefined,
        conversationId,
        previousResponseId,
        owner,
        wantStream,
      });
    }

    // In-world agents answer with text: a Responses tool schema or output
    // format cannot be honored on this route, so say so instead of dropping it.
    const rejected = rejectUnsupportedForAgents(body as Record<string, unknown>);
    if (rejected) return rejected;

    const opts: RouteOptions = {
      context: body.instructions ? `system: ${body.instructions}` : undefined,
      conversationId,
      // Explicit X-Load-Balance wins; otherwise the operator-configured strategy.
      strategy: req.headers.has("X-Load-Balance") ? extractStrategy(req) : ec.strategy,
    };

    try {
      if (wantStream) {
        // Agents stream natively (`model_response_chunk` deltas from the
        // routed agent) — each delta becomes one `response.output_text.delta`.
        const emitter = new ResponsesSseEmitter({
          id: newResponseId(),
          conversationId,
          model,
          createdAt: Date.now(),
          previousResponseId,
          owner,
        });
        const { stream, requestId } = routeToChannelStreaming(
          engine,
          model,
          userInput,
          "responses",
          opts,
          {
            emitter,
            onComplete: (rec) => {
              if (body.store !== false) responseIndex.set(rec.id, rec);
            },
          },
        );
        return new Response(stream, {
          headers: {
            ...SSE_HEADERS,
            "X-Conversation-Id": conversationId,
            "x-request-id": requestId,
          },
        });
      }
      const result = await routeToChannel(engine, model, userInput, opts);
      const id = newResponseId();
      const rec: ResponseRecord = {
        id,
        conversationId,
        model,
        content: result.content,
        createdAt: Date.now(),
        previousResponseId,
        status: "completed",
        usage: usageFromTrace(engine, result.requestId),
        owner,
      };
      if (body.store !== false) {
        responseIndex.set(id, rec);
      }
      const headers = {
        "X-Conversation-Id": conversationId,
        "x-request-id": result.requestId,
      };
      return json(formatResponseRecord(rec), 200, headers);
    } catch (routeError) {
      if (routeError instanceof HttpError && routeError.status === 503) {
        // No agents online — do NOT fall back silently for Responses API;
        // surface the state error so the client can decide.
        return errorJson(503, routeError.message);
      }
      throw routeError;
    }
  } catch (e) {
    if (e instanceof HttpError) return errorJson(e.status, e.message);
    return errorJson(500, "Internal error");
  }
}

/**
 * Responses-API passthru: memory lands in the native `instructions` slot, the
 * conversation channel supplies prior turns (same server-side state contract
 * as agent routing), and the completion is stored as a response record so
 * `previous_response_id` threading keeps working against an upstream model.
 * Tools travel both ways (`responses-tools.ts`): `chatTools` are the
 * already-translated chat-completions fields, `turn` the chat messages for
 * the new input (text, replayed `function_call`s, `function_call_output`
 * results), and `priorToolCalls` the stored calls of the threaded prior
 * response so a `function_call_output`-only continuation reaches the upstream
 * with its `tool_calls` restored.
 */
async function runResponsesPassthru(
  engine: Engine,
  req: Request,
  auth: PassthruAuthResult | undefined,
  input: {
    model: string;
    body: {
      instructions?: string;
      temperature?: unknown;
      top_p?: unknown;
      max_output_tokens?: unknown;
      store?: boolean;
    };
    userInput: string;
    turn: OpenAIMessage[];
    chatTools?: ChatToolFields;
    priorToolCalls?: ResponsesFunctionCall[];
    conversationId: string;
    previousResponseId?: string;
    owner: string;
    wantStream?: boolean;
  },
): Promise<Response> {
  const ec = getEndpointConfig(engine.db);
  const cm = engine.channelManager;
  const convChannel = cm ? getOrCreateConversationChannel(cm, input.conversationId) : undefined;
  const history: OpenAIMessage[] =
    cm && convChannel
      ? buildHistory(cm, convChannel.id).map((entry) => ({
          role: entry.role,
          content: entry.content,
        }))
      : [];
  const turns: OpenAIMessage[] = [
    ...restorePriorToolCalls(history, input.priorToolCalls, input.turn),
    ...input.turn,
  ];
  const prep = await preparePassthru(engine, req, auth, turns, "responses");
  const instructions = typeof input.body.instructions === "string" ? input.body.instructions : "";
  // Streaming asks the upstream for chat-completions SSE and re-encodes it
  // incrementally as Responses SSE (see `responsesPassthruStream`); the
  // response cache is bypassed for streams by construction.
  const wantStream = input.wantStream === true;
  // `instructions` is the caller's stable system prompt; the memory addendum
  // is injected on the chat body as its own system message right after it
  // (`applyInjection` openai shape) so the Anthropic translation yields
  // separate stable / memory system blocks for the cache breakpoints.
  const body: Record<string, unknown> = {
    model: input.model,
    messages: [...(instructions ? [{ role: "system", content: instructions }] : []), ...turns],
    stream: wantStream,
    ...(wantStream ? { stream_options: { include_usage: true } } : {}),
    ...(typeof input.body.temperature === "number" ? { temperature: input.body.temperature } : {}),
    ...(typeof input.body.top_p === "number" ? { top_p: input.body.top_p } : {}),
    ...(typeof input.body.max_output_tokens === "number"
      ? { max_tokens: input.body.max_output_tokens }
      : {}),
    ...(input.chatTools ?? {}),
  };
  applyInjection(body, prep.addendum, "openai");

  const cached = await passthruCacheLookup(engine, prep, body, ec.passthruModel);
  const resp =
    cached ??
    (await proxyToUpstream(
      engine,
      body,
      ec.passthruModel || undefined,
      passthruTraceOptions(prep),
      passthruUpstreamHints(prep),
    ));
  if (!resp.ok) {
    let message = resp.statusText || "Upstream request failed";
    try {
      const data = (await resp.json()) as { error?: { message?: unknown } };
      if (typeof data.error?.message === "string") message = data.error.message;
    } catch {
      // Keep the status-derived message.
    }
    return errorJson(resp.status, message);
  }
  const headers = forwardPassthruHeaders(resp.headers, {
    "X-Conversation-Id": input.conversationId,
    "x-request-id": prep.requestId,
  });
  // Runs once the answer is known — after the stream's `response.completed`
  // for a streamed reply, immediately for a buffered one.
  const finalize = (rec: ResponseRecord): void => {
    if (cm && convChannel) {
      // Same sender convention as agent routing: `__model_conv__` marks the user
      // turn; any other non-agent sender reads back as the assistant.
      cm.send(convChannel.id, "__model_conv__", "user", input.userInput);
      cm.send(convChannel.id, "__model_passthru__", "assistant", rec.content);
    }
    if (input.body.store !== false) responseIndex.set(rec.id, rec);
  };
  const base = {
    id: newResponseId(),
    conversationId: input.conversationId,
    model: input.model,
    createdAt: Date.now(),
    previousResponseId: input.previousResponseId,
    owner: input.owner,
  };

  const streamedUpstream =
    wantStream && !cached && (resp.headers.get("content-type") ?? "").includes("text/event-stream");
  if (streamedUpstream) {
    if (!resp.body) return errorJson(502, "Upstream returned an empty streaming body");
    const identity = prep.identity?.contextOptIn ? prep.identity.entityId : undefined;
    const stream = responsesPassthruStream(resp.body, new ResponsesSseEmitter(base), (rec) => {
      finalize(rec);
      if (identity && rec.content) capturePassthruTranscript(engine, identity, turns, rec.content);
    });
    return new Response(stream, { headers: { ...SSE_HEADERS, ...headers } });
  }

  if (!cached && prep.identity?.contextOptIn) {
    void capturePassthruResponse(engine, prep.identity.entityId, turns, resp);
    passthruCacheStore(engine, prep, body, ec.passthruModel, resp);
  }
  const { content, usage, toolCalls } = await extractResponseTextAndUsage(resp.clone());
  const rec: ResponseRecord = {
    ...base,
    content,
    status: "completed",
    usage,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
  finalize(rec);
  // A stream was requested but the upstream answered whole (a cache hit, or a
  // provider that ignored `stream`): emit the same sequence with one delta.
  if (wantStream) return responsesSseStream(rec, headers);
  return json(formatResponseRecord(rec), 200, headers);
}

export function handleResponsesGet(id: string, auth: PassthruAuthResult | undefined): Response {
  trimResponseIndex();
  const rec = responseIndex.get(id);
  // Owner-scoped: a non-owner cannot read (or confirm the existence of) another
  // caller's response — not-found and not-owned both return 404.
  if (!rec || rec.owner !== responseOwnerKey(auth)) {
    return errorJson(404, `Response not found: ${id}`);
  }
  return json(formatResponseRecord(rec));
}

export function handleResponsesDelete(
  id: string,
  auth: PassthruAuthResult | undefined,
  engine: Engine,
): Response {
  const rec = responseIndex.get(id);
  // Owner-scoped: only the creating credential may delete; others get 404.
  if (!rec || rec.owner !== responseOwnerKey(auth)) {
    return errorJson(404, `Response not found: ${id}`);
  }
  responseIndex.delete(id);
  // If no other responses reference this conversation, drop the channel too.
  let stillReferenced = false;
  for (const other of responseIndex.values()) {
    if (other.conversationId === rec.conversationId) {
      stillReferenced = true;
      break;
    }
  }
  if (!stillReferenced) {
    const cm = engine.channelManager;
    if (cm) {
      const ch = cm.getChannelByName(`model-conv-${rec.conversationId}`);
      if (ch) cm.deleteChannel(ch.id);
    }
  }
  return json({ id, object: "response", deleted: true });
}
