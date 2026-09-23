// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI chat-completions ⇄ Anthropic Messages translation for the passthru
 * proxy (`proxyToAnthropic` in model-api.ts).
 *
 * The previous proxy rebuilt the upstream body field by field and dropped
 * `tools`, `tool_choice`, `functions`, `stop` and `response_format`, so an
 * OpenAI-SDK client pointed at an Anthropic-backed Marina got plain text
 * where it expected tool calls — silently. Everything here is a faithful,
 * lossless-where-possible mapping in both directions; a parameter with no
 * Anthropic equivalent raises `UnsupportedParameterError` (→ 400
 * `unsupported_parameter`) instead of being ignored.
 *
 * Translation table (request):
 *   tools[{type:"function",function:{name,description,parameters}}]
 *                                → tools[{name,description,input_schema}]
 *   functions[{name,description,parameters}] (legacy)  → same
 *   tool_choice "auto"|"none"|"required"|{function:{name}}
 *                                → {type:"auto"|"none"|"any"|"tool",name}
 *   function_call "auto"|"none"|{name} (legacy)        → same
 *   parallel_tool_calls:false    → tool_choice.disable_parallel_tool_use:true
 *   stop (string | string[])     → stop_sequences[]
 *   max_tokens | max_completion_tokens → max_tokens (default 4096)
 *   user                         → metadata.user_id
 *   response_format json_schema  → output_config.format {type:"json_schema",schema}
 *   response_format json_object  → 400 unsupported_parameter
 *   n > 1                        → 400 unsupported_parameter
 *   system/developer messages    → system[] text blocks (cache_control kept)
 *   user text/image_url parts    → text / image blocks (cache_control kept)
 *   assistant tool_calls         → tool_use blocks (arguments JSON-parsed)
 *   role:"tool" results          → tool_result blocks, consecutive results
 *                                  grouped into ONE user message
 * Translation table (response):
 *   text blocks                  → message.content (joined; thinking skipped)
 *   tool_use blocks              → message.tool_calls, finish_reason "tool_calls"
 *   stop_reason end_turn|stop_sequence → "stop"; max_tokens → "length";
 *   refusal → "content_filter"
 *   usage input/cache_read/cache_creation → prompt_tokens (sum),
 *   prompt_tokens_details.{cached_tokens, cache_creation_tokens,
 *   cache_write_tokens}, cache_read_input_tokens, cache_creation_input_tokens
 *   (`cache_creation_tokens` is Marina's extension field; `cache_write_tokens`
 *   is the spelling pi-ai's openai-completions client reads — both carry the
 *   same number so an OpenAI-shaped client sees cache WRITES, not only reads)
 *
 * Cache breakpoints (`placeCacheBreakpoints`, auto-cache only): the proxy
 * appends its memory addendum as the LAST system block, so a breakpoint on
 * the last block alone re-writes the whole prefix whenever the relevance gate
 * toggles the addendum. The layout is therefore: last STABLE system block
 * (the caller's own prompt) → last system block → last tool, within
 * Anthropic's four-breakpoint limit and never on top of a client marker.
 */

import { UnsupportedParameterError } from "./openai-errors";

// ─── Types (loose on purpose: this is a gateway over untrusted client JSON) ──

export interface CacheControl {
  type: "ephemeral";
  ttl?: string;
}

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: unknown;
  cache_control?: CacheControl;
}

export type AnthropicToolChoice =
  | { type: "auto" | "any" | "none"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export type AnthropicBlock =
  | AnthropicTextBlock
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
      cache_control?: CacheControl;
    }
  | { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: CacheControl }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string | AnthropicTextBlock[];
      is_error?: boolean;
      cache_control?: CacheControl;
    };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: {
    cached_tokens: number;
    /** Cache WRITE tokens (Anthropic `cache_creation_input_tokens`). Marina extension. */
    cache_creation_tokens?: number;
    /** Same value under the name pi-ai's OpenAI-completions client reads. */
    cache_write_tokens?: number;
  };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cacheControlOf(value: unknown): CacheControl | undefined {
  if (!isRec(value)) return undefined;
  const cc = value.cache_control;
  if (!isRec(cc) || cc.type !== "ephemeral") return undefined;
  return typeof cc.ttl === "string" ? { type: "ephemeral", ttl: cc.ttl } : { type: "ephemeral" };
}

function newToolCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

/**
 * OpenAI `tools` (function type) or legacy `functions` → Anthropic `tools`.
 * A `cache_control` marker on the tool (or on its `function` object, where
 * pi-ai puts it) is preserved so the tool prefix can be cached upstream.
 */
export function openaiToolsToAnthropic(tools: unknown, functions?: unknown): AnthropicToolDef[] {
  const out: AnthropicToolDef[] = [];
  if (Array.isArray(tools)) {
    for (const raw of tools) {
      if (!isRec(raw)) continue;
      if (raw.type !== undefined && raw.type !== "function") {
        throw new UnsupportedParameterError(
          "tools",
          `Tool type '${String(raw.type)}' has no Anthropic Messages equivalent; only 'function' tools are translated.`,
        );
      }
      const fn = isRec(raw.function) ? raw.function : raw;
      const name = typeof fn.name === "string" ? fn.name : "";
      if (!name) continue;
      const def: AnthropicToolDef = {
        name,
        ...(typeof fn.description === "string" && fn.description
          ? { description: fn.description }
          : {}),
        input_schema: isRec(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
      };
      const cc = cacheControlOf(raw) ?? cacheControlOf(fn);
      if (cc) def.cache_control = cc;
      out.push(def);
    }
  }
  if (Array.isArray(functions)) {
    for (const raw of functions) {
      if (!isRec(raw) || typeof raw.name !== "string" || !raw.name) continue;
      if (out.some((t) => t.name === raw.name)) continue;
      out.push({
        name: raw.name,
        ...(typeof raw.description === "string" && raw.description
          ? { description: raw.description }
          : {}),
        input_schema: isRec(raw.parameters) ? raw.parameters : { type: "object", properties: {} },
      });
    }
  }
  return out;
}

/**
 * OpenAI `tool_choice` (or legacy `function_call`) → Anthropic `tool_choice`.
 * `parallel_tool_calls: false` becomes `disable_parallel_tool_use`. Returns
 * undefined when the client did not constrain tool use (Anthropic default = auto).
 */
export function openaiToolChoiceToAnthropic(
  choice: unknown,
  parallelToolCalls?: unknown,
): AnthropicToolChoice | undefined {
  let mapped: AnthropicToolChoice | undefined;
  if (choice === "auto") mapped = { type: "auto" };
  else if (choice === "none") mapped = { type: "none" };
  else if (choice === "required" || choice === "any") mapped = { type: "any" };
  else if (isRec(choice)) {
    const fn = isRec(choice.function) ? choice.function : choice;
    const name = typeof fn.name === "string" ? fn.name : undefined;
    if (name) mapped = { type: "tool", name };
    else if (choice.type === "auto" || choice.type === "none" || choice.type === "any")
      mapped = { type: choice.type };
    else if (choice.type === "required") mapped = { type: "any" };
  }
  if (parallelToolCalls === false) {
    mapped = mapped ?? { type: "auto" };
    if (mapped.type !== "none") mapped.disable_parallel_tool_use = true;
  }
  return mapped;
}

// ─── Messages ───────────────────────────────────────────────────────────────

/** Text of an OpenAI content value (string or content-part array). */
function textPartsOf(content: unknown): AnthropicTextBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicTextBlock[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
      continue;
    }
    if (!isRec(part)) continue;
    const kind = part.type;
    if (kind === undefined || kind === "text" || kind === "refusal" || kind === "input_text") {
      const text = typeof part.text === "string" ? part.text : "";
      if (!text) continue;
      const block: AnthropicTextBlock = { type: "text", text };
      const cc = cacheControlOf(part);
      if (cc) block.cache_control = cc;
      blocks.push(block);
    }
  }
  return blocks;
}

function imageBlock(part: Rec): AnthropicBlock | undefined {
  const img = isRec(part.image_url) ? part.image_url : part;
  const url = typeof img.url === "string" ? img.url : undefined;
  if (!url) return undefined;
  const cc = cacheControlOf(part);
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataUrl) {
    return {
      type: "image",
      source: { type: "base64", media_type: dataUrl[1]!, data: dataUrl[2]! },
      ...(cc ? { cache_control: cc } : {}),
    };
  }
  return { type: "image", source: { type: "url", url }, ...(cc ? { cache_control: cc } : {}) };
}

