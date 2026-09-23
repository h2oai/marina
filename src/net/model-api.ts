// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { version as MARINA_VERSION } from "../../package.json";
import { getInternalModelToken } from "../agent/agent-runtime";
import {
  formatUntrustedContext,
  PANEL_SYNTHESIS_SYSTEM_PROMPT,
} from "../agent/prompts/support-prompts";
import type { RateLimiter } from "../auth/rate-limiter";
import { secretsEqual } from "../auth/secret-compare";
import type { ChannelManager } from "../coordination/channel-manager";
import { localOutputBudget } from "../engine/constants";
import type { Engine } from "../engine/engine";
import { getErrorMessage } from "../engine/errors";
import { compareTraceCohorts } from "../engine/trace-dataset";
import { projectTraces } from "../engine/trace-projection";
import { adviseTraceRouting, selectAdaptiveCandidate } from "../engine/trace-routing-advice";
import { isLocalProfile } from "../engine/trust-profile";
import type { EngineEvent, EntityId } from "../types";
import { handleAnthropicMessages } from "./anthropic-inbound";
import {
  anthropicMessageToOpenai,
  anthropicTextContent,
  buildAnthropicRequest,
  translateAnthropicStream,
} from "./anthropic-tools";
import { buildAliasMap, getEnabledProfiles } from "./compat-profiles";
import { corsHeaders } from "./cors";
import { handleMediaApi } from "./media-api";
import {
  encodeMemoryReceiptAttribute,
  encodeMemoryReceiptHeader,
  finalizeMemoryReceipt,
  MEMORY_RECEIPT_HEADER,
  type MemoryReceipt,
} from "./memory-receipt";
import {
  isLocalProvider,
  LOCAL_PROVIDERS,
  localProviderBaseUrl,
  localProviderContextWindow,
} from "./model-discovery";
import { getEndpointConfig } from "./model-endpoint";
import {
  type OpenAIErrorOptions,
  openaiErrorBody,
  UnsupportedParameterError,
  unsupportedParameterBody,
} from "./openai-errors";
import {
  applyInjection,
  buildInjectedContext,
  capturePassthruTranscript,
  type InjectionFormat,
  messageText,
  type OpenAIMessage,
  type PassthruIdentity,
  resolvePassthruIdentity,
} from "./passthru-context";
import {
  lookupResponseCache,
  RESPONSE_CACHE_HEADER,
  responseCacheEnabled,
  storeResponseCache,
} from "./response-cache";
import {
  normalizeTextualToolCalls,
  type StreamEvent,
  ToolCallStreamParser,
} from "./tool-call-normalize";

const MODEL_CORS = corsHeaders(null, {
  methods: "GET, POST, OPTIONS",
  headers:
    "Content-Type, Authorization, X-Conversation-Id, X-Load-Balance, X-Marina-Agent, X-Marina-Context",
  expose: `X-Conversation-Id, x-request-id, ${MEMORY_RECEIPT_HEADER}, ${RESPONSE_CACHE_HEADER}`,
});

/** Response headers a passthru surface forwards from the proxied upstream reply
 *  when it re-encodes the body into its own protocol (Anthropic, Ollama, Responses). */
const PASSTHRU_FORWARDED_HEADERS = ["x-request-id", MEMORY_RECEIPT_HEADER, RESPONSE_CACHE_HEADER];

function forwardPassthruHeaders(
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

function isOpenApiMode(): boolean {
  return process.env.MARINA_OPEN_API === "true";
}

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
  const raw = process.env.MODEL_API_KEYS;
  if (!raw) return null;
  const entries = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map(parseKeyEntry);
  return entries.length > 0 ? entries : null;
}

type AuthOutcome = { error: Response } | { auth: PassthruAuthResult };

function authenticate(req: Request): AuthOutcome {
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

function generateRequestId(): string {
  return `req-${crypto.randomUUID().slice(0, 8)}`;
}

type PeerAddr = { requestIP?: (req: Request) => { address: string } | null };

function extractIp(req: Request, server?: PeerAddr): string {
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

function json(data: unknown, status = 200, extra?: Record<string, string>): Response {
  return Response.json(data, {
    status,
    headers: { ...MODEL_CORS, "x-request-id": generateRequestId(), ...extra },
  });
}

/** OpenAI-compatible nested error format. `code` is a string every OpenAI SDK
 *  can branch on (`invalid_api_key`, `model_not_found`, `context_length_exceeded`,
 *  `rate_limit_exceeded`, `unsupported_parameter`, …) — see `openai-errors.ts`;
 *  it is inferred from status + message unless given explicitly. */
function errorJson(status: number, message: string, opts?: OpenAIErrorOptions): Response {
  return json(openaiErrorBody(status, message, opts), status);
}

/** 400 for a request parameter this route cannot honor (never silently dropped). */
function unsupportedParam(param: string, detail?: string): Response {
  return json(unsupportedParameterBody(param, detail), 400);
}

const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MODEL_REQUEST_TIMEOUT_MS ?? "600000", 10);

/**
 * Pending-request reminders — the mechanical backstop for coordinator drift.
 *
 * Measured in the 2026-09 orchestration sweeps: a small-model coordinator
 * receives a model_request, starts the work (delegates, calcs), and then its
 * autonomous continuation cycle displaces the final reply — the request
 * silently times out even though the answer exists. Prompt-side fixes
 * (envelope teaching, protocol-priority briefs) reduce but do not eliminate
 * this. The engine-side guarantee: while a request is unanswered, re-post it
 * as a reminder (same `model_request` type and id, `reminder: true`, original
 * content included) so the target re-perceives it and can still answer even
 * if it lost its own thread. Duplicate replies are harmless — the waiter
 * takes the first match.
 *
 * Fires at 25% and 60% of REQUEST_TIMEOUT_MS (150s/360s at the 600s default,
 * so the first reminder also lands inside a 300s client window). Disable
 * with MODEL_REQUEST_REMINDERS=0.
 */
const REQUEST_REMINDER_FRACTIONS = [0.25, 0.6];
export function scheduleRequestReminders(
  cm: ChannelManager,
  channelId: string,
  requestId: string,
  target: string,
  userContent: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): () => void {
  if (process.env.MODEL_REQUEST_REMINDERS === "0") return () => {};
  // Name the channel EXPLICITLY and give the exact command. Measured failure
  // (2026-09 swarm run): a reminder saying "reply on this channel" led the
  // agent to run `channel send {json}` with no channel name — the JSON parsed
  // as the channel name, every send failed, and the crew stalled to 0/10.
  const channelName = cm.getChannel(channelId)?.name ?? channelId;
  const timers = REQUEST_REMINDER_FRACTIONS.map((fraction) =>
    setTimeout(
      () => {
        const age = Math.round((timeoutMs * fraction) / 1000);
        cm.send(
          channelId,
          "__model_api__",
          "model-api",
          JSON.stringify({
            type: "model_request",
            id: requestId,
            reminder: true,
            target,
            content:
              `REMINDER (${age}s elapsed, request ${requestId} still unanswered): send your best ` +
              `current answer immediately — do not wait on further coordination. Run EXACTLY: ` +
              `channel send ${channelName} {"type":"model_response","id":"${requestId}","content":"<your best answer>"} ` +
              `(the channel name "${channelName}" is required — never omit it). ` +
              `Original question: ${userContent.slice(0, 1500)}`,
          }),
        );
      },
      Math.round(timeoutMs * fraction),
    ),
  );
  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}

/** Close a ReadableStreamDefaultController safely. The stream may have been
 *  closed already by a client disconnect, a prior end-of-response, or a
 *  response race with the cleanup timer. Swallow the second-close throw. */
function safeClose(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    /* controller already closed — fine */
  }
}

/** Compat-profile aliases — extra model ids that all resolve to the default
 *  "model" channel. Built from src/net/compat-profiles.ts at module init so adding
 *  a new alias is a one-line change in the registry, not here. */
const COMPAT_ALIASES = buildAliasMap();

/** Map model ID to channel name. "marina" → "model", "marina:scholar" → "model-scholar",
 *  "marina/answerer" → "model-answerer". Both colon and slash separators are accepted because
 *  the OpenAI-format convention is `provider/model` and the historic Marina convention was
 *  `provider:variant`; tools, world seeds, and bench harnesses use both interchangeably.
 *  Compat-profile aliases (e.g. "assistant") map to the default "model" channel. */
function modelToChannelName(model: string): string {
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
function channelNameToModel(name: string): string {
  if (name === "model") return "marina";
  const suffix = name.replace(/^model-/, "");
  return `marina:${suffix}`;
}

interface ModelInfo {
  id: string;
  channelId: string;
  onlineMembers: number;
}

function listModels(engine: Engine): ModelInfo[] {
  const cm = engine.channelManager;
  if (!cm) return [];

  const onlineIds = new Set(engine.getOnlineAgents().map((e) => e.id));
  const channels = cm.getAllChannels();
  const models: ModelInfo[] = [];

  for (const ch of channels) {
    if (!ch.name.startsWith("model")) continue;
    if (ch.name !== "model" && !ch.name.startsWith("model-")) continue;
    // Exclude conversation channels from model listing
    if (ch.name.startsWith("model-conv-")) continue;
    const members = cm.getMembers(ch.id);
    const online = members.filter((m) => onlineIds.has(m as never)).length;
    // Hide marina:<name> subroutes with no online agents — they would 503 on request.
    // "model" (the default) stays visible because it falls back to direct upstream proxy.
    if (ch.name !== "model" && online === 0) continue;
    models.push({
      id: channelNameToModel(ch.name),
      channelId: ch.id,
      onlineMembers: online,
    });
  }

  // Compat-profile drop-in: expose the default "model" channel under each registered
  // alias (e.g. "assistant") so external clients pointed at /v1/models see a familiar
  // id. Same channel, same agents — just an alias.
  const defaultModel = models.find((m) => m.id === "marina");
  if (defaultModel) {
    for (const alias of COMPAT_ALIASES.keys()) {
      models.push({
        id: alias,
        channelId: defaultModel.channelId,
        onlineMembers: defaultModel.onlineMembers,
      });
    }
  }

  return models;
}

// --- OpenAI format helpers ---

function openaiModelList(models: ModelInfo[]): unknown {
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "marina",
    })),
  };
}

/** Token usage as OpenAI reports it. Omitted (never zero-filled) when unknown. */
interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

