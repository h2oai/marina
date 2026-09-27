// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Marina as a Jev-compatible decision engine: chat models answering through
// Marina's own passthru (`marina/classifier:<model>`), with logprob, sampled and
// verbalized probabilities, all held to the same conformance kit as real Jev.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  answerResponseFormat,
  distributionsFromLogprobs,
  labelQuestions,
} from "../src/decisions/classifier-methods";
import { providerFromConfig } from "../src/decisions/config";
import { CONFORMANCE_REQUESTS, runConformance, wireViolations } from "../src/decisions/conformance";
import { listEngines, resolveEngine } from "../src/decisions/engines";
import {
  chatClassifierProvider,
  decisionsApiProvider,
  resetClassifierCapabilitiesForTests,
} from "../src/decisions/providers";
import { parseQuestions } from "../src/decisions/questions";
import { resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";
import { handleDecisionModels, handleDecisions } from "../src/net/decisions-api";

// ─── A fake OpenAI-compatible upstream ───────────────────────────────────────

type Body = Record<string, unknown> & {
  response_format?: {
    json_schema: {
      schema: { properties: { answers: { properties: Record<string, Record<string, unknown>> } } };
    };
  };
  logprobs?: boolean;
};

interface FakeOptions {
  /** Return logprobs when asked (an OpenAI-style provider); false ⇒ like Anthropic. */
  logprobs?: boolean;
  /** Reject `response_format` with a 400 (a server without structured output). */
  rejectSchema?: boolean;
  /**
   * Reject logprobs with a 400: `reasoning` like OpenAI's reasoning models, `cap5`
   * like a provider that only allows `top_logprobs` ≤ 5.
   */
  rejectLogprobs?: "reasoning" | "cap5";
  /** Label picked for every labeled answer (default: the first). */
  pick?: (labels: string[], call: number) => string;
  /** Served model name. */
  served?: string;
}

function fakeUpstream(opts: FakeOptions = {}) {
  const bodies: Body[] = [];
  const auth: Array<string | null> = [];
  const urls: string[] = [];
  let calls = 0;
  const fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    urls.push(url);
    auth.push(new Headers(init.headers).get("Authorization"));
    const call = calls++;
    if (body.logprobs && opts.rejectLogprobs === "reasoning") {
      return new Response(
        JSON.stringify({ error: { message: "logprobs are not supported with reasoning models." } }),
        { status: 400 },
      );
    }
    if (body.logprobs && opts.rejectLogprobs === "cap5" && Number(body.top_logprobs) > 5) {
      return new Response(
        JSON.stringify({ error: { message: "Range of top_logprobs should be [0, 5]" } }),
        { status: 400 },
      );
    }
    if (body.response_format && opts.rejectSchema) {
      return new Response(JSON.stringify({ error: { message: "response_format not supported" } }), {
        status: 400,
      });
    }
    const props = body.response_format?.json_schema.schema.properties.answers.properties;
    if (!props) {
      // Unstructured verbalized request: answer every question id seen in the prompt.
      const prompt = String((body.messages as Array<{ content: string }>)[1]!.content);
      const ids = [...prompt.matchAll(/^- (\w+) \((\w+)\)/gm)];
      const answers = Object.fromEntries(
        ids.map(([, id, type]) => [
          id,
          type === "noul"
            ? { noul: 0.8 }
            : type === "choice"
              ? {
                  choice: /"(\w+)"/.exec(prompt.slice(prompt.indexOf(`- ${id} `)))![1],
                  confidence: 0.7,
                }
              : { score: 1, confidence: 0.6 },
        ]),
      );
      return reply(JSON.stringify({ answers }), undefined, opts.served ?? String(body.model));
    }
    const pieces: Array<{ token: string; top?: Array<{ token: string; logprob: number }> }> = [
      { token: '{"answers":{' },
    ];
    const answers: Record<string, unknown> = {};
    Object.entries(props).forEach(([id, schema], i) => {
      if (i > 0) pieces.push({ token: "," });
      const labels = schema.enum as string[] | undefined;
      if (labels) {
        const label = opts.pick ? opts.pick(labels, call) : labels[0]!;
        answers[id] = label;
        pieces.push({ token: `"${id}":"` });
        // 0.7 on the pick, the rest spread; plus a junk alternative that must be ignored.
        const rest = labels.filter((l) => l !== label);
        pieces.push({
          token: label,
          top: [
            { token: label, logprob: Math.log(0.7) },
            ...rest.map((l) => ({ token: l, logprob: Math.log(0.25 / rest.length) })),
            { token: "Maybe", logprob: Math.log(0.05) },
          ],
        });
        pieces.push({ token: '"' });
      } else {
        const p = schema.properties as Record<string, { enum?: string[] }>;
        const value = p.noul
          ? { noul: 0.8 }
          : p.choice
            ? { choice: p.choice.enum![0], confidence: 0.7 }
            : { score: 1, confidence: 0.6 };
        answers[id] = value;
        pieces.push({ token: `"${id}":${JSON.stringify(value)}` });
      }
    });
    pieces.push({ token: "}}" });
    const text = pieces.map((p) => p.token).join("");
    expect(JSON.parse(text)).toEqual({ answers });
    const logprobs =
      body.logprobs && opts.logprobs
        ? {
            content: pieces.map((p) => ({
              token: p.token,
              logprob: 0,
              top_logprobs: p.top ?? [{ token: p.token, logprob: 0 }],
            })),
          }
        : undefined;
    return reply(text, logprobs, opts.served ?? String(body.model));
  };
  return { fetch, bodies, auth, urls, count: () => calls };
}