/** User-role content: text + image parts → blocks; a plain string stays a string. */
function userContent(content: unknown, messageCc?: CacheControl): string | AnthropicBlock[] {
  if (typeof content === "string") {
    if (!messageCc) return content;
    return content ? [{ type: "text", text: content, cache_control: messageCc }] : [];
  }
  if (!Array.isArray(content)) return "";
  const blocks: AnthropicBlock[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
      continue;
    }
    if (!isRec(part)) continue;
    if (part.type === "image_url" || part.type === "image") {
      const block = imageBlock(part);
      if (block) blocks.push(block);
      continue;
    }
    if (part.type === "input_audio" || part.type === "file" || part.type === "audio") {
      throw new UnsupportedParameterError(
        `messages[].content[].type`,
        `Content part type '${String(part.type)}' cannot be forwarded to Anthropic Messages.`,
      );
    }
    blocks.push(...textPartsOf([part]));
  }
  if (messageCc && blocks.length > 0) {
    const last = blocks[blocks.length - 1]!;
    if (!last.cache_control) last.cache_control = messageCc;
  }
  return blocks;
}

function toolResultContent(content: unknown): string | AnthropicTextBlock[] {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    const blocks = textPartsOf(content);
    return blocks.length > 0 ? blocks : "";
  }
  return JSON.stringify(content);
}

