import { getInternalModelToken } from "../agent/agent-runtime";
import type { RateLimiter } from "../auth/rate-limiter";
import type { ChannelManager } from "../coordination/channel-manager";
import { localOutputBudget } from "../engine/constants";
import type { Engine } from "../engine/engine";
import { buildAliasMap } from "./compat-profiles";
import { corsHeaders } from "./cors";
import { handleMediaApi } from "./media-api";
import {
  isLocalProvider,
  LOCAL_PROVIDERS,
  localProviderBaseUrl,
  localProviderContextWindow,
} from "./model-discovery";
import { getEndpointConfig } from "./model-endpoint";
import {
  normalizeTextualToolCalls,
  type StreamEvent,
  ToolCallStreamParser,
} from "./tool-call-normalize";

const MODEL_CORS = corsHeaders(null, {
  methods: "GET, POST, OPTIONS",
  headers: "Content-Type, Authorization, X-Conversation-Id, X-Load-Balance",
  expose: "X-Conversation-Id, x-request-id",
});

// --- API key authentication ---
// When MODEL_API_KEYS is set, only requests with a valid Bearer token are accepted.
// When MARINA_OPEN_API=true, the API accepts unauthenticated requests (development mode).
// When neither is set, the API returns 401.

function isOpenApiMode(): boolean {
  return process.env.MARINA_OPEN_API === "true";
}

function getApiKeys(): Set<string> | null {
  const raw = process.env.MODEL_API_KEYS;
  if (!raw) return null;
  const keys = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return keys.length > 0 ? new Set(keys) : null;
}

function authenticate(req: Request): Response | null {
  // Accept internal token from room agents — always valid, no config needed
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (token === getInternalModelToken()) return null;
  }

  const keys = getApiKeys();
  if (!keys) {
    // No API keys configured — check for open mode
    if (isOpenApiMode()) return null;
    return errorJson(
      401,
      "Model API requires authentication. Set MODEL_API_KEYS or MARINA_OPEN_API=true for development.",
    );
  }
  if (!auth?.startsWith("Bearer ")) {
    return errorJson(401, "Missing or invalid Authorization header");
  }
  const token = auth.slice(7);
  if (!keys.has(token)) {
    return errorJson(401, "Invalid API key");
  }
  return null;
}

function generateRequestId(): string {
  return `req-${crypto.randomUUID().slice(0, 8)}`;
}

function extractIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0]!.trim() : null) ?? req.headers.get("x-real-ip") ?? "unknown";
}

function json(data: unknown, status = 200, extra?: Record<string, string>): Response {
  return Response.json(data, {
    status,
    headers: { ...MODEL_CORS, "x-request-id": generateRequestId(), ...extra },
  });
}

/** OpenAI-compatible nested error format */
function errorJson(status: number, message: string): Response {
  const typeMap: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error",
    404: "not_found_error",
    429: "rate_limit_error",
    503: "server_error",
    504: "server_error",
  };
  return json(
    { error: { message, type: typeMap[status] ?? "server_error", param: null, code: null } },
    status,
  );
}

const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MODEL_REQUEST_TIMEOUT_MS ?? "600000", 10);

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

