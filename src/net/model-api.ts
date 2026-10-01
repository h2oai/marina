// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Model API entry point. The surface implementations live in `./model-api/*`
// (one module per concern, strict import DAG rooted at `shared.ts`); this file
// owns authentication + per-IP rate limiting, the path dispatch table and the
// stable public re-exports. Importers never need to know about the layout.

import { version as MARINA_VERSION } from "../../package.json";
import type { RateLimiter } from "../auth/rate-limiter";
import type { Engine } from "../engine/engine";
import { handleAnthropicMessages } from "./anthropic-inbound";
import { handleBenchmarkFile } from "./benchmarks-api";
import { handleDecisionModels, handleDecisions } from "./decisions-api";
import { handleForecast } from "./forecast-api";
import {
  authFailuresExhausted,
  clientIp,
  consumeHttpRate,
  recordAuthFailure,
  SMALL_JSON_BODY_BYTES,
} from "./http-utils";
import { handleMediaApi } from "./media-api";
import { handleOpenaiChat, runOpenaiChat } from "./model-api/chat-completions";
import { listModels, openaiModelList } from "./model-api/models";
import {
  findOllamaModel,
  handleOllamaChat,
  handleOllamaGenerate,
  ollamaPsResponse,
  ollamaShowResponse,
  ollamaTagList,
  UNSERVED_MODEL_PATHS,
} from "./model-api/ollama";
import {
  handleResponsesCreate,
  handleResponsesDelete,
  handleResponsesGet,
} from "./model-api/responses";
import {
  authenticate,
  errorJson,
  forwardPassthruHeaders,
  hasInternalBearer,
  json,
  type PassthruAuthResult,
  type PeerAddr,
  readModelJsonBody,
} from "./model-api/shared";

// Public surface consumed by other modules, scripts and tests (main.ts,
// engine.ts, command-registry.ts, readiness.ts, ops-api.ts, websocket-server.ts,
// passthru-context.ts, scripts/smoke-production.ts, test/*) — keep these
// re-exports stable so importers never need to know about the `./model-api/*`
// layout.
export { anthropicTextContent } from "./anthropic-tools";
export { anthropicAutoCacheEnabled, anthropicSystemPrompt } from "./model-api/anthropic-bridge";
export { tryVerifiedArithmetic } from "./model-api/chat-completions";
export { isModelApiPath, OLLAMA_API_PATHS } from "./model-api/ollama";
export {
  cleanupStaleConversationChannels,
  pendingRequests,
  roundRobinCounters,
  scheduleRequestReminders,
  selectAgent,
} from "./model-api/routing";
export {
  CACHE_READ_TOKENS_HEADER,
  CACHE_WRITE_TOKENS_HEADER,
  COST_USD_HEADER,
  extractStrategy,
  type PassthruAuthResult,
  UPSTREAM_MODEL_HEADER,
} from "./model-api/shared";
export {
  buildProviderProbeBody,
  buildProviderToolProbeBody,
  configuredUpstreamProviders,
  describeDefaultUpstream,
  evaluateProviderProbe,
  evaluateProviderToolProbe,
  getLastProviderProbe,
  normalizeToolCallSSE,
  PROVIDER_PROBE_MAX_TOKENS,
  PROVIDER_TOOL_PROBE_MAX_TOKENS,
  PROVIDER_TOOL_PROBE_NAME,
  type ProviderProbeResult,
  prepareLlamaBody,
  prepareUpstreamBody,
  probeConfiguredProviders,
  resetLastProviderProbeForTests,
  stripCacheControl,
  TOOL_PROBED_PROVIDERS,
  upstreamCostUsd,
} from "./model-api/upstream";

// --- Route handler ---