function reply(content: string, logprobs: unknown, model: string) {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { role: "assistant", content }, ...(logprobs ? { logprobs } : {}) }],
      // OpenRouter reports what the call cost.
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 },
    }),
    { status: 200 },
  );
}

beforeEach(() => resetClassifierCapabilitiesForTests());

const Q = parseQuestions({
  urgent: { type: "noul", instructions: "It is urgent." },
  team: { type: "choice", instructions: "Which team?", criteria: { billing: null, tech: "Bugs." } },
  sev: { type: "score", instructions: "Severity?", criteria: ["low", "mid", "high"] },
});
const classifier = (
  fetch: ReturnType<typeof fakeUpstream>["fetch"],
  method: "auto" | "logprobs" | "sampled" | "verbalized",
  samples?: number,
) =>
  chatClassifierProvider({
    baseUrl: "http://localhost:3300/v1",
    model: "z-ai/glm-5.3-flash",
    timeoutMs: 2000,
    method,
    structured: true,
    ...(samples ? { samples } : {}),
    fetch,
  });

// ─── Methods ─────────────────────────────────────────────────────────────────

describe("labels and structured output", () => {
  it("labels every question with one character, or gives up above 26 options", () => {
    const l = labelQuestions(Q)!;
    expect(l.urgent!.labels).toEqual(["Y", "N"]);
    expect(l.team!.byLabel).toEqual({ A: "billing", B: "tech" });
    expect(l.sev!.labels).toEqual(["0", "1", "2"]);
    const wide = Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`o${i}`, null]));
    expect(
      labelQuestions(parseQuestions({ c: { type: "choice", instructions: "?", criteria: wide } })),
    ).toBeUndefined();
  });

  it("pins the reply to listed options or labels", () => {
    const verbal = answerResponseFormat(Q) as { json_schema: { schema: unknown } };
    expect(JSON.stringify(verbal.json_schema.schema)).toContain('"enum":["billing","tech"]');
    const labeled = answerResponseFormat(Q, labelQuestions(Q)) as {
      json_schema: { strict: boolean; schema: unknown };
    };
    expect(labeled.json_schema.strict).toBe(true);
    expect(JSON.stringify(labeled.json_schema.schema)).toContain('"enum":["Y","N"]');
  });

  it("reads label distributions from logprobs, whatever the tokenizer merged", () => {
    const labels = labelQuestions(Q)!;
    // The opening quote merged into the label token: `"B"` alternatives carry the prefix.
    const content = [
      { token: '{"answers":{"team":' },
      {
        token: '"B',
        top_logprobs: [
          { token: '"B', logprob: Math.log(0.6) },
          { token: '"A', logprob: Math.log(0.3) },
          { token: '"Bill', logprob: Math.log(0.1) },
        ],
      },
      { token: '"}}' },
    ];
    // The label token starts at the opening quote: alternatives share that prefix.
    const merged = distributionsFromLogprobs(content, labels).team!;
    expect(merged.B).toBeCloseTo(0.6);
    expect(merged.A).toBeCloseTo(0.3);
    expect(Object.keys(merged)).toEqual(["B", "A"]);
    const split = [
      { token: '{"answers":{"team":"' },
      {
        token: "B",
        top_logprobs: [
          { token: "B", logprob: Math.log(0.6) },
          { token: 'A"', logprob: Math.log(0.3) },
          { token: "Bill", logprob: Math.log(0.1) },
        ],
      },
      { token: '"}}' },
    ];
    const d = distributionsFromLogprobs(split, labels).team!;
    expect(d.B).toBeCloseTo(0.6);
    expect(d.A).toBeCloseTo(0.3);
    expect(Object.keys(d)).toEqual(["B", "A"]);
  });
});