function openaiCompletion(model: string, content: string, usage?: CompletionUsage): unknown {
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

/**
 * Usage for an agent-routed request, from the traced lifecycle: the agent's
 * own model turns are `agent_turn_end` spans under the request's trace
 * (`traceId === requestId`, see `requestTrace`). Summed across turns; undefined
 * when no turn reported tokens — the caller then OMITS `usage` rather than
 * inventing zeros an SDK would bill against.
 */
function usageFromTrace(engine: Engine, requestId: string): CompletionUsage | undefined {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let seen = false;
  for (const event of engine.getEventLog()) {
    if (event.type !== "agent_turn_end" || event.traceId !== requestId) continue;
    if (event.inputTokens === undefined && event.outputTokens === undefined) continue;
    seen = true;
    prompt += event.inputTokens ?? 0;
    completion += event.outputTokens ?? 0;
    cached += event.cacheReadTokens ?? 0;
  }
  if (!seen) return undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

// --- OpenAI streaming format helpers ---

/** Role-only first chunk — required by OpenAI SDK stream accumulator */
function openaiStreamRoleChunk(id: string, model: string): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function openaiStreamChunk(id: string, model: string, content: string): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function openaiStreamEnd(id: string, model: string): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
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

function ollamaTagList(models: ModelInfo[]): unknown {
  return { models: models.map(ollamaModelRecord) };
}

/** `POST /api/show` body for a model: the Modelfile/parameters/template are
 *  empty strings (there is no local weight file), `details` and `model_info`
 *  describe the route, `capabilities` advertise what the passthru honors. */
function ollamaShowResponse(m: ModelInfo, engine: Engine): unknown {
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
    capabilities: ["completion", "tools"],
    modified_at: new Date().toISOString(),
  };
}

/** `GET /api/ps`: the "running" model is the configured default route. */
function ollamaPsResponse(models: ModelInfo[]): unknown {
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
function findOllamaModel(models: ModelInfo[], ref: unknown): ModelInfo | undefined {
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

// --- Ollama streaming format helpers ---

function ollamaStreamChunk(model: string, content: string, isChat: boolean): string {
  if (isChat) {
    return `${JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: "assistant", content }, done: false })}\n`;
  }
  return `${JSON.stringify({ model, created_at: new Date().toISOString(), response: content, done: false })}\n`;
}

function ollamaStreamEnd(model: string, isChat: boolean): string {
  if (isChat) {
    return `${JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: "assistant", content: "" }, done: true, total_duration: 0, eval_count: 0 })}\n`;
  }
  return `${JSON.stringify({ model, created_at: new Date().toISOString(), response: "", done: true, total_duration: 0, eval_count: 0 })}\n`;
}

// --- Load balancing ---

const roundRobinCounters = new Map<string, number>();
const pendingRequests = new Map<string, number>();

function selectAgent(
  onlineMembers: string[],
  channelId: string,
  strategy: "round-robin" | "least-busy",
): string {
  if (onlineMembers.length === 1) return onlineMembers[0]!;

  if (strategy === "least-busy") {
    let best = onlineMembers[0]!;
    let bestCount = pendingRequests.get(best) ?? 0;
    for (let i = 1; i < onlineMembers.length; i++) {
      const count = pendingRequests.get(onlineMembers[i]!) ?? 0;
      if (count < bestCount) {
        best = onlineMembers[i]!;
        bestCount = count;
      }
    }
    return best;
  }

  // round-robin
  const idx = roundRobinCounters.get(channelId) ?? 0;
  const selected = onlineMembers[idx % onlineMembers.length]!;
  roundRobinCounters.set(channelId, idx + 1);
  return selected;
}

function incrementPending(entityId: string): void {
  pendingRequests.set(entityId, (pendingRequests.get(entityId) ?? 0) + 1);
}

function decrementPending(entityId: string): void {
  const count = (pendingRequests.get(entityId) ?? 1) - 1;
  if (count <= 0) pendingRequests.delete(entityId);
  else pendingRequests.set(entityId, count);
}

// --- Multi-turn conversation channels ---

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

function getOrCreateConversationChannel(
  cm: ChannelManager,
  conversationId: string,
): { id: string; name: string } {
  const name = `model-conv-${conversationId}`;
  const existing = cm.getChannelByName(name);
  if (existing) return { id: existing.id, name: existing.name };
  const channel = cm.createChannel({
    type: "model",
    name,
    retentionHours: 24,
  });
  return { id: channel.id, name: channel.name };
}

function buildHistory(cm: ChannelManager, channelId: string): HistoryEntry[] {
  const messages = cm.getHistory(channelId, 50);
  const history: HistoryEntry[] = [];
  for (const msg of messages) {
    const role: "user" | "assistant" = msg.senderId === "__model_conv__" ? "user" : "assistant";
    history.push({ role, content: msg.content });
  }
  return history;
}

// --- Core routing ---

interface RouteResult {
  content: string;
  conversationId?: string;
  /** Traced request identity (equals the runId/traceId recorded in the event
   *  log). Returned as `x-request-id` so a caller can jump straight to
   *  `trace show <id>` / Admin → Traces for this exact request. */
  requestId: string;
}

interface RouteOptions {
  context?: string;
  conversationId?: string;
  strategy?: "round-robin" | "least-busy" | "adaptive";
}

const ADAPTIVE_HISTORY_EVENT_LIMIT = 2_000;
// Routing advice is a 2,000-row scan + full trace projection — far too heavy
// to recompute per request. It depends only on event-log contents, so the memo
// keys on MAX(event_log.id): an O(1) rowid-max lookup that stays cached across
// a request burst and invalidates the moment any new event lands (never stale).
// Scoped per Engine (WeakMap) so co-hosted engines never share advice.
const adaptiveAdviceCaches = new WeakMap<
  Engine,
  { maxEventId: number; advice: ReturnType<typeof adviseTraceRouting> }
>();

function adaptiveRoutingAdvice(engine: Engine): ReturnType<typeof adviseTraceRouting> {
  const maxEventId = engine.db?.getMaxEventId() ?? -1;
  const cached = adaptiveAdviceCaches.get(engine);
  if (cached && cached.maxEventId === maxEventId && maxEventId >= 0) {
    return cached.advice;
  }
  const history = engine.db?.getRecentTraceEvents(ADAPTIVE_HISTORY_EVENT_LIMIT);
  // Routing advice is decided purely from observed mechanics (adviseTraceRouting
  // never reads judgments), so skip the per-trace judgment fetch here — it would
  // cost up to one query per projected trace on the request hot path. Judgments
  // remain on the /api/traces display path (dashboard-api.ts).
  const evidence = history ? projectTraces(history.events) : [];
  const advice = adviseTraceRouting(compareTraceCohorts(evidence, "route"), "route");
  adaptiveAdviceCaches.set(engine, { maxEventId, advice });
  return advice;
}

function selectRouteTarget(
  engine: Engine,
  members: string[],
  channelId: string,
  strategy: NonNullable<RouteOptions["strategy"]>,
): { target: string; adviceMode?: "pareto" | "explore" | "insufficient"; reason?: string } {
  if (strategy !== "adaptive") return { target: selectAgent(members, channelId, strategy) };
  const advice = adaptiveRoutingAdvice(engine);
  const selected = selectAdaptiveCandidate(members, advice, () =>
    selectAgent(members, channelId, "least-busy"),
  );
  return { target: selected.target, adviceMode: advice.mode, reason: selected.reason };
}

function requestTrace(requestId: string): {
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

async function routeToChannel(
  engine: Engine,
  model: string,
  userContent: string,
  opts?: RouteOptions,
): Promise<RouteResult> {
  const cm = engine.channelManager;
  if (!cm) throw new HttpError(503, "Channel system unavailable");

  const channelName = modelToChannelName(model);
  const channel = cm.getChannelByName(channelName);
  if (!channel) throw new HttpError(404, `Model "${model}" not found`);

  // Check online members
  const onlineIds = new Set(engine.getOnlineAgents().map((e) => e.id));
  const members = cm.getMembers(channel.id);
  const onlineMembers = members.filter((m) => onlineIds.has(m as never));
  if (onlineMembers.length === 0) {
    throw new HttpError(503, `No agents online for model "${model}"`);
  }

  // Load balancing
  const strategy = opts?.strategy ?? "round-robin";
  const route = selectRouteTarget(engine, onlineMembers, channel.id, strategy);
  const target = route.target;

  // Multi-turn conversation
  const convId = opts?.conversationId ?? undefined;
  let convChannel: { id: string; name: string } | undefined;
  let history: HistoryEntry[] | undefined;
  if (convId) {
    convChannel = getOrCreateConversationChannel(cm, convId);
    history = buildHistory(cm, convChannel.id);
  }

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
    phase: "routed",
    requestId,
    ...requestTrace(requestId),
    model,
    target,
    routeStrategy: strategy,
    candidateCount: onlineMembers.length,
    routeAdviceMode: route.adviceMode,
    routeReason: route.reason,
    timestamp: Date.now(),
  });

  // Build request payload
  const payload = JSON.stringify({
    type: "model_request",
    id: requestId,
    trace: requestTrace(requestId),
    content: userContent,
    target,
    ...(opts?.context ? { context: opts.context } : {}),
    ...(convId ? { conversation_id: convId } : {}),
    ...(history && history.length > 0 ? { history } : {}),
  });

  incrementPending(target);
  const cancelReminders = scheduleRequestReminders(cm, channel.id, requestId, target, userContent);

  try {
    const result = await new Promise<RouteResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new HttpError(504, "Response timeout"));
      }, REQUEST_TIMEOUT_MS);

      const unsub = cm.onMessage((channelId, senderId, _senderName, content) => {
        if (channelId !== channel.id) return;
        if (senderId === "__model_api__") return;
        // Orchestration boundary: only the designated target may fulfill the
        // response. Specialists that share the channel (to hear internal
        // coordination) must not race the orchestrator.
        if (senderId !== target) return;

        // Try JSON response format
        let parsed: Record<string, string> | undefined;
        try {
          parsed = JSON.parse(content);
        } catch {
          // Non-JSON — fall through to plaintext check
        }
        if (parsed?.type === "model_response" && parsed.id === requestId) {
          clearTimeout(timer);
          unsub();
          resolve({ content: parsed.content ?? "", conversationId: convId, requestId });
          return;
        }

        // Fallback: plaintext "[req-abc123] response text"
        const prefix = `[${requestId}] `;
        if (content.startsWith(prefix)) {
          clearTimeout(timer);
          unsub();
          resolve({
            content: content.slice(prefix.length),
            conversationId: convId,
            requestId,
          });
        }
      });

      // Send request to channel
      cm.send(channel.id, "__model_api__", "model-api", payload);
    });

    // Persist to conversation channel (use __model_conv__ to avoid triggering agents)
    if (convChannel) {
      cm.send(convChannel.id, "__model_conv__", "user", userContent);
      cm.send(convChannel.id, target, "agent", result.content);
    }

    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "completed",
      requestId,
      ...requestTrace(requestId),
      model,
      target,
      routeStrategy: strategy,
      candidateCount: onlineMembers.length,
      routeAdviceMode: route.adviceMode,
      routeReason: route.reason,
      durationMs: Date.now() - startedAt,
      timestamp: Date.now(),
    });
    return result;
  } catch (error) {
    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "failed",
      requestId,
      ...requestTrace(requestId),
      model,
      target,
      routeStrategy: strategy,
      candidateCount: onlineMembers.length,
      routeAdviceMode: route.adviceMode,
      routeReason: route.reason,
      durationMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : "unknown error",
      timestamp: Date.now(),
    });
    throw error;
  } finally {
    cancelReminders();
    decrementPending(target);
  }
}

// --- Open / Panel routing (fan-out) ---
//
// Open and Panel both fan out a model_request to each selected online member
// (pinned per-member so they actually answer — no agent-prompt change needed):
//   - open:  resolve on the FIRST response, ignore the rest ("anyone answers").
//   - panel: collect up to N, then merge (concat or synthesize).

const FANOUT_CAP = 6;
const PANEL_GRACE_MS = 8000;

function getModelChannelMembers(
  engine: Engine,
  model: string,
): { cm: ChannelManager; channel: { id: string; name: string }; onlineMembers: string[] } {
  const cm = engine.channelManager;
  if (!cm) throw new HttpError(503, "Channel system unavailable");
  const channel = cm.getChannelByName(modelToChannelName(model));
  if (!channel) throw new HttpError(404, `Model "${model}" not found`);
  const onlineIds = new Set(engine.getOnlineAgents().map((e) => e.id));
  const onlineMembers = cm.getMembers(channel.id).filter((m) => onlineIds.has(m as never));
  if (onlineMembers.length === 0) {
    throw new HttpError(503, `No agents online for model "${model}"`);
  }
  return { cm, channel, onlineMembers };
}

/** Parse a member's reply to a fan-out request: JSON model_response or the
 *  plaintext "[req-id] text" form. Returns the matched requestId + content. */
function matchFanoutReply(
  content: string,
  pending: Set<string>,
): { id: string; text: string } | null {
  try {
    const parsed = JSON.parse(content) as { type?: string; id?: string; content?: string };
    if (parsed.type === "model_response" && parsed.id && pending.has(parsed.id)) {
      return { id: parsed.id, text: parsed.content ?? "" };
    }
  } catch {
    // not JSON — try plaintext
  }
  for (const id of pending) {
    const prefix = `[${id}] `;
    if (content.startsWith(prefix)) return { id, text: content.slice(prefix.length) };
  }
  return null;
}

async function collectResponses(
  engine: Engine,
  model: string,
  userContent: string,
  opts: RouteOptions | undefined,
  resolveMode: "first" | "all",
  maxTargets: number,
): Promise<{ responses: string[]; conversationId?: string; requestId: string }> {
  const { cm, channel, onlineMembers } = getModelChannelMembers(engine, model);
  const targets = onlineMembers.slice(0, Math.min(maxTargets, onlineMembers.length, FANOUT_CAP));
  const convId = opts?.conversationId ?? undefined;
  const pending = new Set<string>();
  const collected: string[] = [];

  // One run/trace identity for the whole fan-out; each target gets its own
  // request span (same traceId, distinct spanId) so a responding agent's turn
  // parents under the span embedded in its own model_request payload.
  const runId = `req-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const targetByRequest = new Map<string, string>();
  const fanoutTrace = (requestId: string) => ({
    runId,
    traceId: runId,
    spanId: `span-${requestId}`,
  });
  const finishTarget = (requestId: string, phase: "completed" | "failed", detail?: string) => {
    const target = targetByRequest.get(requestId);
    if (!target) return;
    targetByRequest.delete(requestId);
    engine.logEvent({
      type: "model_request_lifecycle",
      phase,
      requestId,
      ...fanoutTrace(requestId),
      model,
      target,
      candidateCount: onlineMembers.length,
      durationMs: Date.now() - startedAt,
      ...(detail ? { detail } : {}),
      timestamp: Date.now(),
    });
  };

  return new Promise<{ responses: string[]; conversationId?: string; requestId: string }>(
    (resolve, reject) => {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const done = () => ({ responses: collected, conversationId: convId, requestId: runId });
      const overall = setTimeout(() => {
        cleanup("Response timeout");
        if (collected.length > 0) resolve(done());
        else reject(new HttpError(504, "Response timeout"));
      }, REQUEST_TIMEOUT_MS);

      // `unresolvedDetail` explains, on the trace, why a target's span failed
      // without a reply (timeout, open-mode close, panel grace window).
      function cleanup(unresolvedDetail: string) {
        settled = true;
        clearTimeout(overall);
        if (graceTimer) clearTimeout(graceTimer);
        unsub();
        for (const id of pending) finishTarget(id, "failed", unresolvedDetail);
        for (const t of targets) decrementPending(t);
      }

      const unsub = cm.onMessage((channelId, senderId, _name, content) => {
        if (channelId !== channel.id || senderId === "__model_api__") return;
        const match = matchFanoutReply(content, pending);
        if (!match) return;
        pending.delete(match.id);
        finishTarget(match.id, "completed");
        collected.push(match.text);
        if (resolveMode === "first") {
          cleanup("fan-out closed after first response (open mode)");
          resolve(done());
          return;
        }
        // "all": resolve when every target has replied, or a grace window after the
        // first reply elapses (so one slow/dead agent can't stall the panel).
        if (collected.length === 1) {
          graceTimer = setTimeout(() => {
            cleanup("fan-out grace window elapsed before a response (panel mode)");
            resolve(done());
          }, PANEL_GRACE_MS);
        }
        if (pending.size === 0) {
          cleanup("fan-out complete");
          resolve(done());
        }
      });

      for (const target of targets) {
        // A synchronous responder can settle the fan-out mid-loop (open mode:
        // first answer wins); don't dispatch — or trace — dead requests.
        if (settled) break;
        const requestId = `req-${crypto.randomUUID().slice(0, 8)}`;
        pending.add(requestId);
        targetByRequest.set(requestId, target);
        incrementPending(target);
        engine.logEvent({
          type: "model_request_lifecycle",
          phase: "received",
          requestId,
          ...fanoutTrace(requestId),
          model,
          timestamp: Date.now(),
        });
        engine.logEvent({
          type: "model_request_lifecycle",
          phase: "routed",
          requestId,
          ...fanoutTrace(requestId),
          model,
          target,
          candidateCount: onlineMembers.length,
          timestamp: Date.now(),
        });
        cm.send(
          channel.id,
          "__model_api__",
          "model-api",
          JSON.stringify({
            type: "model_request",
            id: requestId,
            trace: fanoutTrace(requestId),
            content: userContent,
            target,
            ...(opts?.context ? { context: opts.context } : {}),
            ...(convId ? { conversation_id: convId } : {}),
          }),
        );
      }
    },
  );
}

/** Open mode: first online member to answer wins. */
async function routeOpen(
  engine: Engine,
  model: string,
  userContent: string,
  opts?: RouteOptions,
): Promise<RouteResult> {
  const { responses, conversationId, requestId } = await collectResponses(
    engine,
    model,
    userContent,
    opts,
    "first",
    FANOUT_CAP,
  );
  return { content: responses[0] ?? "", conversationId, requestId };
}

/** Panel mode: collect up to N answers, then concat or synthesize. */
async function routePanel(
  engine: Engine,
  model: string,
  userContent: string,
  opts: RouteOptions | undefined,
  panelSize: number,
  synthesis: "concat" | "synthesize",
): Promise<RouteResult> {
  const { responses, conversationId, requestId } = await collectResponses(
    engine,
    model,
    userContent,
    opts,
    "all",
    panelSize,
  );
  if (responses.length <= 1) {
    return { content: responses[0] ?? "", conversationId, requestId };
  }
  if (synthesis === "concat") {
    const merged = responses.map((r, i) => `### Answer ${i + 1}\n\n${r}`).join("\n\n");
    return { content: merged, conversationId, requestId };
  }
  // synthesize: ask the configured upstream model to merge the panel's answers.
  const mergePrompt = formatUntrustedContext("Panel synthesis inputs", {
    question: userContent,
    candidates: responses,
  });
  try {
    const resp = await proxyToUpstream(engine, {
      model: "marina/default",
      messages: [
        { role: "system", content: PANEL_SYNTHESIS_SYSTEM_PROMPT },
        { role: "user", content: mergePrompt },
      ],
    });
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content;
    if (text) return { content: text, conversationId, requestId };
  } catch {
    // synthesis upstream unavailable — fall back to concat below
  }
  const merged = responses.map((r, i) => `### Answer ${i + 1}\n\n${r}`).join("\n\n");
  return { content: merged, conversationId, requestId };
}

