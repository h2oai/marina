// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { type Model, normalizeContext } from "@earendil-works/pi-ai";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { handleModelApi } from "../src/net/model-api";
import {
  buildOpenAIResponsesRequest,
  openAIResponsesStream,
  openAIResponseToChat,
  proxyToOpenAIResponses,
} from "../src/net/model-api/openai-responses-bridge";
import {
  formatResponseRecord,
  ResponsesSseEmitter,
  responsesPassthruStream,
} from "../src/net/model-api/responses-sse";
import { proxyToUpstream } from "../src/net/model-api/upstream";
import { createTestEngine } from "./engine-fixture";
import { until } from "./helpers";
import { scopeProcessState, scopeProperty } from "./process-state";

const reasoning = {
  type: "reasoning",
  id: "rs_test",
  summary: [],
  encrypted_content: "opaque-encrypted-state",
};
const call = {
  type: "function_call",
  id: "fc_test",
  call_id: "call_test",
  name: "read_state",
  arguments: '{"id":1}',
  status: "completed",
};
const usage = {
  input_tokens: 20,
  output_tokens: 7,
  total_tokens: 27,
  input_tokens_details: { cached_tokens: 10 },
};
const response = (output: unknown[]) => ({ id: "resp_test", status: "completed", output, usage });
const textItem = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Verified." }],
};
const frame = (type: string, fields: Record<string, unknown> = {}) =>
  new TextEncoder().encode(
    `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`,
  );
const tools = [
  {
    type: "function",
    function: {
      name: "read_state",
      parameters: { type: "object", properties: { id: { type: "number" } } },
    },
  },
];

