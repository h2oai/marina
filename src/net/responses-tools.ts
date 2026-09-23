// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI Responses API ⇄ chat-completions tool translation for `/v1/responses`
 * passthru. The Responses surface speaks flat function tools and typed input
 * items; every upstream Marina proxies to speaks chat-completions (the
 * Anthropic path translates chat tools onward in `anthropic-tools.ts`), so
 * this module is the one place the two shapes meet:
 *
 *   Responses request                              → chat-completions request
 *   ─────────────────────────────────────────────────────────────────────────
 *   tools[{type:"function", name, description,     → tools[{type:"function",
 *          parameters, strict?}]                       function:{name, description,
 *                                                      parameters, strict}}]
 *   tool_choice "auto" | "none" | "required"       → same string
 *   tool_choice {type:"function", name}            → {type:"function", function:{name}}
 *   parallel_tool_calls                            → parallel_tool_calls
 *   tools[i].type ∉ {"function"} (web_search,      → 400 unsupported_parameter,
 *     file_search, computer_use_preview, …)            param "tools[i].type"
 *
 *   input item                                     → chat message
 *   ─────────────────────────────────────────────────────────────────────────
 *   string / {role, content} / {type:"message"}    → {role, content: text}
 *   {type:"function_call", call_id, name,          → assistant.tool_calls[{id: call_id,
 *      arguments}                                     type:"function", function:{name, arguments}}]
 *      (consecutive calls share one assistant message)
 *   {type:"function_call_output", call_id, output} → {role:"tool", tool_call_id: call_id, content}
 *
 *   chat-completions reply                         → Responses output item
 *   ─────────────────────────────────────────────────────────────────────────
 *   message.tool_calls[{id, function:{name,        → {type:"function_call", id: fc_…,
 *      arguments}}]                                    call_id: id, name, arguments,
 *                                                      status:"completed"}
 *   delta.tool_calls fragments (stream)            → response.output_item.added(function_call)
 *                                                    + response.function_call_arguments.delta/done
 *
 * Nothing here is silently dropped: a tool type that has no chat-completions
 * equivalent is refused before any upstream call, so the client never mistakes
 * a plain answer for "the model chose not to call the tool".
 */

import { UnsupportedParameterError } from "./openai-errors";
import type { OpenAIMessage } from "./passthru-context";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * A malformed Responses request field (a function tool without a name, a
 * `function_call_output` without a `call_id`). Distinct from
 * `UnsupportedParameterError`: the parameter IS supported, the value is wrong.
 */
export class ResponsesRequestError extends Error {
  readonly status = 400;
  constructor(
    readonly param: string,
    detail: string,
  ) {
    super(`Invalid value for '${param}': ${detail}`);
    this.name = "ResponsesRequestError";
  }
}

/**
 * A function call the upstream returned (chat-completions `tool_calls`), kept
 * on the response record so the streaming and non-streaming Responses bodies
 * render the same `function_call` output items. `callId` is the upstream
 * `tool_calls[].id` verbatim — the client sends it back as
 * `function_call_output.call_id`, and the tool-loop continuation below pairs
 * the two.
 */
export interface ResponsesFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

/** A chat message that may carry `tool_calls` (assistant) or `tool_call_id` (tool). */
export interface ChatToolMessage extends OpenAIMessage {
  tool_calls?: Rec[];
  tool_call_id?: string;
}

/** Chat-completions tool fields produced from a Responses request. */
export interface ChatToolFields {
  tools?: Rec[];
  tool_choice?: string | Rec;
  parallel_tool_calls?: boolean;
}

/**
 * Responses `tools` / `tool_choice` / `parallel_tool_calls` → chat-completions
 * fields. Returns `{}` when the request carries none. Throws
 * `UnsupportedParameterError` (`param: "tools[i].type"` / `"tool_choice.type"`)
 * for hosted tool types that have no chat-completions equivalent, and
 * `ResponsesRequestError` for a function tool without a name.
 */
