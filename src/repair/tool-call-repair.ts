// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Output repair for an OpenAI-style assistant message that was meant to call a
 * tool (`output-repair` is the general layer; this is its tool-call contract):
 *
 *  - a tool call whose `arguments` is not valid JSON is re-parsed mechanically
 *    (fences, surrounding prose, trailing commas) → `repaired:parse`;
 *  - a message with no tool call whose text embeds one for a DECLARED tool
 *    (`{"name": …, "arguments": …}`, `<tool_call>…</tool_call>`, a fenced block)
 *    becomes that tool call → `repaired:parse`;
 *  - otherwise, when the text names a declared tool, ONE shot may re-encode the
 *    text into a call → `repaired:shot`.
 *
 * Meaning is never changed: a repaired call names a declared tool, every value
 * in its arguments appears verbatim in the original message, and for a
 * state-changing call every argument name does too (the write-guard rule: only
 * fields present in the draft, no new ids).
 */
import {
  balancedJsonSpan,
  extractJsonValue,
  groundedIn,
  outputRepairMode,
  REENCODE_SYSTEM,
  type RepairLabel,
  type RepairMode,
  type RepairShot,
  stripReasoning,
} from "./output-repair";

export interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: ChatToolCall[];
  [key: string]: unknown;
}

export interface ToolCallRepairResult {
  message: ChatMessage;
  label: RepairLabel;
  detail: string;
}

function declaredNames(tools: unknown[] | undefined): string[] {
  return (tools ?? [])
    .map((t) => (t as { function?: { name?: unknown } }).function?.name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? "")))
      .join("\n");
  }
  return "";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `{"name", "arguments"|"parameters"}` or OpenAI's `{"function": {…}}` → a call. */
function callFrom(v: unknown): { name: string; args: Record<string, unknown> } | undefined {
  if (!isObject(v)) return undefined;
  const fn = isObject(v.function) ? v.function : v;
  const name = fn.name;
  let args = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input;
  if (typeof args === "string") args = extractJsonValue(args);
  if (typeof name !== "string" || !isObject(args)) return undefined;
  return { name, args };
}

/** Every key path name inside `args` appears in `source` (only fields the draft wrote). */
function keysIn(args: unknown, source: string): boolean {
  const hay = source.toLowerCase();
  const named = (key: string): boolean => {
    const escaped = key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "u").test(hay);
  };
  const walk = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.every(walk);
    if (!isObject(v)) return true;
    return Object.entries(v).every(([k, x]) => named(k) && walk(x));
  };
  return walk(args);
}

function preserved(
  call: { name: string; args: Record<string, unknown> },
  source: string,
  declared: string[],
  isWrite: (name: string) => boolean,
): boolean {
  if (!declared.includes(call.name)) return false;
  if (!groundedIn(call.args, source)) return false;
  return !isWrite(call.name) || keysIn(call.args, source);
}

/** Embedded call candidates in prose, in order. */
function embeddedCalls(text: string): unknown[] {
  const body = stripReasoning(text);
  const out: unknown[] = [];
  for (const m of body.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)) {
    const v = extractJsonValue(m[1] ?? "");
    if (v !== undefined) out.push(v);
  }
  const whole = extractJsonValue(body);
  if (whole !== undefined) out.push(...(Array.isArray(whole) ? whole : [whole]));
  const span = balancedJsonSpan(body);
  if (span) {
    const v = extractJsonValue(span);
    if (v !== undefined) out.push(v);
  }
  return out;
}

let repairCallSeq = 0;
function newCallId(): string {
  repairCallSeq = (repairCallSeq + 1) % 1_000_000;
  return `call_repaired_${Date.now().toString(36)}${repairCallSeq}`;
}

/**
 * Repair `message` against the tool-call contract. Returns the repaired message
 * and its label, or undefined when nothing needed (or could safely take) repair.
 */
export async function repairToolCallMessage(input: {
  message: ChatMessage;
  tools: unknown[] | undefined;
  isWrite: (name: string) => boolean;
  shot?: RepairShot;
  mode?: RepairMode;
}): Promise<ToolCallRepairResult | undefined> {
  const mode = input.mode ?? outputRepairMode();
  const declared = declaredNames(input.tools);
  if (mode === "off" || declared.length === 0) return undefined;
  const { message } = input;

  // 1. Malformed arguments on an existing call.
  if (message.tool_calls?.length) {
    let fixed = 0;
    const calls = message.tool_calls.map((c) => {
      const raw = c.function?.arguments;
      if (raw === undefined || raw === "") return c;
      try {
        JSON.parse(raw);
        return c;
      } catch {
        const v = extractJsonValue(raw);
        if (!isObject(v) || !groundedIn(v, raw)) return c;
        fixed++;
        return { ...c, function: { ...c.function, arguments: JSON.stringify(v) } };
      }
    });
    if (fixed === 0) return undefined;
    return {
      message: { ...message, tool_calls: calls },
      label: "repaired:parse",
      detail: `re-parsed ${fixed} malformed argument payload(s)`,
    };
  }

  // 2. A call embedded in the text.
  const text = textOf(message.content);
  if (!text.trim()) return undefined;
  for (const candidate of embeddedCalls(text)) {
    const call = callFrom(candidate);
    if (call && preserved(call, text, declared, input.isWrite)) {
      return {
        message: withCall(message, call),
        label: "repaired:parse",
        detail: `extracted ${call.name} from the text`,
      };
    }
  }

  // 3. One re-encoding shot — only when the text names a declared tool.
  const lower = text.toLowerCase();
  if (mode !== "on" || !input.shot || !declared.some((n) => lower.includes(n.toLowerCase()))) {
    return undefined;
  }
  let reply: string;
  try {
    reply = await input.shot(
      REENCODE_SYSTEM,
      `Required format: one line of JSON {"name": "<tool name>", "arguments": {…}} for the tool call the text below already states, using only these tool names: ${declared.join(", ")}.\n\nText to re-encode:\n<<<\n${text.slice(-12_000)}\n>>>`,
    );
  } catch {
    return undefined;
  }
  const call = callFrom(extractJsonValue(reply ?? ""));
  if (!call || !preserved(call, text, declared, input.isWrite)) return undefined;
  return {
    message: withCall(message, call),
    label: "repaired:shot",
    detail: `re-encoded ${call.name} from the text`,
  };
}

function withCall(
  message: ChatMessage,
  call: { name: string; args: Record<string, unknown> },
): ChatMessage {
  return {
    ...message,
    content: null,
    tool_calls: [
      {
        id: newCallId(),
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      },
    ],
  };
}
