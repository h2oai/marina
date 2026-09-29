// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Ollama surface: `/api/tags|show|ps` record shapes, `/api/chat` and
// `/api/generate` (passthru + agents paths), the explicit-404 path set and the
// `isModelApiPath` dispatcher predicate.

import { createHash } from "node:crypto";
import { version as MARINA_VERSION } from "../../../package.json";
import type { Engine } from "../../engine/engine";
import { getEnabledProfiles } from "../compat-profiles";
import { getEndpointConfig } from "../model-endpoint";
import { applyInjection, type OpenAIMessage } from "../passthru-context";
import type { ModelInfo } from "./models";
import {
  capturePassthruResponse,
  extractResponseText,
  passthruCacheLookup,
  passthruCacheStore,
  passthruTraceOptions,
  passthruUpstreamHints,
  preparePassthru,
} from "./passthru";
import { type RouteOptions, routeToChannel, routeToChannelStreaming } from "./routing";
import {
  COMPAT_ALIASES,
  errorJson,
  extractConversationId,
  extractStrategy,
  forwardPassthruHeaders,
  HttpError,
  isInternalCaller,
  json,
  MODEL_CORS,
  ollamaStreamChunk,
  ollamaStreamEnd,
  type PassthruAuthResult,
  readModelJsonBody,
  safeClose,
  unsupportedParam,
} from "./shared";
import { describeDefaultUpstream, proxyToUpstream } from "./upstream";

// --- Request validation ---

/** `options` keys that map onto the OpenAI-shaped upstream body. */
const MAPPED_OLLAMA_OPTIONS = new Set([
  "temperature",
  "top_p",
  "num_predict",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
]);

/**
 * `options` keys that only tune a LOCAL Ollama runtime (context allocation,
 * GPU/thread layout, memory mapping). Marina runs no local weights, so they
 * are accepted and have nothing to act on — they never change an answer.
 */
const RUNTIME_ONLY_OLLAMA_OPTIONS = new Set([
  "num_ctx",
  "num_gpu",
  "main_gpu",
  "num_thread",
  "num_batch",
  "num_keep",
  "use_mmap",
  "use_mlock",
  "numa",
  "low_vram",
  "f16_kv",
  "vocab_only",
]);