export async function handleModelApi(
  url: URL,
  method: string,
  req: Request,
  engine: Engine,
  rateLimiter?: RateLimiter,
  server?: PeerAddr,
): Promise<Response | undefined> {
  const ip = clientIp(req, server);
  // Authenticate (skipped for CORS preflight). Fails closed by default — see
  // `authenticate`. The resolved outcome is threaded to passthru handlers so
  // they can map the caller to a Marina entity (identity + context injection).
  // A rejected credential spends the per-IP failed-auth budget; once it is
  // spent the caller is refused before its credential is compared at all.
  let authResult: PassthruAuthResult | undefined;
  if (method !== "OPTIONS") {
    // The internal model token (room agents on loopback) is never locked out
    // by someone else's failed guesses from the same address.
    if (!hasInternalBearer(req) && authFailuresExhausted(ip)) {
      return errorJson(429, "Too many failed authentication attempts. Please slow down.", {
        code: "rate_limit_exceeded",
      });
    }
    const outcome = authenticate(req);
    if ("error" in outcome) {
      if (outcome.credentialRejected) recordAuthFailure(ip);
      return outcome.error;
    }
    authResult = outcome.auth;
  }

  // Per-IP rate limiting. POST (mutation) plus the enumerable Responses state
  // surface (GET/DELETE /v1/responses/:id) spend the model limiter so a caller
  // can't brute-force response ids or hammer delete unthrottled; the cheap
  // reads (models, tags, version, ps, health) spend the separate, roomier
  // `modelRead` budget.
  const isResponsesStateOp =
    url.pathname.startsWith("/v1/responses/") && (method === "GET" || method === "DELETE");
  if (rateLimiter && (method === "POST" || isResponsesStateOp)) {
    if (!rateLimiter.consume(`model:${ip}`)) {
      return errorJson(429, "Rate limited. Please slow down.");
    }
  } else if (method === "GET" && !consumeHttpRate("modelRead", ip)) {
    return errorJson(429, "Rate limited. Please slow down.");
  }

  if (url.pathname.startsWith("/v1/media")) {
    return await handleMediaApi(url, method, req, engine, server);
  }

  // Benchmark runs file themselves into this Marina's ledger — src/net/benchmarks-api.ts.
  if (url.pathname === "/v1/benchmarks/runs" && method === "POST") {
    return await handleBenchmarkFile(req, engine, authResult);
  }

  // Forecast any question (research → verified evidence → analysts → judge) — src/forecast.
  if (url.pathname === "/v1/forecast" && method === "POST") {
    return await handleForecast(req);
  }

  // Decisions API (noul / choice / score) for any harness — src/net/decisions-api.ts.
  // `/v1/systemone` is TypeSafe's path: point `langchain-typesafe` (TYPESAFE_BASE_URL) here.
  if ((url.pathname === "/v1/decisions" || url.pathname === "/v1/systemone") && method === "POST") {
    return await handleDecisions(req);
  }
  if (
    (url.pathname === "/v1/decisions/models" || url.pathname === "/v1/systemone/models") &&
    method === "GET"
  ) {
    return handleDecisionModels();
  }

  // OpenAI: GET /v1/models
  if (url.pathname === "/v1/models" && method === "GET") {
    return json(openaiModelList(listModels(engine)));
  }

  // OpenAI: POST /v1/chat/completions
  if (url.pathname === "/v1/chat/completions" && method === "POST") {
    return await handleOpenaiChat(req, engine, authResult);
  }

  // Anthropic Messages: POST /v1/messages — inbound Anthropic-format server so
  // Claude Code / Anthropic SDKs plug in. Auth already enforced above (fails
  // closed identically to /v1/chat/completions). handleAnthropicMessages
  // translates Anthropic <-> OpenAI and drives the existing chat/proxy path via
  // the runInternal callback below.
  if (url.pathname === "/v1/messages" && method === "POST") {
    // The bridge re-encodes the body into an Anthropic message and drops the
    // internal response headers; carry the traced request id, memory receipt
    // and cache marker across so this surface is inspectable like the others.
    let internalHeaders: Headers | undefined;
    // Keep the NATIVE Anthropic body too: when the upstream is Anthropic, the
    // proxy forwards it verbatim (system/tool/message `cache_control` markers,
    // thinking, metadata) instead of round-tripping through the OpenAI shape.
    let anthropicNative: Record<string, unknown> | undefined;
    try {
      const raw: unknown = await req.clone().json();
      if (raw && typeof raw === "object" && !Array.isArray(raw))
        anthropicNative = raw as Record<string, unknown>;
    } catch {
      // handleAnthropicMessages reports the malformed body itself.
    }
    const anthropic = await handleAnthropicMessages(req, {
      runInternal: async (openaiBody, opts) => {
        const internal = await runOpenaiChat(engine, req, openaiBody, authResult, {
          ...opts,
          surface: "anthropic",
          anthropicNative,
        });
        internalHeaders = internal.headers;
        return internal;
      },
    });
    if (!internalHeaders) return anthropic;
    const forwarded = forwardPassthruHeaders(internalHeaders, {});
    if (Object.keys(forwarded).length === 0) return anthropic;
    const headers = new Headers(anthropic.headers);
    for (const [name, value] of Object.entries(forwarded)) headers.set(name, value);
    return new Response(anthropic.body, {
      status: anthropic.status,
      statusText: anthropic.statusText,
      headers,
    });
  }

  // OpenAI Responses API: /v1/responses, /v1/responses/:id
  // Used by passthru clients for server-side conversation state.
  if (url.pathname === "/v1/responses" && method === "POST") {
    return await handleResponsesCreate(req, engine, authResult);
  }
  if (url.pathname.startsWith("/v1/responses/") && method === "GET") {
    const id = url.pathname.slice("/v1/responses/".length);
    return handleResponsesGet(id, authResult);
  }
  if (url.pathname.startsWith("/v1/responses/") && method === "DELETE") {
    const id = url.pathname.slice("/v1/responses/".length);
    return handleResponsesDelete(id, authResult, engine);
  }

  // OpenAI health: /v1/health
  if (url.pathname === "/v1/health" && method === "GET") {
    return json({ status: "ok", engine: "marina" });
  }

  // Endpoints Marina does not serve. An explicit OpenAI-shaped 404 (code
  // `not_found`) instead of falling through to the dashboard/static handler,
  // so an SDK that probes for embeddings or legacy completions gets a parseable
  // answer rather than HTML.
  if (UNSERVED_MODEL_PATHS.has(url.pathname)) {
    return errorJson(404, `${url.pathname} is not served by Marina's model API.`, {
      code: "not_found",
    });
  }

  // Ollama: GET /api/tags
  if (url.pathname === "/api/tags" && method === "GET") {
    return json(ollamaTagList(listModels(engine)));
  }

  // Ollama: GET /api/version
  if (url.pathname === "/api/version" && method === "GET") {
    return json({ version: MARINA_VERSION });
  }

  // Ollama: GET /api/ps — "running" models = the configured default route.
  if (url.pathname === "/api/ps" && method === "GET") {
    return json(ollamaPsResponse(listModels(engine)));
  }

  // Ollama: POST /api/show {model|name}
  if (url.pathname === "/api/show" && method === "POST") {
    const read = await readModelJsonBody(req, SMALL_JSON_BODY_BYTES);
    if (!read.ok) return read.response;
    const body = read.body as { model?: unknown; name?: unknown };
    const ref = body.model ?? body.name;
    const found = findOllamaModel(listModels(engine), ref);
    if (!found) {
      return errorJson(404, `model '${typeof ref === "string" ? ref : ""}' not found`, {
        code: "model_not_found",
        param: "model",
      });
    }
    return json(ollamaShowResponse(found, engine));
  }

  // Ollama: POST /api/chat
  if (url.pathname === "/api/chat" && method === "POST") {
    return await handleOllamaChat(req, engine, authResult);
  }

  // Ollama: POST /api/generate
  if (url.pathname === "/api/generate" && method === "POST") {
    return await handleOllamaGenerate(req, engine, authResult);
  }

  return undefined;
}