export function translateResponsesTools(body: Rec): ChatToolFields {
  const out: ChatToolFields = {};
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) {
      throw new ResponsesRequestError("tools", "expected an array of tool definitions");
    }
    const tools: Rec[] = [];
    body.tools.forEach((raw, i) => {
      if (!isRec(raw)) throw new ResponsesRequestError(`tools[${i}]`, "expected an object");
      const type = raw.type ?? "function";
      if (type !== "function") {
        throw new UnsupportedParameterError(
          `tools[${i}].type`,
          `Tool type '${String(type)}' is a hosted Responses tool with no chat-completions equivalent; only 'function' tools are forwarded upstream.`,
        );
      }
      // Flat Responses shape is canonical; a chat-shaped `{function:{…}}` tool
      // sent to this route is accepted too rather than refused on a technicality.
      const fn = isRec(raw.function) ? raw.function : raw;
      const name = typeof fn.name === "string" ? fn.name.trim() : "";
      if (!name) throw new ResponsesRequestError(`tools[${i}].name`, "function tools need a name");
      const def: Rec = { name };
      if (typeof fn.description === "string" && fn.description) def.description = fn.description;
      if (isRec(fn.parameters)) def.parameters = fn.parameters;
      if (typeof fn.strict === "boolean") def.strict = fn.strict;
      tools.push({ type: "function", function: def });
    });
    if (tools.length > 0) out.tools = tools;
  }

  const choice = body.tool_choice;
  if (choice !== undefined && choice !== null) {
    if (choice === "auto" || choice === "none" || choice === "required") {
      out.tool_choice = choice;
    } else if (isRec(choice)) {
      if (choice.type === "function") {
        const fn = isRec(choice.function) ? choice.function : choice;
        const name = typeof fn.name === "string" ? fn.name.trim() : "";
        if (!name) {
          throw new ResponsesRequestError(
            "tool_choice.name",
            "a function tool_choice needs a name",
          );
        }
        out.tool_choice = { type: "function", function: { name } };
      } else if (choice.type === "auto" || choice.type === "none" || choice.type === "required") {
        out.tool_choice = choice.type;
      } else {
        throw new UnsupportedParameterError(
          "tool_choice.type",
          `tool_choice type '${String(choice.type)}' has no chat-completions equivalent; use "auto", "none", "required" or {type:"function", name}.`,
        );
      }
    } else {
      throw new ResponsesRequestError(
        "tool_choice",
        'expected "auto", "none", "required" or {type:"function", name}',
      );
    }
  }

  if (typeof body.parallel_tool_calls === "boolean") {
    out.parallel_tool_calls = body.parallel_tool_calls;
  }
  return out;
}

/** Text of a Responses content value (string, or an array of typed parts). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRec(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  if (Array.isArray(output)) {
    const text = contentText(output);
    if (text) return text;
  }
  return JSON.stringify(output);
}

function argumentsText(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined || args === null) return "{}";
  return JSON.stringify(args);
}

export interface ResponsesTurn {
  /** Chat-completions messages for the new input, in order. */
  messages: ChatToolMessage[];
  /**
   * Plain-text rendering of the same input — the conversation channel's user
   * turn, transcript capture, and the in-world agent route all consume text.
   * Function calls render as `assistant: [call name(args)]`, tool results as
   * `[tool result <call_id>] <output>`.
   */
  text: string;
}

/**
 * Responses `input` → chat-completions messages. A string is one user
 * message; an array is walked item by item (see the module table). Items
 * without content are dropped; an unknown item type is refused rather than
 * flattened into text the model would misread.
 */
