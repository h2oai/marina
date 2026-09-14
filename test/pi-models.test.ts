// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { resolveModel } from "../src/agent/lean-agent-adapter";
import { piModels } from "../src/agent/pi-models";

function transport(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect() {} });
}

const context = {
  messages: [{ role: "user" as const, content: "remember this", timestamp: 1 }],
};

it("keeps Marina/local Chat Completions routes, output caps and rotated request keys", async () => {
  for (const target of ["marina/default@http://memory.test:3300", "ollama/local-model"]) {
    const model = resolveModel(target);
    const requests: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
    for (const apiKey of ["resident-key-1", "resident-key-2"]) {
      const result = await piModels.completeSimple(model, context, {
        apiKey,
        env: { OPENAI_API_KEY: "unused-cloud-key" },
        maxTokens: 321,
        fetch: transport(async (input, init) => {
          const request = new Request(input, init);
          requests.push({
            url: request.url,
            key: request.headers.get("authorization"),
            body: await request.json(),
          });
          const chunk = {
            id: "test",
            object: "chat.completion.chunk",
            created: 1,
            model: model.id,
            choices: [{ index: 0, delta: { content: "remembered" }, finish_reason: "stop" }],
          };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }),
      });
      expect(result.stopReason).toBe("stop");
      expect(result.content).toMatchObject([{ type: "text", text: "remembered" }]);
    }
    expect(requests.map((request) => request.key)).toEqual([
      "Bearer resident-key-1",
      "Bearer resident-key-2",
    ]);
    for (const request of requests) {
      expect(request.url).toBe(`${model.baseUrl}/chat/completions`);
      expect(request.body).toMatchObject({ model: model.id, stream: true, max_tokens: 321 });
    }
  }
});

it("dispatches catalog models through their own protocol and resolves provider environment auth", async () => {
  for (const [provider, api, path, header, envKey] of [
    ["openai", "openai-responses", "/responses", "authorization", "OPENAI_API_KEY"],
    ["anthropic", "anthropic-messages", "/messages", "x-api-key", "ANTHROPIC_API_KEY"],
  ] as const) {
    const model = piModels.getModels(provider).find((entry) => entry.api === api)!;
    expect(model).toBeDefined();
    let calls = 0;
    const result = await piModels.completeSimple(model, context, {
      env: { [envKey]: "test-env-key" },
      fetch: transport(async (input, init) => {
        const request = new Request(input, init);
        calls++;
        expect(new URL(request.url).pathname).toEndWith(path);
        expect(request.headers.get(header)).toBe(
          header === "authorization" ? "Bearer test-env-key" : "test-env-key",
        );
        expect((await request.json()).model).toBe(model.id);
        return Response.json({ error: { message: "deliberate test denial" } }, { status: 401 });
      }),
    });
    expect(calls).toBe(1);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("deliberate test denial");
  }
});

it("does not dispatch an already-cancelled request or silently reroute an unknown provider", async () => {
  let calls = 0;
  const options = {
    apiKey: "test-key",
    fetch: transport(async () => {
      calls++;
      throw new Error("must not dispatch");
    }),
  };
  const model = resolveModel("marina/default");
  const cancelled = await piModels.completeSimple(model, context, {
    ...options,
    signal: AbortSignal.abort(),
  });
  expect(cancelled.stopReason).toBe("error");
  expect(cancelled.errorMessage).toContain("abort");
  const unknown = await piModels.completeSimple(
    { ...model, provider: "unknown" },
    context,
    options,
  );
  expect(unknown.stopReason).toBe("error");
  expect(unknown.errorMessage).toContain("Unknown provider");
  expect(calls).toBe(0);
});
