// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// TypeSafe's published Jev contract (docs.typesafe.ai/api) that Marina must
// accept and answer in: null option descriptions, structured instructions, the
// 255-option / 10-level limits, and the 422 / 429 / 529 statuses clients retry on.

import { afterEach, describe, expect, it } from "bun:test";
import { toWireAnswers } from "../src/decisions/answers";
import {
  decisionConfigFromEnv,
  providerFromConfig,
  researchJudge,
  TYPESAFE_INPUT_USD_PER_MTOK,
} from "../src/decisions/config";
import { chatClassifierProvider, decisionsApiProvider } from "../src/decisions/providers";
import {
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  noul,
  parseQuestions,
} from "../src/decisions/questions";
import { handleDecisions } from "../src/net/decisions-api";

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function sequenceFetch(replies: Reply[], bodies: unknown[] = []) {
  let i = 0;
  const fn = async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  };
  return Object.assign(fn, { count: () => i });
}

const OK = { status: 200, body: { answers: { d: { noul: 0.3 } } } };
const ask = { state: "s", questions: { d: noul("?") } };

describe("TypeSafe question contract", () => {
  it("accepts null option descriptions and forwards them unchanged", async () => {
    const q = parseQuestions({
      team: {
        type: "choice",
        instructions: "Which team?",
        criteria: { billing: null, sales: "x" },
      },
    });
    expect(q.team).toEqual({
      type: "choice",
      instructions: "Which team?",
      criteria: { billing: null, sales: "x" },
    });
    const bodies: unknown[] = [];
    const provider = decisionsApiProvider({
      baseUrl: "https://example.test",
      model: "jev",
      timeoutMs: 1000,
      fetch: sequenceFetch(
        [{ status: 200, body: { answers: { team: { choice: "billing", confidence: 0.9 } } } }],
        bodies,
      ),
    });
    const result = await provider.ask({ state: "invoice wrong", questions: q });
    expect((bodies[0] as { questions: unknown }).questions).toEqual(q);
    expect(toWireAnswers(q, result.answers).team).toMatchObject({ choice: "billing" });
  });

  it("shows a null option to a chat classifier as its bare key", async () => {
    const bodies: unknown[] = [];
    const provider = chatClassifierProvider({
      baseUrl: "http://localhost:1/v1",
      model: "m",
      timeoutMs: 1000,
      fetch: sequenceFetch(
        [
          {
            status: 200,
            body: { choices: [{ message: { content: '{"answers":{"t":{"choice":"a"}}}' } }] },
          },
        ],
        bodies,
      ),
    });
    await provider.ask({
      state: "s",
      questions: parseQuestions({
        t: { type: "choice", instructions: "?", criteria: { a: null, b: "B" } },
      }),
    });
    const prompt = (bodies[0] as { messages: { content: string }[] }).messages[1]!.content;
    expect(prompt).toContain('    "a"\n');
    expect(prompt).not.toContain('"a": null');
    expect(prompt).toContain('"b": B');
  });

  it("accepts object and array instructions as JSON text", () => {
    const q = parseQuestions({
      a: { type: "noul", instructions: { goal: "is it urgent?", lang: "en" } },
      b: { type: "noul", instructions: ["is it", "urgent?"] },
    });
    expect(q.a!.instructions).toBe('{"goal":"is it urgent?","lang":"en"}');
    expect(q.b!.instructions).toBe('["is it","urgent?"]');
  });

  it("enforces Jev's 255-option and 10-level limits before any call", () => {
    const options = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]));
    expect(() =>
      parseQuestions({
        c: { type: "choice", instructions: "?", criteria: options(MAX_CHOICE_OPTIONS) },
      }),
    ).not.toThrow();
    expect(() =>
      parseQuestions({
        c: { type: "choice", instructions: "?", criteria: options(MAX_CHOICE_OPTIONS + 1) },
      }),
    ).toThrow(/more than 255 options/);
    const levels = (n: number) => Array.from({ length: n }, (_, i) => `level ${i}`);
    expect(() =>
      parseQuestions({
        s: { type: "score", instructions: "?", criteria: levels(MAX_SCORE_LEVELS) },
      }),
    ).not.toThrow();
    expect(() =>
      parseQuestions({
        s: { type: "score", instructions: "?", criteria: levels(MAX_SCORE_LEVELS + 1) },
      }),
    ).toThrow(/more than 10 levels/);
    expect(() =>
      parseQuestions({ c: { type: "choice", instructions: "?", criteria: { a: 1, b: null } } }),
    ).toThrow(/criteria\.a/);
  });
});

