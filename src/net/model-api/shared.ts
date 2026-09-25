// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Root of the model-api import DAG: response headers + CORS, API-key
// authentication, JSON/error helpers, request-id + trace helpers, the model-id
// ↔ channel-name mapping, OpenAI/Ollama wire-format helpers and the HttpError
// type. Imports nothing from `./model-api/*`.

import { getInternalModelToken } from "../../agent/agent-runtime";
import { secretsEqual } from "../../auth/secret-compare";
import { isOpenApiMode } from "../../engine/trust-profile";
import { buildAliasMap } from "../compat-profiles";
import { corsHeaders } from "../cors";
import { MEMORY_RECEIPT_HEADER } from "../memory-receipt";
import {
  type OpenAIErrorOptions,
  openaiErrorBody,
  unsupportedParameterBody,
} from "../openai-errors";
import { RESPONSE_CACHE_HEADER } from "../response-cache";

/**
 * Cost and cache response headers on every proxied (passthru / internal /
 * fallback) reply. `x-marina-upstream-model` is `provider/model` — the target
 * the request was actually served by — and is present on streamed replies too;
 * the three token/cost headers need the completed usage, so they are set on
 * NON-streaming replies only (a stream's tokens land on the lifecycle
 * `completed` event and in the final SSE usage chunk instead). Marina's own
 * agents read `x-marina-upstream-model` / `x-marina-cost-usd` to price turns
 * on the synthesized `marina/default` model.
 */
export const UPSTREAM_MODEL_HEADER = "x-marina-upstream-model";
export const COST_USD_HEADER = "x-marina-cost-usd";
export const CACHE_READ_TOKENS_HEADER = "x-marina-cache-read-tokens";
export const CACHE_WRITE_TOKENS_HEADER = "x-marina-cache-write-tokens";

export const MODEL_CORS = corsHeaders(null, {
  methods: "GET, POST, OPTIONS",
  headers:
    "Content-Type, Authorization, X-Conversation-Id, X-Load-Balance, X-Marina-Agent, X-Marina-Context",
  expose: [
    "X-Conversation-Id",
    "x-request-id",
    MEMORY_RECEIPT_HEADER,
    RESPONSE_CACHE_HEADER,
    UPSTREAM_MODEL_HEADER,
    COST_USD_HEADER,
    CACHE_READ_TOKENS_HEADER,
    CACHE_WRITE_TOKENS_HEADER,
  ].join(", "),
});

/** Response headers a passthru surface forwards from the proxied upstream reply
 *  when it re-encodes the body into its own protocol (Anthropic, Ollama, Responses). */
const PASSTHRU_FORWARDED_HEADERS = [
  "x-request-id",
  MEMORY_RECEIPT_HEADER,
  RESPONSE_CACHE_HEADER,
  UPSTREAM_MODEL_HEADER,
  COST_USD_HEADER,
  CACHE_READ_TOKENS_HEADER,
  CACHE_WRITE_TOKENS_HEADER,
];

export function forwardPassthruHeaders(
  from: Headers,
  into: Record<string, string>,
): Record<string, string> {
  for (const name of PASSTHRU_FORWARDED_HEADERS) {
    const value = from.get(name);
    if (value) into[name] = value;
  }
  return into;
}

// --- API key authentication ---
// When MODEL_API_KEYS is set, only requests with a valid Bearer token are accepted.
// When MARINA_OPEN_API=true, the API accepts unauthenticated requests (development mode).
// When neither is set, the API returns 401.

/**
 * Result of authenticating a model-API request. The integrator constructs this
 * and hands it to `resolvePassthruIdentity` (passthru-context.ts), which maps
 * the authenticated caller to a Marina entity. Owned here because authentication
 * is the integrator's responsibility; passthru-context imports the type.
 */
