// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";

/** Gate actual upstream attempts, including router fallback. Local protocol traffic
 * is free. Other providers/models are refused before credentials leave the process. */
export function evaluationBudgetFetch(
  network: typeof fetch,
  state: {
    ceiling: number;
    reserved: number;
    attempts: number;
    maxAttempts: number;
    model: string;
    inputPerMillion: number;
    outputPerMillion: number;
  },
) {
  return new Proxy(network, {
    async apply(target, _receiver, args: Parameters<typeof fetch>): Promise<Response> {
      const request = new Request(args[0], args[1]);
      const url = new URL(request.url);
      if (url.hostname === "127.0.0.1" && url.protocol === "http:") return target(request);
      if (url.href !== "https://api.openai.com/v1/chat/completions" || request.method !== "POST")
        throw new Error("Evaluation refused an unapproved upstream endpoint");
      const text = await request.clone().text();
      if (Buffer.byteLength(text) > 65536) throw new Error("Evaluation input budget exceeded");
      const body = JSON.parse(text) as {
        model: string;
        max_tokens: number;
        messages: { content: string }[];
      };
      if (
        body.model !== state.model ||
        body.max_tokens !== 500 ||
        !Array.isArray(body.messages) ||
        body.messages.some((m) => typeof m.content !== "string")
      )
        throw new Error("Evaluation refused an unapproved model or token limit");
      const bound =
        ((Buffer.byteLength(text) + 128 * body.messages.length) * state.inputPerMillion) / 1e6 +
        (500 * state.outputPerMillion) / 1e6;
      if (state.attempts >= state.maxAttempts || state.reserved + bound > state.ceiling)
        throw new Error("Evaluation spending limit reached");
      state.reserved += bound;
      state.attempts++;
      // Ambiguous failures retain their reservation. No redirect can send the key elsewhere.
      return target(
        new Request(request, {
          redirect: "error",
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(60000)]),
        }),
      );
    },
  });
}

if (import.meta.main) {
  let calls = 0;
  const requests: Request[] = [];
  const network = Object.assign(
    async (request: Request) => {
      calls++;
      requests.push(request);
      return Response.json({});
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
  const state = {
    ceiling: 0.0004,
    reserved: 0,
    attempts: 0,
    maxAttempts: 20,
    model: "gpt-4o-mini-2024-07-18",
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
  };
  const guarded = evaluationBudgetFetch(network, state);
  const send = (model = state.model) =>
    guarded("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model, max_tokens: 500, messages: [{ content: "hello" }] }),
    });
  await assert.rejects(() => send("expensive-fallback"), /unapproved model/);
  await assert.rejects(
    () => guarded("https://other.example/v1/chat/completions"),
    /unapproved upstream/,
  );
  assert.equal(calls, 0);
  await send();
  assert.equal(state.attempts, 1);
  assert.equal(requests[0]!.redirect, "error");
  await assert.rejects(() => send(), /spending limit/);
  assert.equal(calls, 1);
  await guarded("http://127.0.0.1:1234/v1/memory");
  assert.equal(calls, 2);
  assert.equal(state.attempts, 1);
  const failureState = { ...state, ceiling: 1, reserved: 0, attempts: 0 };
  const failure = evaluationBudgetFetch(
    Object.assign(
      async () => {
        throw new Error("lost reply");
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
    failureState,
  );
  await assert.rejects(
    () =>
      failure("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: state.model, max_tokens: 500, messages: [] }),
      }),
    /lost reply/,
  );
  assert.ok(failureState.reserved > 0);
  assert.equal(failureState.attempts, 1);
  console.log(
    "Evaluation budget checks passed: upstream/model isolation, actual-attempt reservation, redirect refusal, local traffic, ambiguous failure.",
  );
}