export function responsesInputToMessages(input: unknown): ResponsesTurn {
  if (typeof input === "string") {
    return { messages: input ? [{ role: "user", content: input }] : [], text: input };
  }
  if (!Array.isArray(input)) return { messages: [], text: "" };

  const messages: ChatToolMessage[] = [];
  const text: string[] = [];
  let openCalls: (ChatToolMessage & { tool_calls: Rec[] }) | undefined;

  input.forEach((item, i) => {
    if (!isRec(item)) return;
    const type = typeof item.type === "string" ? item.type : "message";

    if (type === "function_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const name = typeof item.name === "string" ? item.name : "";
      if (!callId) {
        throw new ResponsesRequestError(
          `input[${i}].call_id`,
          "function_call items need a call_id",
        );
      }
      if (!name)
        throw new ResponsesRequestError(`input[${i}].name`, "function_call items need a name");
      const args = argumentsText(item.arguments);
      const call: Rec = { id: callId, type: "function", function: { name, arguments: args } };
      if (!openCalls) {
        openCalls = { role: "assistant", content: "", tool_calls: [call] };
        messages.push(openCalls);
      } else {
        openCalls.tool_calls.push(call);
      }
      text.push(`assistant: [call ${name}(${args})]`);
      return;
    }

    openCalls = undefined;

    if (type === "function_call_output") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      if (!callId) {
        throw new ResponsesRequestError(
          `input[${i}].call_id`,
          "function_call_output items need a call_id",
        );
      }
      const output = outputText(item.output);
      const result: ChatToolMessage = { role: "tool", tool_call_id: callId, content: output };
      messages.push(result);
      text.push(`[tool result ${callId}] ${output}`);
      return;
    }

    if (type === "message") {
      const role = typeof item.role === "string" && item.role ? item.role : "user";
      const body = contentText(item.content);
      if (!body) return;
      messages.push({ role, content: body });
      text.push(role === "user" ? body : `${role}: ${body}`);
      return;
    }

    throw new UnsupportedParameterError(
      `input[${i}].type`,
      `Input item type '${type}' is not forwarded on this route; send message, function_call or function_call_output items.`,
    );
  });

  return { messages, text: text.filter(Boolean).join("\n") };
}

/** True when `messages` contain a tool result for `callId`. */
function hasToolResult(messages: OpenAIMessage[], callId: string): boolean {
  return messages.some(
    (m) => m.role === "tool" && (m as { tool_call_id?: unknown }).tool_call_id === callId,
  );
}

/** True when `messages` already replay an assistant `tool_calls` entry for `callId`. */
function hasToolCall(messages: OpenAIMessage[], callId: string): boolean {
  return messages.some((m) => {
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    return Array.isArray(calls) && calls.some((c) => isRec(c) && c.id === callId);
  });
}

/**
 * Tool-loop continuation over server-side state. A client that threads with
 * `previous_response_id` sends only the `function_call_output` items — the
 * calls themselves live on the stored prior response, not in the request.
 * The conversation channel replays the prior assistant turn as text, so the
 * structured `tool_calls` are re-attached here: onto the trailing assistant
 * history message when there is one, else as a fresh assistant message. Only
 * calls the new turn answers (and does not already restate) are restored, so
 * the upstream sees every `role:tool` paired with a `tool_calls` entry.
 */
export function restorePriorToolCalls(
  history: OpenAIMessage[],
  priorCalls: ReadonlyArray<ResponsesFunctionCall> | undefined,
  turn: OpenAIMessage[],
): ChatToolMessage[] {
  if (!priorCalls?.length) return history;
  const needed = priorCalls.filter(
    (c) => hasToolResult(turn, c.callId) && !hasToolCall(turn, c.callId),
  );
  if (needed.length === 0) return history;
  const toolCalls: Rec[] = needed.map((c) => ({
    id: c.callId,
    type: "function",
    function: { name: c.name, arguments: c.arguments },
  }));
  const last = history[history.length - 1];
  if (last && last.role === "assistant" && !(last as { tool_calls?: unknown }).tool_calls) {
    const merged: ChatToolMessage = {
      ...last,
      content: typeof last.content === "string" ? last.content : "",
      tool_calls: toolCalls,
    };
    return [...history.slice(0, -1), merged];
  }
  const fresh: ChatToolMessage = { role: "assistant", content: "", tool_calls: toolCalls };
  return [...history, fresh];
}

/**
 * Chat-completions `message.tool_calls` → `ResponsesFunctionCall[]`.
 * `callId` is the upstream id verbatim (minted only when the upstream sent none).
 */
export function chatToolCallsToResponses(rawCalls: unknown): ResponsesFunctionCall[] | undefined {
  if (!Array.isArray(rawCalls)) return undefined;
  const calls = rawCalls.filter(isRec).map((c) => {
    const fn = (isRec(c.function) ? c.function : {}) as { name?: unknown; arguments?: unknown };
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
  });
  return calls.length > 0 ? calls : undefined;
}