/** Emit a buffered string as an OpenAI-format SSE stream (used when a stream is
 *  requested in a mode that can't stream incrementally — open / panel). */
function bufferedOpenaiStream(
  model: string,
  content: string,
  convId?: string,
  requestId?: string,
): Response {
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(openaiStreamRoleChunk(id, model)));
      controller.enqueue(enc.encode(openaiStreamChunk(id, model, content)));
      controller.enqueue(enc.encode(openaiStreamEnd(id, model)));
      safeClose(controller);
    },
  });
  const headers: Record<string, string> = {
    ...MODEL_CORS,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Prefer the traced request identity so the header matches `trace show <id>`.
    "x-request-id": requestId ?? generateRequestId(),
  };
  if (convId) headers["X-Conversation-Id"] = convId;
  return new Response(stream, { headers });
}

// --- Streaming routing ---

type StreamFormat = "openai" | "ollama-chat" | "ollama-generate" | "responses";

/** Responses-API stream target: the emitter writes the events, `onComplete`
 *  receives the finished record (the caller stores it). Required for `"responses"`. */
interface ResponsesStreamSink {
  emitter: ResponsesSseEmitter;
  onComplete: (rec: ResponseRecord) => void;
}

function routeToChannelStreaming(
  engine: Engine,
  model: string,
  userContent: string,
  format: StreamFormat,
  opts?: RouteOptions,
  responses?: ResponsesStreamSink,
): { stream: ReadableStream<Uint8Array>; conversationId?: string; requestId: string } {
  if (format === "responses" && !responses) {
    throw new HttpError(500, "Responses stream requested without a sink");
  }
  const cm = engine.channelManager;
  if (!cm) throw new HttpError(503, "Channel system unavailable");

  const channelName = modelToChannelName(model);
  const channel = cm.getChannelByName(channelName);
  if (!channel) throw new HttpError(404, `Model "${model}" not found`);

  const onlineIds = new Set(engine.getOnlineAgents().map((e) => e.id));
  const members = cm.getMembers(channel.id);
  const onlineMembers = members.filter((m) => onlineIds.has(m as never));
  if (onlineMembers.length === 0) {
    throw new HttpError(503, `No agents online for model "${model}"`);
  }

  const strategy = opts?.strategy ?? "round-robin";
  const route = selectRouteTarget(engine, onlineMembers, channel.id, strategy);
  const target = route.target;

  const convId = opts?.conversationId ?? undefined;
  let convChannel: { id: string; name: string } | undefined;
  let history: HistoryEntry[] | undefined;
  if (convId) {
    convChannel = getOrCreateConversationChannel(cm, convId);
    history = buildHistory(cm, convChannel.id);
  }

  const reqId = `req-${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const streamId = `chatcmpl-${reqId.slice(4)}`;
  const encoder = new TextEncoder();
  const collectedContent: string[] = [];

  const payload = JSON.stringify({
    type: "model_request",
    id: reqId,
    trace: requestTrace(reqId),
    content: userContent,
    target,
    stream: true,
    ...(opts?.context ? { context: opts.context } : {}),
    ...(convId ? { conversation_id: convId } : {}),
    ...(history && history.length > 0 ? { history } : {}),
  });

  incrementPending(target);

  engine.logEvent({
    type: "model_request_lifecycle",
    phase: "received",
    requestId: reqId,
    ...requestTrace(reqId),
    model,
    timestamp: startedAt,
  });
  engine.logEvent({
    type: "model_request_lifecycle",
    phase: "routed",
    requestId: reqId,
    ...requestTrace(reqId),
    model,
    target,
    routeStrategy: strategy,
    candidateCount: onlineMembers.length,
    routeAdviceMode: route.adviceMode,
    routeReason: route.reason,
    timestamp: Date.now(),
  });

  // Hoisted so cancel() (client disconnect) runs the same cleanup as the
  // success/timeout paths. `settled` guards decrementPending against running
  // more than once across {end, single-response, timeout, cancel}.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsub: (() => void) | undefined;
  let settled = false;
  let traceFinished = false;
  let cancelReminders: (() => void) | undefined;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    cancelReminders?.();
    unsub?.();
    decrementPending(target);
  };
  const finishTrace = (phase: "completed" | "failed", detail?: string) => {
    if (traceFinished) return;
    traceFinished = true;
    engine.logEvent({
      type: "model_request_lifecycle",
      phase,
      requestId: reqId,
      ...requestTrace(reqId),
      model,
      target,
      routeStrategy: strategy,
      candidateCount: onlineMembers.length,
      routeAdviceMode: route.adviceMode,
      routeReason: route.reason,
      durationMs: Date.now() - startedAt,
      ...(detail ? { detail } : {}),
      timestamp: Date.now(),
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // OpenAI streams must begin with a role-only chunk
      if (format === "openai") {
        controller.enqueue(encoder.encode(openaiStreamRoleChunk(streamId, model)));
      }
      if (format === "responses" && responses) {
        responses.emitter.bind((frame) => controller.enqueue(frame));
        responses.emitter.start();
      }

      timer = setTimeout(() => {
        cleanup();
        finishTrace("failed", "Response timeout");
        if (format === "responses" && responses) {
          responses.emitter.fail("Response timeout — no agent answered in time", "timeout");
        }
        safeClose(controller);
      }, REQUEST_TIMEOUT_MS);

      unsub = cm.onMessage((channelId, senderId, _senderName, content) => {
        if (channelId !== channel.id) return;
        if (senderId === "__model_api__") return;
        // Orchestration boundary: only the designated target may fulfill the
        // stream. Mirrors the non-streaming guard in routeToChannel.
        if (senderId !== target) return;

        let parsed: { type?: string; id?: string; content?: string };
        try {
          parsed = JSON.parse(content);
        } catch {
          return; // Non-JSON message — skip
        }

        const text = parsed.content ?? "";

        // Streaming chunk
        if (parsed.type === "model_response_chunk" && parsed.id === reqId) {
          collectedContent.push(text);
          if (format === "responses") {
            responses!.emitter.textDelta(text);
            return;
          }
          let chunk: string;
          if (format === "openai") {
            chunk = openaiStreamChunk(streamId, model, text);
          } else {
            chunk = ollamaStreamChunk(model, text, format === "ollama-chat");
          }
          controller.enqueue(encoder.encode(chunk));
          return;
        }

        // Streaming end
        if (parsed.type === "model_response_end" && parsed.id === reqId) {
          cleanup();
          finishTrace("completed");
          if (format === "responses") {
            // The agent's turn span is logged before it answers, so the
            // trace-derived usage is available here.
            responses!.onComplete(responses!.emitter.finish(usageFromTrace(engine, reqId)));
          } else {
            let endChunk: string;
            if (format === "openai") {
              endChunk = openaiStreamEnd(streamId, model);
            } else {
              endChunk = ollamaStreamEnd(model, format === "ollama-chat");
            }
            controller.enqueue(encoder.encode(endChunk));
          }
          // Persist to conversation channel
          if (convChannel) {
            cm.send(convChannel.id, "__model_conv__", "user", userContent);
            cm.send(convChannel.id, target, "agent", collectedContent.join(""));
          }
          safeClose(controller);
          return;
        }

        // Phase 1 compat: single model_response → wrap as one chunk + end
        if (parsed.type === "model_response" && parsed.id === reqId) {
          cleanup();
          finishTrace("completed");
          collectedContent.push(text);
          if (format === "responses") {
            responses!.emitter.textDelta(text);
            responses!.onComplete(responses!.emitter.finish(usageFromTrace(engine, reqId)));
          } else if (format === "openai") {
            controller.enqueue(encoder.encode(openaiStreamChunk(streamId, model, text)));
            controller.enqueue(encoder.encode(openaiStreamEnd(streamId, model)));
          } else {
            controller.enqueue(
              encoder.encode(ollamaStreamChunk(model, text, format === "ollama-chat")),
            );
            controller.enqueue(encoder.encode(ollamaStreamEnd(model, format === "ollama-chat")));
          }
          if (convChannel) {
            cm.send(convChannel.id, "__model_conv__", "user", userContent);
            cm.send(convChannel.id, target, "agent", text);
          }
          safeClose(controller);
        }
      });

      try {
        cancelReminders = scheduleRequestReminders(cm, channel.id, reqId, target, userContent);
        // A local listener can finish the stream inside send(). Install all
        // cleanup handles first so a completed request cannot leave reminders.
        cm.send(channel.id, "__model_api__", "model-api", payload);
      } catch (error) {
        cleanup();
        finishTrace("failed", "Request dispatch failed");
        throw error;
      }
    },
    cancel() {
      // Client disconnected mid-stream — release the channel listener and the
      // pending-request slot now instead of leaking them until the timeout
      // (which otherwise skews least-busy load-balancing for up to REQUEST_TIMEOUT_MS).
      cleanup();
      finishTrace("failed", "Client disconnected");
    },
  });

  return { stream, conversationId: convId, requestId: reqId };
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- OpenAI Responses API (server-side conversation state) ---
//
// Passthru clients that use the OpenAI Responses API get the same server-side
// state experience. Each response_id maps to a conversation channel;
// previous_response_id threads continuations onto the same channel.
// Memory-only index (restart wipes the id map; messages remain in channels).

/**
 * A function call the upstream returned (chat-completions `tool_calls`), kept
 * on the record so the streaming and non-streaming Responses bodies render the
 * same `function_call` output items. `/v1/responses` passthru does not forward
 * Responses tool schemas; these appear only when an upstream (or the textual
 * tool-call repair) emits a structured call anyway.
 */
interface ResponsesFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

interface ResponseRecord {
  id: string;
  conversationId: string;
  model: string;
  content: string;
  createdAt: number;
  previousResponseId?: string;
  status: "completed" | "failed";
  /** Upstream-reported usage (passthru) or trace-derived usage (agents); omitted when unknown. */
  usage?: CompletionUsage;
  /** Structured function calls, in arrival order (see `ResponsesFunctionCall`). */
  toolCalls?: ResponsesFunctionCall[];
  /**
   * How many function calls precede the assistant message item in `output`.
   * A stream decides this by arrival order (text before or after the first
   * call); a non-streaming body puts the message first. Undefined = 0.
   */
  messageAfter?: number;
  /**
   * Owner key binding this record to the credential that created it. A
   * different caller (different API key) can never GET/DELETE it, nor thread a
   * new response onto its conversation — cross-caller access returns 404 (the
   * record's existence is never revealed to a non-owner). Same key = same owner
   * (a shared secret is shared by definition).
   */
  owner: string;
}

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

function extractInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  // OpenAI Responses API accepts an array of {role, content} entries.
  const parts: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: string }).role;
    const content = (item as { content?: unknown }).content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((c) => {
                if (typeof c === "string") return c;
                if (c && typeof c === "object") {
                  const cc = c as { text?: string; type?: string };
                  if (typeof cc.text === "string") return cc.text;
                }
                return "";
              })
              .filter(Boolean)
              .join("\n")
          : "";
    if (role && role !== "user") parts.push(`${role}: ${text}`);
    else parts.push(text);
  }
  return parts.filter(Boolean).join("\n");
}

function responsesUsage(usage: CompletionUsage | undefined): Record<string, unknown> {
  if (!usage) return {};
  return {
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
    },
  };
}

/** Item ids are derived from the response id so a stream's incremental items
 *  and the stored record's `output` name the same objects. */
function responsesMessageItemId(rec: Pick<ResponseRecord, "id">): string {
  return `msg_${rec.id.slice(5)}`;
}
function responsesFunctionCallItemId(rec: Pick<ResponseRecord, "id">, position: number): string {
  return `fc_${rec.id.slice(5)}_${position}`;
}

function responsesMessageItem(
  rec: Pick<ResponseRecord, "id">,
  text: string,
  status: "completed" | "in_progress" = "completed",
): Record<string, unknown> {
  return {
    type: "message",
    id: responsesMessageItemId(rec),
    role: "assistant",
    status,
    content:
      status === "completed" ? [{ type: "output_text", text, annotations: [] }] : ([] as unknown[]),
  };
}

function responsesFunctionCallItem(
  rec: Pick<ResponseRecord, "id">,
  call: ResponsesFunctionCall,
  position: number,
  status: "completed" | "in_progress" = "completed",
): Record<string, unknown> {
  return {
    type: "function_call",
    id: responsesFunctionCallItemId(rec, position),
    call_id: call.callId,
    name: call.name,
    arguments: status === "completed" ? call.arguments : "",
    status,
  };
}

/** The message item is present when there is text, or when nothing else is. */
function responsesHasMessageItem(rec: Pick<ResponseRecord, "content" | "toolCalls">): boolean {
  return rec.content !== "" || !rec.toolCalls?.length;
}

/** `output` items in their final order: function calls before the message
 *  (`messageAfter` of them), the message, the remaining function calls. */
function responsesOutputItems(rec: ResponseRecord): Record<string, unknown>[] {
  const calls = rec.toolCalls ?? [];
  const items = calls.map((call, i) => responsesFunctionCallItem(rec, call, i));
  if (!responsesHasMessageItem(rec)) return items;
  const at = Math.min(rec.messageAfter ?? 0, items.length);
  items.splice(at, 0, responsesMessageItem(rec, rec.content));
  return items;
}

function formatResponseRecord(rec: ResponseRecord): Record<string, unknown> {
  return {
    id: rec.id,
    object: "response",
    created_at: Math.floor(rec.createdAt / 1000),
    model: rec.model,
    status: rec.status,
    output: responsesOutputItems(rec),
    output_text: rec.content,
    previous_response_id: rec.previousResponseId ?? null,
    ...responsesUsage(rec.usage),
  };
}

/** One chat-completions `delta.tool_calls[]` fragment (OpenAI streaming shape). */
interface ToolCallDeltaFragment {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Incremental Responses-API SSE writer. Feed it text deltas and tool-call
 * fragments as they arrive; it emits the standard event sequence with a
 * running `sequence_number`:
 *
 *   response.created → response.in_progress
 *   → (first text) response.output_item.added [message] → response.content_part.added
 *     → response.output_text.delta …
 *   → (each function call) response.output_item.added [function_call]
 *     → response.function_call_arguments.delta …
 *   → finish: response.output_text.done → response.content_part.done → response.output_item.done
 *     and response.function_call_arguments.done → response.output_item.done per call
 *     (in output order) → response.completed
 *
 * `finish` returns the `ResponseRecord` the caller stores; the `response`
 * payload of `response.completed` is exactly `formatResponseRecord(record)`,
 * so a streaming client and a non-streaming client see the same final body.
 */
class ResponsesSseEmitter {
  private seq = 0;
  private readonly enc = new TextEncoder();
  private sink: (frame: Uint8Array) => void = () => {};
  private text = "";
  private messageOpen = false;
  private messageIndex = -1;
  private readonly calls: (ResponsesFunctionCall & { outputIndex: number })[] = [];
  private readonly callPositions = new Map<number, number>();
  private nextOutputIndex = 0;
  private done = false;

  constructor(
    private readonly base: Pick<
      ResponseRecord,
      "id" | "conversationId" | "model" | "createdAt" | "previousResponseId" | "owner"
    >,
  ) {}

  /** Where frames go — the stream controller, once it exists. */
  bind(sink: (frame: Uint8Array) => void): void {
    this.sink = sink;
  }

  get responseId(): string {
    return this.base.id;
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const payload = { type, sequence_number: this.seq++, ...data };
    this.sink(this.enc.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
  }

  private skeleton(): ResponseRecord {
    return { ...this.base, content: "", status: "completed" };
  }

  start(): void {
    const inProgress = {
      ...formatResponseRecord(this.skeleton()),
      status: "in_progress",
      output: [],
      output_text: "",
    };
    this.emit("response.created", { response: inProgress });
    this.emit("response.in_progress", { response: inProgress });
  }

  private openMessage(): void {
    if (this.messageOpen) return;
    this.messageOpen = true;
    this.messageIndex = this.nextOutputIndex++;
    const itemId = responsesMessageItemId(this.base);
    this.emit("response.output_item.added", {
      output_index: this.messageIndex,
      item: responsesMessageItem(this.base, "", "in_progress"),
    });
    this.emit("response.content_part.added", {
      output_index: this.messageIndex,
      item_id: itemId,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  }

  textDelta(delta: string): void {
    if (this.done || !delta) return;
    this.openMessage();
    this.text += delta;
    this.emit("response.output_text.delta", {
      output_index: this.messageIndex,
      item_id: responsesMessageItemId(this.base),
      content_index: 0,
      delta,
    });
  }

  toolCallDelta(fragment: ToolCallDeltaFragment): void {
    if (this.done) return;
    const upstreamIndex = fragment.index ?? this.calls.length;
    let position = this.callPositions.get(upstreamIndex);
    if (position === undefined) {
      position = this.calls.length;
      this.callPositions.set(upstreamIndex, position);
      const call = {
        callId: fragment.id ?? `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        name: fragment.function?.name ?? "",
        arguments: "",
        outputIndex: this.nextOutputIndex++,
      };
      this.calls.push(call);
      this.emit("response.output_item.added", {
        output_index: call.outputIndex,
        item: responsesFunctionCallItem(this.base, call, position, "in_progress"),
      });
    }
    const call = this.calls[position]!;
    if (!call.name && fragment.function?.name) call.name = fragment.function.name;
    const args = fragment.function?.arguments;
    if (typeof args === "string" && args.length > 0) {
      call.arguments += args;
      this.emit("response.function_call_arguments.delta", {
        output_index: call.outputIndex,
        item_id: responsesFunctionCallItemId(this.base, position),
        delta: args,
      });
    }
  }

  /** Close every open item (in output order) and emit `response.completed`. */
  finish(usage?: CompletionUsage): ResponseRecord {
    if (this.done) return this.skeleton();
    this.done = true;
    // An empty answer still renders one (empty) message item, like the
    // non-streaming body does.
    if (!this.messageOpen && this.calls.length === 0) this.openMessage();
    const rec: ResponseRecord = {
      ...this.base,
      content: this.text,
      createdAt: this.base.createdAt,
      status: "completed",
      ...(usage ? { usage } : {}),
      ...(this.calls.length > 0
        ? {
            toolCalls: this.calls.map(({ callId, name, arguments: args }) => ({
              callId,
              name,
              arguments: args,
            })),
            messageAfter: this.messageOpen
              ? this.calls.filter((c) => c.outputIndex < this.messageIndex).length
              : undefined,
          }
        : {}),
    };
    const closers: { outputIndex: number; run: () => void }[] = [];
    if (this.messageOpen) {
      const itemId = responsesMessageItemId(rec);
      closers.push({
        outputIndex: this.messageIndex,
        run: () => {
          this.emit("response.output_text.done", {
            output_index: this.messageIndex,
            item_id: itemId,
            content_index: 0,
            text: this.text,
          });
          this.emit("response.content_part.done", {
            output_index: this.messageIndex,
            item_id: itemId,
            content_index: 0,
            part: { type: "output_text", text: this.text, annotations: [] },
          });
          this.emit("response.output_item.done", {
            output_index: this.messageIndex,
            item: responsesMessageItem(rec, this.text),
          });
        },
      });
    }
    this.calls.forEach((call, position) => {
      closers.push({
        outputIndex: call.outputIndex,
        run: () => {
          this.emit("response.function_call_arguments.done", {
            output_index: call.outputIndex,
            item_id: responsesFunctionCallItemId(rec, position),
            arguments: call.arguments,
          });
          this.emit("response.output_item.done", {
            output_index: call.outputIndex,
            item: responsesFunctionCallItem(rec, call, position),
          });
        },
      });
    });
    closers.sort((a, b) => a.outputIndex - b.outputIndex);
    for (const closer of closers) closer.run();
    this.emit("response.completed", { response: formatResponseRecord(rec) });
    return rec;
  }

  /** Terminal failure mid-stream: `response.failed` with the partial output. */
  fail(message: string, code = "upstream_error"): void {
    if (this.done) return;
    this.done = true;
    const rec: ResponseRecord = { ...this.base, content: this.text, status: "failed" };
    this.emit("response.failed", {
      response: { ...formatResponseRecord(rec), error: { code, message } },
    });
  }
}