export interface PassthruAuthResult {
  /** The MODEL_API_KEYS secret that matched, if any (never the bound name). */
  matchedKey?: string;
  /** Entity name bound by a `secret:entity` MODEL_API_KEYS entry, if present. */
  boundEntityName?: string;
  /** Internal room-agent token was presented (fully trusted). */
  internal: boolean;
  /** MARINA_OPEN_API dev mode allowed the request through. */
  openMode: boolean;
  /**
   * Whether an `X-Marina-Agent` name-map header may be honored for this caller.
   * NARROW by design — true ONLY for genuinely privileged callers: the internal
   * room-agent token, open dev mode, or an explicitly-flagged multi-tenant
   * operator key (`secret:*`). A scoped `secret:entity` key is CONFINED to its
   * bound entity and CANNOT name-map — merely holding a binding is not authority
   * to impersonate arbitrary entities.
   */
  canNameMap: boolean;
}

interface KeyEntry {
  secret: string;
  /** Scoped binding from `secret:entity` — the key resolves to exactly this entity. */
  entity?: string;
  /** `secret:*` — an explicitly-flagged multi-tenant operator key that MAY name-map. */
  multiTenant?: boolean;
}

/**
 * Parse a MODEL_API_KEYS entry. Backward compatible: a plain `secret` maps to
 * the default passthru entity; `secret:entity` binds (scopes) the key to a named
 * entity (mirrors the MEM_API_KEYS `secret:agent` convention); the reserved
 * `secret:*` marks a multi-tenant operator key authorized to name-map via
 * `X-Marina-Agent`. Splits on the FIRST colon so entity names may not contain
 * one, consistent with MEM_API_KEYS.
 */
function parseKeyEntry(entry: string): KeyEntry {
  const idx = entry.indexOf(":");
  if (idx < 0) return { secret: entry };
  const secret = entry.slice(0, idx);
  const rest = entry.slice(idx + 1).trim();
  if (!rest) return { secret };
  if (rest === "*") return { secret, multiTenant: true };
  return { secret, entity: rest };
}

function getApiKeyEntries(): KeyEntry[] | null {
  // MARINA_LOCAL_API_KEY: the local profile's generated key (src/net/local-api-key.ts).
  const raw = [process.env.MODEL_API_KEYS, process.env.MARINA_LOCAL_API_KEY]
    .filter(Boolean)
    .join(",");
  if (!raw) return null;
  const entries = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map(parseKeyEntry);
  return entries.length > 0 ? entries : null;
}

type AuthOutcome = { error: Response } | { auth: PassthruAuthResult };

export function authenticate(req: Request): AuthOutcome {
  // Accept internal token from room agents — always valid, no config needed
  const auth = req.headers.get("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (token) {
    const internal = getInternalModelToken();
    // Constant-time compare, consistent with GATEWAY_SECRET / internal-WS-token.
    if (internal && secretsEqual(token, internal)) {
      return { auth: { internal: true, openMode: false, canNameMap: true } };
    }
  }

  const entries = getApiKeyEntries();
  if (!entries) {
    // No API keys configured — check for open (dev) mode. Fails closed otherwise.
    if (isOpenApiMode()) {
      return { auth: { internal: false, openMode: true, canNameMap: true } };
    }
    return {
      error: errorJson(
        401,
        "Model API requires authentication. Set MODEL_API_KEYS or MARINA_OPEN_API=true for development.",
      ),
    };
  }
  if (!token) {
    return { error: errorJson(401, "Missing or invalid Authorization header") };
  }
  // Non-short-circuiting constant-time membership check (every comparison runs
  // regardless of an early match) so timing doesn't leak which/whether a key
  // matched. secretsEqual is itself constant-time per comparison.
  let matched: KeyEntry | undefined;
  for (const e of entries) {
    if (secretsEqual(token, e.secret)) matched = e;
  }
  if (!matched) {
    return { error: errorJson(401, "Invalid API key") };
  }
  return {
    auth: {
      matchedKey: matched.secret,
      // A scoped `secret:entity` key carries its bound entity (and is confined to
      // it). A multi-tenant `secret:*` key carries NO binding — it name-maps.
      boundEntityName: matched.entity,
      internal: false,
      openMode: false,
      // Name-map authority is narrow: ONLY an explicitly-flagged multi-tenant
      // operator key. A scoped `secret:entity` binding is NOT name-map authority.
      canNameMap: matched.multiTenant === true,
    },
  };
}