function present(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Refuse Ollama request fields Marina cannot honor with `400
 * unsupported_parameter` instead of silently dropping them: tool schemas,
 * structured `format`, images, thinking, raw/template/suffix/context on
 * `/api/generate`, and any `options` key without a mapping. `think: false`
 * (Marina never returns a thinking trace) and runtime-only options pass.
 */
export function validateOllamaRequest(
  kind: "chat" | "generate",
  body: Record<string, unknown>,
): Response | undefined {
  if (present(body.tools)) {
    return unsupportedParam(
      "tools",
      "Marina's Ollama routes return text only and cannot return tool calls; use /v1/chat/completions in passthru mode for tool calling.",
    );
  }
  if (present(body.format)) {
    return unsupportedParam("format", "Structured output formats are not supported on this route.");
  }
  if (present(body.think)) {
    return unsupportedParam(
      "think",
      "Thinking traces are not returned on this route; omit think or send false.",
    );
  }
  if (kind === "chat") {
    if (body.messages !== undefined && !Array.isArray(body.messages)) {
      return errorJson(400, "messages must be an array", { param: "messages" });
    }
    for (const message of (body.messages as unknown[] | undefined) ?? []) {
      if (
        message &&
        typeof message === "object" &&
        present((message as { images?: unknown }).images)
      ) {
        return unsupportedParam(
          "messages[].images",
          "Image inputs are not supported on this route.",
        );
      }
    }
  } else {
    for (const param of ["images", "suffix", "template", "raw", "context"]) {
      if (present(body[param])) {
        return unsupportedParam(param, `'${param}' is not supported on this route.`);
      }
    }
  }
  if (body.options !== undefined && body.options !== null) {
    if (typeof body.options !== "object" || Array.isArray(body.options)) {
      return errorJson(400, "options must be an object", { param: "options" });
    }
    for (const key of Object.keys(body.options)) {
      if (MAPPED_OLLAMA_OPTIONS.has(key) || RUNTIME_ONLY_OLLAMA_OPTIONS.has(key)) continue;
      return unsupportedParam(`options.${key}`, "This sampling option has no upstream mapping.");
    }
  }
  return undefined;
}

// --- Ollama format helpers ---

/** Stable per-alias digest: Ollama clients key their model cache on it, so it
 *  must not change between requests or restarts. Content-addressed on the id. */
function ollamaDigest(modelId: string): string {
  return `sha256:${createHash("sha256").update(`marina-model:${modelId}`).digest("hex")}`;
}

/** The `details` object Ollama attaches to every model record. Marina models
 *  are routes, not weights, so the weight-shaped fields are honest blanks. */
function ollamaModelDetails(modelId: string): Record<string, unknown> {
  const profile = getEnabledProfiles().find((p) => p.modelAliases?.includes(modelId));
  return {
    parent_model: COMPAT_ALIASES.has(modelId) ? "marina" : "",
    format: "marina",
    family: profile ? `marina-compat-${profile.name}` : "marina",
    families: ["marina"],
    parameter_size: "",
    quantization_level: "",
  };
}

function ollamaModelRecord(m: ModelInfo): Record<string, unknown> {
  return {
    name: m.id,
    model: m.id,
    modified_at: new Date().toISOString(),
    size: 0,
    digest: ollamaDigest(m.id),
    details: ollamaModelDetails(m.id),
  };
}

export function ollamaTagList(models: ModelInfo[]): unknown {
  return { models: models.map(ollamaModelRecord) };
}

/** `POST /api/show` body for a model: the Modelfile/parameters/template are
 *  empty strings (there is no local weight file), `details` and `model_info`
 *  describe the route, `capabilities` advertise what the Ollama routes honor:
 *  plain completion only — `tools`, `format`, `images` and thinking are
 *  refused with `unsupported_parameter` (see `validateOllamaRequest`), so
 *  advertising them would invite requests that can only fail. */
export function ollamaShowResponse(m: ModelInfo, engine: Engine): unknown {
  const upstream = describeDefaultUpstream(engine);
  return {
    modelfile: "",
    parameters: "",
    template: "",
    license: "",
    details: ollamaModelDetails(m.id),
    model_info: {
      "general.architecture": "marina",
      "general.name": m.id,
      "marina.channel": m.channelId,
      "marina.online_members": m.onlineMembers,
      ...(upstream ? { "marina.default_upstream": upstream } : {}),
      "marina.version": MARINA_VERSION,
    },
    capabilities: ["completion"],
    modified_at: new Date().toISOString(),
  };
}

/** `GET /api/ps`: the "running" model is the configured default route. */
export function ollamaPsResponse(models: ModelInfo[]): unknown {
  const running = models.find((m) => m.id === "marina");
  if (!running) return { models: [] };
  return {
    models: [
      {
        ...ollamaModelRecord(running),
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        size_vram: 0,
      },
    ],
  };
}

/** Resolve an Ollama model reference (`name`, `name:latest`) to a listed model. */
export function findOllamaModel(models: ModelInfo[], ref: unknown): ModelInfo | undefined {
  if (typeof ref !== "string" || !ref) return undefined;
  const bare = ref.endsWith(":latest") ? ref.slice(0, -":latest".length) : ref;
  return models.find((m) => m.id === ref || m.id === bare);
}

function ollamaChatResponse(model: string, content: string): unknown {
  return {
    model,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content },
    done: true,
    total_duration: 0,
    eval_count: 0,
  };
}

function ollamaGenerateResponse(model: string, content: string): unknown {
  return {
    model,
    created_at: new Date().toISOString(),
    response: content,
    done: true,
    total_duration: 0,
    eval_count: 0,
  };
}

/**
 * Ollama-surface passthru: translate to the OpenAI shape, inject memory in the
 * protocol's native slot (a system-role message for `/api/chat`, the `system`
 * string for `/api/generate`), proxy, then re-encode the completion as Ollama
 * JSON. The upstream call is always non-streaming; a client that asked for
 * Ollama's default streaming gets the completed answer as a buffered ndjson
 * stream (one content chunk + the terminal record).
 */
