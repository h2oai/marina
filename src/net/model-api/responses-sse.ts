// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Responses API wire shapes: the stored `ResponseRecord`, its `output` items and
// the incremental SSE emitter, plus the two stream adapters (a finished record
// replayed as SSE; an upstream chat-completions SSE re-encoded as Responses
// SSE). Below `routing.ts`, which streams into the emitter.

import { getErrorMessage } from "../../engine/errors";
import type { ResponsesFunctionCall } from "../responses-tools";
import { type CompletionUsage, promptTokensDetails, SSE_HEADERS, safeClose } from "./shared";

// --- OpenAI Responses API (server-side conversation state) ---
//
// Passthru clients that use the OpenAI Responses API get the same server-side
// state experience. Each response_id maps to a conversation channel;
// previous_response_id threads continuations onto the same channel.
// Memory-only index (restart wipes the id map; messages remain in channels).

export interface ResponseRecord {
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

function responsesUsage(usage: CompletionUsage | undefined): Record<string, unknown> {
  if (!usage) return {};
  return {
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      input_tokens_details: {
        cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        ...(usage.prompt_tokens_details?.cache_creation_tokens === undefined
          ? {}
          : { cache_creation_tokens: usage.prompt_tokens_details.cache_creation_tokens }),
      },
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

export function formatResponseRecord(rec: ResponseRecord): Record<string, unknown> {
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
export class ResponsesSseEmitter {
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
export function responsesSseStream(
  rec: ResponseRecord,
  extraHeaders: Record<string, string>,
): Response {
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
  const details = promptTokensDetails(u);
  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: num(u.total_tokens) ?? (prompt ?? 0) + (completion ?? 0),
    ...(details ? { prompt_tokens_details: details } : {}),
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
export function responsesPassthruStream(
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