describe("OpenAI Responses upstream contracts", () => {
  it("never turns a malformed provider object into an empty successful answer", () => {
    expect(() => openAIResponseToChat({ choices: [] }, "gpt-6.1-sol")).toThrow("invalid terminal");
    expect(() =>
      openAIResponseToChat({ id: "r", status: "in_progress", output: [] }, "gpt-6.1-sol"),
    ).toThrow("invalid terminal");
  });
  it("translates images, schemas, structured tool results and reasoning without changing the tool schema", () => {
    const body = buildOpenAIResponsesRequest({
      model: "gpt-6.1-sol",
      temperature: 0,
      top_p: 1,
      reasoning_effort: "high",
      max_tokens: 100,
      tools,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "low" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          marina_reasoning: [reasoning],
          tool_calls: [
            {
              id: "call_test",
              type: "function",
              function: { name: "read_state", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_test",
          content: [{ type: "text", text: "state: ready" }],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", schema: { type: "object" }, strict: true },
      },
    });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.max_output_tokens).toBe(100);
    expect(body.store).toBe(false);
    expect(body.tools).toEqual([{ type: "function", ...tools[0]!.function, strict: false }]);
    expect(body.input).toMatchObject([
      { role: "user", content: [{ type: "input_image", detail: "low" }] },
      reasoning,
      { type: "function_call", call_id: "call_test" },
      { type: "function_call_output", output: [{ type: "input_text", text: "state: ready" }] },
    ]);
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true },
    });
    expect(() =>
      buildOpenAIResponsesRequest({ model: "gpt-6.1-sol", reasoning_effort: "none" }),
    ).toThrow("supports low");
    expect(() => buildOpenAIResponsesRequest({ model: "gpt-6.1-sol", n: 2 })).toThrow(
      "one completion",
    );
  });

  it("routes shared helpers and tool replay directly to OpenAI, validates before a paid request", async () => {
    using _state = scopeProcessState({
      env: {
        OPENAI_API_KEY: "test-openai",
        OPENROUTER_API_KEY: "test-router",
        MARINA_DAILY_SPEND_CAP_USD: "0",
      },
    });
    const f = createTestEngine();
    const requests: Record<string, unknown>[] = [];
    using _fetchScope = scopeProperty(globalThis, "fetch", (async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-openai");
      requests.push(JSON.parse(String(init?.body)));
      return Response.json(response(requests.length === 1 ? [reasoning, call] : [textItem]));
    }) as typeof fetch);
    try {
      const first = await proxyToUpstream(f.engine, {
        model: "openai/gpt-6.1-sol",
        tools,
        messages: [{ role: "user", content: "Check state" }],
        temperature: 0,
      });
      expect(first.status).toBe(200);
      const answer = await first.json();
      expect(answer.choices[0].message.marina_reasoning).toEqual([reasoning]);
      const second = await proxyToUpstream(f.engine, {
        model: "openai/gpt-6.1-sol",
        tools,
        messages: [
          { role: "user", content: "Check state" },
          answer.choices[0].message,
          { role: "tool", tool_call_id: "call_test", content: "ready" },
        ],
      });
      expect((await second.json()).choices[0].message.content).toBe("Verified.");
      expect(requests[1]!.input).toContainEqual(reasoning);
      const refused = await proxyToUpstream(f.engine, {
        model: "openai/gpt-6.1-sol",
        n: 2,
        messages: [],
      });
      expect(refused.status).toBe(400);
      expect(requests).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  });

  it("preserves multi-step Responses history, encrypted state and owner isolation through the public API", async () => {
    using _state = scopeProcessState({
      trustProfile: "local",
      rateLimitBypass: true,
      env: {
        OPENAI_API_KEY: "test-openai",
        MARINA_DAILY_SPEND_CAP_USD: "0",
        MODEL_API_KEYS: "owner-key,other-key",
      },
    });
    const f = createTestEngine();
    f.login("Operator");
    const requests: Record<string, unknown>[] = [];
    using _fetchScope = scopeProperty(globalThis, "fetch", (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json(
        response(
          requests.length < 3
            ? [reasoning, { ...call, call_id: `call_${requests.length}` }]
            : [textItem],
        ),
      );
    }) as typeof fetch);
    const post = async (body: unknown, key = "owner-key") => {
      const url = new URL("http://localhost/v1/responses");
      return (await handleModelApi(
        url,
        "POST",
        new Request(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        f.engine,
      ))!;
    };
    try {
      const first = await post({
        model: "openai/gpt-6.1-sol",
        input: "Read state",
        reasoning: { effort: "high" },
      });
      expect(first.status).toBe(200);
      const one = await first.json();
      expect(one.output[0]).toEqual(reasoning);
      const second = await post({
        model: "openai/gpt-6.1-sol",
        previous_response_id: one.id,
        input: [{ type: "function_call_output", call_id: "call_1", output: "ready" }],
      });
      expect(second.status).toBe(200);
      const two = await second.json();
      expect(
        (
          await post(
            { model: "openai/gpt-6.1-sol", previous_response_id: two.id, input: "steal" },
            "other-key",
          )
        ).status,
      ).toBe(404);
      const third = await post({
        model: "openai/gpt-6.1-sol",
        previous_response_id: two.id,
        input: [
          {
            type: "function_call_output",
            call_id: "call_2",
            output: [{ type: "input_text", text: "confirmed" }],
          },
        ],
      });
      expect(third.status).toBe(200);
      expect((await third.json()).output_text).toBe("Verified.");
      expect(requests[0]!.reasoning).toEqual({ effort: "high" });
      expect(requests[2]!.input).toMatchObject([
        { role: "user", content: "Read state" },
        reasoning,
        { type: "function_call", call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "ready" },
        reasoning,
        { type: "function_call", call_id: "call_2" },
        { type: "function_call_output", call_id: "call_2" },
      ]);
    } finally {
      await f.dispose();
    }
  });

  it("streams before completion, retains usage, and handles split CRLF frames", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        push = controller;
      },
    });
    let reported: unknown;
    const reader = openAIResponsesStream(raw, "gpt-6.1-sol", true, (value) => {
      reported = value;
    }).getReader();
    push.enqueue(frame("response.output_item.done", { item: reasoning }));
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("marina_reasoning");
    const added = frame("response.output_item.added", { output_index: 1, item: call });
    // Split between CR and LF, then consume while the source remains open.
    const split = added.indexOf(13) + 1;
    push.enqueue(added.slice(0, split));
    push.enqueue(added.slice(split));
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("read_state");
    push.enqueue(
      frame("response.function_call_arguments.delta", { output_index: 1, delta: '{"id":1}' }),
    );
    push.enqueue(frame("response.completed", { response: response([reasoning, call]) }));
    push.close();
    let tail = "";
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      tail += new TextDecoder().decode(item.value);
    }
    expect(tail).toContain("tool_calls");
    expect(tail).toContain('"cached_tokens":10');
    expect(reported).toMatchObject({ prompt_tokens: 20, completion_tokens: 7 });
  });

  it("retains encrypted reasoning through Marina's native pi-ai Chat tool loop", async () => {
    const native = builtinModels().getModel("openai", "gpt-6-luna")!;
    const model: Model<"openai-completions"> = {
      ...native,
      id: "gpt-6.1-sol",
      api: "openai-completions",
      baseUrl: "https://marina.invalid/v1",
    };
    const requests: Record<string, unknown>[] = [];
    using _fetchScope = scopeProperty(globalThis, "fetch", (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const events =
        requests.length === 1
          ? [
              frame("response.output_item.done", { item: reasoning }),
              frame("response.output_item.added", { output_index: 1, item: call }),
              frame("response.function_call_arguments.delta", {
                output_index: 1,
                delta: call.arguments,
              }),
              frame("response.completed", { response: response([reasoning, call]) }),
            ]
          : [
              frame("response.output_text.delta", { delta: "Verified." }),
              frame("response.completed", { response: response([textItem]) }),
            ];
      return new Response(
        new ReadableStream({
          start(c) {
            for (const event of events) c.enqueue(event);
            c.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch);
    let transportError: unknown;
    const fetchThroughMarina = (async (url: string | URL | Request, init?: RequestInit) => {
      try {
        const request = new Request(url, init);
        return await proxyToOpenAIResponses(await request.json(), "test", {}, request.signal);
      } catch (error) {
        transportError = error;
        throw error;
      }
    }) as typeof fetch;
    const user = { role: "user" as const, content: "Read state", timestamp: Date.now() };
    const one = await streamCompletions(model, normalizeContext({ messages: [user] }), {
      apiKey: "test",
      fetch: fetchThroughMarina,
      reasoningEffort: "high",
    }).result();
    expect(one.stopReason, String(transportError ?? one.errorMessage)).toBe("toolUse");
    expect(
      one.content.some(
        (block) =>
          block.type === "thinking" && block.thinkingSignature?.includes("opaque-encrypted-state"),
      ),
    ).toBe(true);
    const two = await streamCompletions(
      model,
      normalizeContext({
        messages: [
          user,
          one,
          {
            role: "toolResult",
            toolCallId: "call_test",
            toolName: "read_state",
            content: [{ type: "text", text: "ready" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      }),
      { apiKey: "test", fetch: fetchThroughMarina, reasoningEffort: "high" },
    ).result();
    expect(two.stopReason, two.errorMessage).toBe("stop");
    expect(requests[1]!.input).toContainEqual(reasoning);
  });

  it("propagates cancellation and rejects a stream without a terminal event", async () => {
    let cancelled = false;
    const raw = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const reader = openAIResponsesStream(raw, "gpt-6.1-sol", false, () => {}).getReader();
    await reader.cancel("operator stopped");
    await until(() => cancelled);
    const incomplete = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(frame("response.output_text.delta", { delta: "partial" }));
        c.close();
      },
    });
    await expect(
      new Response(openAIResponsesStream(incomplete, "gpt-6.1-sol", false, () => {})).text(),
    ).rejects.toThrow("without a terminal");
  });

  it("keeps truncation distinct from completion and cancels the public Responses stream reader", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const base = {
      id: "resp_public",
      conversationId: "c",
      model: "gpt-6.1-sol",
      createdAt: Date.now(),
      owner: "test",
    };
    const publicStream = responsesPassthruStream(source, new ResponsesSseEmitter(base), () => {
      throw new Error("Cancelled work must not complete");
    });
    const reader = publicStream.getReader();
    await reader.read();
    await reader.cancel("stop");
    await until(() => cancelled);
    const events: string[] = [];
    const emitter = new ResponsesSseEmitter(base);
    emitter.bind((frame) => events.push(new TextDecoder().decode(frame)));
    emitter.start();
    emitter.textDelta("partial");
    const record = emitter.finish(undefined, true);
    expect(formatResponseRecord(record)).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(events.join("\n")).toContain("event: response.incomplete");
    expect(events.join("\n")).not.toContain("event: response.completed");
  });

  it("preserves provider errors and aborts a disconnected non-streaming call", async () => {
    using _errorFetch = scopeProperty(globalThis, "fetch", (async (
      _url: unknown,
      _init?: RequestInit,
    ) => Response.json({ error: { message: "quota reached" } }, { status: 429 })) as typeof fetch);
    const error = await proxyToOpenAIResponses({ model: "gpt-6.1-sol", messages: [] }, "test", {});
    expect(error.status).toBe(429);
    expect(await error.text()).toContain("quota reached");
    const abort = new AbortController();
    let observed!: AbortSignal;
    using _abortFetch = scopeProperty(globalThis, "fetch", (async (_url, init) => {
      observed = init!.signal!;
      return new Promise<Response>((_resolve, reject) =>
        observed.addEventListener("abort", () => reject(observed.reason), { once: true }),
      );
    }) as typeof fetch);
    const pending = proxyToOpenAIResponses(
      { model: "gpt-6.1-sol", messages: [] },
      "test",
      {},
      abort.signal,
    );
    abort.abort();
    expect((await pending).status).toBe(502);
    expect(observed.aborted).toBe(true);
  });

  it("stops upstream work when the public stream receives an error", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"error":{"message":"provider failed"}}\n\n'),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const stream = responsesPassthruStream(
      source,
      new ResponsesSseEmitter({
        id: "resp_failed",
        conversationId: "c",
        model: "test",
        createdAt: Date.now(),
        owner: "test",
      }),
      () => {
        throw new Error("Failed work must not complete");
      },
    );
    const events = await new Response(stream).text();
    expect(cancelled).toBe(true);
    expect(events).toContain("event: response.failed");
    expect(events).toContain("provider failed");
    expect(events).not.toContain("event: response.completed");
  });
});
