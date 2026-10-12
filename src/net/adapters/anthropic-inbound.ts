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
};

type OpenAIMessage = {
  role: string;
  content: string | null;
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

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      const block = item as Block;
      return block?.type === "text" ? (block.text ?? "") : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function translateMessages(messages: unknown[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  for (const raw of messages) {
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
    const calls: NonNullable<OpenAIMessage["tool_calls"]> = [];
    const toolResults: OpenAIMessage[] = [];
    for (const item of message.content) {
      const block = (item ?? {}) as Block;
      if (block.type === "text") texts.push(block.text ?? "");
      if (block.type === "tool_use") {
        calls.push({
          id: block.id ?? id("toolu"),
          type: "function",
          function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
        });
      }
      if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id ?? "",
          content: blockText(block.content),
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
      if (text || toolResults.length === 0) result.push({ role: "user", content: text });
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
  return "end_turn";
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
  return new ReadableStream({
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
      let stopReason = "end_turn";
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const chunk = JSON.parse(line.slice(6)) as {
              choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }>;
            };
            const choice = chunk.choices?.[0];
            if (typeof choice?.delta?.content === "string") {
              controller.enqueue(
                encoder.encode(
                  event("content_block_delta", {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: choice.delta.content },
                  }),
                ),
              );
            }
            if (choice?.finish_reason) stopReason = mapStopReason(choice.finish_reason);
          } catch {
            // Ignore malformed upstream SSE records; the terminal envelope remains well formed.
          }
        }
      }
      controller.enqueue(
        encoder.encode(
          event("content_block_stop", { type: "content_block_stop", index: 0 }) +
            event("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: 0 },
            }) +
            event("message_stop", { type: "message_stop" }),
        ),
      );
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
  const body = anthropicRequestToOpenai(raw);
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
  const content: unknown[] = [];
  if (typeof choice?.message?.content === "string" && choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function?.arguments ?? "{}");
    } catch {
      input = {};
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
      stop_reason: mapStopReason(choice?.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      },
    },
    { headers: HEADERS },
  );
}
