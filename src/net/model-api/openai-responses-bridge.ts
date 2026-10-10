// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Shared outbound bridge. All callers (including vision and judges) retain the
// normal routing, spend settlement and trace path in upstream.ts.
import { getErrorMessage } from "../../engine/errors";
import { UnsupportedParameterError } from "../openai-errors";
import { streamUsageSidecar } from "./anthropic-bridge";
import { errorJson, json, SSE_HEADERS, upstreamAbort } from "./shared";

type RecordValue = Record<string, unknown>;
const rec = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const list = (value: unknown): RecordValue[] => (Array.isArray(value) ? value.map(rec) : []);

/** Reasoning families use Responses even when the caller speaks Chat. */
function isReasoningModel(model: unknown): boolean {
  return (
    typeof model === "string" &&
    /^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/.test(model) &&
    !model.includes("chat-latest")
  );
}
export function usesOpenAIResponses(body: RecordValue): boolean {
  if (!isReasoningModel(body.model)) return false;
  if (/^gpt-(?:6\.1-sol|6-astra)(?:-|$)/.test(String(body.model))) return true;
  const reasoning = body.reasoning_effort ?? rec(body.reasoning).effort;
  return (
    (list(body.tools).length > 0 && reasoning !== "none") ||
    list(body.messages).some(
      (message) =>
        message.marina_reasoning !== undefined ||
        list(message.reasoning_details).some(
          (item) => item.format === "marina-openai-responses-v1",
        ),
    )
  );
}

/** Sampling controls are unsupported while these models reason. Never change effort. */
export function prepareOpenAIReasoning(body: RecordValue): RecordValue {
  if (!isReasoningModel(body.model)) return body;
  const result = { ...body };
  const effort = body.reasoning_effort ?? rec(body.reasoning).effort;
  if (effort !== "none") {
    delete result.temperature;
    delete result.top_p;
    delete result.logprobs;
    delete result.top_logprobs;
  }
  return result;
}

function inputContent(value: unknown, param: string): unknown {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (!Array.isArray(value))
    throw new UnsupportedParameterError(param, "Expected text or content parts.");
  return value.map((raw, index) => {
    const part = rec(raw);
    if (["text", "input_text", "output_text"].includes(String(part.type)))
      return { type: "input_text", text: part.text };
    if (part.type === "image_url") {
      const image = rec(part.image_url);
      return {
        type: "input_image",
        image_url: typeof part.image_url === "string" ? part.image_url : image.url,
        ...(image.detail ? { detail: image.detail } : {}),
      };
    }
    if (part.type === "input_image") return part;
    throw new UnsupportedParameterError(
      `${param}[${index}].type`,
      "This content type is not supported by the OpenAI Responses bridge.",
    );
  });
}