function parseArguments(raw: unknown): unknown {
  if (isRec(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRec(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolUseBlocks(toolCalls: unknown): AnthropicBlock[] {
  if (!Array.isArray(toolCalls)) return [];
  const blocks: AnthropicBlock[] = [];
  for (const call of toolCalls) {
    if (!isRec(call)) continue;
    const fn = isRec(call.function) ? call.function : call;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    blocks.push({
      type: "tool_use",
      id: typeof call.id === "string" && call.id ? call.id : newToolCallId(),
      name,
      input: parseArguments(fn.arguments),
    });
  }
  return blocks;
}

export interface TranslatedMessages {
  system: AnthropicTextBlock[];
  messages: AnthropicMessage[];
}

/**
 * OpenAI `messages` → Anthropic `system` blocks + `messages`. Every
 * system/developer message becomes a text block (order kept, `cache_control`
 * kept); consecutive `role:"tool"` results collapse into ONE user message of
 * `tool_result` blocks (Anthropic requires all results for a parallel call
 * batch in a single turn). Empty messages are dropped — Anthropic rejects
 * empty text blocks.
 */
export function openaiMessagesToAnthropic(messages: unknown): TranslatedMessages {
  const system: AnthropicTextBlock[] = [];
  const out: AnthropicMessage[] = [];
  if (!Array.isArray(messages)) return { system, messages: out };

  let pendingResults: AnthropicBlock[] = [];
  const flushResults = () => {
    if (pendingResults.length === 0) return;
    out.push({ role: "user", content: pendingResults });
    pendingResults = [];
  };

  for (const raw of messages) {
    if (!isRec(raw)) continue;
    const role = raw.role;
    const messageCc = cacheControlOf(raw);

    if (role === "system" || role === "developer") {
      flushResults();
      const blocks = textPartsOf(raw.content);
      if (blocks.length > 0 && messageCc && !blocks[blocks.length - 1]!.cache_control) {
        blocks[blocks.length - 1]!.cache_control = messageCc;
      }
      system.push(...blocks);
      continue;
    }

    if (role === "tool") {
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: typeof raw.tool_call_id === "string" ? raw.tool_call_id : "",
        content: toolResultContent(raw.content),
      };
      if (messageCc) block.cache_control = messageCc;
      pendingResults.push(block);
      continue;
    }

    if (role === "function") {
      // Legacy function-call result: no tool_use_id to pair with — surface it as text.
      flushResults();
      const name = typeof raw.name === "string" ? raw.name : "function";
      const text = typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content);
      out.push({ role: "user", content: [{ type: "text", text: `[${name} result] ${text}` }] });
      continue;
    }

    flushResults();
    if (role === "assistant") {
      const blocks: AnthropicBlock[] = [...textPartsOf(raw.content)];
      if (messageCc && blocks.length > 0 && !blocks[blocks.length - 1]!.cache_control) {
        blocks[blocks.length - 1]!.cache_control = messageCc;
      }
      blocks.push(...toolUseBlocks(raw.tool_calls));
      if (isRec(raw.function_call) && typeof raw.function_call.name === "string") {
        blocks.push(...toolUseBlocks([{ id: newToolCallId(), function: raw.function_call }]));
      }
      if (blocks.length === 0) continue;
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    // user (and any unknown role, treated as user input)
    const content = userContent(raw.content, messageCc);
    if (typeof content === "string" ? !content : content.length === 0) continue;
    out.push({ role: "user", content });
  }
  flushResults();
  return { system, messages: out };
}

// ─── Request ────────────────────────────────────────────────────────────────

export interface AnthropicRequestOptions {
  /** Place auto-cache breakpoints (`placeCacheBreakpoints`) on system blocks and tools. */
  autoCache?: boolean;
  /**
   * The LAST system block is the proxy's injected memory addendum (volatile),
   * so the caller's stable prompt ends one block earlier. Drives where the
   * stable-block breakpoint lands.
   */
  injectedSystemTail?: boolean;
  /**
   * Native Anthropic body (a `/v1/messages` client). When present it is
   * forwarded VERBATIM — system blocks, message blocks, tools, tool_choice,
   * thinking, metadata and their `cache_control` markers — instead of being
   * re-derived from the OpenAI translation. Only model/stream are overridden.
   */
  native?: Record<string, unknown>;
}

/** Anthropic allows at most four `cache_control` breakpoints per request. */
export const ANTHROPIC_CACHE_BREAKPOINT_LIMIT = 4;

export interface CacheBreakpointOptions {
  /** The last system block is the proxy's injected memory addendum. */
  injectedSystemTail?: boolean;
}

function isTextBlock(value: unknown): value is Rec {
  return isRec(value) && value.type === "text";
}

/** Number of `cache_control` markers on an array of blocks / tools (top level only). */
function countMarkers(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const item of list) if (cacheControlOf(item)) n++;
  return n;
}

/** Markers on messages: message-level plus every content block. */
function countMessageMarkers(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const message of messages) {
    if (!isRec(message)) continue;
    if (cacheControlOf(message)) n++;
    n += countMarkers(message.content);
  }
  return n;
}

/**
 * Auto-cache breakpoint placement. Layout, in priority order and within the
 * four-breakpoint limit (markers the client already set count against it):
 *
 *   1. the last STABLE system block — the caller's own prompt; when the proxy
 *      appended a memory addendum (`injectedSystemTail`) that is the block
 *      BEFORE the last one, otherwise the last block itself. This is the one
 *      that keeps the prefix cached when the relevance-gated memory block
 *      toggles between requests;
 *   2. the last system block (the memory addendum) — only when the client set
 *      no marker anywhere, so identical memory also reads from cache;
 *   3. the last tool — only when the client set no marker anywhere.
 *
 * A client that placed its own markers (pi-ai with
 * `cacheControlFormat: "anthropic"`, an Anthropic SDK on `/v1/messages`) keeps
 * every one of them; the proxy then adds ONLY the stable-block breakpoint, and
 * only if that block has none. Non-text blocks are never marked. Inputs are
 * not mutated.
 */
export function placeCacheBreakpoints(
  request: { system?: unknown; tools?: unknown; messages?: unknown },
  opts: CacheBreakpointOptions = {},
): { system?: unknown; tools?: unknown } {
  const system = Array.isArray(request.system) ? [...request.system] : undefined;
  const tools = Array.isArray(request.tools) ? [...request.tools] : undefined;
  let used =
    countMarkers(request.system) +
    countMarkers(request.tools) +
    countMessageMarkers(request.messages);
  const clientMarked = used > 0;
  const mark = (list: unknown[], index: number): void => {
    if (index < 0 || index >= list.length) return;
    const block = list[index];
    if (!isRec(block) || cacheControlOf(block)) return;
    if (used >= ANTHROPIC_CACHE_BREAKPOINT_LIMIT) return;
    list[index] = { ...block, cache_control: { type: "ephemeral" } };
    used++;
  };

  if (system && system.length > 0) {
    const last = system.length - 1;
    const stable = opts.injectedSystemTail ? last - 1 : last;
    if (stable >= 0 && isTextBlock(system[stable])) mark(system, stable);
    if (!clientMarked && stable !== last && isTextBlock(system[last])) mark(system, last);
  }
  if (!clientMarked && tools && tools.length > 0) mark(tools, tools.length - 1);

  return {
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
  };
}

/** System-only view of `placeCacheBreakpoints` (no injected tail, no tools). */
export function applyAutoCache(system: unknown): unknown {
  if (!Array.isArray(system) || system.length === 0) return system;
  return placeCacheBreakpoints({ system }).system;
}

function stopSequences(stop: unknown): string[] | undefined {
  if (typeof stop === "string") return stop ? [stop] : undefined;
  if (Array.isArray(stop)) {
    const list = stop.filter((s): s is string => typeof s === "string" && s.length > 0);
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

function outputConfig(responseFormat: unknown): Rec | undefined {
  if (!isRec(responseFormat)) return undefined;
  const type = responseFormat.type;
  if (type === undefined || type === "text") return undefined;
  if (type === "json_schema") {
    const spec = isRec(responseFormat.json_schema) ? responseFormat.json_schema : responseFormat;
    const schema = isRec(spec.schema) ? spec.schema : undefined;
    if (!schema) {
      throw new UnsupportedParameterError(
        "response_format.json_schema.schema",
        "A JSON schema is required to translate response_format to Anthropic output_config.",
      );
    }
    return { format: { type: "json_schema", schema } };
  }
  throw new UnsupportedParameterError(
    "response_format",
    `response_format type '${String(type)}' has no Anthropic Messages equivalent; use type 'json_schema' with a schema.`,
  );
}

/**
 * Build the Anthropic Messages request for an OpenAI chat-completions body.
 * Throws `UnsupportedParameterError` for `n > 1`, `response_format` without
 * a schema, non-function tools and audio/file content parts.
 */
// ─── Extended thinking ──────────────────────────────────────────────────────

/** Tokens always left for the answer beside a thinking budget (mirrors pi-ai). */
export const MIN_ANSWER_TOKENS = 1024;

/**
 * `reasoning_effort` level → Anthropic `budget_tokens`. The same table pi-ai
 * uses for its Anthropic provider (`DEFAULT_THINKING_BUDGETS`), so an agent on
 * the `marina/*` proxy and a direct pi-ai agent think with equal depth at the
 * same level. `xhigh`/`max` clamp to `high`; `none`/`off`/`minimal-less`
 * values disable thinking.
 */
export const THINKING_BUDGET_TOKENS: Readonly<Record<string, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 16384,
  max: 16384,
};

/**
 * Anthropic `thinking` parameter for an OpenAI-shaped body, or undefined when
 * thinking stays off. Accepted spellings, in precedence order:
 *  - `thinking: { type: "enabled", budget_tokens }` — Anthropic-native, forwarded
 *    (a `type: "disabled"` object turns thinking off even if `reasoning_effort` is set);
 *  - `thinking: "<level>"` or `thinking: { effort: "<level>" }` — level names;
 *  - `reasoning_effort: "<level>"` — the OpenAI spelling pi-ai emits.
 * The budget is clamped so at least `MIN_ANSWER_TOKENS` fit under `max_tokens`
 * when the caller set a cap large enough; otherwise `buildAnthropicRequest`
 * raises `max_tokens` instead.
 */
export function anthropicThinking(
  body: Record<string, unknown>,
  maxTokens: number | undefined,
): { type: "enabled"; budget_tokens: number } | undefined {
  const raw = body.thinking;
  let budget: number | undefined;
  if (raw && typeof raw === "object") {
    const obj = raw as { type?: unknown; budget_tokens?: unknown; effort?: unknown };
    if (obj.type === "disabled") return undefined;
    if (typeof obj.budget_tokens === "number" && Number.isFinite(obj.budget_tokens)) {
      budget = Math.max(1024, Math.floor(obj.budget_tokens));
    } else if (typeof obj.effort === "string") {
      budget = THINKING_BUDGET_TOKENS[obj.effort.toLowerCase()];
    } else if (obj.type === "enabled") {
      budget = THINKING_BUDGET_TOKENS.medium;
    }
  } else if (typeof raw === "string") {
    budget = THINKING_BUDGET_TOKENS[raw.toLowerCase()];
  }
  if (budget === undefined && typeof body.reasoning_effort === "string") {
    budget = THINKING_BUDGET_TOKENS[body.reasoning_effort.toLowerCase()];
  }
  if (budget === undefined) return undefined;
  // Fit under the caller's cap when it leaves room; a too-small cap is raised
  // by the caller instead of silently shrinking the requested depth to nothing.
  if (maxTokens !== undefined && maxTokens - MIN_ANSWER_TOKENS >= 1024) {
    budget = Math.min(budget, maxTokens - MIN_ANSWER_TOKENS);
  }
  return { type: "enabled", budget_tokens: budget };
}

export function buildAnthropicRequest(
  body: Record<string, unknown>,
  model: string,
  stream: boolean,
  opts: AnthropicRequestOptions = {},
): Record<string, unknown> {
  if (typeof body.n === "number" && body.n > 1) {
    throw new UnsupportedParameterError(
      "n",
      "Anthropic Messages returns one completion per request; send n=1 or omit it.",
    );
  }

  if (opts.native) {
    const native = { ...opts.native };
    delete native.stream;
    const system =
      typeof native.system === "string" && native.system
        ? [{ type: "text", text: native.system }]
        : native.system;
    const maxTokens = typeof native.max_tokens === "number" ? native.max_tokens : 4096;
    const out: Rec = { ...native, model, max_tokens: maxTokens, stream };
    if (Array.isArray(system) && system.length > 0) {
      out.system = system;
    } else {
      delete out.system;
    }
    if (opts.autoCache) {
      const placed = placeCacheBreakpoints(
        { system: out.system, tools: out.tools, messages: out.messages },
        { injectedSystemTail: opts.injectedSystemTail },
      );
      if (placed.system) out.system = placed.system;
      if (placed.tools) out.tools = placed.tools;
    }
    return out;
  }

  const translated = openaiMessagesToAnthropic(body.messages);
  let tools: AnthropicToolDef[] = openaiToolsToAnthropic(body.tools, body.functions);
  const toolChoice = openaiToolChoiceToAnthropic(
    body.tool_choice ?? body.function_call,
    body.parallel_tool_calls,
  );
  const explicitMaxTokens =
    typeof body.max_tokens === "number"
      ? body.max_tokens
      : typeof body.max_completion_tokens === "number"
        ? body.max_completion_tokens
        : undefined;
  const maxTokens = explicitMaxTokens ?? 4096;
  const stops = stopSequences(body.stop);
  const config = outputConfig(body.response_format);
  let system: unknown = translated.system;
  if (opts.autoCache) {
    const placed = placeCacheBreakpoints(
      { system, tools, messages: translated.messages },
      { injectedSystemTail: opts.injectedSystemTail },
    );
    system = placed.system ?? system;
    if (Array.isArray(placed.tools)) tools = placed.tools as AnthropicToolDef[];
  }
  // Only a cap the CLIENT set clamps the thinking budget; the 4096 default is
  // raised to fit the requested depth instead.
  const thinking = anthropicThinking(body, explicitMaxTokens);

  return {
    model,
    // Extended thinking must leave answer room: Anthropic requires
    // budget_tokens < max_tokens, so the ceiling is raised when the client's
    // cap would not fit the budget.
    max_tokens: thinking
      ? Math.max(maxTokens, thinking.budget_tokens + MIN_ANSWER_TOKENS)
      : maxTokens,
    stream,
    ...(thinking ? { thinking } : {}),
    // Claude rejects sampling overrides while thinking is enabled
    // ("temperature may only be set to 1", top_p likewise) — omit both.
    ...(!thinking && typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(!thinking && typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(stops ? { stop_sequences: stops } : {}),
    ...(typeof body.user === "string" && body.user ? { metadata: { user_id: body.user } } : {}),
    ...(Array.isArray(system) && system.length > 0 ? { system } : {}),
    messages: translated.messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && toolChoice ? { tool_choice: toolChoice } : {}),
    ...(config ? { output_config: config } : {}),
  };
}

// ─── Response ───────────────────────────────────────────────────────────────

/**
 * Concatenate the text blocks of an Anthropic Messages response. Thinking,
 * tool-use and any future non-text blocks are skipped; `content[0].text` is
 * NOT sufficient because the Claude 5 family emits a `thinking` block first.
 */
export function anthropicTextContent(
  blocks: ReadonlyArray<{ type?: string; text?: string }> | undefined,
): string {
  if (!blocks) return "";
  return blocks
    .filter((block) => (block.type === undefined || block.type === "text") && block.text)
    .map((block) => block.text as string)
    .join("");
}

/** `tool_use` blocks → OpenAI `tool_calls`. */
export function anthropicToolCalls(
  blocks: ReadonlyArray<{ type?: string; id?: string; name?: string; input?: unknown }> | undefined,
): OpenAIToolCall[] {
  if (!blocks) return [];
  const calls: OpenAIToolCall[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    calls.push({
      id: block.id ?? newToolCallId(),
      type: "function",
      function: {
        name: block.name ?? "",
        arguments: JSON.stringify(block.input ?? {}),
      },
    });
  }
  return calls;
}

export function anthropicFinishReason(
  stopReason: string | null | undefined,
  hasToolCalls: boolean,
): string {
  if (hasToolCalls || stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "refusal") return "content_filter";
  return "stop";
}

/**
 * Anthropic `usage` → OpenAI `usage`. Anthropic's `input_tokens` EXCLUDES the
 * cached prefix; OpenAI's `prompt_tokens` includes it, with the cached share
 * reported in `prompt_tokens_details.cached_tokens`. The raw Anthropic cache
 * counters ride along so traces and receipts can show cache hits verbatim.
 */
export function anthropicUsageToOpenai(usage: unknown): OpenAIUsage {
  const u = isRec(usage) ? usage : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  const prompt = input + cacheRead + cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: {
      cached_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
      cache_write_tokens: cacheWrite,
    },
    ...(u.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(u.cache_creation_input_tokens !== undefined
      ? { cache_creation_input_tokens: cacheWrite }
      : {}),
  };
}

/** Non-streaming Anthropic message → OpenAI `chat.completion`. */
export function anthropicMessageToOpenai(
  data: {
    id?: string;
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string | null;
    usage?: unknown;
  },
  model: string,
): Record<string, unknown> {
  const text = anthropicTextContent(data.content);
  const toolCalls = anthropicToolCalls(data.content);
  const message: Rec = {
    role: "assistant",
    content: text || (toolCalls.length > 0 ? null : ""),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: data.id ?? `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: anthropicFinishReason(data.stop_reason, toolCalls.length > 0),
      },
    ],
    usage: anthropicUsageToOpenai(data.usage),
  };
}

// ─── Streaming ──────────────────────────────────────────────────────────────

/**
 * Incremental Anthropic SSE → OpenAI `chat.completion.chunk` SSE translator.
 * Feed raw upstream bytes (as text) to `push`; each call returns zero or more
 * complete `data: …\n\n` frames. `flush` drains the line buffer at EOF.
 *
 *   message_start                → role chunk (captures id + input usage)
 *   content_block_start tool_use → delta.tool_calls[{index,id,type,function:{name,arguments:""}}]
 *   content_block_delta text     → delta.content
 *   content_block_delta input_json → delta.tool_calls[{index,function:{arguments}}]
 *   message_delta                → stop_reason + output usage
 *   message_stop                 → finish chunk (finish_reason; usage when
 *                                  stream_options.include_usage) + [DONE]
 */
export class AnthropicSseTranslator {
  private buffer = "";
  private id: string;
  private readonly created = Math.floor(Date.now() / 1000);
  private roleSent = false;
  private finished = false;
  private sawToolUse = false;
  private stopReason: string | null = null;
  private usage: Rec = {};
  /** Anthropic content-block index → OpenAI tool_calls index. */
  private readonly toolIndex = new Map<number, number>();
  private nextToolIndex = 0;

  constructor(
    private readonly model: string,
    private readonly includeUsage = false,
    /** Final OpenAI-shaped usage, reported once at stream end whether or not the
     *  client asked for `stream_options.include_usage` — the proxy's lifecycle
     *  `completed` event records tokens the client never sees. */
    private readonly onUsage?: (usage: OpenAIUsage) => void,
  ) {
    this.id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
  }

  get done(): boolean {
    return this.finished;
  }

  push(text: string): string[] {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const frames: string[] = [];
    for (const line of lines) frames.push(...this.line(line));
    return frames;
  }

  flush(): string[] {
    const frames: string[] = [];
    if (this.buffer.trim()) frames.push(...this.line(this.buffer));
    this.buffer = "";
    if (!this.finished && this.roleSent) frames.push(...this.finish());
    return frames;
  }

  private chunk(delta: Rec, finishReason: string | null = null, extra: Rec = {}): string {
    return `data: ${JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra,
    })}\n\n`;
  }

  private role(): string[] {
    if (this.roleSent) return [];
    this.roleSent = true;
    return [this.chunk({ role: "assistant" })];
  }

  private finish(): string[] {
    if (this.finished) return [];
    this.finished = true;
    const frames = this.role();
    const finishReason = anthropicFinishReason(this.stopReason, this.sawToolUse);
    const usage = Object.keys(this.usage).length > 0 ? anthropicUsageToOpenai(this.usage) : null;
    if (usage && this.onUsage) this.onUsage(usage);
    const extra = this.includeUsage ? { usage: usage ?? anthropicUsageToOpenai(this.usage) } : {};
    frames.push(this.chunk({}, finishReason, extra), "data: [DONE]\n\n");
    return frames;
  }

  private line(raw: string): string[] {
    if (this.finished) return [];
    const line = raw.trim();
    if (!line.startsWith("data:")) return [];
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return [];
    let event: Rec;
    try {
      event = JSON.parse(payload) as Rec;
    } catch {
      return [];
    }
    const frames: string[] = [];
    switch (event.type) {
      case "message_start": {
        const message = isRec(event.message) ? event.message : {};
        if (typeof message.id === "string" && message.id) this.id = message.id;
        if (isRec(message.usage)) this.usage = { ...this.usage, ...message.usage };
        frames.push(...this.role());
        break;
      }
      case "content_block_start": {
        const block = isRec(event.content_block) ? event.content_block : {};
        if (block.type === "tool_use" && typeof event.index === "number") {
          this.sawToolUse = true;
          const index = this.nextToolIndex++;
          this.toolIndex.set(event.index, index);
          frames.push(...this.role());
          frames.push(
            this.chunk({
              tool_calls: [
                {
                  index,
                  id: typeof block.id === "string" ? block.id : newToolCallId(),
                  type: "function",
                  function: {
                    name: typeof block.name === "string" ? block.name : "",
                    arguments: "",
                  },
                },
              ],
            }),
          );
        }
        break;
      }
      case "content_block_delta": {
        const delta = isRec(event.delta) ? event.delta : {};
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          frames.push(...this.role());
          frames.push(this.chunk({ content: delta.text }));
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const index = this.toolIndex.get(typeof event.index === "number" ? event.index : -1);
          if (index !== undefined && delta.partial_json) {
            frames.push(
              this.chunk({ tool_calls: [{ index, function: { arguments: delta.partial_json } }] }),
            );
          }
        }
        break;
      }
      case "message_delta": {
        const delta = isRec(event.delta) ? event.delta : {};
        if (typeof delta.stop_reason === "string") this.stopReason = delta.stop_reason;
        if (isRec(event.usage)) this.usage = { ...this.usage, ...event.usage };
        break;
      }
      case "message_stop":
        frames.push(...this.finish());
        break;
      case "error": {
        const err = isRec(event.error) ? event.error : {};
        frames.push(
          `data: ${JSON.stringify({
            error: {
              message: typeof err.message === "string" ? err.message : "upstream stream error",
              type: typeof err.type === "string" ? err.type : "server_error",
              param: null,
              code: "upstream_error",
            },
          })}\n\n`,
        );
        frames.push(...this.finish());
        break;
      }
      default:
        break;
    }
    return frames;
  }
}

/** Pipe an Anthropic SSE body through the translator into OpenAI SSE bytes. */
export function translateAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  includeUsage = false,
  onUsage?: (usage: OpenAIUsage) => void,
): ReadableStream<Uint8Array> {
  const translator = new AnthropicSseTranslator(model, includeUsage, onUsage);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const frame of translator.push(decoder.decode(chunk, { stream: true }))) {
          controller.enqueue(encoder.encode(frame));
        }
      },
      flush(controller) {
        for (const frame of translator.flush()) controller.enqueue(encoder.encode(frame));
      },
    }),
  );
}