function openaiCompletion(model: string, content: string): unknown {
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
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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

function ollamaTagList(models: ModelInfo[]): unknown {
  return {
    models: models.map((m) => ({
      name: m.id,
      modified_at: new Date().toISOString(),
      size: 0,
    })),
  };
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
}

interface RouteOptions {
  context?: string;
  conversationId?: string;
  strategy?: "round-robin" | "least-busy";
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
  const target = selectAgent(onlineMembers, channel.id, strategy);

  // Multi-turn conversation
  const convId = opts?.conversationId ?? undefined;
  let convChannel: { id: string; name: string } | undefined;
  let history: HistoryEntry[] | undefined;
  if (convId) {
    convChannel = getOrCreateConversationChannel(cm, convId);
    history = buildHistory(cm, convChannel.id);
  }

  const requestId = `req-${crypto.randomUUID().slice(0, 8)}`;

  // Build request payload
  const payload = JSON.stringify({
    type: "model_request",
    id: requestId,
    content: userContent,
    target,
    ...(opts?.context ? { context: opts.context } : {}),
    ...(convId ? { conversation_id: convId } : {}),
    ...(history && history.length > 0 ? { history } : {}),
  });

  incrementPending(target);

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
          resolve({ content: parsed.content ?? "", conversationId: convId });
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

    return result;
  } finally {
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
): Promise<{ responses: string[]; conversationId?: string }> {
  const { cm, channel, onlineMembers } = getModelChannelMembers(engine, model);
  const targets = onlineMembers.slice(0, Math.min(maxTargets, onlineMembers.length, FANOUT_CAP));
  const convId = opts?.conversationId ?? undefined;
  const pending = new Set<string>();
  const collected: string[] = [];

  return new Promise<{ responses: string[]; conversationId?: string }>((resolve, reject) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const overall = setTimeout(() => {
      cleanup();
      if (collected.length > 0) resolve({ responses: collected, conversationId: convId });
      else reject(new HttpError(504, "Response timeout"));
    }, REQUEST_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(overall);
      if (graceTimer) clearTimeout(graceTimer);
      unsub();
      for (const t of targets) decrementPending(t);
    }

    const unsub = cm.onMessage((channelId, senderId, _name, content) => {
      if (channelId !== channel.id || senderId === "__model_api__") return;
      const match = matchFanoutReply(content, pending);
      if (!match) return;
      pending.delete(match.id);
      collected.push(match.text);
      if (resolveMode === "first") {
        cleanup();
        resolve({ responses: collected, conversationId: convId });
        return;
      }
      // "all": resolve when every target has replied, or a grace window after the
      // first reply elapses (so one slow/dead agent can't stall the panel).
      if (collected.length === 1) {
        graceTimer = setTimeout(() => {
          cleanup();
          resolve({ responses: collected, conversationId: convId });
        }, PANEL_GRACE_MS);
      }
      if (pending.size === 0) {
        cleanup();
        resolve({ responses: collected, conversationId: convId });
      }
    });

    for (const target of targets) {
      const requestId = `req-${crypto.randomUUID().slice(0, 8)}`;
      pending.add(requestId);
      incrementPending(target);
      cm.send(
        channel.id,
        "__model_api__",
        "model-api",
        JSON.stringify({
          type: "model_request",
          id: requestId,
          content: userContent,
          target,
          ...(opts?.context ? { context: opts.context } : {}),
          ...(convId ? { conversation_id: convId } : {}),
        }),
      );
    }
  });
}

/** Open mode: first online member to answer wins. */
async function routeOpen(
  engine: Engine,
  model: string,
  userContent: string,
  opts?: RouteOptions,
): Promise<RouteResult> {
  const { responses, conversationId } = await collectResponses(
    engine,
    model,
    userContent,
    opts,
    "first",
    FANOUT_CAP,
  );
  return { content: responses[0] ?? "", conversationId };
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
  const { responses, conversationId } = await collectResponses(
    engine,
    model,
    userContent,
    opts,
    "all",
    panelSize,
  );
  if (responses.length <= 1) {
    return { content: responses[0] ?? "", conversationId };
  }
  if (synthesis === "concat") {
    const merged = responses.map((r, i) => `### Answer ${i + 1}\n\n${r}`).join("\n\n");
    return { content: merged, conversationId };
  }
  // synthesize: ask the configured upstream model to merge the panel's answers.
  const mergePrompt =
    `You are merging ${responses.length} independent expert answers into one best response.\n\n` +
    `Question:\n${userContent}\n\n` +
    `${responses.map((r, i) => `Answer ${i + 1}:\n${r}`).join("\n\n")}\n\n` +
    `Write a single, coherent answer that reconciles and improves on them.`;
  try {
    const resp = await proxyToUpstream(engine, {
      model: "marina/default",
      messages: [{ role: "user", content: mergePrompt }],
    });
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content;
    if (text) return { content: text, conversationId };
  } catch {
    // synthesis upstream unavailable — fall back to concat below
  }
  const merged = responses.map((r, i) => `### Answer ${i + 1}\n\n${r}`).join("\n\n");
  return { content: merged, conversationId };
}

