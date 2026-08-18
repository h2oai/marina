// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Textual tool-call normalization.
 *
 * Some models emit tool calls as TEXT in the assistant content —
 * `<tool_call>{"name":...,"arguments":{...}}</tool_call>` (Hermes, Qwen, several
 * Llama/Mistral fine-tunes) — rather than as OpenAI-structured `tool_calls`. The
 * agent SDK (pi-ai) only understands structured `tool_calls`, so a leaked tag is
 * treated as plain text and the tool never runs.
 *
 * Marina serves any model — cloud or self-hosted — so this normalization is
 * applied on the OpenAI-completions path universally and is PASSTHROUGH BY
 * DEFAULT: models that already return structured `tool_calls` are untouched and
 * stream verbatim. Only literal `<tool_call>` blocks in content are rewritten,
 * and the streaming parser holds back at most a tag's-width of text so the
 * surrounding prose still streams token-by-token.
 */

const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";
// Whole-content scan (non-stream path): tolerant of whitespace and a missing
// closing tag at end-of-content (some servers cut the stream short).
const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/gi;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

let counter = 0;
function nextId(): string {
  counter = (counter + 1) % 1_000_000;
  return `call_${counter.toString(36).padStart(4, "0")}`;
}

/**
 * Parse the JSON inside a tool-call block into a structured call. Accepts
 * `arguments` or `parameters`; returns null for non-JSON or nameless blocks so
 * the caller can leave the original text intact rather than guess.
 */
export function parseToolCallJson(raw: string): OpenAIToolCall | null {
  try {
    const parsed = JSON.parse(raw.trim()) as {
      name?: string;
      arguments?: unknown;
      parameters?: unknown;
    };
    if (!parsed.name || typeof parsed.name !== "string") return null;
    const args = parsed.arguments ?? parsed.parameters ?? {};
    return {
      id: nextId(),
      type: "function",
      function: {
        name: parsed.name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Extract textual tool calls from a complete `content` string (non-streaming
 * path). Returns the structured calls plus the content with the tags removed.
 */
export function extractTextualToolCalls(content: string): {
  toolCalls: OpenAIToolCall[];
  cleaned: string;
} {
  if (typeof content !== "string" || !content.includes(OPEN_TAG)) {
    return { toolCalls: [], cleaned: content };
  }
  const toolCalls: OpenAIToolCall[] = [];
  const consumed: string[] = [];
  for (const m of content.matchAll(TOOL_CALL_RE)) {
    const call = parseToolCallJson(m[1] ?? "");
    if (call) {
      toolCalls.push(call);
      consumed.push(m[0]);
    }
  }
  if (toolCalls.length === 0) return { toolCalls, cleaned: content };
  let cleaned = content;
  for (const block of consumed) cleaned = cleaned.replace(block, "");
  return { toolCalls, cleaned: cleaned.trim() };
}

/**
 * Mutate a parsed OpenAI completion in place (non-streaming): promote textual
 * tool calls to `message.tool_calls`. Skips any choice that already has
 * structured tool calls. Returns true if anything changed.
 */
export function normalizeTextualToolCalls(data: unknown): boolean {
  const choices = (data as { choices?: unknown[] })?.choices;
  if (!Array.isArray(choices)) return false;
  let changed = false;
  for (const choice of choices) {
    const msg = (choice as { message?: Record<string, unknown> })?.message;
    if (!msg || typeof msg.content !== "string") continue;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) continue;
    const { toolCalls, cleaned } = extractTextualToolCalls(msg.content);
    if (toolCalls.length === 0) continue;
    msg.tool_calls = toolCalls;
    msg.content = cleaned.length > 0 ? cleaned : null;
    (choice as { finish_reason?: string }).finish_reason = "tool_calls";
    changed = true;
  }
  return changed;
}

/** Longest suffix of `buf` that is a proper prefix of `tag` — the bytes we must
 *  hold back so a tag split across chunks isn't streamed as visible text. */
function heldSuffixLen(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (buf.slice(-k) === tag.slice(0, k)) return k;
  }
  return 0;
}

export type StreamEvent =
  | { type: "content"; text: string }
  | { type: "toolCall"; call: OpenAIToolCall };

/**
 * Incremental parser for the streaming path. Feed assistant content deltas; it
 * emits content to stream through and tool calls to convert — holding back only
 * a partial `<tool_call>` tag at a chunk boundary, so normal text keeps
 * streaming token-by-token. Structured `tool_calls` deltas are handled by the
 * caller (forwarded verbatim) and never reach this parser.
 */
export class ToolCallStreamParser {
  private mode: "text" | "capture" = "text";
  private buf = "";
  private capture = "";
  /** True once at least one textual tool call has been converted. */
  sawToolCall = false;

  /** Feed a content delta; returns events to emit in order. */
  push(text: string): StreamEvent[] {
    const out: StreamEvent[] = [];
    this.process(text, out);
    return out;
  }

  private process(text: string, out: StreamEvent[]): void {
    if (this.mode === "text") {
      this.buf += text;
      const open = this.buf.indexOf(OPEN_TAG);
      if (open >= 0) {
        const before = this.buf.slice(0, open);
        if (before) out.push({ type: "content", text: before });
        this.capture = this.buf.slice(open + OPEN_TAG.length);
        this.buf = "";
        this.mode = "capture";
        this.drainCapture(out);
      } else {
        const hold = heldSuffixLen(this.buf, OPEN_TAG);
        const safe = this.buf.slice(0, this.buf.length - hold);
        if (safe) out.push({ type: "content", text: safe });
        this.buf = hold > 0 ? this.buf.slice(this.buf.length - hold) : "";
      }
    } else {
      this.capture += text;
      this.drainCapture(out);
    }
  }

  private drainCapture(out: StreamEvent[]): void {
    const close = this.capture.indexOf(CLOSE_TAG);
    if (close < 0) return; // wait for more
    const raw = this.capture.slice(0, close);
    const call = parseToolCallJson(raw);
    if (call) {
      out.push({ type: "toolCall", call });
      this.sawToolCall = true;
    } else {
      // Not a real tool call — preserve the original text verbatim.
      out.push({ type: "content", text: `${OPEN_TAG}${raw}${CLOSE_TAG}` });
    }
    const rest = this.capture.slice(close + CLOSE_TAG.length);
    this.capture = "";
    this.mode = "text";
    if (rest) this.process(rest, out);
  }

  /** Flush remaining buffers at stream end. */
  finish(): StreamEvent[] {
    const out: StreamEvent[] = [];
    if (this.mode === "capture") {
      const call = parseToolCallJson(this.capture);
      if (call) {
        out.push({ type: "toolCall", call });
        this.sawToolCall = true;
      } else if (this.capture) {
        out.push({ type: "content", text: `${OPEN_TAG}${this.capture}` });
      }
      this.capture = "";
    } else if (this.buf) {
      out.push({ type: "content", text: this.buf });
      this.buf = "";
    }
    return out;
  }
}
