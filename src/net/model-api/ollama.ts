// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Ollama surface: `/api/tags|show|ps` record shapes, `/api/chat` and
// `/api/generate` (passthru + agents paths), the explicit-404 path set and the
// `isModelApiPath` dispatcher predicate.

import { createHash } from "node:crypto";
import { version as MARINA_VERSION } from "../../../package.json";
import type { Engine } from "../../engine/engine";
import { sniffRaster, visionMaxBytes } from "../../engine/media/vision";
import { getEnabledProfiles } from "../adapters/compat-profiles";
import { getEndpointConfig } from "../model/model-endpoint";
import type { OpenAIMessage } from "../model/passthru-context";
import type { ModelInfo } from "./models";
import {
  capturePassthruResponse,
  extractResponseTextAndUsage,
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
  rejectChatOnlyPrefix,
  safeClose,
  unsupportedParam,
} from "./shared";
import { rejectStackHeaders } from "./stack";
import {
  describeDefaultUpstream,
  explicitUpstreamModel,
  passthruForceModel,
  proxyToUpstream,
} from "./upstream";

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

/** Ollama sends images as bare base64 strings (no `data:` prefix). */
function decodeOllamaImage(raw: unknown): { mime: string; data: string; bytes: number } | string {
  if (typeof raw !== "string" || !raw.trim()) return "each image must be a base64 string";
  const b64 = raw.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return "images must be base64-encoded";
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  const mime = sniffRaster(bytes);
  if (!mime) return "images must be PNG, JPEG, GIF or WebP (checked by content)";
  const cap = visionMaxBytes();
  if (bytes.byteLength > cap) return `an image of ${bytes.byteLength} bytes exceeds ${cap}`;
  return { mime, data: b64, bytes: bytes.byteLength };
}

/** Why these Ollama `images` cannot be sent, or undefined when every one can. */
export function ollamaImagesProblem(images: unknown): string | undefined {
  if (!Array.isArray(images)) return "images must be an array of base64 strings";
  for (const raw of images) {
    const decoded = decodeOllamaImage(raw);
    if (typeof decoded === "string") return decoded;
  }
  return undefined;
}

/** Validated Ollama `images` as OpenAI `image_url` parts (data URLs). */
export function ollamaImageParts(
  images: unknown,
): Array<{ type: "image_url"; image_url: { url: string } }> {
  if (!Array.isArray(images)) return [];
  const parts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  for (const raw of images) {
    const decoded = decodeOllamaImage(raw);
    if (typeof decoded === "string") continue;
    parts.push({
      type: "image_url",
      image_url: { url: `data:${decoded.mime};base64,${decoded.data}` },
    });
  }
  return parts;
}

/** An Ollama chat message in the OpenAI shape: `images` become `image_url` parts. */
export function ollamaMessageToOpenai(message: unknown): OpenAIMessage {
  const m = (message ?? {}) as { role?: unknown; content?: unknown; images?: unknown };
  const role = typeof m.role === "string" ? m.role : "user";
  const text = typeof m.content === "string" ? m.content : "";
  const parts = present(m.images) ? ollamaImageParts(m.images) : [];
  // A message without images passes through exactly as the caller sent it.
  if (parts.length === 0) {
    if (!("images" in m)) return message as OpenAIMessage;
    const { images: _images, ...rest } = m;
    return rest as OpenAIMessage;
  }
  const { images: _images, content: _content, ...rest } = m;
  return { ...rest, role, content: [...(text ? [{ type: "text", text }] : []), ...parts] };
}

/** True when any message (or the generate body) carries images. */
function hasOllamaImages(body: Record<string, unknown>): boolean {
  if (present(body.images)) return true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.some(
    (m) => !!m && typeof m === "object" && present((m as { images?: unknown }).images),
  );
}

/**
 * Refuse Ollama request fields Marina cannot honor with `400
 * unsupported_parameter` instead of silently dropping them: tool schemas,
 * structured `format`, images that are not base64 PNG/JPEG/GIF/WebP within
 * `MARINA_VISION_MAX_BYTES` (valid images are translated into OpenAI
 * `image_url` parts on the passthru route — `ollamaImageParts`), thinking,
 * raw/template/suffix/context on
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
      if (!message || typeof message !== "object") continue;
      const images = (message as { images?: unknown }).images;
      if (!present(images)) continue;
      const problem = ollamaImagesProblem(images);
      if (problem) return unsupportedParam("messages[].images", problem);
    }
  } else {
    if (present(body.images)) {
      const problem = ollamaImagesProblem(body.images);
      if (problem) return unsupportedParam("images", problem);
    }
    for (const param of ["suffix", "template", "raw", "context"]) {
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
 *  plain completion only — `tools`, `format` and thinking are refused with
 *  `unsupported_parameter` (see `validateOllamaRequest`), and `images` reach
 *  the model only on the passthru route, so advertising them would invite
 *  requests that can fail. */
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

function ollamaChatResponse(
  model: string,
  content: string,
  terminal: Record<string, unknown> = {},
): unknown {
  return {
    model,
    created_at: new Date().toISOString(),
    message: { role: "assistant", content },
    done: true,
    total_duration: 0,
    eval_count: 0,
    done_reason: "stop",
    ...terminal,
  };
}