/** Emit a buffered string as an OpenAI-format SSE stream (used when a stream is
 *  requested in a mode that can't stream incrementally — open / panel). */
function bufferedOpenaiStream(model: string, content: string, convId?: string): Response {
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
    "x-request-id": generateRequestId(),
  };
  if (convId) headers["X-Conversation-Id"] = convId;
  return new Response(stream, { headers });
}

// --- Streaming routing ---

type StreamFormat = "openai" | "ollama-chat" | "ollama-generate";

function routeToChannelStreaming(
  engine: Engine,
  model: string,
  userContent: string,
  format: StreamFormat,
  opts?: RouteOptions,
): { stream: ReadableStream<Uint8Array>; conversationId?: string } {
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
  const target = selectAgent(onlineMembers, channel.id, strategy);

  const convId = opts?.conversationId ?? undefined;
  let convChannel: { id: string; name: string } | undefined;
  let history: HistoryEntry[] | undefined;
  if (convId) {
    convChannel = getOrCreateConversationChannel(cm, convId);
    history = buildHistory(cm, convChannel.id);
  }

  const reqId = `req-${crypto.randomUUID().slice(0, 8)}`;
  const streamId = `chatcmpl-${reqId.slice(4)}`;
  const encoder = new TextEncoder();
  const collectedContent: string[] = [];

  const payload = JSON.stringify({
    type: "model_request",
    id: reqId,
    content: userContent,
    target,
    stream: true,
    ...(opts?.context ? { context: opts.context } : {}),
    ...(convId ? { conversation_id: convId } : {}),
    ...(history && history.length > 0 ? { history } : {}),
  });

  incrementPending(target);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // OpenAI streams must begin with a role-only chunk
      if (format === "openai") {
        controller.enqueue(encoder.encode(openaiStreamRoleChunk(streamId, model)));
      }

      const timer = setTimeout(() => {
        unsub();
        decrementPending(target);
        safeClose(controller);
      }, REQUEST_TIMEOUT_MS);

      const unsub = cm.onMessage((channelId, senderId, _senderName, content) => {
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
          clearTimeout(timer);
          unsub();
          decrementPending(target);
          let endChunk: string;
          if (format === "openai") {
            endChunk = openaiStreamEnd(streamId, model);
          } else {
            endChunk = ollamaStreamEnd(model, format === "ollama-chat");
          }
          controller.enqueue(encoder.encode(endChunk));
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
          clearTimeout(timer);
          unsub();
          decrementPending(target);
          collectedContent.push(text);
          if (format === "openai") {
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

      cm.send(channel.id, "__model_api__", "model-api", payload);
    },
  });

  return { stream, conversationId: convId };
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

interface ResponseRecord {
  id: string;
  conversationId: string;
  model: string;
  content: string;
  createdAt: number;
  previousResponseId?: string;
  status: "completed" | "failed";
}

const responseIndex = new Map<string, ResponseRecord>();
const RESPONSE_RETENTION_MS = 24 * 60 * 60 * 1000;

function trimResponseIndex(): void {
  const cutoff = Date.now() - RESPONSE_RETENTION_MS;
  for (const [id, rec] of responseIndex) {
    if (rec.createdAt < cutoff) responseIndex.delete(id);
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

function formatResponseRecord(rec: ResponseRecord): unknown {
  return {
    id: rec.id,
    object: "response",
    created_at: Math.floor(rec.createdAt / 1000),
    model: rec.model,
    status: rec.status,
    output: [
      {
        type: "message",
        id: `msg_${rec.id.slice(5)}`,
        role: "assistant",
        content: [{ type: "output_text", text: rec.content, annotations: [] }],
      },
    ],
    output_text: rec.content,
    previous_response_id: rec.previousResponseId ?? null,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
}

async function handleResponsesCreate(req: Request, engine: Engine): Promise<Response> {
  trimResponseIndex();
  try {
    const body = (await req.json()) as {
      model?: string;
      input?: unknown;
      instructions?: string;
      previous_response_id?: string;
      conversation_id?: string;
      store?: boolean;
    };

    const model = body.model ?? "marina";
    const userInput = extractInputText(body.input);
    if (!userInput) return errorJson(400, "`input` is required");

    // Resolve conversation: previous_response_id > explicit conversation_id > new
    let conversationId: string;
    let previousResponseId: string | undefined;
    if (body.previous_response_id) {
      const prior = responseIndex.get(body.previous_response_id);
      if (!prior) {
        return errorJson(404, `previous_response_id not found: ${body.previous_response_id}`);
      }
      conversationId = prior.conversationId;
      previousResponseId = prior.id;
    } else if (body.conversation_id) {
      conversationId = body.conversation_id;
    } else {
      conversationId = crypto.randomUUID();
    }

    const opts: RouteOptions = {
      context: body.instructions ? `system: ${body.instructions}` : undefined,
      conversationId,
    };

    try {
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
      };
      if (body.store !== false) {
        responseIndex.set(id, rec);
      }
      return json(formatResponseRecord(rec), 200, { "X-Conversation-Id": conversationId });
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

function handleResponsesGet(id: string): Response {
  trimResponseIndex();
  const rec = responseIndex.get(id);
  if (!rec) return errorJson(404, `Response not found: ${id}`);
  return json(formatResponseRecord(rec));
}

function handleResponsesDelete(id: string, engine: Engine): Response {
  const rec = responseIndex.get(id);
  if (!rec) return errorJson(404, `Response not found: ${id}`);
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

function extractStrategy(req: Request): "round-robin" | "least-busy" {
  const header = req.headers.get("X-Load-Balance");
  if (header === "least-busy") return "least-busy";
  return "round-robin";
}

export async function handleModelApi(
  url: URL,
  method: string,
  req: Request,
  engine: Engine,
  rateLimiter?: RateLimiter,
): Promise<Response | undefined> {
  // Authenticate (skipped for CORS preflight)
  if (method !== "OPTIONS") {
    const authError = authenticate(req);
    if (authError) return authError;
  }

  // Per-IP rate limiting for mutation endpoints
  if (rateLimiter && method === "POST") {
    const ip = extractIp(req);
    if (!rateLimiter.consume(`model:${ip}`)) {
      return errorJson(429, "Rate limited. Please slow down.");
    }
  }

  if (url.pathname.startsWith("/v1/media")) {
    return await handleMediaApi(url, method, req, engine);
  }

  // OpenAI: GET /v1/models
  if (url.pathname === "/v1/models" && method === "GET") {
    return json(openaiModelList(listModels(engine)));
  }

  // OpenAI: POST /v1/chat/completions
  if (url.pathname === "/v1/chat/completions" && method === "POST") {
    return await handleOpenaiChat(req, engine);
  }

  // OpenAI Responses API: /v1/responses, /v1/responses/:id
  // Used by passthru clients for server-side conversation state.
  if (url.pathname === "/v1/responses" && method === "POST") {
    return await handleResponsesCreate(req, engine);
  }
  if (url.pathname.startsWith("/v1/responses/") && method === "GET") {
    const id = url.pathname.slice("/v1/responses/".length);
    return handleResponsesGet(id);
  }
  if (url.pathname.startsWith("/v1/responses/") && method === "DELETE") {
    const id = url.pathname.slice("/v1/responses/".length);
    return handleResponsesDelete(id, engine);
  }

  // OpenAI health: /v1/health
  if (url.pathname === "/v1/health" && method === "GET") {
    return json({ status: "ok", engine: "marina" });
  }

  // Ollama: GET /api/tags
  if (url.pathname === "/api/tags" && method === "GET") {
    return json(ollamaTagList(listModels(engine)));
  }

  // Ollama: POST /api/chat
  if (url.pathname === "/api/chat" && method === "POST") {
    return await handleOllamaChat(req, engine);
  }

  // Ollama: POST /api/generate
  if (url.pathname === "/api/generate" && method === "POST") {
    return await handleOllamaGenerate(req, engine);
  }

  return undefined;
}

async function handleOpenaiChat(req: Request, engine: Engine): Promise<Response> {
  try {
    const body = await req.json();
    const model = body.model ?? "marina";
    const messages = body.messages ?? [];

    // Extract last user message
    const userMsg = [...messages].reverse().find((m: { role: string }) => m.role === "user");
    if (!userMsg) return errorJson(400, "No user message found");

    // Build context from system/prior messages
    const contextParts: string[] = [];
    for (const msg of messages) {
      if (msg === userMsg) break;
      contextParts.push(`${msg.role}: ${msg.content}`);
    }
    const context = contextParts.length > 0 ? contextParts.join("\n") : undefined;

    const conversationId = extractConversationId(req, body);
    const ec = getEndpointConfig(engine.db);

    // Passthru: Marina is a thin gateway — proxy straight to the configured
    // upstream model, no agents involved.
    if (ec.mode === "passthru") {
      return await proxyToUpstream(engine, body, ec.passthruModel || undefined);
    }

    const opts: RouteOptions = { context, conversationId, strategy: ec.strategy };
    const wantStream = body.stream === true;

    try {
      // Agents mode streams natively (one coordinator, incremental deltas).
      if (wantStream && ec.mode === "agents") {
        const { stream, conversationId: convId } = routeToChannelStreaming(
          engine,
          model,
          userMsg.content,
          "openai",
          opts,
        );
        const headers: Record<string, string> = {
          ...MODEL_CORS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "x-request-id": generateRequestId(),
        };
        if (convId) headers["X-Conversation-Id"] = convId;
        return new Response(stream, { headers });
      }

      let result: RouteResult;
      if (ec.mode === "open") {
        result = await routeOpen(engine, model, userMsg.content, opts);
      } else if (ec.mode === "panel") {
        result = await routePanel(
          engine,
          model,
          userMsg.content,
          opts,
          ec.panelSize,
          ec.panelSynthesis,
        );
      } else {
        result = await routeToChannel(engine, model, userMsg.content, opts);
      }

      // open/panel can't stream incrementally — emit the buffered result as SSE.
      if (wantStream) return bufferedOpenaiStream(model, result.content, result.conversationId);

      const extra: Record<string, string> = {};
      if (result.conversationId) extra["X-Conversation-Id"] = result.conversationId;
      return json(openaiCompletion(model, result.content), 200, extra);
    } catch (routeError) {
      // No agent answered (503): fall back to direct upstream proxy when enabled.
      // 404 (unknown model variant) remains an error — caller asked for a specific model.
      if (routeError instanceof HttpError && routeError.status === 503 && ec.fallback) {
        return await proxyToUpstream(engine, body, ec.passthruModel || undefined);
      }
      throw routeError;
    }
  } catch (e) {
    if (e instanceof HttpError) return errorJson(e.status, e.message);
    return errorJson(500, "Internal error");
  }
}

async function handleOllamaChat(req: Request, engine: Engine): Promise<Response> {
  try {
    const body = await req.json();
    const model = body.model ?? "marina";
    const messages = body.messages ?? [];

    const userMsg = [...messages].reverse().find((m: { role: string }) => m.role === "user");
    if (!userMsg) return errorJson(400, "No user message found");

    const contextParts: string[] = [];
    for (const msg of messages) {
      if (msg === userMsg) break;
      contextParts.push(`${msg.role}: ${msg.content}`);
    }
    const context = contextParts.length > 0 ? contextParts.join("\n") : undefined;

    const conversationId = extractConversationId(req, body);
    const strategy = extractStrategy(req);
    const opts: RouteOptions = { context, conversationId, strategy };

    // Ollama defaults to streaming (stream !== false)
    if (body.stream !== false) {
      const { stream, conversationId: convId } = routeToChannelStreaming(
        engine,
        model,
        userMsg.content,
        "ollama-chat",
        opts,
      );
      const headers: Record<string, string> = {
        ...MODEL_CORS,
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
      };
      if (convId) headers["X-Conversation-Id"] = convId;
      return new Response(stream, { headers });
    }

    const result = await routeToChannel(engine, model, userMsg.content, opts);
    const extra: Record<string, string> = {};
    if (result.conversationId) extra["X-Conversation-Id"] = result.conversationId;
    return json(ollamaChatResponse(model, result.content), 200, extra);
  } catch (e) {
    if (e instanceof HttpError) return errorJson(e.status, e.message);
    return errorJson(500, "Internal error");
  }
}

async function handleOllamaGenerate(req: Request, engine: Engine): Promise<Response> {
  try {
    const body = await req.json();
    const model = body.model ?? "marina";
    const prompt = body.prompt;
    if (!prompt) return errorJson(400, "No prompt provided");

    const context = body.system ? `system: ${body.system}` : undefined;
    const conversationId = extractConversationId(req, body);
    const strategy = extractStrategy(req);
    const opts: RouteOptions = { context, conversationId, strategy };

    // Ollama defaults to streaming (stream !== false)
    if (body.stream !== false) {
      const { stream, conversationId: convId } = routeToChannelStreaming(
        engine,
        model,
        prompt,
        "ollama-generate",
        opts,
      );
      const headers: Record<string, string> = {
        ...MODEL_CORS,
        "Content-Type": "application/x-ndjson",
        "Transfer-Encoding": "chunked",
      };
      if (convId) headers["X-Conversation-Id"] = convId;
      return new Response(stream, { headers });
    }

    const result = await routeToChannel(engine, model, prompt, opts);
    const extra: Record<string, string> = {};
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
  OPENAI_API_KEY: "gpt-4o",
  GEMINI_API_KEY: "gemini-2.0-flash",
  OPENROUTER_API_KEY: "anthropic/claude-sonnet-4",
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
  return BUILTIN_DEFAULT_MODELS[envKey] ?? "gpt-4o";
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
): Promise<Response | null> {
  try {
    // Omit the Authorization header entirely when keyless (local servers) — an
    // empty `Bearer ` confuses some OpenAI-compatible implementations.
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!resp.ok) return null;
    const model = String((body.model as string) ?? "marina");
    if (wantStream) {
      if (!resp.body) return null;
      return new Response(normalizeToolCallSSE(resp.body, model), { headers: SSE_HEADERS });
    }
    const data = await resp.json();
    normalizeTextualToolCalls(data);
    return new Response(JSON.stringify(data), {
      headers: { ...MODEL_CORS, "Content-Type": "application/json" },
    });
  } catch {
    return null;
  }
}

/**
 * Stream-transform an upstream OpenAI SSE response, repairing textual tool calls
 * inline. Content streams through (≤ one tag's width of holdback); structured
 * `tool_calls` and other deltas pass through verbatim; a single authoritative
 * finish chunk is emitted at the end (`tool_calls` when any textual call was
 * converted). pi-ai's accumulator reads `delta.tool_calls` by index.
 */
function normalizeToolCallSSE(
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

  const send = (c: ReadableStreamDefaultController<Uint8Array>, frame: string) =>
    c.enqueue(encoder.encode(frame));
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
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return emitFinish(c);
    let parsed: {
      id?: string;
      model?: string;
      choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[];
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed.id === "string") id = parsed.id;
    if (typeof parsed.model === "string") model = parsed.model;
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
    if (choice?.finish_reason) emitFinish(c);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (sseBuf.trim()) processLine(sseBuf, controller);
          emitFinish(controller);
          controller.close();
          return;
        }
        sseBuf += decoder.decode(value, { stream: true });
        const parts = sseBuf.split("\n");
        sseBuf = parts.pop() ?? "";
        for (const part of parts) processLine(part, controller);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
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

async function proxyToUpstream(
  engine: Engine,
  body: Record<string, unknown>,
  forceModel?: string,
): Promise<Response> {
  const wantStream = body.stream === true;
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
      if (cfg.anthropic) return await proxyToAnthropic(body, key!, upstreamModel, wantStream);
      const r = await dispatchOpenAICompatible(
        cfg.url,
        key ?? "",
        prepareLlamaBody({ ...body, model: upstreamModel }, provider),
        wantStream,
      );
      if (r) return r;
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
    const envKey = cfg.envKeys[0]!;
    if (cfg.anthropic) {
      return await proxyToAnthropic(body, key!, getDefaultUpstreamModel(envKey), wantStream);
    }
    const requestModel = isDefault ? getDefaultUpstreamModel(envKey) : (body.model as string);
    const r = await dispatchOpenAICompatible(
      cfg.url,
      key ?? "",
      prepareLlamaBody({ ...body, model: requestModel }, provider),
      wantStream,
    );
    if (r) return r;
  }

  return errorJson(
    503,
    "No upstream LLM providers configured. Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.) or add one in Admin → Keys.",
  );
}

async function proxyToAnthropic(
  body: Record<string, unknown>,
  apiKey: string,
  defaultModel: string,
  wantStream = false,
): Promise<Response> {
  const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");

  const requestModel = isMarinaModel(body.model as string) ? defaultModel : (body.model as string);

  try {
    // Native streaming: call Anthropic with stream: true and convert SSE on-the-fly
    if (wantStream) {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: requestModel,
          max_tokens: (body.max_tokens as number) ?? 4096,
          stream: true,
          ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
          ...(systemMsg ? { system: systemMsg.content } : {}),
          messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!resp.ok) {
        return errorJson(resp.status, `Anthropic API error: ${resp.statusText}`);
      }

      const completionId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let buffer = "";

      const transformStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          // Keep the last potentially incomplete line in the buffer
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data) as {
                type?: string;
                delta?: { type?: string; text?: string };
              };
              if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                const oaiChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: requestModel,
                  choices: [
                    { index: 0, delta: { content: parsed.delta.text }, finish_reason: null },
                  ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(oaiChunk)}\n\n`));
              } else if (parsed.type === "message_stop") {
                const stopChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: requestModel,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              }
            } catch {
              /* skip malformed chunks */
            }
          }
        },
        flush(controller) {
          // Process any remaining buffered data
          if (buffer.startsWith("data: ")) {
            const data = buffer.slice(6).trim();
            if (data && data !== "[DONE]") {
              try {
                const parsed = JSON.parse(data) as { type?: string };
                if (parsed.type === "message_stop") {
                  const stopChunk = {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: requestModel,
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
              } catch {
                /* ignore */
              }
            }
          }
        },
      });

      return new Response(resp.body!.pipeThrough(transformStream), {
        headers: {
          ...MODEL_CORS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Non-streaming: collect full response and convert to OpenAI format
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: requestModel,
        max_tokens: (body.max_tokens as number) ?? 4096,
        ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
        ...(systemMsg ? { system: systemMsg.content } : {}),
        messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (resp.ok) {
      const data = (await resp.json()) as {
        id?: string;
        content?: Array<{ text?: string }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const content = data.content?.[0]?.text ?? "";
      const completionId = data.id ?? `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;

      const openaiResponse = {
        id: completionId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: data.stop_reason === "end_turn" ? "stop" : (data.stop_reason ?? "stop"),
          },
        ],
        usage: {
          prompt_tokens: data.usage?.input_tokens ?? 0,
          completion_tokens: data.usage?.output_tokens ?? 0,
          total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        },
      };

      return new Response(JSON.stringify(openaiResponse), {
        headers: { ...MODEL_CORS, "Content-Type": "application/json" },
      });
    }
    return errorJson(resp.status, `Anthropic API error: ${resp.statusText}`);
  } catch (e) {
    return errorJson(502, `Anthropic proxy error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Exported for testing
export { pendingRequests, roundRobinCounters, selectAgent };
