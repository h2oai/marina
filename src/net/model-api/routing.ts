// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Agents-mode routing over the `model*` channels: load balancing (round-robin /
// least-busy / adaptive), multi-turn conversation channels, pending-request
// reminders, single-target + open/panel fan-out + streaming routes, the
// trace-derived usage, the agents-route parameter refusal and the stale
// conversation-channel sweep.

import {
  formatUntrustedContext,
  PANEL_SYNTHESIS_SYSTEM_PROMPT,
} from "../../agent/prompts/support-prompts";
import type { ChannelManager } from "../../coordination/channel-manager";
import type { Engine } from "../../engine/engine";
import { compareTraceCohorts } from "../../engine/trace-dataset";
import { projectTraces } from "../../engine/trace-projection";
import { adviseTraceRouting, selectAdaptiveCandidate } from "../../engine/trace-routing-advice";
import type { ResponseRecord, ResponsesSseEmitter } from "./responses-sse";
import {
  type CompletionUsage,
  generateRequestId,
  HttpError,
  MODEL_CORS,
  modelToChannelName,
  ollamaStreamChunk,
  ollamaStreamEnd,
  openaiStreamChunk,
  openaiStreamEnd,
  openaiStreamRoleChunk,
  requestTrace,
  safeClose,
  unsupportedParam,
} from "./shared";
import { proxyToUpstream } from "./upstream";

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

/**
 * Usage for an agent-routed request, from the traced lifecycle: the agent's
 * own model turns are `agent_turn_end` spans under the request's trace
 * (`traceId === requestId`, see `requestTrace`). Summed across turns; undefined
 * when no turn reported tokens — the caller then OMITS `usage` rather than
 * inventing zeros an SDK would bill against.
 */
export function usageFromTrace(engine: Engine, requestId: string): CompletionUsage | undefined {
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

// --- Load balancing ---

export const roundRobinCounters = new Map<string, number>();
export const pendingRequests = new Map<string, number>();

export function selectAgent(
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

export function getOrCreateConversationChannel(
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

export function buildHistory(cm: ChannelManager, channelId: string): HistoryEntry[] {
  const messages = cm.getHistory(channelId, 50);
  const history: HistoryEntry[] = [];
  for (const msg of messages) {
    const role: "user" | "assistant" = msg.senderId === "__model_conv__" ? "user" : "assistant";
    history.push({ role, content: msg.content });
  }
  return history;
}

// --- Core routing ---

export interface RouteResult {
  content: string;
  conversationId?: string;
  /** Traced request identity (equals the runId/traceId recorded in the event
   *  log). Returned as `x-request-id` so a caller can jump straight to
   *  `trace show <id>` / Admin → Traces for this exact request. */
  requestId: string;
}

export interface RouteOptions {
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

export async function routeToChannel(
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
export async function routeOpen(
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
export async function routePanel(
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
export function bufferedOpenaiStream(
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

export function routeToChannelStreaming(
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

/**
 * Parameters an in-world agent route cannot honor. Agents answer in text over
 * a channel: a tool schema, multiple choices or a structured output format
 * would be silently ignored, so the request is refused with a structured
 * `unsupported_parameter` error the SDK can act on (drop tools, retry).
 */
export function rejectUnsupportedForAgents(body: Record<string, unknown>): Response | undefined {
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