function ollamaGenerateResponse(
  model: string,
  content: string,
  terminal: Record<string, unknown> = {},
): unknown {
  return {
    model,
    created_at: new Date().toISOString(),
    response: content,
    done: true,
    total_duration: 0,
    eval_count: 0,
    done_reason: "stop",
    ...terminal,
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
    /** `/api/generate` images (validated base64). */
    images?: unknown;
    system?: string;
    options?: Record<string, unknown>;
  },
): Promise<Response> {
  const ec = getEndpointConfig(engine.db);
  const isChat = input.kind === "chat";
  const generateUser = ollamaMessageToOpenai({
    role: "user",
    content: input.prompt ?? "",
    images: input.images,
  });
  const inbound: OpenAIMessage[] = isChat
    ? (input.messages ?? []).map(ollamaMessageToOpenai)
    : [generateUser];
  const prep = await preparePassthru(
    engine,
    req,
    authResult,
    inbound,
    isChat ? "openai" : "ollama-generate",
  );

  // The memory addendum rides the trailing note after the cache breakpoints
  // (`passthruUpstreamHints`), so the caller's prompt is the stable prefix.
  const messages: OpenAIMessage[] = isChat
    ? [...inbound]
    : [...(input.system ? [{ role: "system", content: input.system }] : []), generateUser];
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

  const forceModel = passthruForceModel(engine, ec, body.model);
  const cached = await passthruCacheLookup(engine, prep, body, forceModel);
  const resp =
    cached ??
    (await proxyToUpstream(engine, body, forceModel || undefined, passthruTraceOptions(prep), {
      ...passthruUpstreamHints(prep),
      clientSignal: req.signal,
    }));
  if (!resp.ok) return resp;
  if (!cached && prep.identity?.contextOptIn) {
    void capturePassthruResponse(engine, prep.identity.entityId, inbound, resp);
    passthruCacheStore(engine, prep, body, forceModel, resp);
  }
  const extracted = await extractResponseTextAndUsage(resp.clone());
  const text = extracted.content;
  if (!extracted.finishReason) return errorJson(502, "Upstream returned no finish reason");
  const terminal = {
    done_reason: extracted.finishReason,
    ...(extracted.usage
      ? {
          prompt_eval_count: extracted.usage.prompt_tokens,
          eval_count: extracted.usage.completion_tokens,
        }
      : {}),
  };
  const headers = forwardPassthruHeaders(resp.headers, { ...MODEL_CORS });
  if (input.wantStream) {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(ollamaStreamChunk(input.model, text, isChat)));
        controller.enqueue(enc.encode(ollamaStreamEnd(input.model, isChat, terminal)));
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
    isChat
      ? ollamaChatResponse(input.model, text, terminal)
      : ollamaGenerateResponse(input.model, text, terminal),
    200,
    headers,
  );
}

/** The agent (channel) route hears text only: images are refused, never dropped. */
function refuseRoutedImages(param: string): Response {
  return unsupportedParam(
    param,
    "Images reach the model on the passthru route only; this request is routed to Marina's agents, which hear text.",
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
  const refusedPrefix =
    rejectChatOnlyPrefix(body.model, "/api/chat") ?? rejectStackHeaders(req, "/api/chat");
  if (refusedPrefix) return refusedPrefix;
  try {
    const model = body.model ?? "marina";
    const messages = body.messages ?? [];

    const userMsg = [...messages].reverse().find((m: { role: string }) => m.role === "user");
    if (!userMsg) return errorJson(400, "No user message found");

    if (
      getEndpointConfig(engine.db).mode === "passthru" ||
      isInternalCaller(authResult) ||
      explicitUpstreamModel(engine, model)
    ) {
      return await runOllamaPassthru(engine, req, authResult, {
        kind: "chat",
        model,
        wantStream: body.stream !== false,
        messages,
        options: body.options && typeof body.options === "object" ? body.options : undefined,
      });
    }
    if (body.options?.num_predict !== undefined)
      return unsupportedParam(
        "options.num_predict",
        "In-world agent routing cannot enforce output-token limits; use the passthru endpoint mode.",
      );
    if (hasOllamaImages(body)) return refuseRoutedImages("messages[].images");

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
  const refusedPrefix =
    rejectChatOnlyPrefix(body.model, "/api/generate") ?? rejectStackHeaders(req, "/api/generate");
  if (refusedPrefix) return refusedPrefix;
  try {
    const model = body.model ?? "marina";
    const prompt = body.prompt;
    if (!prompt) return errorJson(400, "No prompt provided");

    if (
      getEndpointConfig(engine.db).mode === "passthru" ||
      isInternalCaller(authResult) ||
      explicitUpstreamModel(engine, model)
    ) {
      return await runOllamaPassthru(engine, req, authResult, {
        kind: "generate",
        model,
        wantStream: body.stream !== false,
        prompt: String(prompt),
        images: body.images,
        system: typeof body.system === "string" ? body.system : undefined,
        options: body.options && typeof body.options === "object" ? body.options : undefined,
      });
    }
    if (body.options?.num_predict !== undefined)
      return unsupportedParam(
        "options.num_predict",
        "In-world agent routing cannot enforce output-token limits; use the passthru endpoint mode.",
      );
    if (hasOllamaImages(body)) return refuseRoutedImages("images");

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