describe("chat classifier methods", () => {
  it("logprobs: one call, Jev-shaped distributions", async () => {
    const up = fakeUpstream({ logprobs: true, pick: (labels) => labels[1]! });
    const result = await classifier(up.fetch, "logprobs").ask({ state: "s", questions: Q });
    expect(up.count()).toBe(1);
    expect(up.bodies[0]).toMatchObject({ logprobs: true, top_logprobs: 20, temperature: 0 });
    expect(result.method).toBe("logprobs");
    // noul: P(Y) where N was picked at 0.7.
    expect(result.answers.urgent).toMatchObject({ type: "noul" });
    expect((result.answers.urgent as { noul: number }).noul).toBeCloseTo(0.25 / 0.95);
    expect(result.answers.team).toMatchObject({ choice: "tech" });
    // Score: probability-weighted level (pick 1 at 0.7, 0 and 2 share 0.25) = 1.
    expect((result.answers.sev as { score: number }).score).toBeCloseTo(1);
  });

  it("auto: falls back to verbalized once when the provider returns no logprobs, then remembers", async () => {
    const up = fakeUpstream({ logprobs: false });
    const provider = classifier(up.fetch, "auto");
    const first = await provider.ask({ state: "s", questions: Q });
    expect(first.method).toBe("verbalized");
    expect(up.count()).toBe(2);
    const second = await provider.ask({ state: "s", questions: Q });
    expect(second.method).toBe("verbalized");
    expect(up.count()).toBe(3);
    expect(up.bodies[2]!.logprobs).toBeUndefined();
  });

  it("a provider that rejects logprobs (reasoning models) is answered verbalized, never refused", async () => {
    for (const method of ["auto", "logprobs"] as const) {
      resetClassifierCapabilitiesForTests();
      const up = fakeUpstream({ logprobs: true, rejectLogprobs: "reasoning" });
      const provider = classifier(up.fetch, method);
      const first = await provider.ask({ state: "s", questions: Q });
      expect(first.method).toBe("verbalized");
      // The rejection is not mistaken for a schema problem: the verbalized call keeps its schema.
      expect(up.count()).toBe(2);
      expect(up.bodies[1]!.response_format).toBeDefined();
      await provider.ask({ state: "s", questions: Q });
      expect(up.count()).toBe(3);
      expect(up.bodies[2]!.logprobs).toBeUndefined();
    }
  });

  it("a provider that caps top_logprobs is asked again at 5, and remembered", async () => {
    const up = fakeUpstream({ logprobs: true, rejectLogprobs: "cap5" });
    const provider = classifier(up.fetch, "auto");
    const first = await provider.ask({ state: "s", questions: Q });
    expect(first.method).toBe("logprobs");
    expect(up.bodies.map((b) => b.top_logprobs)).toEqual([20, 5]);
    await provider.ask({ state: "s", questions: Q });
    expect(up.bodies.map((b) => b.top_logprobs)).toEqual([20, 5, 5]);
  });

  it("sampled: k calls, answer frequencies", async () => {
    const up = fakeUpstream({ pick: (labels, call) => labels[call % 4 === 0 ? 0 : 1]! });
    const result = await classifier(up.fetch, "sampled", 4).ask({ state: "s", questions: Q });
    expect(up.count()).toBe(4);
    expect(result.method).toBe("sampled");
    expect((result.answers.urgent as { noul: number }).noul).toBeCloseTo(0.25);
    expect(result.answers.team).toMatchObject({ choice: "tech", confidence: 0.75 });
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 40 });
    expect(result.costUsd).toBeCloseTo(0.0004);
  });

  it("drops response_format for a server that rejects it, once", async () => {
    const up = fakeUpstream({ rejectSchema: true });
    const provider = classifier(up.fetch, "verbalized");
    await provider.ask({ state: "s", questions: Q });
    expect(up.count()).toBe(2);
    await provider.ask({ state: "s", questions: Q });
    expect(up.count()).toBe(3);
    expect(up.bodies[2]!.response_format).toBeUndefined();
  });

  it("keeps the original classifier request when no method is chosen", async () => {
    const up = fakeUpstream();
    const plain = chatClassifierProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "m",
      timeoutMs: 1000,
      fetch: up.fetch,
    });
    const result = await plain.ask({ state: "s", questions: Q });
    expect(up.bodies[0]!.response_format).toBeUndefined();
    expect(up.bodies[0]!.logprobs).toBeUndefined();
    expect(result.method).toBe("verbalized");
  });
});