export function generateRequestId(): string {
  return `req-${crypto.randomUUID().slice(0, 8)}`;
}

export type PeerAddr = { requestIP?: (req: Request) => { address: string } | null };

export function extractIp(req: Request, server?: PeerAddr): string {
  // Trust forwarding headers only behind an explicit trusted proxy; otherwise
  // use the real socket peer so a direct caller can't spoof X-Forwarded-For to
  // land in a fresh rate-limit bucket and evade the per-IP throttle.
  if (process.env.MARINA_TRUST_PROXY === "true") {
    const fwd = req.headers.get("x-forwarded-for");
    const hdr = (fwd ? fwd.split(",")[0]!.trim() : null) ?? req.headers.get("x-real-ip");
    if (hdr) return hdr;
  }
  return server?.requestIP?.(req)?.address ?? "unknown";
}

export function json(data: unknown, status = 200, extra?: Record<string, string>): Response {
  return Response.json(data, {
    status,
    headers: { ...MODEL_CORS, "x-request-id": generateRequestId(), ...extra },
  });
}

/** OpenAI-compatible nested error format. `code` is a string every OpenAI SDK
 *  can branch on (`invalid_api_key`, `model_not_found`, `context_length_exceeded`,
 *  `rate_limit_exceeded`, `unsupported_parameter`, …) — see `openai-errors.ts`;
 *  it is inferred from status + message unless given explicitly. */
export function errorJson(status: number, message: string, opts?: OpenAIErrorOptions): Response {
  return json(openaiErrorBody(status, message, opts), status);
}

/** 400 for a request parameter this route cannot honor (never silently dropped). */
export function unsupportedParam(param: string, detail?: string): Response {
  return json(unsupportedParameterBody(param, detail), 400);
}

/** Close a ReadableStreamDefaultController safely. The stream may have been
 *  closed already by a client disconnect, a prior end-of-response, or a
 *  response race with the cleanup timer. Swallow the second-close throw. */
export function safeClose(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    /* controller already closed — fine */
  }
}

/** Compat-profile aliases — extra model ids that all resolve to the default
 *  "model" channel. Built from src/net/compat-profiles.ts at module init so adding
 *  a new alias is a one-line change in the registry, not here. */
export const COMPAT_ALIASES = buildAliasMap();

/** Map model ID to channel name. "marina" → "model", "marina:scholar" → "model-scholar",
 *  "marina/answerer" → "model-answerer". Both colon and slash separators are accepted because
 *  the OpenAI-format convention is `provider/model` and the historic Marina convention was
 *  `provider:variant`; tools, world seeds, and bench harnesses use both interchangeably.
 *  Compat-profile aliases (e.g. "assistant") map to the default "model" channel. */
export function modelToChannelName(model: string): string {
  const aliased = COMPAT_ALIASES.get(model);
  if (aliased) return aliased;
  // Split on the first `:` or `/`. `marina:answerer:foo` and `marina/answerer/foo` both
  // resolve to `model-answerer-foo` so deeper subroutes stay namespaceable.
  const parts = model.split(/[:/]/);
  if (parts.length > 1) {
    const tail = parts.slice(1).filter(Boolean).join("-");
    return tail ? `model-${tail}` : "model";
  }
  return "model";
}

/** Map channel name back to model ID. "model" → "marina", "model-scholar" → "marina:scholar" */
export function channelNameToModel(name: string): string {
  if (name === "model") return "marina";
  const suffix = name.replace(/^model-/, "");
  return `marina:${suffix}`;
}

