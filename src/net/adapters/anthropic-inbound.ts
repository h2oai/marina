// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface AnthropicInboundDeps {
  runInternal: (
    body: Record<string, unknown>,
    opts: { stream: boolean; model: string },
  ) => Promise<Response>;
}

type Block = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
};

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIMessage = {
  role: string;
  content: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, anthropic-version, X-Marina-Agent, X-Marina-Context",
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function anthropicSystemToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((block): block is Block => !!block && (block as Block).type === "text")
    .map((block) => block.text ?? "")
    .join("\n\n");
}

/**
 * A content block this route cannot carry. The bridge refuses it with a 400
 * naming the block (`messages[i].content[j]`) rather than dropping it.
 */
export class AnthropicTranslationError extends Error {
  constructor(
    readonly param: string,
    message: string,
  ) {
    super(`${param}: ${message}`);
    this.name = "AnthropicTranslationError";
  }
}

/** Placeholder tool text when a tool result carries only images (pi-ai's convention). */
const TOOL_IMAGE_PLACEHOLDER = "(see attached image)";
/** Lead text of the user message that carries a tool result's images. */
const TOOL_IMAGES_LEAD = "Attached image(s) from tool result:";

/**
 * An Anthropic `image` block as an OpenAI `image_url` part: a base64 source
 * becomes a `data:` URL, a url source is passed as is. Any other source kind
 * (a Files API `file` id, ...) is refused.
 */
function imagePart(block: Block, param: string): OpenAIContentPart {
  const src = block.source;
  if (src?.type === "base64" && typeof src.data === "string" && src.data) {
    const mediaType = typeof src.media_type === "string" ? src.media_type : "";
    if (!/^image\/(png|jpeg|gif|webp)$/i.test(mediaType)) {
      throw new AnthropicTranslationError(
        param,
        `image media_type "${mediaType}" is not supported (png, jpeg, gif or webp)`,
      );
    }
    return { type: "image_url", image_url: { url: `data:${mediaType};base64,${src.data}` } };
  }
  if (src?.type === "url" && typeof src.url === "string" && /^https?:\/\//i.test(src.url)) {
    return { type: "image_url", image_url: { url: src.url } };
  }
  throw new AnthropicTranslationError(
    param,
    `image source type "${src?.type ?? "missing"}" is not supported on this route (use base64 or an http(s) url)`,
  );
}

function refuseDocument(param: string): never {
  throw new AnthropicTranslationError(
    param,
    "document blocks are not supported on this route; send PDF pages as images, or store the file and read it with `canvas look`",
  );
}