export function buildOpenAIResponsesRequest(original: RecordValue): RecordValue {
  const body = prepareOpenAIReasoning(original);
  const effort = body.reasoning_effort ?? rec(body.reasoning).effort;
  if (
    /^gpt-6\.1-sol(?:-|$)/.test(String(body.model)) &&
    effort !== undefined &&
    !["low", "medium", "high", "xhigh", "max"].includes(String(effort))
  )
    throw new UnsupportedParameterError(
      "reasoning_effort",
      "GPT-6.1 Sol supports low, medium, high, xhigh and max.",
    );
  for (const field of [
    "stop",
    "logit_bias",
    "frequency_penalty",
    "presence_penalty",
    "functions",
    "function_call",
    "audio",
    "modalities",
  ])
    if (body[field] !== undefined)
      throw new UnsupportedParameterError(
        field,
        "This Chat parameter has no supported Responses translation.",
      );
  if (body.n !== undefined && body.n !== 1)
    throw new UnsupportedParameterError("n", "Responses produces one completion per request.");
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined)
    throw new UnsupportedParameterError("max_tokens", "Specify only one output token limit.");
  const supported = new Set([
    "model",
    "messages",
    "stream",
    "stream_options",
    "store",
    "n",
    "max_tokens",
    "max_completion_tokens",
    "reasoning",
    "reasoning_effort",
    "tools",
    "tool_choice",
    "temperature",
    "top_p",
    "parallel_tool_calls",
    "service_tier",
    "metadata",
    "user",
    "safety_identifier",
    "prompt_cache_key",
    "prompt_cache_retention",
    "response_format",
    "verbosity",
  ]);
  for (const field of Object.keys(body))
    if (body[field] !== undefined && !supported.has(field))
      throw new UnsupportedParameterError(
        field,
        "This parameter has no supported Responses translation.",
      );
  const input: RecordValue[] = [];
  for (const [index, message] of list(body.messages).entries()) {
    if (message.marina_reasoning !== undefined && !Array.isArray(message.marina_reasoning))
      throw new UnsupportedParameterError(
        `messages[${index}].marina_reasoning`,
        "Expected completed encrypted reasoning items.",
      );
    const replay =
      message.marina_reasoning ??
      list(message.reasoning_details)
        .filter(
          (item) =>
            item.type === "reasoning.encrypted" && item.format === "marina-openai-responses-v1",
        )
        .map((item) => {
          try {
            return JSON.parse(String(item.data));
          } catch {
            throw new UnsupportedParameterError(
              `messages[${index}].reasoning_details`,
              "Invalid encrypted reasoning replay envelope.",
            );
          }
        });
    if (Array.isArray(replay) && replay.length) {
      if (message.role !== "assistant" || !Array.isArray(replay))
        throw new UnsupportedParameterError(
          `messages[${index}].marina_reasoning`,
          "Only assistant reasoning items can be replayed.",
        );
      for (const item of list(replay)) {
        if (item.type !== "reasoning" || typeof item.encrypted_content !== "string")
          throw new UnsupportedParameterError(
            `messages[${index}].marina_reasoning`,
            "Replay the encrypted reasoning items returned by Marina.",
          );
        input.push(item);
      }
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: inputContent(message.content, `messages[${index}].content`),
      });
      continue;
    }
    if (!["system", "developer", "user", "assistant"].includes(String(message.role)))
      throw new UnsupportedParameterError(`messages[${index}].role`, "Unsupported message role.");
    if (message.content !== null && message.content !== undefined && message.content !== "")
      input.push({
        role: message.role,
        content: inputContent(message.content, `messages[${index}].content`),
      });
    for (const call of list(message.tool_calls)) {
      if (call.type !== "function")
        throw new UnsupportedParameterError(
          "tool_calls.type",
          "Only function tools are supported.",
        );
      const fn = rec(call.function);
      input.push({
        type: "function_call",
        call_id: call.id,
        name: fn.name,
        arguments: fn.arguments,
      });
    }
  }
  const result: RecordValue = {
    model: body.model,
    input,
    store: false,
    stream: body.stream === true,
    include: ["reasoning.encrypted_content"],
  };
  for (const field of [
    "temperature",
    "top_p",
    "parallel_tool_calls",
    "service_tier",
    "metadata",
    "user",
    "safety_identifier",
    "prompt_cache_key",
    "prompt_cache_retention",
  ])
    if (body[field] !== undefined) result[field] = body[field];
  const cap = body.max_completion_tokens ?? body.max_tokens;
  if (cap !== undefined) result.max_output_tokens = cap;
  if (body.reasoning !== undefined || effort !== undefined)
    result.reasoning = { ...rec(body.reasoning), ...(effort !== undefined ? { effort } : {}) };
  if (body.tools !== undefined)
    result.tools = list(body.tools).map((tool, i) => {
      if (tool.type !== "function")
        throw new UnsupportedParameterError(
          `tools[${i}].type`,
          "Only function tools are supported.",
        );
      const fn = rec(tool.function);
      return { ...fn, type: "function", strict: fn.strict ?? false };
    });
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === "string") result.tool_choice = body.tool_choice;
    else {
      const choice = rec(body.tool_choice);
      if (choice.type !== "function")
        throw new UnsupportedParameterError("tool_choice", "Only function tools are supported.");
      result.tool_choice = { type: "function", name: rec(choice.function).name };
    }
  }
  if (body.response_format !== undefined) {
    const format = rec(body.response_format);
    result.text = {
      format:
        format.type === "json_schema"
          ? { type: "json_schema", ...rec(format.json_schema) }
          : format,
    };
  }
  if (body.verbosity !== undefined)
    result.text = { ...rec(result.text), verbosity: body.verbosity };
  return result;
}

/** pi-ai and other Chat tool-loop clients preserve this opaque replay extension. */
function reasoningDetail(item: RecordValue): RecordValue {
  return {
    type: "reasoning.encrypted",
    format: "marina-openai-responses-v1",
    id: item.id,
    data: JSON.stringify(item),
  };
}

function chatUsage(value: unknown) {
  const usage = rec(value);
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number")
    return undefined;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens:
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : usage.input_tokens + usage.output_tokens,
    prompt_tokens_details: {
      cached_tokens: Number(rec(usage.input_tokens_details).cached_tokens ?? 0),
    },
    completion_tokens_details: {
      reasoning_tokens: Number(rec(usage.output_tokens_details).reasoning_tokens ?? 0),
    },
  };
}