describe("backend statuses and retries", () => {
  const provider = (fetch: ReturnType<typeof sequenceFetch>, timeoutMs = 2000) =>
    decisionsApiProvider({ baseUrl: "https://example.test", model: "jev", timeoutMs, fetch });

  it("retries once on 429 / 503 / 529 and then answers", async () => {
    for (const status of [429, 503, 529]) {
      const fetch = sequenceFetch([{ status, body: { error: "busy" } }, OK]);
      const result = await provider(fetch).ask(ask);
      expect(result.answers.d).toEqual({ type: "noul", noul: 0.3 });
      expect(fetch.count()).toBe(2);
    }
  });

  it("retries at most once, and names what failed", async () => {
    const limited = sequenceFetch([{ status: 429, body: {} }]);
    await expect(provider(limited).ask(ask)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
    expect(limited.count()).toBe(2);
    const overloaded = sequenceFetch([{ status: 529, body: {} }]);
    await expect(provider(overloaded).ask(ask)).rejects.toMatchObject({
      code: "overloaded",
      status: 529,
    });
  });

  it("never retries a refusal or an auth failure", async () => {
    const refused = sequenceFetch([{ status: 422, body: { detail: "bad" } }]);
    await expect(provider(refused).ask(ask)).rejects.toMatchObject({
      code: "upstream_rejected",
      status: 422,
    });
    expect(refused.count()).toBe(1);
    const auth = sequenceFetch([{ status: 401, body: {} }]);
    await expect(provider(auth).ask(ask)).rejects.toMatchObject({ code: "upstream_error" });
    expect(auth.count()).toBe(1);
  });

  it("never retries past the call's own budget", async () => {
    const fetch = sequenceFetch([{ status: 429, body: {}, headers: { "retry-after": "5" } }, OK]);
    await expect(provider(fetch, 2000).ask(ask)).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetch.count()).toBe(1);
  });
});

describe("spend on TypeSafe's own host", () => {
  it("prices input tokens when the backend reports no cost", async () => {
    const config = decisionConfigFromEnv({ MARINA_DECISIONS: "typesafe", TYPESAFE_API_KEY: "k" });
    expect(config?.inputUsdPerMTok).toBe(TYPESAFE_INPUT_USD_PER_MTOK);
    const priced = decisionsApiProvider({
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      timeoutMs: 1000,
      inputUsdPerMTok: TYPESAFE_INPUT_USD_PER_MTOK,
      fetch: sequenceFetch([
        {
          status: 200,
          body: { answers: { d: { noul: 0.5 } }, usage: { input_tokens: 1_000_000 } },
        },
      ]),
    });
    expect((await priced.ask(ask)).costUsd).toBeCloseTo(0.042, 10);
  });

  it("keeps a reported cost, and prices nothing off TypeSafe's host", () => {
    expect(
      decisionConfigFromEnv({ MARINA_DECISIONS: "jev", OPENROUTER_API_KEY: "k" })?.inputUsdPerMTok,
    ).toBeUndefined();
    expect(
      decisionConfigFromEnv({
        MARINA_DECISIONS: "typesafe",
        MARINA_DECISION_BASE_URL: "http://localhost:8080",
      })?.inputUsdPerMTok,
    ).toBeUndefined();
  });
});

describe("research judge", () => {
  it("defaults to jev on OpenRouter and stays off without a key", () => {
    expect(researchJudge("jev", {}, "or-key")?.model).toBe("typesafe/jev-1.13");
    expect(researchJudge("jev", {}, undefined)).toBeUndefined();
    expect(researchJudge("none", {}, "or-key")).toBeUndefined();
  });

  it("`decisions` uses the configured backend, and falls back to jev when there is none", () => {
    const env = {
      MARINA_DECISIONS: "decisions-api",
      MARINA_DECISION_MODEL: "openjev-2",
      MARINA_DECISION_BASE_URL: "http://localhost:9000",
    };
    const judge = researchJudge("decisions", env, "or-key");
    expect(judge?.model).toBe("openjev-2");
    expect(researchJudge("decisions", {}, "or-key")?.model).toBe("typesafe/jev-1.13");
    expect(researchJudge("decisions", {}, undefined)).toBeUndefined();
    // Configured backends keep their calibration flag for the aggregator.
    expect(
      researchJudge(
        "decisions",
        { MARINA_DECISIONS: "classifier", MARINA_DECISION_MODEL: "x" },
        "k",
      )?.calibrated,
    ).toBe(false);
    expect(providerFromConfig(decisionConfigFromEnv(env)!).calibrated).toBe(true);
  });
});

describe("POST /v1/systemone passes the backend's status through", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["MARINA_DECISIONS", "MARINA_DECISION_MODEL", "MARINA_DECISION_BASE_URL"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function statusFor(upstream: number): Promise<{ status: number; code: string }> {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ error: "x" }), { status: upstream }),
    });
    try {
      process.env.MARINA_DECISIONS = "decisions-api";
      process.env.MARINA_DECISION_MODEL = `stub-${upstream}`;
      process.env.MARINA_DECISION_BASE_URL = `http://localhost:${server.port}`;
      const res = await handleDecisions(
        new Request("http://marina.test/v1/systemone", {
          method: "POST",
          body: JSON.stringify({
            state: "s",
            questions: { d: { type: "noul", instructions: "?" } },
          }),
        }),
      );
      const body = (await res.json()) as { error: { code: string } };
      return { status: res.status, code: body.error.code };
    } finally {
      server.stop(true);
    }
  }

  it("422 refused, 429 rate limited, 529 overloaded, 502 otherwise", async () => {
    expect(await statusFor(422)).toEqual({ status: 422, code: "invalid_request_error" });
    expect(await statusFor(429)).toEqual({ status: 429, code: "rate_limit_exceeded" });
    expect(await statusFor(529)).toEqual({ status: 529, code: "upstream_error" });
    expect(await statusFor(500)).toEqual({ status: 502, code: "upstream_error" });
  });
});