async function runOllamaPassthru(
  engine: Engine,
  req: Request,
  authResult: PassthruAuthResult | undefined,
  input: {
    kind: "chat" | "generate";
    model: string;
    wantStream: boolean;
    messages?: OpenAIMessage[];
    prompt?: string;
    system?: string;
    options?: Record<string, unknown>;
  },
): Promise<Response> {
  const ec = getEndpointConfig(engine.db);
  const isChat = input.kind === "chat";
  const inbound: OpenAIMessage[] = isChat
    ? (input.messages ?? [])
    : [{ role: "user", content: input.prompt ?? "" }];
  const prep = await preparePassthru(
    engine,
    req,
    authResult,
    inbound,
    isChat ? "openai" : "ollama-generate",
  );

  let messages: OpenAIMessage[];
  if (isChat) {
    const chat: Record<string, unknown> = { messages: [...inbound] };
    applyInjection(chat, prep.addendum, "openai");
    messages = chat.messages as OpenAIMessage[];
  } else {
    const gen: Record<string, unknown> = { system: input.system };
    applyInjection(gen, prep.addendum, "ollama-generate");
    messages = [
      ...(typeof gen.system === "string" && gen.system
        ? [{ role: "system", content: gen.system }]
        : []),
      { role: "user", content: input.prompt ?? "" },
    ];
  }
  const options = input.options ?? {};
  const body: Record<string, unknown> = {
    model: input.model,
    messages,
    stream: false,
    ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
    ...(typeof options.top_p === "number" ? { top_p: options.top_p } : {}),
    ...(typeof options.num_predict === "number" && options.num_predict > 0
      ? { max_tokens: options.num_predict }
      : {}),
    ...(Array.isArray(options.stop) ? { stop: options.stop } : {}),
    ...(typeof options.seed === "number" ? { seed: options.seed } : {}),
    ...(typeof options.presence_penalty === "number"
      ? { presence_penalty: options.presence_penalty }
      : {}),
    ...(typeof options.frequency_penalty === "number"
      ? { frequency_penalty: options.frequency_penalty }
      : {}),
  };

  const cached = await passthruCacheLookup(engine, prep, body, ec.passthruModel);
  const resp =
    cached ??
    (await proxyToUpstream(
      engine,
      body,
      ec.passthruModel || undefined,
      passthruTraceOptions(prep),
      // `/api/generate` folds the addendum into ONE system string — no separate tail.
      isChat
        ? { ...passthruUpstreamHints(prep), clientSignal: req.signal }
        : { clientSignal: req.signal },
    ));
  if (!resp.ok) return resp;
  if (!cached && prep.identity?.contextOptIn) {
    void capturePassthruResponse(engine, prep.identity.entityId, inbound, resp);
    passthruCacheStore(engine, prep, body, ec.passthruModel, resp);
  }
  const text = await extractResponseText(resp.clone());
  const headers = forwardPassthruHeaders(resp.headers, { ...MODEL_CORS });
  if (input.wantStream) {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(ollamaStreamChunk(input.model, text, isChat)));
        controller.enqueue(enc.encode(ollamaStreamEnd(input.model, isChat)));
        safeClose(controller);
      },
    });
    return new Response(stream, {
      headers: {
        ...headers,
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
      },
    });
  }
  return json(
    isChat ? ollamaChatResponse(input.model, text) : ollamaGenerateResponse(input.model, text),
    200,
    headers,
  );
}

export async function handleOllamaChat(
  req: Request,
  engine: Engine,
  authResult?: PassthruAuthResult,
): Promise<Response> {
  const read = await readModelJsonBody(req);
  if (!read.ok) return read.response;
  // biome-ignore lint/suspicious/noExplicitAny: Ollama request bodies are loosely shaped client JSON.
  const body = read.body as Record<string, any>;
  const invalid = validateOllamaRequest("chat", body);
  if (invalid) return invalid;
  try {
    const model = body.model ?? "marina";
    const messages = body.messages ?? [];

    const userMsg = [...messages].reverse().find((m: { role: string }) => m.role === "user");
    if (!userMsg) return errorJson(400, "No user message found");

    if (getEndpointConfig(engine.db).mode === "passthru" || isInternalCaller(authResult)) {
      return await runOllamaPassthru(engine, req, authResult, {
        kind: "chat",
        model,
        wantStream: body.stream !== false,
        messages,
        options: body.options && typeof body.options === "object" ? body.options : undefined,
      });
    }

    const contextParts: string[] = [];
    for (const msg of messages) {
      if (msg === userMsg) break;
      contextParts.push(`${msg.role}: ${msg.content}`);
    }
    const context = contextParts.length > 0 ? contextParts.join("\n") : undefined;

    const conversationId = extractConversationId(req, body);
    // Explicit X-Load-Balance wins; otherwise the operator-configured strategy.
    const strategy = req.headers.has("X-Load-Balance")
      ? extractStrategy(req)
      : getEndpointConfig(engine.db).strategy;
    const opts: RouteOptions = { context, conversationId, strategy };

    // Ollama defaults to streaming (stream !== false)
    if (body.stream !== false) {
      const {
        stream,
        conversationId: convId,
        requestId,
      } = routeToChannelStreaming(engine, model, userMsg.content, "ollama-chat", opts);
      const headers: Record<string, string> = {
        ...MODEL_CORS,
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "x-request-id": requestId,
      };
      if (convId) headers["X-Conversation-Id"] = convId;
      return new Response(stream, { headers });
    }

    const result = await routeToChannel(engine, model, userMsg.content, opts);
    const extra: Record<string, string> = { "x-request-id": result.requestId };
    if (result.conversationId) extra["X-Conversation-Id"] = result.conversationId;
    return json(ollamaChatResponse(model, result.content), 200, extra);
  } catch (e) {
    if (e instanceof HttpError) return errorJson(e.status, e.message);
    return errorJson(500, "Internal error");
  }
}