describe("classifier spend", () => {
  beforeEach(() => resetSpendLedgerForTests());
  afterEach(() => resetSpendLedgerForTests());

  it("a direct chat-classifier backend records what each call cost", async () => {
    const up = fakeUpstream();
    const provider = providerFromConfig({
      kind: "chat-classifier",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "z-ai/glm-5.3-flash",
      timeoutMs: 1000,
    });
    const orig = globalThis.fetch;
    globalThis.fetch = up.fetch as typeof fetch;
    try {
      const result = await provider.ask({ state: "s", questions: Q });
      expect(result.costUsd).toBeCloseTo(0.0001);
      expect(spentTodayUsd()).toBeCloseTo(0.0001);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("a marina/classifier engine reports its cost but leaves recording to the passthru", async () => {
    const up = fakeUpstream({ logprobs: true });
    const r = resolveEngine(
      "marina/classifier:m",
      { MARINA_DECISION_ENGINES: "m" },
      { token: async () => "t", fetch: up.fetch },
    );
    if (!("provider" in r)) throw new Error("no engine");
    const result = await r.provider.ask({ state: "s", questions: Q });
    expect(result.costUsd).toBeCloseTo(0.0001);
    expect(spentTodayUsd()).toBe(0);
  });
});

// ─── Engines ─────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "MARINA_DECISIONS",
  "MARINA_DECISION_MODEL",
  "MARINA_DECISION_BASE_URL",
  "MARINA_DECISION_ENGINES",
  "MARINA_DECISION_METHOD",
] as const;

describe("engines", () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("there are none until an operator opts in", () => {
    expect(resolveEngine(undefined, {})).toMatchObject({
      error: { status: 404, code: "decisions_disabled" },
    });
    expect(listEngines({})).toEqual([]);
  });

  it("serves only the listed chat models, or any with `*`", () => {
    const env = { MARINA_DECISION_ENGINES: "z-ai/glm-5.3-flash, anthropic/claude-haiku-4-5" };
    expect("provider" in resolveEngine("marina/classifier:z-ai/glm-5.3-flash", env)).toBe(true);
    expect(resolveEngine("marina/classifier:openai/o9", env)).toMatchObject({
      error: { status: 400, code: "unsupported_parameter" },
    });
    expect(resolveEngine("typesafe/jev-1.13", env)).toMatchObject({ error: { status: 400 } });
    const bare = resolveEngine(undefined, env);
    expect("provider" in bare && bare.provider.model).toBe("marina/classifier:z-ai/glm-5.3-flash");
    const any = resolveEngine("marina/classifier:openai/o9", { MARINA_DECISION_ENGINES: "*" });
    expect("provider" in any && any.provider.model).toBe("marina/classifier:openai/o9");
    const dflt = resolveEngine("marina/classifier", { MARINA_DECISION_ENGINES: "*" });
    expect("provider" in dflt && dflt.provider.model).toBe("marina/classifier:marina/default");
    expect(listEngines(env).map((e) => e.id)).toEqual([
      "marina/classifier:z-ai/glm-5.3-flash",
      "marina/classifier:anthropic/claude-haiku-4-5",
    ]);
  });

  it("the configured backend stays the default, and engines sit beside it", () => {
    const env = {
      MARINA_DECISIONS: "jev",
      OPENROUTER_API_KEY: "k",
      MARINA_DECISION_ENGINES: "z-ai/glm-5.3-flash",
    };
    const d = resolveEngine(undefined, env);
    expect("provider" in d && d.provider.model).toBe("typesafe/jev-1.13");
    const latest = resolveEngine("jev-latest", env);
    expect("provider" in latest && latest.provider.model).toBe("typesafe/jev-1.13");
    const c = resolveEngine("marina/classifier:z-ai/glm-5.3-flash", env);
    expect("provider" in c && c.provider.calibrated).toBe(false);
    expect(listEngines(env).map((e) => [e.id, e.calibrated])).toEqual([
      ["typesafe/jev-1.13", true],
      ["marina/classifier:z-ai/glm-5.3-flash", false],
      // Jev first, the classifier as a second opinion — offered, used only when named.
      ["marina/auto", false],
    ]);
  });

  it("answers through Marina's own /v1 with the internal token and names who answered", async () => {
    const up = fakeUpstream({ logprobs: true, served: "glm-5.3-flash-0914" });
    const r = resolveEngine(
      "marina/classifier:z-ai/glm-5.3-flash",
      { MARINA_DECISION_ENGINES: "*", WS_PORT: "4555" },
      {
        token: async () => "marina-internal-test",
        fetch: up.fetch,
      },
    );
    if (!("provider" in r)) throw new Error("no engine");
    const result = await r.provider.ask({ state: "s", questions: Q });
    expect(up.urls[0]).toBe("http://localhost:4555/v1/chat/completions");
    expect(up.auth[0]).toBe("Bearer marina-internal-test");
    expect(up.bodies[0]!.model).toBe("z-ai/glm-5.3-flash");
    expect(result.model).toBe("marina/classifier:glm-5.3-flash-0914");
    expect(result.provider).toBe("marina-classifier");
    expect(result.method).toBe("logprobs");
  });

  it("POST /v1/systemone answers with an engine even when MARINA_DECISIONS is off", async () => {
    delete process.env.MARINA_DECISIONS;
    process.env.MARINA_DECISION_ENGINES = "z-ai/glm-5.3-flash";
    const up = fakeUpstream({ logprobs: true });
    const res = await handleDecisions(
      new Request("http://marina.test/v1/systemone", {
        method: "POST",
        body: JSON.stringify({
          model: "marina/classifier:z-ai/glm-5.3-flash",
          state: "My card was charged twice.",
          questions: {
            team: {
              type: "choice",
              instructions: "Which team?",
              criteria: { billing: null, tech: null },
            },
          },
        }),
      }),
      { token: async () => "t", fetch: up.fetch },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answers: Record<string, unknown>;
      calibrated: boolean;
      method: string;
    };
    expect(body.calibrated).toBe(false);
    expect(body.method).toBe("logprobs");
    expect(body.answers.team).toMatchObject({ type: "choice", choice: "billing" });
    const models = (await handleDecisionModels().json()) as { data: Array<{ id: string }> };
    expect(models.data.map((m) => m.id)).toEqual(["marina/classifier:z-ai/glm-5.3-flash"]);
  });

  it("still 404s with nothing configured, before looking at the body", async () => {
    delete process.env.MARINA_DECISIONS;
    delete process.env.MARINA_DECISION_ENGINES;
    const res = await handleDecisions(
      new Request("http://x/v1/systemone", { method: "POST", body: "nope" }),
    );
    expect(res.status).toBe(404);
  });
});

// ─── Conformance ─────────────────────────────────────────────────────────────

describe("conformance kit", () => {
  it("catches what a non-conformant reply gets wrong", () => {
    const q = CONFORMANCE_REQUESTS[3]!.request.questions;
    expect(
      wireViolations(q, {
        destructive: { type: "noul", noul: 1.2 },
        tier: { type: "choice", choice: "medium", confidence: 0.5, probabilities: { fast: 0.5 } },
      }),
    ).toEqual([
      "destructive: noul is not a probability",
      "tier: choice is not a listed option",
      "tier: probabilities missing powerful",
      "tier: probabilities sum to 0.500",
      "risk: not answered",
    ]);
  });

  it("a Jev-shaped backend conforms", async () => {
    const jev = decisionsApiProvider({
      baseUrl: "https://example.test",
      model: "jev",
      timeoutMs: 1000,
      fetch: async (_url, init) => {
        const { questions } = JSON.parse(String(init.body)) as {
          questions: Record<string, { type: string; criteria?: unknown }>;
        };
        const answers = Object.fromEntries(
          Object.entries(questions).map(([id, q]) => {
            if (q.type === "noul") return [id, { type: "noul", noul: 0.9 }];
            if (q.type === "choice") {
              const keys = Object.keys(q.criteria as object);
              return [
                id,
                {
                  type: "choice",
                  choice: keys[0],
                  confidence: 0.8,
                  probabilities: Object.fromEntries(
                    keys.map((k, i) => [k, i === 0 ? 0.8 : 0.2 / (keys.length - 1)]),
                  ),
                },
              ];
            }
            const n = (q.criteria as string[]).length;
            return [
              id,
              {
                type: "score",
                score: 2,
                confidence: 0.5,
                probabilities: Object.fromEntries(
                  Array.from({ length: n }, (_, i) => [String(i), 1 / n]),
                ),
              },
            ];
          }),
        );
        return new Response(JSON.stringify({ answers }), { status: 200 });
      },
    });
    expect(await runConformance(jev)).toEqual({ passed: 4, total: 4, failures: [] });
  });

  for (const [method, logprobs, rejectLogprobs] of [
    ["logprobs", true, undefined],
    ["auto", false, undefined],
    ["auto", true, "reasoning"],
    ["auto", true, "cap5"],
    ["sampled", false, undefined],
    ["verbalized", false, undefined],
  ] as const) {
    it(`a marina/classifier engine conforms (${method}${logprobs ? "" : ", no logprobs"}${rejectLogprobs ? `, ${rejectLogprobs}` : ""})`, async () => {
      const up = fakeUpstream({ logprobs, ...(rejectLogprobs ? { rejectLogprobs } : {}) });
      const r = resolveEngine(
        "marina/classifier:m",
        { MARINA_DECISION_ENGINES: "m", MARINA_DECISION_METHOD: method },
        {
          token: async () => "t",
          fetch: up.fetch,
        },
      );
      if (!("provider" in r)) throw new Error("no engine");
      expect(await runConformance(r.provider)).toEqual({ passed: 4, total: 4, failures: [] });
    });
  }
});