export function openAIResponseToChat(response: RecordValue, model: string): RecordValue {
  if (response.error || response.status === "failed" || response.status === "cancelled")
    throw new Error(String(rec(response.error).message ?? `OpenAI response ${response.status}`));
  if (
    typeof response.id !== "string" ||
    !Array.isArray(response.output) ||
    !["completed", "incomplete"].includes(String(response.status))
  )
    throw new Error("OpenAI returned an invalid terminal Responses object.");
  const output = list(response.output);
  const calls = output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      id: item.call_id,
      type: "function",
      function: { name: item.name, arguments: item.arguments },
    }));
  const reasoning = output.filter((item) => item.type === "reasoning");
  const content = output
    .filter((item) => item.type === "message")
    .flatMap((item) => list(item.content))
    .filter((part) => part.type === "output_text")
    .map((part) => String(part.text ?? ""))
    .join("");
  const refusal = output
    .flatMap((item) => list(item.content))
    .find((part) => part.type === "refusal")?.refusal;
  return {
    id: response.id,
    object: "chat.completion",
    model,
    created: response.created_at ?? Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(refusal ? { refusal } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(reasoning.length
            ? { marina_reasoning: reasoning, reasoning_details: reasoning.map(reasoningDetail) }
            : {}),
        },
        finish_reason:
          response.status === "incomplete" ? "length" : calls.length ? "tool_calls" : "stop",
      },
    ],
    ...(chatUsage(response.usage) ? { usage: chatUsage(response.usage) } : {}),
  };
}

/** Incremental transformation: no whole-response buffering; cancellation propagates upstream. */
export function openAIResponsesStream(
  body: ReadableStream<Uint8Array>,
  model: string,
  includeUsage: boolean,
  onUsage: (usage: ReturnType<typeof chatUsage>) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let done = false;
  let id = "";
  const calls = new Map<number, number>();
  const encode = (delta: RecordValue, finish: string | null = null) =>
    encoder.encode(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  const event = (frame: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    const value = rec(JSON.parse(data));
    const response = rec(value.response);
    if (typeof response.id === "string") id = response.id;
    if (value.type === "response.output_text.delta")
      controller.enqueue(encode({ content: value.delta }));
    else if (value.type === "response.refusal.delta")
      controller.enqueue(encode({ refusal: value.delta }));
    else if (
      value.type === "response.output_item.added" &&
      rec(value.item).type === "function_call"
    ) {
      const item = rec(value.item);
      const index = calls.size;
      calls.set(Number(value.output_index), index);
      controller.enqueue(
        encode({
          tool_calls: [
            {
              index,
              id: item.call_id,
              type: "function",
              function: { name: item.name, arguments: "" },
            },
          ],
        }),
      );
    } else if (value.type === "response.function_call_arguments.delta") {
      const index = calls.get(Number(value.output_index));
      if (index === undefined) throw new Error("OpenAI sent tool arguments without a tool call.");
      controller.enqueue(encode({ tool_calls: [{ index, function: { arguments: value.delta } }] }));
    } else if (value.type === "response.output_item.done" && rec(value.item).type === "reasoning") {
      controller.enqueue(
        encode({
          marina_reasoning: [value.item],
          reasoning_details: [reasoningDetail(rec(value.item))],
        }),
      );
    } else if (value.type === "error" || value.type === "response.failed") {
      throw new Error(
        String(value.message ?? rec(response.error).message ?? "OpenAI stream failed"),
      );
    } else if (value.type === "response.completed" || value.type === "response.incomplete") {
      const usage = chatUsage(response.usage);
      onUsage(usage);
      controller.enqueue(
        encode(
          {},
          value.type === "response.incomplete" ? "length" : calls.size ? "tool_calls" : "stop",
        ),
      );
      if (includeUsage && usage)
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [], usage })}\n\n`,
          ),
        );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      done = true;
    }
  };
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          event(frame, controller);
        }
        if (buffer.length > 16 * 1024 * 1024)
          throw new Error("OpenAI SSE event exceeds the size limit.");
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) event(buffer, controller);
        if (!done) throw new Error("OpenAI stream ended without a terminal response.");
      },
    }),
  );
}

export async function proxyToOpenAIResponses(
  body: RecordValue,
  apiKey: string,
  headers: Record<string, string>,
  clientSignal?: AbortSignal,
): Promise<Response> {
  const request = buildOpenAIResponsesRequest(body); // validate before spending
  const abort = upstreamAbort(clientSignal);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
      signal: abort.signal,
    });
    if (!response.ok)
      return new Response(await response.text(), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    if (request.stream === true) {
      abort.settle();
      if (!response.body) return errorJson(502, "OpenAI returned an empty stream.");
      let usage: ReturnType<typeof chatUsage>;
      const result = new Response(
        openAIResponsesStream(
          response.body,
          String(body.model),
          rec(body.stream_options).include_usage === true,
          (value) => {
            usage = value;
          },
        ),
        { headers: SSE_HEADERS },
      );
      streamUsageSidecar.set(result, () => usage);
      return result;
    }
    return json(openAIResponseToChat(await response.json(), String(body.model)));
  } catch (error) {
    return errorJson(
      abort.timedOut() ? 504 : 502,
      `OpenAI Responses failed: ${getErrorMessage(error)}`,
    );
  } finally {
    abort.settle();
  }
}