export function isMarinaModel(model: string): boolean {
  if (COMPAT_ALIASES.has(model)) return true;
  // Accept `marina`, `default`, `marina/default`, `marina:default` — slash and colon
  // separators are interchangeable per modelToChannelName.
  return (
    model === "marina" ||
    model === "default" ||
    model === "marina/default" ||
    model === "marina:default"
  );
}

export function requestTrace(requestId: string): {
  runId: string;
  traceId: string;
  spanId: string;
} {
  return {
    runId: requestId,
    traceId: requestId,
    spanId: `span-${requestId}`,
  };
}

export function newRequestId(): string {
  return `req-${crypto.randomUUID().slice(0, 8)}`;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function extractConversationId(
  req: Request,
  body?: { conversation_id?: string },
): string | undefined {
  return body?.conversation_id ?? req.headers.get("X-Conversation-Id") ?? undefined;
}

export function extractStrategy(req: Request): "round-robin" | "least-busy" | "adaptive" {
  const header = req.headers.get("X-Load-Balance");
  if (header === "least-busy") return "least-busy";
  if (header === "adaptive") return "adaptive";
  return "round-robin";
}

/**
 * Whether a request must be proxied to the configured upstream like passthru
 * mode regardless of the operator's endpoint mode: Marina's own runtime agents
 * (room / crew / coding agents on `marina/default`, authenticated with the
 * internal model token) are CONSUMERS of the upstream, never participants of
 * the agents/open/panel routes — routing them onto the `model` channel would
 * hand their turn to another agent, and `rejectUnsupportedForAgents` would
 * refuse their `tools`. Found on a fresh install (default mode `agents`): the
 * first turn of every spawned agent failed with `400 unsupported_parameter`.
 */
export function isInternalCaller(auth: PassthruAuthResult | undefined): boolean {
  return auth?.internal === true;
}

export const SSE_HEADERS = {
  ...MODEL_CORS,
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

// --- OpenAI format helpers ---

/** Token usage as OpenAI reports it. Omitted (never zero-filled) when unknown. */
export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number; cache_creation_tokens?: number };
}

/** `prompt_tokens_details` from an OpenAI-shaped usage block — cache reads plus
 *  Marina's cache-write extension (`cache_creation_tokens`), when present. */
export function promptTokensDetails(
  u: unknown,
): CompletionUsage["prompt_tokens_details"] | undefined {
  const details = (u as { prompt_tokens_details?: unknown } | undefined)?.prompt_tokens_details;
  if (!details || typeof details !== "object") return undefined;
  const d = details as { cached_tokens?: unknown; cache_creation_tokens?: unknown };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const cached = num(d.cached_tokens);
  const created = num(d.cache_creation_tokens);
  if (cached === undefined && created === undefined) return undefined;
  return {
    cached_tokens: cached ?? 0,
    ...(created === undefined ? {} : { cache_creation_tokens: created }),
  };
}

export function openaiCompletion(model: string, content: string, usage?: CompletionUsage): unknown {
  return {
    id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

// --- OpenAI streaming format helpers ---

/** Role-only first chunk — required by OpenAI SDK stream accumulator */
export function openaiStreamRoleChunk(id: string, model: string): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function openaiStreamChunk(id: string, model: string, content: string): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function openaiStreamEnd(id: string, model: string): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

// --- Ollama streaming format helpers ---

export function ollamaStreamChunk(model: string, content: string, isChat: boolean): string {
  if (isChat) {
    return `${JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: "assistant", content }, done: false })}\n`;
  }
  return `${JSON.stringify({ model, created_at: new Date().toISOString(), response: content, done: false })}\n`;
}

export function ollamaStreamEnd(model: string, isChat: boolean): string {
  if (isChat) {
    return `${JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: "assistant", content: "" }, done: true, total_duration: 0, eval_count: 0 })}\n`;
  }
  return `${JSON.stringify({ model, created_at: new Date().toISOString(), response: "", done: true, total_duration: 0, eval_count: 0 })}\n`;
}