/** A tool_result's content: its text and its images (as `image_url` parts). */
function toolResultContent(
  content: unknown,
  param: string,
): { text: string; images: OpenAIContentPart[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const texts: string[] = [];
  const images: OpenAIContentPart[] = [];
  for (const [j, item] of content.entries()) {
    if (typeof item === "string") {
      if (item) texts.push(item);
      continue;
    }
    const block = (item ?? {}) as Block;
    if (block.type === "text" && block.text) texts.push(block.text);
    else if (block.type === "image") images.push(imagePart(block, `${param}.content[${j}]`));
    else if (block.type === "document") refuseDocument(`${param}.content[${j}]`);
  }
  return { text: texts.join("\n\n"), images };
}

/**
 * Anthropic messages -> OpenAI chat messages. Text, tool calls and tool
 * results translate one to one; `image` blocks become `image_url` parts (the
 * user message's content turns into a parts array); a tool result's images,
 * which an OpenAI `tool` message cannot carry, follow it in a user message
 * (`Attached image(s) from tool result:` + the parts) merged with that turn's
 * own user content. `document` blocks and image sources other than base64 or
 * an http(s) url throw `AnthropicTranslationError` — never a silent drop.
 */
export function translateMessages(messages: unknown[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  for (const [i, raw] of messages.entries()) {
    const message = (raw ?? {}) as { role?: string; content?: unknown };
    const role = message.role === "assistant" ? "assistant" : "user";
    if (typeof message.content === "string") {
      result.push({ role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) {
      result.push({ role, content: "" });
      continue;
    }
    const texts: string[] = [];
    const parts: OpenAIContentPart[] = [];
    const toolImages: OpenAIContentPart[] = [];
    const calls: NonNullable<OpenAIMessage["tool_calls"]> = [];
    const toolResults: OpenAIMessage[] = [];
    for (const [j, item] of message.content.entries()) {
      const block = (item ?? {}) as Block;
      const param = `messages[${i}].content[${j}]`;
      if (block.type === "text") {
        texts.push(block.text ?? "");
        parts.push({ type: "text", text: block.text ?? "" });
      }
      if (block.type === "image") {
        if (role === "assistant")
          throw new AnthropicTranslationError(param, "assistant messages cannot carry images");
        parts.push(imagePart(block, param));
      }
      if (block.type === "document") refuseDocument(param);
      if (block.type === "tool_use") {
        calls.push({
          id: block.id ?? id("toolu"),
          type: "function",
          function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
        });
      }
      if (block.type === "tool_result") {
        const out = toolResultContent(block.content, param);
        toolImages.push(...out.images);
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id ?? "",
          content: out.text || (out.images.length ? TOOL_IMAGE_PLACEHOLDER : ""),
        });
      }
    }
    if (role === "assistant") {
      const translated: OpenAIMessage = { role, content: texts.join("\n\n") || null };
      if (calls.length) translated.tool_calls = calls;
      result.push(translated);
    } else {
      result.push(...toolResults);
      const text = texts.join("\n\n");
      const own = parts.filter((p) => p.type === "image_url" || p.text);
      if (toolImages.length > 0) {
        // Tool images first (they answer the calls), then this turn's own content.
        result.push({
          role: "user",
          content: [{ type: "text", text: TOOL_IMAGES_LEAD }, ...toolImages, ...own],
        });
      } else if (own.some((p) => p.type === "image_url")) {
        result.push({ role: "user", content: own });
      } else if (text || toolResults.length === 0) {
        result.push({ role: "user", content: text });
      }
    }
  }
  return result;
}

export function translateTools(tools: unknown[]): unknown[] {
  return tools.map((raw) => {
    const tool = (raw ?? {}) as { name?: string; description?: string; input_schema?: unknown };
    return {
      type: "function",
      function: {
        name: tool.name ?? "",
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    };
  });
}

export function anthropicRequestToOpenai(raw: Record<string, unknown>): Record<string, unknown> {
  const messages = translateMessages(Array.isArray(raw.messages) ? raw.messages : []);
  const system = anthropicSystemToText(raw.system);
  if (system) messages.unshift({ role: "system", content: system });
  return {
    model: typeof raw.model === "string" ? raw.model : "marina",
    messages,
    stream: raw.stream === true,
    ...(typeof raw.max_tokens === "number" ? { max_tokens: raw.max_tokens } : {}),
    ...(typeof raw.temperature === "number" ? { temperature: raw.temperature } : {}),
    ...(typeof raw.top_p === "number" ? { top_p: raw.top_p } : {}),
    ...(Array.isArray(raw.stop_sequences) ? { stop: raw.stop_sequences } : {}),
    ...(Array.isArray(raw.tools) ? { tools: translateTools(raw.tools) } : {}),
  };
}

export function mapStopReason(reason: string | null | undefined): string {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "stop") return "end_turn";
  if (reason === "content_filter") return "refusal";
  throw new Error(`Upstream response has no completed termination (${String(reason)})`);
}

function errorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}

function errorResponse(status: number, message: string): Response {
  return Response.json(
    { type: "error", error: { type: errorType(status), message } },
    { status, headers: HEADERS },
  );
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function translateStreamToAnthropic(
  stream: ReadableStream<Uint8Array>,
  model: string,
  messageId = id("msg"),
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  return new ReadableStream({
    cancel(reason) {
      return reader.cancel(reason);
    },
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          event("message_start", {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }) +
            event("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            }),
        ),
      );
      let buffer = "";
      let stopReason: string | undefined;
      let outputTokens = 0;
      const tools = new Map<number, { index: number; id: string; name: string }>();
      const emit = (name: string, data: unknown) =>
        controller.enqueue(encoder.encode(event(name, data)));
      const consume = (line: string) => {
        if (!line.startsWith("data:")) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        const chunk = JSON.parse(payload) as {
          error?: { message?: string };
          choices?: Array<{
            delta?: {
              content?: unknown;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: { completion_tokens?: number };
        };
        if (chunk.error) throw new Error(chunk.error.message ?? "Upstream stream failed");
        if (typeof chunk.usage?.completion_tokens === "number")
          outputTokens = chunk.usage.completion_tokens;
        const choice = chunk.choices?.[0];
        if (typeof choice?.delta?.content === "string") {
          emit("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: choice.delta.content },
          });
        }
        for (const call of choice?.delta?.tool_calls ?? []) {
          const key = call.index ?? 0;
          let tool = tools.get(key);
          if (!tool) {
            if (!call.id || !call.function?.name)
              throw new Error("Upstream tool stream lacks its id or name");
            tool = { index: tools.size + 1, id: call.id, name: call.function.name };
            tools.set(key, tool);
            emit("content_block_start", {
              type: "content_block_start",
              index: tool.index,
              content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
            });
          }
          if (call.function?.arguments) {
            emit("content_block_delta", {
              type: "content_block_delta",
              index: tool.index,
              delta: { type: "input_json_delta", partial_json: call.function.arguments },
            });
          }
        }
        if (choice?.finish_reason != null) stopReason = mapStopReason(choice.finish_reason);
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) consume(line);
        }
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
        if (!stopReason) throw new Error("Upstream stream ended without a finish reason");
        emit("content_block_stop", { type: "content_block_stop", index: 0 });
        for (const tool of tools.values())
          emit("content_block_stop", { type: "content_block_stop", index: tool.index });
        emit("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        emit("message_stop", { type: "message_stop" });
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
      controller.close();
    },
  });
}

export async function handleAnthropicMessages(
  request: Request,
  deps: AnthropicInboundDeps,
): Promise<Response> {
  let raw: Record<string, unknown>;
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return errorResponse(400, "messages must contain at least one message");
  }
  const model = typeof raw.model === "string" ? raw.model : "marina";
  let body: Record<string, unknown>;
  try {
    body = anthropicRequestToOpenai(raw);
  } catch (e) {
    if (e instanceof AnthropicTranslationError) return errorResponse(400, e.message);
    throw e;
  }
  const internal = await deps.runInternal(body, { stream: raw.stream === true, model });
  if (!internal.ok) {
    let message = internal.statusText || "Upstream request failed";
    try {
      const data = (await internal.json()) as { error?: { message?: unknown } };
      if (typeof data.error?.message === "string") message = data.error.message;
    } catch {
      // Keep the status-derived message.
    }
    return errorResponse(internal.status, message);
  }
  const messageId = id("msg");
  if (raw.stream === true && internal.body) {
    return new Response(translateStreamToAnthropic(internal.body, model, messageId), {
      headers: { ...HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const data = (await internal.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  let stopReason: string;
  try {
    stopReason = mapStopReason(choice?.finish_reason);
  } catch {
    return errorResponse(502, "Upstream response has no completed termination");
  }
  const content: unknown[] = [];
  if (typeof choice?.message?.content === "string" && choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(call.function?.arguments ?? "");
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Tool input must be an object");
    } catch {
      return errorResponse(
        502,
        `Upstream tool arguments are incomplete or invalid (${String(choice?.finish_reason)})`,
      );
    }
    content.push({
      type: "tool_use",
      id: call.id ?? id("toolu"),
      name: call.function?.name ?? "",
      input,
    });
  }
  return Response.json(
    {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      },
    },
    { headers: HEADERS },
  );
}