/**
 * Responses-API SSE for a record that already exists in full (the answer was
 * produced in one piece): the same event sequence as the incremental path,
 * with one text delta. Clients that only understand streaming Responses get a
 * well-formed stream instead of a 400.
 */
function responsesSseStream(rec: ResponseRecord, extraHeaders: Record<string, string>): Response {
  const emitter = new ResponsesSseEmitter(rec);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      emitter.bind((frame) => controller.enqueue(frame));
      emitter.start();
      let position = 0;
      const before = Math.min(rec.messageAfter ?? 0, rec.toolCalls?.length ?? 0);
      const calls = rec.toolCalls ?? [];
      const feedCall = (call: ResponsesFunctionCall, index: number) =>
        emitter.toolCallDelta({
          index,
          id: call.callId,
          function: { name: call.name, arguments: call.arguments },
        });
      for (; position < before; position++) feedCall(calls[position]!, position);
      if (responsesHasMessageItem(rec)) emitter.textDelta(rec.content);
      for (; position < calls.length; position++) feedCall(calls[position]!, position);
      emitter.finish(rec.usage);
      safeClose(controller);
    },
  });
  return new Response(stream, { headers: { ...SSE_HEADERS, ...extraHeaders } });
}

/**
 * Walk an OpenAI chat-completions SSE body, calling `onData` with every parsed
 * `data:` JSON object (the `[DONE]` sentinel ends the walk). Resolves when the
 * upstream closes. Comment/heartbeat lines and malformed frames are skipped.
 */
async function forEachSseData(
  body: ReadableStream<Uint8Array>,
  onData: (chunk: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return true;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object") onData(parsed as Record<string, unknown>);
    } catch {
      // Malformed frame — skip it.
    }
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (handle(line)) return;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) handle(buf);
  } finally {
    reader.releaseLock();
  }
}

/** Usage block of a streamed chat-completions chunk (providers send it last). */
function usageFromChunk(chunk: Record<string, unknown>): CompletionUsage | undefined {
  const u = chunk.usage as
    | {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
      }
    | null
    | undefined;
  if (!u || typeof u !== "object") return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  if (prompt === undefined && completion === undefined) return undefined;
  const cached = num(u.prompt_tokens_details?.cached_tokens);
  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: num(u.total_tokens) ?? (prompt ?? 0) + (completion ?? 0),
    ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

/**
 * Stream an upstream chat-completions SSE reply as incremental Responses SSE.
 * `delta.content` → `response.output_text.delta`; `delta.tool_calls` →
 * `function_call` items with `response.function_call_arguments.delta`; the
 * trailing `usage` chunk lands on the record. `onComplete` receives the stored
 * record once `response.completed` has been written; an upstream transport
 * error mid-stream ends with `response.failed` and no record.
 */
function responsesPassthruStream(
  upstream: ReadableStream<Uint8Array>,
  emitter: ResponsesSseEmitter,
  onComplete: (rec: ResponseRecord) => void,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      emitter.bind((frame) => {
        if (!cancelled) controller.enqueue(frame);
      });
      emitter.start();
      let usage: CompletionUsage | undefined;
      try {
        await forEachSseData(upstream, (chunk) => {
          usage = usageFromChunk(chunk) ?? usage;
          const choice = (chunk.choices as { delta?: Record<string, unknown> }[] | undefined)?.[0];
          const delta = choice?.delta ?? {};
          if (typeof delta.content === "string") emitter.textDelta(delta.content);
          const calls = delta.tool_calls;
          if (Array.isArray(calls)) {
            for (const fragment of calls) {
              if (fragment && typeof fragment === "object")
                emitter.toolCallDelta(fragment as ToolCallDeltaFragment);
            }
          }
        });
      } catch (e) {
        if (!cancelled) emitter.fail(`Upstream stream failed: ${getErrorMessage(e)}`);
        safeClose(controller);
        return;
      }
      if (cancelled) return;
      onComplete(emitter.finish(usage));
      safeClose(controller);
    },
    cancel(reason) {
      cancelled = true;
      upstream.cancel(reason).catch(() => {});
    },
  });
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