export async function handleOllamaGenerate(
  req: Request,
  engine: Engine,
  authResult?: PassthruAuthResult,
): Promise<Response> {
  const read = await readModelJsonBody(req);
  if (!read.ok) return read.response;
  // biome-ignore lint/suspicious/noExplicitAny: Ollama request bodies are loosely shaped client JSON.
  const body = read.body as Record<string, any>;
  const invalid = validateOllamaRequest("generate", body);
  if (invalid) return invalid;
  try {
    const model = body.model ?? "marina";
    const prompt = body.prompt;
    if (!prompt) return errorJson(400, "No prompt provided");

    if (getEndpointConfig(engine.db).mode === "passthru" || isInternalCaller(authResult)) {
      return await runOllamaPassthru(engine, req, authResult, {
        kind: "generate",
        model,
        wantStream: body.stream !== false,
        prompt: String(prompt),
        system: typeof body.system === "string" ? body.system : undefined,
        options: body.options && typeof body.options === "object" ? body.options : undefined,
      });
    }

    const context = body.system ? `system: ${body.system}` : undefined;
    const conversationId = extractConversationId(req, body);
    // Explicit X-Load-Balance wins; otherwise the operator-configured strategy.
    const strategy = req.headers.has("X-Load-Balance")
      ? extractStrategy(req)
      : getEndpointConfig(engine.db).strategy;
    const opts: RouteOptions = { context, conversationId, strategy };

    // Ollama defaults to streaming (stream !== false)
    if (body.stream !== false) {
      const {
        stream,
        conversationId: convId,
        requestId,
      } = routeToChannelStreaming(engine, model, prompt, "ollama-generate", opts);
      const headers: Record<string, string> = {
        ...MODEL_CORS,
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
        "x-request-id": requestId,
      };
      if (convId) headers["X-Conversation-Id"] = convId;
      return new Response(stream, { headers });
    }

    const result = await routeToChannel(engine, model, prompt, opts);
    const extra: Record<string, string> = { "x-request-id": result.requestId };
    if (result.conversationId) extra["X-Conversation-Id"] = result.conversationId;
    return json(ollamaGenerateResponse(model, result.content), 200, extra);
  } catch (e) {
    if (e instanceof HttpError) return errorJson(e.status, e.message);
    return errorJson(500, "Internal error");
  }
}

/** Paths a compat client may probe that Marina answers with an explicit 404. */
export const UNSERVED_MODEL_PATHS = new Set([
  "/v1/embeddings",
  "/v1/completions",
  "/api/embed",
  "/api/embeddings",
]);

/** Ollama-surface paths `handleModelApi` serves (the `/v1/*` prefix is implicit). */
export const OLLAMA_API_PATHS: readonly string[] = [
  "/api/tags",
  "/api/chat",
  "/api/generate",
  "/api/version",
  "/api/show",
  "/api/ps",
  "/api/embed",
  "/api/embeddings",
];

/** True when `pathname` belongs to the model API (for the HTTP dispatcher). */
export function isModelApiPath(pathname: string): boolean {
  return pathname.startsWith("/v1/") || OLLAMA_API_PATHS.includes(pathname);
}