async function handleResponsesCreate(
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
    };

    const model = body.model ?? "marina";
    const userInput = extractInputText(body.input);
    if (!userInput) return errorJson(400, "`input` is required", { param: "input" });
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
    if (ec.mode === "passthru") {
      return await runResponsesPassthru(engine, req, auth, {
        model,
        body,
        userInput,
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
 * Text-only by design — Responses tool schemas are not translated here.
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
  const turns: OpenAIMessage[] = [...history, { role: "user", content: input.userInput }];
  const prep = await preparePassthru(engine, req, auth, turns, "responses");
  const native: Record<string, unknown> = { instructions: input.body.instructions };
  applyInjection(native, prep.addendum, "responses");
  const instructions = typeof native.instructions === "string" ? native.instructions : "";
  // Streaming asks the upstream for chat-completions SSE and re-encodes it
  // incrementally as Responses SSE (see `responsesPassthruStream`); the
  // response cache is bypassed for streams by construction.
  const wantStream = input.wantStream === true;
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
  };

  const cached = await passthruCacheLookup(engine, prep, body, ec.passthruModel);
  const resp =
    cached ??
    (await proxyToUpstream(
      engine,
      body,
      ec.passthruModel || undefined,
      passthruTraceOptions(prep),
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

/**
 * Parameters an in-world agent route cannot honor. Agents answer in text over
 * a channel: a tool schema, multiple choices or a structured output format
 * would be silently ignored, so the request is refused with a structured
 * `unsupported_parameter` error the SDK can act on (drop tools, retry).
 */
function rejectUnsupportedForAgents(body: Record<string, unknown>): Response | undefined {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return unsupportedParam(
      "tools",
      "In-world agent routing answers in text and cannot execute tool schemas; use the passthru endpoint mode for tool calling.",
    );
  }
  if (Array.isArray(body.functions) && body.functions.length > 0) {
    return unsupportedParam("functions", "In-world agent routing cannot execute function schemas.");
  }
  if (typeof body.n === "number" && body.n > 1) {
    return unsupportedParam("n", "In-world agent routing returns one completion per request.");
  }
  const format = body.response_format ?? body.text;
  if (format && typeof format === "object") {
    const type = (format as { type?: unknown; format?: { type?: unknown } }).type;
    const nested = (format as { format?: { type?: unknown } }).format?.type;
    const effective = type ?? nested;
    if (effective !== undefined && effective !== "text") {
      return unsupportedParam(
        body.response_format ? "response_format" : "text.format",
        "In-world agent routing cannot constrain the output format.",
      );
    }
  }
  return undefined;
}

function handleResponsesGet(id: string, auth: PassthruAuthResult | undefined): Response {
  trimResponseIndex();
  const rec = responseIndex.get(id);
  // Owner-scoped: a non-owner cannot read (or confirm the existence of) another
  // caller's response — not-found and not-owned both return 404.
  if (!rec || rec.owner !== responseOwnerKey(auth)) {
    return errorJson(404, `Response not found: ${id}`);
  }
  return json(formatResponseRecord(rec));
}

function handleResponsesDelete(
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

// --- Conversation channel cleanup (called from engine tick) ---

export function cleanupStaleConversationChannels(cm: ChannelManager): number {
  const channels = cm.getAllChannels();
  let cleaned = 0;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const ch of channels) {
    if (!ch.name.startsWith("model-conv-")) continue;
    const history = cm.getHistory(ch.id, 1);
    if (history.length === 0 || history[history.length - 1]!.createdAt < cutoff) {
      cm.deleteChannel(ch.id);
      cleaned++;
    }
  }
  return cleaned;
}

// --- Route handler ---

function extractConversationId(
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

export async function handleModelApi(
  url: URL,
  method: string,
  req: Request,
  engine: Engine,
  rateLimiter?: RateLimiter,
  server?: PeerAddr,
): Promise<Response | undefined> {
  // Authenticate (skipped for CORS preflight). Fails closed by default — see
  // `authenticate`. The resolved outcome is threaded to passthru handlers so
  // they can map the caller to a Marina entity (identity + context injection).
  let authResult: PassthruAuthResult | undefined;
  if (method !== "OPTIONS") {
    const outcome = authenticate(req);
    if ("error" in outcome) return outcome.error;
    authResult = outcome.auth;
  }

  // Per-IP rate limiting. Covers POST (mutation) plus the enumerable Responses
  // state surface (GET/DELETE /v1/responses/:id) so a caller can't brute-force
  // response ids or hammer delete unthrottled. Static reads (models/health)
  // stay unlimited.
  const isResponsesStateOp =
    url.pathname.startsWith("/v1/responses/") && (method === "GET" || method === "DELETE");
  if (rateLimiter && (method === "POST" || isResponsesStateOp)) {
    const ip = extractIp(req, server);
    if (!rateLimiter.consume(`model:${ip}`)) {
      return errorJson(429, "Rate limited. Please slow down.");
    }
  }

  if (url.pathname.startsWith("/v1/media")) {
    return await handleMediaApi(url, method, req, engine, server);
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
    let body: { model?: unknown; name?: unknown };
    try {
      body = (await req.json()) as { model?: unknown; name?: unknown };
    } catch {
      return errorJson(400, "Invalid JSON body");
    }
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

/** Paths a compat client may probe that Marina answers with an explicit 404. */
const UNSERVED_MODEL_PATHS = new Set([
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

function newRequestId(): string {
  return `req-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Everything the four proxy surfaces share before they touch their protocol:
 * the resolved identity, the injected addendum (built once from the unified
 * memory surface for the caller's query), the finalized receipt and the
 * pre-minted request id that ties header, trace and cache together.
 */
interface PassthruPrep {
  identity?: PassthruIdentity;
  addendum: string | null;
  receipt?: MemoryReceipt;
  requestId: string;
  /** Protocol surface the request arrived on; rides every lifecycle event so
   *  receipts and trace spans can be grouped per surface. */
  surface: InjectionFormat;
}

async function preparePassthru(
  engine: Engine,
  req: Request,
  authResult: PassthruAuthResult | undefined,
  messages: OpenAIMessage[],
  surface: InjectionFormat,
): Promise<PassthruPrep> {
  const requestId = newRequestId();
  const identity = maybePassthruIdentity(engine, req, authResult);
  if (!identity?.contextOptIn) return { identity, addendum: null, requestId, surface };
  const built = await buildInjectedContext(engine, identity.entityId, messages);
  return {
    identity,
    addendum: built.systemAddendum,
    receipt: built.receipt ? finalizeMemoryReceipt(built.receipt, requestId) : undefined,
    requestId,
    surface,
  };
}

/** The trace options every passthru surface hands `proxyToUpstream`. */
function passthruTraceOptions(prep: PassthruPrep) {
  return {
    routeKind: "passthru" as const,
    entityId: prep.identity?.entityId,
    requestId: prep.requestId,
    memoryReceipt: prep.receipt,
    surface: prep.surface,
  };
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
async function passthruCacheLookup(
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
function passthruCacheStore(
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
async function extractResponseTextAndUsage(
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
    const rawCalls = choice?.message?.tool_calls;
    const toolCalls: ResponsesFunctionCall[] | undefined = Array.isArray(rawCalls)
      ? rawCalls
          .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
          .map((c) => {
            const fn = (c.function ?? {}) as { name?: unknown; arguments?: unknown };
            return {
              callId:
                typeof c.id === "string" && c.id
                  ? c.id
                  : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
              name: typeof fn.name === "string" ? fn.name : "",
              arguments:
                typeof fn.arguments === "string"
                  ? fn.arguments
                  : fn.arguments === undefined
                    ? ""
                    : JSON.stringify(fn.arguments),
            };
          })
      : undefined;
    const u = data?.usage;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const prompt = num(u?.prompt_tokens);
    const completion = num(u?.completion_tokens);
    const usage: CompletionUsage | undefined =
      prompt !== undefined || completion !== undefined
        ? {
            prompt_tokens: prompt ?? 0,
            completion_tokens: completion ?? 0,
            total_tokens: num(u?.total_tokens) ?? (prompt ?? 0) + (completion ?? 0),
            ...(num(u?.prompt_tokens_details?.cached_tokens) !== undefined
              ? {
                  prompt_tokens_details: {
                    cached_tokens: num(u?.prompt_tokens_details?.cached_tokens)!,
                  },
                }
              : {}),
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

async function extractResponseText(resp: Response): Promise<string> {
  return (await extractResponseTextAndUsage(resp)).content;
}

/**
 * Fire-and-forget capture of a passthru exchange into the caller's OWN memory so
 * future injections see it. Clones the response synchronously (before the caller
 * consumes it), then extracts and records off the hot path.
 */
async function capturePassthruResponse(
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

async function handleOpenaiChat(
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
async function runOpenaiChat(
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
    if (ec.mode === "passthru") {
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
        anthropicNative ? { anthropicNative } : undefined,
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
      if (wantStream && ec.mode === "agents") {
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
      if (ec.mode === "open") {
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
  };

  const cached = await passthruCacheLookup(engine, prep, body, ec.passthruModel);
  const resp =
    cached ??
    (await proxyToUpstream(
      engine,
      body,
      ec.passthruModel || undefined,
      passthruTraceOptions(prep),
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

async function handleOllamaChat(
  req: Request,
  engine: Engine,
  authResult?: PassthruAuthResult,
): Promise<Response> {
  try {
    const body = await req.json();
    const model = body.model ?? "marina";
    const messages = body.messages ?? [];

    const userMsg = [...messages].reverse().find((m: { role: string }) => m.role === "user");
    if (!userMsg) return errorJson(400, "No user message found");

    if (getEndpointConfig(engine.db).mode === "passthru") {
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

async function handleOllamaGenerate(
  req: Request,
  engine: Engine,
  authResult?: PassthruAuthResult,
): Promise<Response> {
  try {
    const body = await req.json();
    const model = body.model ?? "marina";
    const prompt = body.prompt;
    if (!prompt) return errorJson(400, "No prompt provided");

    if (getEndpointConfig(engine.db).mode === "passthru") {
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

// --- Direct upstream proxy (fallback when no model agents are online) ---

/**
 * Built-in defaults for the direct-upstream proxy fallback (used when no
 * model agent is online on the requested channel). These are intentionally
 * conservative — production-deployed model IDs that have been curl-confirmed
 * against each provider's live API. Override per-provider with
 * `MARINA_DEFAULT_<PROVIDER>_MODEL` (see `.env.example`).
 */
const BUILTIN_DEFAULT_MODELS: Record<string, string> = {
  ANTHROPIC_API_KEY: "claude-sonnet-4-5-20250929",
  OPENAI_API_KEY: "gpt-5.6-luna",
  GEMINI_API_KEY: "gemini-2.0-flash",
  OPENROUTER_API_KEY: "openai/gpt-5.6-luna",
  GROQ_API_KEY: "llama-3.3-70b-versatile",
  LLAMA_API_KEY: LOCAL_PROVIDERS.llama!.defaultModel,
  OLLAMA_API_KEY: LOCAL_PROVIDERS.ollama!.defaultModel,
};

function getDefaultUpstreamModel(envKey: string): string {
  // Per-provider override: e.g. ANTHROPIC_API_KEY → MARINA_DEFAULT_ANTHROPIC_MODEL.
  const providerName = envKey.replace(/_API_KEY$/, "");
  const overrideKey = `MARINA_DEFAULT_${providerName}_MODEL`;
  const override = process.env[overrideKey];
  if (override && override.trim().length > 0) return override.trim();
  return BUILTIN_DEFAULT_MODELS[envKey] ?? "gpt-5.6-luna";
}

function isMarinaModel(model: string): boolean {
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

/** provider → upstream endpoint. `anthropic` uses a non-OpenAI request format. */
const PROVIDER_UPSTREAM: Record<string, { url: string; envKeys: string[]; anthropic?: boolean }> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    envKeys: ["ANTHROPIC_API_KEY"],
    anthropic: true,
  },
  openai: { url: "https://api.openai.com/v1/chat/completions", envKeys: ["OPENAI_API_KEY"] },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", envKeys: ["GROQ_API_KEY"] },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    envKeys: ["OPENROUTER_API_KEY"],
  },
  // Self-hosted local runtimes, OpenAI-compatible (/chat/completions). Base URL
  // defaults to localhost (native install); override with LLAMA_BASE_URL /
  // OLLAMA_BASE_URL (docker-compose sets the in-cluster service name). Keys are
  // optional — see resolveProviderKey / the fallback loop's local handling.
  llama: {
    url: `${localProviderBaseUrl("llama")}/chat/completions`,
    envKeys: ["LLAMA_API_KEY"],
  },
  ollama: {
    url: `${localProviderBaseUrl("ollama")}/chat/completions`,
    envKeys: ["OLLAMA_API_KEY"],
  },
  // VibeThinker served via vLLM/SGLang (OpenAI-compatible). Override the base
  // URL with VIBETHINKER_BASE_URL (compose sets the in-cluster service name).
  vibethinker: {
    url: `${localProviderBaseUrl("vibethinker")}/chat/completions`,
    envKeys: ["VIBETHINKER_API_KEY"],
  },
};

// First-party providers preferred over OpenRouter on the fallback path, since
// OpenRouter is an aggregator that re-routes (and adds markup). An explicitly
// configured default model overrides this order entirely (see proxyToUpstream).
// `llama` is first: when a local model is configured (LLAMA_API_KEY set) it's the
// preferred default; deployments without that key skip it (resolveProviderKey → undefined).
const FALLBACK_PRIORITY = [
  "llama",
  "ollama",
  "anthropic",
  "openai",
  "google",
  "groq",
  "openrouter",
];

/**
 * True if an operator has opted into a self-hosted local runtime by setting
 * either its key or its base URL. Gates the (keyless) fallback attempt so a
 * cloud-only deployment doesn't pay a failed localhost fetch on every request.
 */
function localProviderConfigured(provider: string): boolean {
  const spec = LOCAL_PROVIDERS[provider];
  return !!spec && (!!process.env[spec.keyEnv] || !!process.env[spec.baseUrlEnv]);
}

/** Resolve a provider's key from env first, then admin-panel/DB keys. */
function resolveProviderKey(engine: Engine, provider: string): string | undefined {
  const cfg = PROVIDER_UPSTREAM[provider];
  if (cfg) {
    for (const envKey of cfg.envKeys) {
      const v = process.env[envKey];
      if (v) return v;
    }
  }
  return engine.db?.getApiKeysByProvider(provider)[0]?.encrypted_value;
}

/**
 * Human-readable "what would the marina/default channel actually hit right now"
 * — mirrors proxyToUpstream's selection order without making a request. Used by
 * the boot wiring summary so it reports the concrete upstream (e.g.
 * "openai/gpt-4o") instead of the circular "marina/default". Returns undefined
 * when no upstream is configured at all.
 */
export function describeDefaultUpstream(engine: Engine): string | undefined {
  // 1) Operator-configured concrete default with a usable key wins.
  const dm = engine.db?.getDefaultModel();
  if (dm && !isMarinaModel(dm)) {
    const slash = dm.indexOf("/");
    const provider = slash >= 0 ? dm.slice(0, slash) : dm;
    const cfg = PROVIDER_UPSTREAM[provider];
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (cfg && (resolveProviderKey(engine, provider) || localReady)) return dm;
  }
  // 2) Otherwise the first-party-preferred fallback order over available keys.
  for (const provider of FALLBACK_PRIORITY) {
    const cfg = PROVIDER_UPSTREAM[provider]!;
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (!resolveProviderKey(engine, provider) && !localReady) continue;
    return `${provider}/${getDefaultUpstreamModel(cfg.envKeys[0]!)}`;
  }
  return undefined;
}

// ─── Provider conformance probe ─────────────────────────────────────────────

export interface ProviderProbeResult {
  provider: string;
  model: string;
  ok: boolean;
  /** HTTP status Marina's proxy produced (null on a transport failure/timeout). */
  status: number | null;
  latencyMs: number;
  /** Non-empty assistant text came back (catches dropped content blocks). */
  textOk: boolean;
  /** The SECOND system message was honored (catches dropped system messages). */
  systemHonored: boolean;
  text: string;
  /** `provider/model` that actually answered, from the routed lifecycle event. */
  servedBy?: string;
  /**
   * Tool-call probe (Anthropic / OpenAI providers): a one-tool request came
   * back as a structured `tool_calls` entry naming the tool with the nonce in
   * its arguments. `undefined` when the provider was not tool-probed. Catches
   * the silent-drop class of bug (tools stripped in translation).
   */
  toolCallOk?: boolean;
  /** Tool-probe failure detail (HTTP status / shape), when `toolCallOk` is false. */
  toolCallError?: string;
  error?: string;
  checkedAt: number;
}

export const PROVIDER_PROBE_MAX_TOKENS = 32;
export const PROVIDER_TOOL_PROBE_MAX_TOKENS = 128;
export const PROVIDER_TOOL_PROBE_NAME = "report_check_word";
/** Providers whose passthru path translates tool schemas and is therefore tool-probed. */
export const TOOL_PROBED_PROVIDERS: readonly string[] = ["anthropic", "openai"];

/**
 * The tool-call probe: one tiny tool and an instruction to call it with the
 * nonce. `tool_choice` stays `auto` on purpose — the Claude Fable 5.1 family
 * rejects forced tool choice with a 400 — so the model must decide to call;
 * the system prompt makes that unambiguous. Passes only if a structured
 * `tool_calls` entry names the tool and its JSON arguments carry the nonce.
 */
export function buildProviderToolProbeBody(nonce: string): Record<string, unknown> {
  return {
    model: "marina",
    max_tokens: PROVIDER_TOOL_PROBE_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content: `You are a conformance probe for an API gateway. You MUST call the ${PROVIDER_TOOL_PROBE_NAME} tool exactly once with word="${nonce}". Do not answer in text.`,
      },
      { role: "user", content: `Report the check word "${nonce}" using the tool.` },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: PROVIDER_TOOL_PROBE_NAME,
          description: "Report the check word to the gateway.",
          parameters: {
            type: "object",
            properties: { word: { type: "string", description: "The check word." } },
            required: ["word"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: "auto",
  };
}

export function evaluateProviderToolProbe(
  data: unknown,
  nonce: string,
): { ok: boolean; error?: string } {
  const choice = (
    data as {
      choices?: {
        finish_reason?: unknown;
        message?: { tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[] };
      }[];
    }
  )?.choices?.[0];
  const calls = choice?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    return { ok: false, error: "no structured tool_calls in the reply (tools dropped?)" };
  }
  const call = calls.find((c) => c.function?.name === PROVIDER_TOOL_PROBE_NAME);
  if (!call) return { ok: false, error: `tool_calls did not name ${PROVIDER_TOOL_PROBE_NAME}` };
  const rawArgs = call.function?.arguments;
  let word: unknown;
  try {
    word =
      typeof rawArgs === "string"
        ? (JSON.parse(rawArgs) as { word?: unknown }).word
        : (rawArgs as { word?: unknown } | undefined)?.word;
  } catch {
    return { ok: false, error: "tool_calls arguments were not JSON" };
  }
  if (typeof word !== "string" || !word.includes(nonce)) {
    return { ok: false, error: "tool_calls arguments did not carry the check word" };
  }
  if (choice?.finish_reason !== undefined && choice.finish_reason !== "tool_calls") {
    return {
      ok: false,
      error: `finish_reason was ${String(choice.finish_reason)}, not tool_calls`,
    };
  }
  return { ok: true };
}

/** The `provider/model` the proxy routed `requestId` to, from the newest routed lifecycle event. */
function routedTargetFor(engine: Engine, requestId: string): string | undefined {
  const events = engine.getEventLog();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (
      event.type === "model_request_lifecycle" &&
      event.requestId === requestId &&
      event.phase === "routed" &&
      event.target
    )
      return event.target;
  }
  return undefined;
}

/**
 * The probe request: two system messages and a one-word answer. A provider
 * passes only if the reply is non-empty AND contains the check word that lives
 * in the SECOND system message — exactly the two ways Claude 5 passthru failed
 * silently in 2026-09 (thinking block read as the answer; only the first
 * system message forwarded). Memory injection rides a second system message,
 * so this is the contract every upstream must meet.
 */
export function buildProviderProbeBody(nonce: string): Record<string, unknown> {
  return {
    model: "marina",
    max_tokens: PROVIDER_PROBE_MAX_TOKENS,
    messages: [
      {
        role: "system",
        content:
          "You are a conformance probe for an API gateway. Follow the second system message exactly.",
      },
      { role: "system", content: `The check word is "${nonce}". Reply with the check word only.` },
      { role: "user", content: "What is the check word?" },
    ],
  };
}

export function evaluateProviderProbe(
  text: string,
  nonce: string,
): { textOk: boolean; systemHonored: boolean } {
  const trimmed = text.trim();
  return { textOk: trimmed.length > 0, systemHonored: trimmed.includes(nonce) };
}

/** Providers that would be used right now: a key (or a configured local runtime) is present. */
export function configuredUpstreamProviders(engine: Engine): { provider: string; model: string }[] {
  const out: { provider: string; model: string }[] = [];
  const dm = engine.db?.getDefaultModel();
  const dmSlash = dm ? dm.indexOf("/") : -1;
  const dmProvider = dm && !isMarinaModel(dm) && dmSlash >= 0 ? dm.slice(0, dmSlash) : undefined;
  for (const provider of FALLBACK_PRIORITY) {
    const cfg = PROVIDER_UPSTREAM[provider];
    if (!cfg) continue;
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (!resolveProviderKey(engine, provider) && !localReady) continue;
    // Probe the model marina/default would actually hit for this provider.
    const model =
      dmProvider === provider ? dm!.slice(dmSlash + 1) : getDefaultUpstreamModel(cfg.envKeys[0]!);
    out.push({ provider, model });
  }
  return out;
}

let lastProviderProbe: ProviderProbeResult[] | null = null;
export function getLastProviderProbe(): ProviderProbeResult[] | null {
  return lastProviderProbe;
}

/**
 * Send one tiny request per configured provider through the SAME proxy path
 * passthru clients use and check the reply shape. Costs a few tokens per
 * provider; run it on demand (`readiness providers`), never on a hot path.
 */
export async function probeConfiguredProviders(
  engine: Engine,
  opts: { providers?: string[]; timeoutMs?: number } = {},
): Promise<ProviderProbeResult[]> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const targets = configuredUpstreamProviders(engine).filter(
    (t) => !opts.providers || opts.providers.includes(t.provider),
  );
  const results: ProviderProbeResult[] = [];
  for (const target of targets) {
    const nonce = `probe-${crypto.randomUUID().slice(0, 8)}`;
    const started = Date.now();
    let result: ProviderProbeResult = {
      ...target,
      ok: false,
      status: null,
      latencyMs: 0,
      textOk: false,
      systemHonored: false,
      text: "",
      checkedAt: started,
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Trace the request so the ROUTED target is observable: proxyToUpstream
      // falls back to the next configured provider when the forced one fails
      // (e.g. an expired key), and a fallback-served reply must not pass the
      // probe for the provider that actually failed.
      const requestId = `probe-${nonce}`;
      const response = await Promise.race([
        proxyToUpstream(
          engine,
          buildProviderProbeBody(nonce),
          `${target.provider}/${target.model}`,
          { routeKind: "passthru", requestId },
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      const servedBy = routedTargetFor(engine, requestId);
      const raw = await response.text();
      let text = "";
      let error: string | undefined;
      try {
        const data = JSON.parse(raw) as {
          choices?: { message?: { content?: unknown } }[];
          error?: { message?: string };
        };
        const content = data.choices?.[0]?.message?.content;
        text = typeof content === "string" ? content : "";
        if (!response.ok) error = data.error?.message ?? raw.slice(0, 200);
      } catch {
        error = raw.slice(0, 200);
      }
      const verdict = evaluateProviderProbe(text, nonce);
      const expected = `${target.provider}/${target.model}`;
      const misrouted = servedBy !== undefined && servedBy !== expected;
      if (misrouted && !error)
        error = `served by fallback ${servedBy} — ${target.provider} itself failed (see server log)`;
      result = {
        ...result,
        status: response.status,
        latencyMs: Date.now() - started,
        text: text.slice(0, 200),
        ...verdict,
        ...(servedBy ? { servedBy } : {}),
        ok: response.ok && verdict.textOk && verdict.systemHonored && !misrouted,
        ...(error ? { error } : {}),
      };
      // Tool-call probe — only where the proxy translates tool schemas, and
      // only once the text probe passed (a dead key would fail both for the
      // same reason and the first error is the useful one).
      if (result.ok && TOOL_PROBED_PROVIDERS.includes(target.provider)) {
        const toolNonce = `tool-${crypto.randomUUID().slice(0, 8)}`;
        const toolRequestId = `probe-${toolNonce}`;
        let toolTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const toolResponse = await Promise.race([
            proxyToUpstream(
              engine,
              buildProviderToolProbeBody(toolNonce),
              `${target.provider}/${target.model}`,
              { routeKind: "passthru", requestId: toolRequestId },
            ),
            new Promise<never>((_, reject) => {
              toolTimeout = setTimeout(
                () => reject(new Error(`timeout after ${timeoutMs} ms`)),
                timeoutMs,
              );
            }),
          ]);
          const toolRaw = await toolResponse.text();
          let toolVerdict: { ok: boolean; error?: string };
          if (!toolResponse.ok) {
            let reason = toolRaw.slice(0, 200);
            try {
              reason =
                (JSON.parse(toolRaw) as { error?: { message?: string } }).error?.message ?? reason;
            } catch {
              // keep the raw slice
            }
            toolVerdict = { ok: false, error: `HTTP ${toolResponse.status}: ${reason}` };
          } else {
            try {
              toolVerdict = evaluateProviderToolProbe(JSON.parse(toolRaw), toolNonce);
            } catch {
              toolVerdict = { ok: false, error: "tool probe reply was not JSON" };
            }
          }
          const toolServedBy = routedTargetFor(engine, toolRequestId);
          if (
            toolVerdict.ok &&
            toolServedBy &&
            toolServedBy !== `${target.provider}/${target.model}`
          )
            toolVerdict = { ok: false, error: `tool probe served by fallback ${toolServedBy}` };
          result = {
            ...result,
            latencyMs: Date.now() - started,
            toolCallOk: toolVerdict.ok,
            ...(toolVerdict.error ? { toolCallError: toolVerdict.error } : {}),
            ok: result.ok && toolVerdict.ok,
            ...(toolVerdict.ok ? {} : { error: `tool call dropped — ${toolVerdict.error}` }),
          };
        } catch (e) {
          result = {
            ...result,
            latencyMs: Date.now() - started,
            toolCallOk: false,
            toolCallError: getErrorMessage(e),
            ok: false,
            error: `tool probe failed — ${getErrorMessage(e)}`,
          };
        } finally {
          clearTimeout(toolTimeout);
        }
      }
    } catch (e) {
      result = { ...result, latencyMs: Date.now() - started, error: getErrorMessage(e) };
    } finally {
      clearTimeout(timeout);
    }
    results.push(result);
  }
  lastProviderProbe = results;
  return results;
}

const SSE_HEADERS = {
  ...MODEL_CORS,
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

/**
 * POST to an OpenAI-compatible upstream and normalize textual tool calls.
 *
 * Marina serves ANY model, so this runs on every openai-completions upstream
 * (cloud or self-hosted) and is passthrough-by-default: structured `tool_calls`
 * and ordinary content stream through verbatim; only literal `<tool_call>`
 * blocks in content are rewritten into structured calls, with a streaming parser
 * that holds back at most a tag's width so surrounding prose still streams
 * token-by-token. Returns null on network error / non-OK so the caller can try
 * the next provider.
 */
async function dispatchOpenAICompatible(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  wantStream: boolean,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response | null; errorStatus?: number; networkError?: boolean }> {
  try {
    // Omit the Authorization header entirely when keyless (local servers) — an
    // empty `Bearer ` confuses some OpenAI-compatible implementations.
    const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      let detail = "";
      try {
        const payload = (await resp.clone().json()) as {
          error?: { message?: string } | string;
          message?: string;
        };
        const message =
          typeof payload.error === "string"
            ? payload.error
            : (payload.error?.message ?? payload.message ?? "");
        detail = message ? `: ${message.slice(0, 300)}` : "";
      } catch {
        // Status and provider host are still enough to distinguish routing failures.
      }
      console.warn(
        `[model-api] upstream ${new URL(url).host} returned HTTP ${resp.status}${detail}`,
      );
      return { response: null, errorStatus: resp.status };
    }
    const model = String((body.model as string) ?? "marina");
    if (wantStream) {
      if (!resp.body) return { response: null, networkError: true };
      return {
        response: new Response(normalizeToolCallSSE(resp.body, model), { headers: SSE_HEADERS }),
      };
    }
    const data = await resp.json();
    normalizeTextualToolCalls(data);
    return {
      response: new Response(JSON.stringify(data), {
        headers: { ...MODEL_CORS, "Content-Type": "application/json" },
      }),
    };
  } catch (error) {
    console.warn(
      `[model-api] upstream request failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return { response: null, networkError: true };
  }
}

/**
 * Stream-transform an upstream OpenAI SSE response, repairing textual tool calls
 * inline. Content streams through (≤ one tag's width of holdback); structured
 * `tool_calls` and other deltas pass through verbatim; a single authoritative
 * finish chunk is emitted at the end (`tool_calls` when any textual call was
 * converted). pi-ai's accumulator reads `delta.tool_calls` by index.
 */
export function normalizeToolCallSSE(
  upstream: ReadableStream<Uint8Array>,
  fallbackModel: string,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parser = new ToolCallStreamParser();
  const created = Math.floor(Date.now() / 1000);
  let sseBuf = "";
  let id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  let model = fallbackModel;
  let toolIndex = 0;
  let roleSent = false;
  let pendingFinish: string | null = null;
  let finishEmitted = false;
  let emittedFrames = 0;
  let cancelled = false;

  const send = (c: ReadableStreamDefaultController<Uint8Array>, frame: string) => {
    emittedFrames++;
    c.enqueue(encoder.encode(frame));
  };
  const chunk = (delta: unknown, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

  const flushEvents = (c: ReadableStreamDefaultController<Uint8Array>, events: StreamEvent[]) => {
    for (const ev of events) {
      if (!roleSent) {
        send(c, openaiStreamRoleChunk(id, model));
        roleSent = true;
      }
      if (ev.type === "content") {
        send(c, openaiStreamChunk(id, model, ev.text));
      } else {
        send(c, chunk({ tool_calls: [{ index: toolIndex++, ...ev.call }] }));
      }
    }
  };

  const emitFinish = (c: ReadableStreamDefaultController<Uint8Array>) => {
    if (finishEmitted) return;
    flushEvents(c, parser.finish());
    if (!roleSent) {
      send(c, openaiStreamRoleChunk(id, model));
      roleSent = true;
    }
    send(c, chunk({}, parser.sawToolCall ? "tool_calls" : (pendingFinish ?? "stop")));
    send(c, "data: [DONE]\n\n");
    finishEmitted = true;
  };

  const processLine = (line: string, c: ReadableStreamDefaultController<Uint8Array>) => {
    if (finishEmitted) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return emitFinish(c);
    let parsed: {
      id?: string;
      model?: string;
      usage?: unknown;
      choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[];
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed.id === "string") id = parsed.id;
    if (typeof parsed.model === "string") model = parsed.model;
    // Providers may emit usage after the last choice's finish_reason. Preserve
    // it before the authoritative DONE frame so resident accounting sees it.
    if (parsed.usage !== undefined && parsed.usage !== null)
      send(c, `data: ${JSON.stringify({ ...parsed, choices: [] })}\n\n`);
    const choice = parsed.choices?.[0];
    const delta = choice?.delta ?? {};
    if (choice?.finish_reason) pendingFinish = choice.finish_reason;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      flushEvents(c, parser.push(delta.content));
    }
    const toolCalls = delta.tool_calls as unknown[] | undefined;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      // Structured tool calls — flush any held text, then forward verbatim
      // (preserving the upstream's index/id/argument fragments).
      flushEvents(c, parser.finish());
      const fwd: Record<string, unknown> = { tool_calls: toolCalls };
      if (delta.role) fwd.role = delta.role;
      send(c, chunk(fwd));
      roleSent = true;
    } else if (delta.role && delta.content === undefined) {
      send(c, openaiStreamRoleChunk(id, model));
      roleSent = true;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const before = emittedFrames;
        // A network fragment, heartbeat or held tool-call prefix may produce
        // no output. Keep reading until this pull satisfies downstream demand.
        while (!cancelled && emittedFrames === before) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            sseBuf += decoder.decode();
            if (sseBuf.trim()) processLine(sseBuf, controller);
            emitFinish(controller);
            controller.close();
            return;
          }
          sseBuf += decoder.decode(value, { stream: true });
          const parts = sseBuf.split("\n");
          sseBuf = parts.pop() ?? "";
          for (const part of parts) processLine(part, controller);
          if (finishEmitted) {
            controller.close();
            reader.cancel().catch(() => {});
            return;
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      cancelled = true;
      reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Resolve the completion-token budget for the local `llama` upstream: half the
 * server's context window by default (see localOutputBudget). Reads the window
 * from LLAMA_CONTEXT_WINDOW (16384 default), so set that to your server's real
 * size or the budget stays small.
 */
function llamaOutputBudget(): number {
  return localOutputBudget(localProviderContextWindow("llama") ?? 16384);
}

/**
 * Prepare a request body bound for the local `llama` upstream. Two concerns,
 * both aimed at the "agent connects but never acts" failure on reasoning
 * models (Qwen3):
 *   1. Suppress `<think>` blocks at the Jinja template level
 *      (`enable_thinking: false`). Only honored when llama.cpp runs with
 *      `--jinja`, so it's a best-effort hint, not the load-bearing fix.
 *   2. Guarantee a generous completion budget. `marina/default` agents send no
 *      `max_tokens` (the agent layer can't see which upstream the proxy will
 *      pick), so without this the reasoning model spends the server-default
 *      budget on `<think>` and returns no tool call. A larger caller-supplied
 *      value is always preserved.
 * Other providers pass through untouched.
 */
export function prepareLlamaBody(
  body: Record<string, unknown>,
  provider: string,
): Record<string, unknown> {
  if (provider !== "llama") return body;
  const prepared: Record<string, unknown> = {
    ...body,
    chat_template_kwargs: { enable_thinking: false },
  };
  const budget = llamaOutputBudget();
  const current = typeof body.max_tokens === "number" ? body.max_tokens : 0;
  if (current < budget) prepared.max_tokens = budget;
  return prepared;
}

/** Keep a caller's provider-specific completion budget from poisoning a
 * fallback request. For example, Gemini-oriented agents may request 32k output
 * while gpt-4o accepts at most 16,384 and otherwise rejects the whole turn. */
/**
 * Remove Anthropic-only `cache_control` markers before an OpenAI-compatible
 * upstream sees the body. Marina's own agents send them (pi-ai with
 * `cacheControlFormat: "anthropic"` puts one on the system text part, the last
 * tool and the last message part); the Anthropic path maps them onto blocks,
 * but strict OpenAI-style servers (OpenAI, llama.cpp, vLLM, Ollama) reject
 * unknown fields. A system `content` array that is pure text collapses back to
 * a string for the widest compatibility. Never mutates the caller's body.
 */
export function stripCacheControl(body: Record<string, unknown>): Record<string, unknown> {
  let touched = false;
  const stripPart = (part: unknown): unknown => {
    if (!part || typeof part !== "object" || !("cache_control" in (part as object))) return part;
    touched = true;
    const { cache_control: _cc, ...rest } = part as Record<string, unknown>;
    return rest;
  };
  const messages = Array.isArray(body.messages)
    ? body.messages.map((m) => {
        if (!m || typeof m !== "object") return m;
        const msg = m as Record<string, unknown>;
        let next = msg;
        if ("cache_control" in msg) {
          touched = true;
          const { cache_control: _cc, ...rest } = msg;
          next = rest;
        }
        if (Array.isArray(next.content)) {
          const parts = next.content.map(stripPart);
          const allText = parts.every(
            (p) => p && typeof p === "object" && (p as { type?: unknown }).type === "text",
          );
          const collapsible =
            next.role === "system" && allText && parts.length > 0 && parts !== next.content;
          next = {
            ...next,
            content: collapsible
              ? parts.map((p) => String((p as { text?: unknown }).text ?? "")).join("\n")
              : parts,
          };
        }
        return next;
      })
    : body.messages;
  const tools = Array.isArray(body.tools) ? body.tools.map(stripPart) : body.tools;
  if (!touched) return body;
  return {
    ...body,
    ...(messages !== undefined ? { messages } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
}

export function prepareUpstreamBody(
  body: Record<string, unknown>,
  provider: string,
  defaultRoute = false,
): Record<string, unknown> {
  // Anthropic upstreams take the markers through proxyToAnthropic; every
  // OpenAI-compatible provider must not see them.
  let prepared = prepareLlamaBody(
    provider === "anthropic" ? body : stripCacheControl(body),
    provider,
  );
  const luna =
    (provider === "openai" && body.model === "gpt-5.6-luna") ||
    (provider === "openrouter" && body.model === "openai/gpt-5.6-luna");
  // Preserve the former non-reasoning default's latency/cost role. Explicit
  // effort settings and direct model requests retain the caller's choices.
  if (luna && defaultRoute && body.reasoning_effort === undefined && body.reasoning === undefined)
    prepared = { ...prepared, reasoning_effort: "none" };
  if (provider !== "openai") return prepared;
  const bounded = { ...prepared };
  // Luna requires the modern token field. Preserve an explicitly supplied
  // max_completion_tokens and let the provider reject conflicting fields.
  if (luna && bounded.max_tokens !== undefined && bounded.max_completion_tokens === undefined) {
    bounded.max_completion_tokens = bounded.max_tokens;
    delete bounded.max_tokens;
  }
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    const value = bounded[field];
    if (typeof value === "number" && value > 16_384) bounded[field] = 16_384;
  }
  return bounded;
}

async function proxyToUpstream(
  engine: Engine,
  body: Record<string, unknown>,
  forceModel?: string,
  traceOptions?: {
    routeKind: "passthru" | "fallback" | "synthesis";
    /** Resolved passthru identity, tagged onto every lifecycle span. */
    entityId?: EntityId;
    /** Pre-minted request id (passthru surfaces mint it before injection so the
     *  receipt, header and trace agree). Minted here when absent. */
    requestId?: string;
    /** Memory receipt for the injected context — emitted on the received and
     *  terminal lifecycle events and returned as `x-marina-memory-receipt`. */
    memoryReceipt?: MemoryReceipt;
    /** Protocol surface (passthru only) — stamped on every lifecycle event. */
    surface?: InjectionFormat;
  },
  hints?: {
    /** Native Anthropic body to forward verbatim when the upstream is Anthropic. */
    anthropicNative?: Record<string, unknown>;
  },
): Promise<Response> {
  const wantStream = body.stream === true;
  let attemptedUpstream = false;
  let lastTarget: string | undefined;
  let lastErrorKind: ProxyTraceMetrics["errorKind"];
  const requestedModel = typeof body.model === "string" ? body.model : "marina";
  const entityId = traceOptions?.entityId;
  const surface = traceOptions?.surface;
  const memoryReceipt = traceOptions?.memoryReceipt
    ? encodeMemoryReceiptAttribute(traceOptions.memoryReceipt)
    : undefined;
  const startedAt = Date.now();
  const requestId = traceOptions ? (traceOptions.requestId ?? newRequestId()) : undefined;
  // Correlate the upstream call with Marina's traced request id (OpenAI echoes
  // `x-request-id`; `prompt_cache_key` in the body passes through untouched).
  const upstreamHeaders: Record<string, string> = requestId ? { "x-request-id": requestId } : {};
  const anthropic = async (key: string, model: string): Promise<Response> => {
    try {
      return await proxyToAnthropic(body, key, model, wantStream, hints?.anthropicNative);
    } catch (e) {
      // A parameter Anthropic cannot honor is a 400 the CLIENT must see, not
      // a reason to try the next provider (which would honor it differently).
      if (e instanceof UnsupportedParameterError) return json(e.toBody(), 400);
      throw e;
    }
  };
  if (requestId) {
    engine.logEvent({
      type: "model_request_lifecycle",
      phase: "received",
      requestId,
      ...requestTrace(requestId),
      model: requestedModel,
      routeKind: traceOptions!.routeKind,
      ...(entityId ? { entityId } : {}),
      ...(memoryReceipt ? { memoryReceipt } : {}),
      ...(surface ? { surface } : {}),
      timestamp: startedAt,
    });
  }

  const finish = async (
    response: Response,
    target?: string,
    errorKind?: ProxyTraceMetrics["errorKind"],
  ): Promise<Response> => {
    if (!requestId) return response;
    if (target) {
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: "routed",
        requestId,
        ...requestTrace(requestId),
        model: requestedModel,
        target,
        routeKind: traceOptions!.routeKind,
        ...(entityId ? { entityId } : {}),
        ...(surface ? { surface } : {}),
        timestamp: Date.now(),
      });
    }
    return await traceProxyResponse(engine, response, {
      requestId,
      model: requestedModel,
      target,
      routeKind: traceOptions!.routeKind,
      entityId,
      memoryReceipt: traceOptions!.memoryReceipt,
      surface,
      startedAt,
      errorKind,
    });
  };
  // `forceModel` (passthru endpoint mode) pins the upstream model regardless of
  // what the caller requested; otherwise only marina/default models resolve to
  // the configured default.
  const isDefault = !!forceModel || isMarinaModel(body.model as string);

  // 1) Explicit configured default: when marina/default is requested and an
  //    operator has set `default_model`, honor that exact provider — including
  //    OpenRouter — instead of the first-party priority. The key is resolved from
  //    env or the admin panel. Falls through to (2) only if its key is missing.
  if (isDefault && engine.db) {
    const dm = forceModel || engine.db.getDefaultModel();
    const slash = dm.indexOf("/");
    const provider = slash >= 0 ? dm.slice(0, slash) : dm;
    const upstreamModel = slash >= 0 ? dm.slice(slash + 1) : dm;
    const cfg = PROVIDER_UPSTREAM[provider];
    const key = cfg ? resolveProviderKey(engine, provider) : undefined;
    // Local runtimes route keyless when configured (base URL set); cloud
    // providers still require a key.
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (cfg && (key || localReady) && upstreamModel) {
      attemptedUpstream = true;
      lastTarget = `${provider}/${upstreamModel}`;
      if (cfg.anthropic) {
        return finish(await anthropic(key!, upstreamModel), lastTarget);
      }
      const r = await dispatchOpenAICompatible(
        cfg.url,
        key ?? "",
        prepareUpstreamBody({ ...body, model: upstreamModel }, provider, isDefault),
        wantStream,
        upstreamHeaders,
      );
      if (r.response) return finish(r.response, lastTarget);
      lastErrorKind = r.networkError ? "network" : classifyProxyError(r.errorStatus ?? 0);
    }
  }

  // 2) Fallback: first-party-preferred over whatever keys exist (env or DB).
  for (const provider of FALLBACK_PRIORITY) {
    const cfg = PROVIDER_UPSTREAM[provider]!;
    const key = resolveProviderKey(engine, provider);
    // Skip cloud providers with no key, and local runtimes the operator hasn't
    // opted into — otherwise a keyless local server would be probed every call.
    const localReady = isLocalProvider(provider) && localProviderConfigured(provider);
    if (!key && !localReady) continue;
    attemptedUpstream = true;
    const envKey = cfg.envKeys[0]!;
    const requestModel = isDefault ? getDefaultUpstreamModel(envKey) : (body.model as string);
    lastTarget = `${provider}/${requestModel}`;
    if (cfg.anthropic) {
      return finish(await anthropic(key!, requestModel), lastTarget);
    }
    const r = await dispatchOpenAICompatible(
      cfg.url,
      key ?? "",
      prepareUpstreamBody({ ...body, model: requestModel }, provider, isDefault),
      wantStream,
      upstreamHeaders,
    );
    if (r.response) return finish(r.response, lastTarget);
    lastErrorKind = r.networkError ? "network" : classifyProxyError(r.errorStatus ?? 0);
  }

  if (attemptedUpstream) {
    return finish(
      errorJson(
        502,
        "Configured upstream LLM providers were reachable by configuration but rejected or could not complete the request. Check provider status, quota, model access, and server logs.",
      ),
      lastTarget,
      lastErrorKind,
    );
  }

  return finish(
    errorJson(
      503,
      "No upstream LLM providers configured. Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.) or add one in Admin → Keys.",
    ),
  );
}

interface ProxyTraceMetrics {
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  errorKind?: Extract<EngineEvent, { type: "model_request_lifecycle" }>["errorKind"];
}

async function traceProxyResponse(
  engine: Engine,
  response: Response,
  trace: {
    requestId: string;
    model: string;
    target?: string;
    routeKind: "passthru" | "fallback" | "synthesis";
    entityId?: EntityId;
    memoryReceipt?: MemoryReceipt;
    surface?: InjectionFormat;
    startedAt: number;
    errorKind?: ProxyTraceMetrics["errorKind"];
  },
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", trace.requestId);
  // The receipt rides every injected response — including failures, so a
  // client can see what was injected into a request that the upstream refused.
  if (trace.memoryReceipt) {
    headers.set(MEMORY_RECEIPT_HEADER, encodeMemoryReceiptHeader(trace.memoryReceipt));
  }
  const memoryReceipt = trace.memoryReceipt
    ? encodeMemoryReceiptAttribute(trace.memoryReceipt)
    : undefined;
  let terminal = false;
  const finish = (
    phase: "completed" | "failed",
    detail?: string,
    metrics: ProxyTraceMetrics = {},
  ) => {
    if (terminal) return;
    terminal = true;
    engine.logEvent({
      type: "model_request_lifecycle",
      phase,
      requestId: trace.requestId,
      ...requestTrace(trace.requestId),
      model: trace.model,
      target: trace.target,
      routeKind: trace.routeKind,
      ...(trace.entityId ? { entityId: trace.entityId } : {}),
      ...(memoryReceipt ? { memoryReceipt } : {}),
      ...(trace.surface ? { surface: trace.surface } : {}),
      durationMs: Date.now() - trace.startedAt,
      ...metrics,
      ...(detail ? { detail } : {}),
      timestamp: Date.now(),
    });
  };

  if (!response.ok) {
    finish("failed", `upstream response HTTP ${response.status}`, {
      errorKind: trace.errorKind ?? classifyProxyError(response.status),
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    finish("completed", undefined, await extractProxyUsage(response));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const reader = response.body.getReader();
  let firstChunkAt = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish("completed", undefined, {
            ...(firstChunkAt > 0 ? { ttftMs: firstChunkAt - trace.startedAt } : {}),
          });
          controller.close();
        } else {
          if (firstChunkAt === 0) firstChunkAt = Date.now();
          controller.enqueue(value);
        }
      } catch (cause) {
        finish("failed", cause instanceof Error ? cause.message : "upstream stream failed", {
          errorKind: "network",
          ...(firstChunkAt > 0 ? { ttftMs: firstChunkAt - trace.startedAt } : {}),
        });
        controller.error(cause);
      }
    },
    cancel(reason) {
      finish("failed", "response stream cancelled before completion", {
        errorKind: "cancelled",
        ...(firstChunkAt > 0 ? { ttftMs: firstChunkAt - trace.startedAt } : {}),
      });
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function extractProxyUsage(response: Response): Promise<ProxyTraceMetrics> {
  try {
    const data = (await response.clone().json()) as { usage?: Record<string, unknown> };
    const usage = data.usage;
    if (!usage) return {};
    const finite = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const cost = usage.cost;
    const costUsd =
      typeof cost === "number"
        ? finite(cost)
        : cost && typeof cost === "object"
          ? finite((cost as Record<string, unknown>).total)
          : undefined;
    const inputTokens = finite(usage.prompt_tokens ?? usage.input_tokens ?? usage.input);
    const outputTokens = finite(usage.completion_tokens ?? usage.output_tokens ?? usage.output);
    // Cache counters in every dialect the proxy sees: Anthropic
    // (`cache_read_input_tokens` / `cache_creation_input_tokens`, also carried
    // on the translated OpenAI usage), OpenAI (`prompt_tokens_details.cached_tokens`),
    // and the OpenRouter-style `cache_read_tokens` / `cacheRead`.
    const promptDetails =
      usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
        ? (usage.prompt_tokens_details as Record<string, unknown>)
        : undefined;
    const cacheReadTokens = finite(
      usage.cache_read_input_tokens ??
        promptDetails?.cached_tokens ??
        usage.cache_read_tokens ??
        usage.cacheRead,
    );
    const cacheWriteTokens = finite(
      usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? usage.cacheWrite,
    );
    return {
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
      ...(costUsd === undefined ? {} : { costUsd }),
    };
  } catch {
    return {};
  }
}

function classifyProxyError(status: number): ProxyTraceMetrics["errorKind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 504) return "timeout";
  if (status === 503) return "unavailable";
  if (status >= 500) return "provider";
  return "unknown";
}

/**
 * Concatenate the text blocks of an Anthropic Messages response. Thinking,
 * tool-use and any future non-text blocks are skipped; `content[0].text` is
 * NOT sufficient because the Claude 5 family emits a `thinking` block first.
 */
/**
 * Error text for a failed Anthropic response — includes the upstream reason
 * (e.g. the Claude 5 family rejecting an explicit `temperature`) instead of a
 * bare status text, so operators can see WHY passthru failed.
 */
async function anthropicErrorMessage(resp: Response): Promise<string> {
  const detail = await resp.text().catch(() => "");
  let reason = "";
  try {
    reason = String((JSON.parse(detail) as { error?: { message?: unknown } }).error?.message ?? "");
  } catch {
    reason = detail.slice(0, 200);
  }
  return `Anthropic API error: ${resp.statusText}${reason ? ` — ${reason.slice(0, 300)}` : ""}`;
}

/**
 * Anthropic takes one top-level `system` string. Concatenate every system
 * message (string content, or the text parts of an OpenAI content array) in
 * order, separated by a blank line, so nothing a client put in the system slot
 * is lost.
 */
export function anthropicSystemPrompt(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string") {
      if (message.content.trim()) parts.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; text?: string }>) {
        if ((part.type === undefined || part.type === "text") && part.text?.trim())
          parts.push(part.text);
      }
    }
  }
  return parts.join("\n\n");
}

/**
 * Whether the proxy adds a `cache_control: ephemeral` breakpoint to the LAST
 * system block of every Anthropic request that has none. Default: on under
 * the `local` trust profile (one operator, repeated prompts, their own bill),
 * off otherwise. `MARINA_ANTHROPIC_AUTO_CACHE=true|false` overrides. A client
 * that places its own markers (pi-ai with `cacheControlFormat: "anthropic"`,
 * an Anthropic SDK on `/v1/messages`) is never second-guessed.
 */
export function anthropicAutoCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MARINA_ANTHROPIC_AUTO_CACHE?.trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "off") return false;
  return isLocalProfile(env);
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/**
 * Proxy an OpenAI chat-completions body to Anthropic Messages and translate
 * the reply back. The request translation (tools, tool_choice, stop, images,
 * tool results, response_format, cache_control) lives in `anthropic-tools.ts`
 * — see its header for the full table. `native`, when given, is the client's
 * original Anthropic body (a `/v1/messages` caller) and is forwarded verbatim.
 * Throws `UnsupportedParameterError` for parameters Anthropic cannot honor;
 * `proxyToUpstream` turns that into a 400 for the client.
 */
async function proxyToAnthropic(
  body: Record<string, unknown>,
  apiKey: string,
  defaultModel: string,
  wantStream = false,
  native?: Record<string, unknown>,
): Promise<Response> {
  const requestModel = isMarinaModel(body.model as string) ? defaultModel : (body.model as string);
  const upstreamBody = buildAnthropicRequest(body, requestModel, wantStream, {
    autoCache: anthropicAutoCacheEnabled(),
    native,
  });
  const includeUsage =
    !!body.stream_options &&
    typeof body.stream_options === "object" &&
    (body.stream_options as { include_usage?: unknown }).include_usage === true;

  try {
    const resp = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(upstreamBody),
    });

    if (!resp.ok) {
      return errorJson(resp.status, await anthropicErrorMessage(resp));
    }

    // Native streaming: Anthropic SSE → OpenAI chunk SSE on the fly, including
    // `tool_use` blocks as `delta.tool_calls` fragments.
    if (wantStream) {
      if (!resp.body) return errorJson(502, "Anthropic proxy error: empty streaming body");
      return new Response(translateAnthropicStream(resp.body, requestModel, includeUsage), {
        headers: {
          ...MODEL_CORS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Non-streaming: full message → chat.completion (text joined across every
    // text block, tool_use → tool_calls, cache counters surfaced in usage).
    const data = (await resp.json()) as Parameters<typeof anthropicMessageToOpenai>[0];
    return new Response(JSON.stringify(anthropicMessageToOpenai(data, requestModel)), {
      headers: { ...MODEL_CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return errorJson(502, `Anthropic proxy error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Exported for testing
export { anthropicTextContent, pendingRequests, roundRobinCounters, selectAgent };
